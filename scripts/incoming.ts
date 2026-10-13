/**
 * 「取り込み待ち」の置き場所（Supabase Storage の incoming バケット）を操作する。SharePointの代わり。
 *   npm run incoming -- setup                 バケットを作る（最初に1回）
 *   npm run incoming -- upload <ファイル...>   ファイルを置く（＝SharePointに文書が追加された状態を作る）
 *   npm run incoming -- list                  置いてあるファイルと、取り込み済みかどうかを表示する
 *   npm run incoming -- run                   定期取り込みを手元で1回実行する（Cronと同じ処理）
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import fs from "node:fs/promises";
import path from "node:path";
import { INCOMING_BUCKET, getDocumentSource } from "../src/lib/document-source";
import { runScheduledIngest, summarizeReport } from "../src/lib/scheduled-ingest";
import { createAdminClient } from "../src/lib/supabase-admin";

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const admin = createAdminClient();

  if (command === "setup") {
    // 非公開のバケット。サービスロールだけが読み書きする
    const { error } = await admin.storage.createBucket(INCOMING_BUCKET, { public: false });
    if (error && !/already exists/i.test(error.message)) throw new Error(error.message);
    console.log(`✅ バケット「${INCOMING_BUCKET}」${error ? "は作成済みです" : "を作成しました"}（非公開）`);
  } else if (command === "upload") {
    if (args.length === 0) throw new Error("置くファイルを指定してください");
    for (const file of args) {
      const name = path.basename(file);
      const { error } = await admin.storage
        .from(INCOMING_BUCKET)
        .upload(name, await fs.readFile(file), { contentType: CONTENT_TYPES[path.extname(name).toLowerCase()], upsert: true });
      if (error) throw new Error(`${name}: ${error.message}`);
      console.log(`✅ 置きました: ${name}`);
    }
  } else if (command === "list") {
    const files = await getDocumentSource().list();
    const { data, error } = await admin.from("documents").select("source_path, department").like("source_path", `storage://${INCOMING_BUCKET}/%`);
    if (error) throw new Error(error.message);
    const ingested = new Map(data.map((d) => [d.source_path as string, d.department as string]));
    for (const file of files) console.log(`${ingested.has(file.sourcePath) ? `取り込み済み（${ingested.get(file.sourcePath)}）` : "未取り込み"}  ${file.filename}`);
    console.log(`\n${files.length} 件`);
  } else if (command === "run") {
    const report = await runScheduledIngest(getDocumentSource(), { deadlineMs: 240_000 });
    console.log(JSON.stringify(report, null, 2));
    console.log(`\n${summarizeReport(report) ?? "取り込む文書はありませんでした"}`);
  } else {
    console.error("使い方: npm run incoming -- <setup | upload <ファイル...> | list | run>");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
