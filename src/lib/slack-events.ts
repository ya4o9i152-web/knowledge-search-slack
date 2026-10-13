import { answerQuestion, type ConversationTurn } from "./pipeline";
import { slackApi, verifySlackSignature, type SlackApi } from "./slack";
import { ERROR_MESSAGE, USAGE_MESSAGE, progressMessage, resultMessage } from "./slack-format";
import { createAdminClient } from "./supabase-admin";

// Slack Events API のイベント（使う項目だけ）
type SlackEvent = {
  type: string;
  user?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
};

type SlackPayload = { type: string; challenge?: string; event_id?: string; event?: SlackEvent };

export type SlackEventDeps = {
  /** レスポンスを返した後に実行する処理を登録する。Route Handlerでは next/server の after を渡す */
  schedule: (task: () => Promise<void>) => void;
  slack: SlackApi;
  answer: typeof answerQuestion;
  /** イベントIDを記録し、初めて見るIDなら true を返す */
  claimEvent: (eventId: string) => Promise<boolean>;
};

const HISTORY_MAX_TURNS = 6;
const HISTORY_MAX_CHARS = 1500;

/** slack_events の主キー制約を使った重複排除。同じIDの2回目は挿入に失敗する（23505 = 一意制約違反） */
async function claimEventInDb(eventId: string): Promise<boolean> {
  const { error } = await createAdminClient().from("slack_events").insert({ event_id: eventId });
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(`イベントの記録に失敗: ${error.message}`);
}

export const defaultDeps = (schedule: SlackEventDeps["schedule"]): SlackEventDeps => ({
  schedule,
  slack: slackApi,
  answer: answerQuestion,
  claimEvent: claimEventInDb,
});

/** 「<@U0123> 質問」の形で届くメンション部分を取り除く */
const stripMentions = (text: string) => text.replace(/<@[A-Z0-9]+>/g, "").trim();

/** 質問として扱うイベントだけを通す。ボット自身の投稿や、編集・削除などの通知は無視する */
function isQuestionEvent(event: SlackEvent): event is SlackEvent & { user: string; channel: string; ts: string } {
  if (event.bot_id || event.subtype) return false;
  if (!event.user || !event.channel || !event.ts) return false;
  // 「/invite @knowledge」のように、スラッシュコマンドがそのまま発言として届いたものは質問ではない
  if (stripMentions(event.text ?? "").startsWith("/")) return false;
  if (event.type === "app_mention") return true;
  return event.type === "message" && event.channel_type === "im";
}

/**
 * 非同期の部分：検索と要約。Slackに 200 を返した後に実行される。
 *
 * ・DM：質問のメッセージにスレッドで返信する
 * ・チャンネルでのメンション：回答をチャンネルに出すと、権限のない人にも要約が見えてしまう。
 *   チャンネルには「DMでお答えします」と本人にだけ見える形で伝え、回答はDMに送る
 * ・最初に「考え中…」を出し、進むたびに同じメッセージを書き換える（進捗フィードバック）
 */
async function respond(event: SlackEvent & { user: string; channel: string; ts: string }, deps: SlackEventDeps): Promise<void> {
  const { slack } = deps;
  const question = stripMentions(event.text ?? "");
  const isDm = event.type === "message";

  let channel = event.channel;
  let threadTs: string | undefined = event.thread_ts ?? event.ts;
  if (!isDm) {
    channel = await slack.openDm(event.user);
    threadTs = undefined;
    await slack.postEphemeral(event.channel, event.user, "DMでお答えします（回答は、あなたの所属部署の文書をもとにしているため、チャンネルには表示しません）。");
  }

  if (!question) {
    await slack.postMessage(channel, USAGE_MESSAGE, threadTs);
    return;
  }

  const placeholderTs = await slack.postMessage(channel, progressMessage("accepted"), threadTs);
  try {
    // スレッド内の追加質問なら、それまでのやりとりを会話の文脈として渡す
    let history: ConversationTurn[] = [];
    if (isDm && event.thread_ts && event.thread_ts !== event.ts) {
      const thread = await slack.fetchThread(channel, event.thread_ts);
      history = thread
        .filter((m) => m.ts !== event.ts && m.ts !== placeholderTs && m.text.trim().length > 0)
        .slice(-HISTORY_MAX_TURNS)
        .map((m) => ({ role: m.fromBot ? ("assistant" as const) : ("user" as const), text: stripMentions(m.text).slice(0, HISTORY_MAX_CHARS) }));
    }

    const result = await deps.answer(event.user, question, {
      history,
      onProgress: async (stage, detail) => {
        if (stage === "summarizing") await slack.updateMessage(channel, placeholderTs, progressMessage("summarizing", detail.documentCount));
      },
    });
    // メンションから来た場合はDM側に質問文が無いので、回答の先頭に質問を添える
    await slack.updateMessage(channel, placeholderTs, resultMessage(result, isDm ? undefined : question));
  } catch (err) {
    console.error(`[slack] 回答に失敗: ${err instanceof Error ? err.message : String(err)}`);
    await slack.updateMessage(channel, placeholderTs, ERROR_MESSAGE);
  }
}

/**
 * 同期の部分：Slackからのリクエストを受け付ける。
 *
 * Slackは3秒以内に 200 が返らないと同じイベントを再送する。検索と要約は3秒では終わらないので、
 * ここでは「署名の検証 → 重複の確認 → 後で実行する処理の登録」だけを行って、すぐに 200 を返す。
 */
export async function handleSlackRequest(
  rawBody: string,
  headers: { timestamp: string | null; signature: string | null },
  deps: SlackEventDeps,
): Promise<Response> {
  const verified = verifySlackSignature(rawBody, headers.timestamp, headers.signature);
  if (!verified.ok) {
    console.warn(`[slack] 署名の検証に失敗: ${verified.reason}`);
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  const payload = JSON.parse(rawBody) as SlackPayload;

  // Slackアプリの設定画面でURLを登録するときの確認。受け取った challenge をそのまま返す
  if (payload.type === "url_verification") {
    return Response.json({ challenge: payload.challenge });
  }

  if (payload.type !== "event_callback" || !payload.event || !payload.event_id) {
    return Response.json({ ok: true, ignored: "not an event" });
  }
  const event = payload.event;
  if (!isQuestionEvent(event)) {
    return Response.json({ ok: true, ignored: "not a question" });
  }
  // 再送や二重配信で同じ質問に2回答えないよう、イベントIDで重複を弾く
  if (!(await deps.claimEvent(payload.event_id))) {
    return Response.json({ ok: true, ignored: "duplicate" });
  }

  deps.schedule(() => respond(event, deps));
  return Response.json({ ok: true });
}
