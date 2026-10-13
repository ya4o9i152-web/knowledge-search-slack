import { createHmac, timingSafeEqual } from "node:crypto";

/** 署名で許容する時刻のずれ。これより古いリクエストは、盗み見た通信の再送とみなして弾く */
const SIGNATURE_TOLERANCE_SEC = 5 * 60;

/**
 * Slackから届いたリクエストの署名検証。
 * x-slack-signature = "v0=" + hex(HMAC-SHA256(Signing Secret, `v0:${timestamp}:${本文}`))
 * 本文は JSON.parse する前の「受け取ったままの文字列」で計算する。
 */
export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  now: number = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return { ok: false, reason: "SLACK_SIGNING_SECRET が未設定" };
  if (!timestamp || !signature) return { ok: false, reason: "署名ヘッダーがない" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > SIGNATURE_TOLERANCE_SEC) {
    return { ok: false, reason: "タイムスタンプが古い、または不正" };
  }

  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "署名が一致しない" };
}

/** Slack の mrkdwn で特別な意味を持つ記号をエスケープする（文書の本文に < > が含まれても崩れないように） */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type SlackMessage = { text: string; blocks?: unknown[] };
export type ThreadMessage = { ts: string; text: string; fromBot: boolean };

/** Slack Web API のうち、このボットが使う操作。テストでは差し替える */
export interface SlackApi {
  postMessage(channel: string, message: SlackMessage, threadTs?: string): Promise<string>;
  updateMessage(channel: string, ts: string, message: SlackMessage): Promise<void>;
  /** チャンネル内で、指定したユーザーにだけ見えるメッセージを出す */
  postEphemeral(channel: string, user: string, text: string): Promise<void>;
  /** ユーザーとの個人宛てのやりとり（DM）を開き、そのチャンネルIDを返す */
  openDm(user: string): Promise<string>;
  fetchThread(channel: string, threadTs: string): Promise<ThreadMessage[]>;
}

async function call(method: string, body: Record<string, unknown>, query = false): Promise<Record<string, unknown>> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN が設定されていません");
  // 読み取り系（conversations.replies）はJSONの本文を受け付けないため、クエリ文字列で渡す
  const url = query
    ? `https://slack.com/api/${method}?${new URLSearchParams(body as Record<string, string>)}`
    : `https://slack.com/api/${method}`;
  const res = await fetch(url, {
    method: query ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(query ? {} : { "Content-Type": "application/json; charset=utf-8" }),
    },
    body: query ? undefined : JSON.stringify(body),
  });
  if (res.status === 429) throw new Error(`Slack ${method}: レート制限（Retry-After: ${res.headers.get("retry-after")}秒）`);
  const json = (await res.json()) as { ok: boolean; error?: string } & Record<string, unknown>;
  if (!json.ok) throw new Error(`Slack ${method} に失敗: ${json.error}`);
  return json;
}

export const slackApi: SlackApi = {
  async postMessage(channel, message, threadTs) {
    const json = await call("chat.postMessage", { channel, ...message, thread_ts: threadTs, unfurl_links: false });
    return json.ts as string;
  },
  async updateMessage(channel, ts, message) {
    await call("chat.update", { channel, ts, ...message });
  },
  async postEphemeral(channel, user, text) {
    await call("chat.postEphemeral", { channel, user, text });
  },
  async openDm(user) {
    const json = await call("conversations.open", { users: user });
    return (json.channel as { id: string }).id;
  },
  async fetchThread(channel, threadTs) {
    const json = await call("conversations.replies", { channel, ts: threadTs, limit: "20" }, true);
    return (json.messages as { ts: string; text?: string; bot_id?: string }[]).map((m) => ({
      ts: m.ts,
      text: m.text ?? "",
      fromBot: Boolean(m.bot_id),
    }));
  },
};
