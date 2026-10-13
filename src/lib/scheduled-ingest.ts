import type { DocumentSource, SourceFile } from "./document-source";
import { ingestPrepared, prepareDocument } from "./ingest";
import { createAdminClient } from "./supabase-admin";

export type ScheduledIngestReport = {
  /** 取り込み元にあったPDF・Wordの数 */
  found: number;
  alreadyIngested: number;
  ingested: { file: string; department: string; chunkCount: number; warnings: string[] }[];
  failed: { file: string; error: string }[];
  /** 制限時間に達して、今回は処理しなかった件数（次回の実行で続きから処理される） */
  remaining: number;
  elapsedMs: number;
};

/** 取り込み済みの文書の source_path をまとめて取得する（1件ずつ問い合わせない） */
async function ingestedSourcePaths(): Promise<Set<string>> {
  const admin = createAdminClient();
  const paths = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("documents").select("source_path").order("source_path").range(from, from + 999);
    if (error) throw new Error(`取り込み済み文書の確認に失敗: ${error.message}`);
    for (const row of data) paths.add(row.source_path as string);
    if (data.length < 1000) break;
  }
  return paths;
}

/**
 * 定期取り込みの本体。取り込み元にあって、まだDBに無い文書だけを取り込む（追加のみ）。
 *
 * ・1件の失敗で全体を止めない。失敗した文書はDBに入らないので、次回の実行でもう一度試される
 * ・サーバー上の関数には実行時間の上限があるため、制限時間が近づいたら新しい文書を始めない。
 *   残りは次回の実行に回る（取り込み済みはスキップされるので、続きから進む）
 */
export async function runScheduledIngest(source: DocumentSource, options: { deadlineMs: number }): Promise<ScheduledIngestReport> {
  const startedAt = Date.now();
  const files = await source.list();
  const ingestedPaths = await ingestedSourcePaths();
  const pending: SourceFile[] = files.filter((file) => !ingestedPaths.has(file.sourcePath));

  const report: ScheduledIngestReport = {
    found: files.length,
    alreadyIngested: files.length - pending.length,
    ingested: [],
    failed: [],
    remaining: 0,
    elapsedMs: 0,
  };

  for (const [index, file] of pending.entries()) {
    if (Date.now() - startedAt > options.deadlineMs) {
      report.remaining = pending.length - index;
      break;
    }
    try {
      const prepared = await prepareDocument(await source.download(file), file.filename);
      const result = await ingestPrepared(prepared, { sourcePath: file.sourcePath, sourceUrl: file.sourceUrl });
      report.ingested.push({ file: file.sourcePath, department: result.department, chunkCount: result.chunkCount, warnings: result.warnings });
    } catch (err) {
      report.failed.push({ file: file.sourcePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  report.elapsedMs = Date.now() - startedAt;
  return report;
}

/** 管理者に知らせる文面。取り込みも失敗も無ければ null（何も送らない） */
export function summarizeReport(report: ScheduledIngestReport): string | null {
  if (report.ingested.length === 0 && report.failed.length === 0 && report.remaining === 0) return null;
  const lines = [`📥 定期取り込みの結果：取り込み ${report.ingested.length} 件 ／ 失敗 ${report.failed.length} 件 ／ 取り込み済み ${report.alreadyIngested} 件`];
  const byDepartment = new Map<string, number>();
  for (const item of report.ingested) byDepartment.set(item.department, (byDepartment.get(item.department) ?? 0) + 1);
  if (byDepartment.size > 0) lines.push(`部署別：${[...byDepartment].map(([department, count]) => `${department} ${count}件`).join("・")}`);
  for (const item of report.failed) lines.push(`⚠️ ${item.file.split("/").pop()}：${item.error}`);
  if (report.remaining > 0) lines.push(`⏳ 制限時間のため ${report.remaining} 件は次回に回りました`);
  return lines.join("\n");
}
