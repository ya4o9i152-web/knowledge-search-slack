import { createAdminClient } from "./supabase-admin";

type LogRow = { slack_user_id: string | null; question: string; departments: string[]; status: string; latency_ms: number | null };

export type AuditReport = {
  /** 集計した月（例: 2026-10） */
  month: string;
  total: number;
  users: number;
  byStatus: Record<string, number>;
  byDepartment: { department: string; total: number; users: number; noMatch: number }[];
  /** 該当なしになった質問（多い順）。文書が足りていない分野の手がかり */
  topNoMatch: { question: string; count: number }[];
  redactedLogs: number;
};

/** 指定した月の1日 0:00（日本時間）から翌月1日 0:00 まで */
function monthRange(year: number, month: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  return { from: `${year}-${pad(month)}-01T00:00:00+09:00`, to: `${next.y}-${pad(next.m)}-01T00:00:00+09:00` };
}

/**
 * 監査ログの月次集計。数字はすべてDBの記録から計算する（AIに数えさせない）。
 * 兼務の人の質問は、所属する部署それぞれに数える。
 */
export async function buildAuditReport(year: number, month: number): Promise<AuditReport> {
  const admin = createAdminClient();
  const { from, to } = monthRange(year, month);
  const rows: (LogRow & { redacted_chunk_count: number })[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin
      .from("search_logs")
      .select("slack_user_id, question, departments, status, latency_ms, redacted_chunk_count")
      .gte("created_at", from)
      .lt("created_at", to)
      // 確認スクリプトからの検索（cli）は利用状況に含めない
      .eq("channel", "slack")
      .order("created_at")
      .range(offset, offset + 999);
    if (error) throw new Error(`監査ログの取得に失敗: ${error.message}`);
    rows.push(...(data as (LogRow & { redacted_chunk_count: number })[]));
    if (data.length < 1000) break;
  }

  const byStatus: Record<string, number> = {};
  const departments = new Map<string, { total: number; users: Set<string>; noMatch: number }>();
  const noMatch = new Map<string, number>();
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    if (row.status === "no_match") noMatch.set(row.question, (noMatch.get(row.question) ?? 0) + 1);
    for (const department of row.departments.length > 0 ? row.departments : ["（所属なし）"]) {
      const entry = departments.get(department) ?? { total: 0, users: new Set<string>(), noMatch: 0 };
      entry.total++;
      if (row.slack_user_id) entry.users.add(row.slack_user_id);
      if (row.status === "no_match") entry.noMatch++;
      departments.set(department, entry);
    }
  }

  return {
    month: `${year}-${String(month).padStart(2, "0")}`,
    total: rows.length,
    users: new Set(rows.map((r) => r.slack_user_id).filter(Boolean)).size,
    byStatus,
    byDepartment: [...departments].map(([department, e]) => ({ department, total: e.total, users: e.users.size, noMatch: e.noMatch })).sort((a, b) => b.total - a.total),
    topNoMatch: [...noMatch].map(([question, count]) => ({ question, count })).sort((a, b) => b.count - a.count).slice(0, 5),
    redactedLogs: rows.filter((r) => r.redacted_chunk_count > 0).length,
  };
}

export function formatAuditReport(report: AuditReport): string {
  const status = (key: string) => report.byStatus[key] ?? 0;
  const lines = [
    `📊 ナレッジ検索の利用状況（${report.month}）`,
    `質問 ${report.total} 件 ／ 利用者 ${report.users} 名`,
    `回答あり ${status("answered")} 件 ／ 該当なし ${status("no_match")} 件 ／ 未登録の利用者 ${status("unregistered")} 件 ／ エラー ${status("error") + status("searched")} 件`,
  ];
  if (report.byDepartment.length > 0) {
    lines.push("", "部署別");
    for (const d of report.byDepartment) lines.push(`・${d.department}：${d.total} 件（利用者 ${d.users} 名、該当なし ${d.noMatch} 件）`);
  }
  if (report.topNoMatch.length > 0) {
    lines.push("", "該当なしが多かった質問（文書が足りていない分野の手がかり）");
    for (const q of report.topNoMatch) lines.push(`・${q.question}（${q.count} 回）`);
  }
  if (report.redactedLogs > 0) lines.push("", `文書の完全削除により、参照を消した記録が ${report.redactedLogs} 件あります`);
  return lines.join("\n");
}

/** 先月（日本時間）の年と月 */
export function previousMonth(now: Date = new Date()): { year: number; month: number } {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth() + 1;
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}
