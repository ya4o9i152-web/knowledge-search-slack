import { getDocumentSource } from "@/lib/document-source";
import { runScheduledIngest, summarizeReport } from "@/lib/scheduled-ingest";
import { slackApi } from "@/lib/slack";

// Vercelの関数の実行時間の上限（秒）。月50〜100件の追加を1回で処理する想定
export const maxDuration = 300;
// 上限の手前で新しい文書の処理を始めるのをやめ、残りは次回に回す
const DEADLINE_MS = 240_000;

/**
 * 月次取り込み。Vercel Cron（vercel.json）が毎月1日に呼び出す。
 * Vercel Cron は、環境変数 CRON_SECRET があると `Authorization: Bearer <CRON_SECRET>` を付けて呼び出すので、
 * それ以外からの呼び出しは拒否する。
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const report = await runScheduledIngest(getDocumentSource(), { deadlineMs: DEADLINE_MS });
  console.log(`[cron:ingest] ${JSON.stringify(report)}`);

  // 取り込みや失敗があったときだけ、管理者に結果を知らせる（設定されている場合）
  const notifyChannel = process.env.INGEST_NOTIFY_CHANNEL;
  const summary = summarizeReport(report);
  if (notifyChannel && summary) {
    try {
      await slackApi.postMessage(notifyChannel, { text: summary });
    } catch (err) {
      console.error(`[cron:ingest] 通知に失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return Response.json(report);
}
