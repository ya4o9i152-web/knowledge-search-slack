import { buildAuditReport, formatAuditReport, previousMonth } from "@/lib/audit-report";
import { slackApi } from "@/lib/slack";

export const maxDuration = 60;

/**
 * 監査ログの月次レポート。Vercel Cron（vercel.json）が毎月1日に呼び出し、先月分の利用状況を管理者に送る。
 * /api/cron/ingest と同じく、CRON_SECRET を付けた呼び出しだけを受け付ける。
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { year, month } = previousMonth();
  const report = await buildAuditReport(year, month);
  console.log(`[cron:audit-report] ${JSON.stringify(report)}`);

  const notifyChannel = process.env.INGEST_NOTIFY_CHANNEL;
  let notified = false;
  if (notifyChannel) {
    await slackApi.postMessage(notifyChannel, { text: formatAuditReport(report) });
    notified = true;
  }
  return Response.json({ ...report, notified });
}
