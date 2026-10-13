/**
 * フォルダ内のPDF・Wordをまとめて取り込む（バッチ取り込み）。
 *
 *   npm run ingest                         docs/samples を取り込む
 *   npm run ingest -- --dir <フォルダ>      取り込むフォルダを指定（下位フォルダも対象）
 *   npm run ingest -- --dry-run            抽出とチャンキングだけ行い、分割結果を表示する（API・DBを使わない）
 *   npm run ingest -- --limit 10           先頭10件だけ処理する（少量で試すとき）
 *   npm run ingest -- --batch-size 20      1バッチの文書数（既定20）
 *
 * ・途中で止まっても、同じコマンドをもう一度実行すれば続きから進む（取り込み済みはスキップ）
 * ・1件の失敗で全体を止めない。失敗した文書と理由は reports/ingest-<日時>.json に残る
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import fs from "node:fs/promises";
import path from "node:path";
import { DEPARTMENTS } from "../src/lib/departments";
import { detectFileType } from "../src/lib/extract";
import { ingestPrepared, prepareDocument } from "../src/lib/ingest";
import { createAdminClient } from "../src/lib/supabase-admin";

type FileReport = {
  file: string;
  status: "completed" | "skipped" | "failed" | "dry-run";
  department?: string;
  chunkCount?: number;
  warnings?: string[];
  error?: string;
};

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && detectFileType(e.name) !== null && !e.name.startsWith("~$"))
    .map((e) => path.join(e.parentPath, e.name))
    .sort();
}

async function main() {
  const targetDir = path.resolve(argValue("--dir") ?? "docs/samples");
  const dryRun = process.argv.includes("--dry-run");
  const limit = Number(argValue("--limit") ?? Infinity);
  const batchSize = Number(argValue("--batch-size") ?? 20);

  const files = (await listFiles(targetDir)).slice(0, limit);
  if (files.length === 0) {
    console.error(`PDF・Wordが見つかりません: ${targetDir}`);
    process.exit(1);
  }
  console.log(`${files.length} 件を処理します（${targetDir}）${dryRun ? " ※ドライラン" : ""}\n`);

  const reports: FileReport[] = [];
  const startedAt = Date.now();

  for (let start = 0; start < files.length; start += batchSize) {
    const batch = files.slice(start, start + batchSize);
    for (const filePath of batch) {
      const relative = path.relative(process.cwd(), filePath);
      try {
        const prepared = await prepareDocument(await fs.readFile(filePath), path.basename(filePath));
        if (dryRun) {
          reports.push({ file: relative, status: "dry-run", department: prepared.metadata.department, chunkCount: prepared.chunks.length, warnings: prepared.warnings });
          console.log(`📄 ${relative}`);
          console.log(`   ${prepared.metadata.title} ／ 部署: ${prepared.metadata.department} ／ 客先: ${prepared.metadata.client ?? "-"} ／ 作成: ${prepared.metadata.docYear ?? "-"} ／ ${prepared.pageCount ?? "-"}ページ`);
          for (const chunk of prepared.chunks) {
            const pages = chunk.pageStart === null ? "" : `p.${chunk.pageStart}${chunk.pageEnd !== chunk.pageStart ? `-${chunk.pageEnd}` : ""} `;
            console.log(`   [${chunk.chunkIndex}] ${chunk.sectionTitle ?? "（見出しなし）"} ${pages}${chunk.tokens}トークン`);
          }
        } else {
          // 手元から実行するときの保存場所。SharePoint連携ではSharePoint上のパスを入れる
          const result = await ingestPrepared(prepared, { sourcePath: `local://${relative}` });
          reports.push({ file: relative, ...result });
          console.log(`${result.status === "completed" ? "✅ 取り込み" : "⏭️  取り込み済み"} ${relative}（${result.department}・${result.chunkCount}チャンク）`);
        }
        for (const warning of prepared.warnings) console.log(`   ⚠️ ${warning}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reports.push({ file: relative, status: "failed", error: message });
        console.log(`❌ 失敗 ${relative}: ${message}`);
      }
    }
    const done = Math.min(start + batchSize, files.length);
    if (files.length > batchSize) console.log(`--- ${done}/${files.length} 件まで処理（経過 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`);
  }

  const count = (status: FileReport["status"]) => reports.filter((r) => r.status === status).length;
  console.log(`\n=== 結果 ===`);
  console.log(dryRun ? `ドライラン ${count("dry-run")} 件 ／ 失敗 ${count("failed")} 件` : `取り込み ${count("completed")} 件 ／ 取り込み済み ${count("skipped")} 件 ／ 失敗 ${count("failed")} 件`);

  if (!dryRun) {
    // 件数の照合：DBに入っている文書数・チャンク数を部署別に数える
    const admin = createAdminClient();
    console.log(`\n=== DBの件数（部署別） ===`);
    for (const department of DEPARTMENTS) {
      const [docs, chunks] = await Promise.all([
        admin.from("documents").select("*", { count: "exact", head: true }).eq("department", department),
        admin.from("document_chunks").select("*", { count: "exact", head: true }).eq("department", department),
      ]);
      console.log(`${department}: 文書 ${docs.count ?? "?"} 件 ／ チャンク ${chunks.count ?? "?"} 件`);
    }

    await fs.mkdir("reports", { recursive: true });
    const reportPath = `reports/ingest-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    await fs.writeFile(reportPath, JSON.stringify({ targetDir, startedAt: new Date(startedAt).toISOString(), files: reports }, null, 2));
    console.log(`\nレポート: ${reportPath}`);
  }

  if (count("failed") > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
