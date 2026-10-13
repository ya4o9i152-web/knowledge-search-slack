/**
 * Slackイベント受信のテスト。Slackには接続しない（Slack APIは記録用の代役に差し替える）。
 *   npm run test:slack
 * 重複排除の1項目だけ本番のSupabaseを使い、最後の1項目（追加質問）だけClaudeを2回呼ぶ。
 */
import { config } from "dotenv";
config({ path: ".env.local" });
process.env.SLACK_SIGNING_SECRET = "test-signing-secret"; // テスト用。本物のシークレットは使わない

import { createHmac } from "node:crypto";
import { answerQuestion, type PipelineResult } from "../src/lib/pipeline";
import type { SlackApi, SlackMessage } from "../src/lib/slack";
import { defaultDeps, handleSlackRequest, type SlackEventDeps } from "../src/lib/slack-events";
import { ERROR_MESSAGE, USAGE_MESSAGE } from "../src/lib/slack-format";
import { createAdminClient } from "../src/lib/supabase-admin";
import { TEST_USERS } from "./lib/test-users";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? `  →  ${detail}` : ""}`);
}

function sign(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = `v0=${createHmac("sha256", "test-signing-secret").update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return { timestamp: String(timestamp), signature };
}

type Call = { method: string; channel: string; text?: string; threadTs?: string; user?: string; ts?: string };

function harness(options: { answer?: SlackEventDeps["answer"]; thread?: { ts: string; text: string; fromBot: boolean }[] } = {}) {
  const calls: Call[] = [];
  const tasks: (() => Promise<void>)[] = [];
  const seen = new Set<string>();
  const answerCalls: { user: string; question: string; history: unknown }[] = [];
  let counter = 0;
  const slack: SlackApi = {
    async postMessage(channel, message: SlackMessage, threadTs) {
      const ts = `bot-${++counter}`;
      calls.push({ method: "postMessage", channel, text: message.text, threadTs, ts });
      return ts;
    },
    async updateMessage(channel, ts, message) { calls.push({ method: "updateMessage", channel, ts, text: message.text }); },
    async postEphemeral(channel, user, text) { calls.push({ method: "postEphemeral", channel, user, text }); },
    async openDm(user) { calls.push({ method: "openDm", channel: `D-${user}`, user }); return `D-${user}`; },
    async fetchThread(channel, threadTs) { calls.push({ method: "fetchThread", channel, threadTs }); return options.thread ?? []; },
  };
  const fakeAnswer: SlackEventDeps["answer"] = async (user, question, opts) => {
    answerCalls.push({ user, question, history: opts?.history });
    await opts?.onProgress?.("searching", { documentCount: 0 });
    await opts?.onProgress?.("summarizing", { documentCount: 2 });
    return { status: "no_match", latencyMs: 1 } satisfies PipelineResult;
  };
  const deps: SlackEventDeps = {
    schedule: (task) => tasks.push(task),
    slack,
    answer: options.answer ?? fakeAnswer,
    claimEvent: async (id) => (seen.has(id) ? false : (seen.add(id), true)),
  };
  const send = async (payload: unknown, headers?: { timestamp: string | null; signature: string | null }) => {
    const body = JSON.stringify(payload);
    const startedAt = Date.now();
    const res = await handleSlackRequest(body, headers ?? sign(body), deps);
    return { res, json: (await res.json()) as Record<string, unknown>, ms: Date.now() - startedAt };
  };
  const runTasks = async () => { for (const task of tasks.splice(0)) await task(); };
  return { calls, tasks, answerCalls, send, runTasks };
}

const dm = (overrides: Record<string, unknown> = {}, eventId = "Ev1") => ({
  type: "event_callback",
  event_id: eventId,
  event: { type: "message", channel_type: "im", user: "U_ASKER", channel: "D_ASKER", ts: "100.1", text: "クラウド移行の事例は？", ...overrides },
});

async function main() {
  // 1. 署名
  {
    const h = harness();
    const body = JSON.stringify(dm());
    const bad = await handleSlackRequest(body, { timestamp: sign(body).timestamp, signature: "v0=deadbeef" }, { ...defaultDeps(() => {}), claimEvent: async () => true });
    check("署名が違うリクエストは 401", bad.status === 401);
    const old = await h.send(dm(), sign(body, Math.floor(Date.now() / 1000) - 600));
    check("10分前のタイムスタンプは 401（再送攻撃の防止）", old.res.status === 401 && h.tasks.length === 0);
    const none = await h.send(dm(), { timestamp: null, signature: null });
    check("署名ヘッダーがなければ 401", none.res.status === 401);
  }

  // 2. URLの確認
  {
    const h = harness();
    const { res, json } = await h.send({ type: "url_verification", challenge: "abc123" });
    check("url_verification には challenge をそのまま返す", res.status === 200 && json.challenge === "abc123");
  }

  // 3. DMでの質問
  {
    const h = harness();
    const { res, ms } = await h.send(dm());
    check("DMの質問：すぐに 200 を返し、処理は後回しにする", res.status === 200 && h.tasks.length === 1 && h.calls.length === 0, `${ms}ミリ秒・Slackへの投稿0件`);
    await h.runTasks();
    const [first, second, third] = h.calls;
    check("最初に「考え中…」を、質問へのスレッド返信として出す", first.method === "postMessage" && first.channel === "D_ASKER" && first.threadTs === "100.1" && first.text!.includes("考え中"), first.text);
    check("進むと同じメッセージを書き換える（進捗フィードバック）", second.method === "updateMessage" && second.ts === first.ts && second.text!.includes("2 件"), second.text);
    check("最後に同じメッセージを回答に書き換える", third.method === "updateMessage" && third.ts === first.ts && third.text!.includes("見つかりませんでした"));
    check("質問者のSlackユーザーIDと質問文が渡る", h.answerCalls[0].user === "U_ASKER" && h.answerCalls[0].question === "クラウド移行の事例は？");
  }

  // 4. チャンネルでのメンション
  {
    const h = harness();
    await h.send({ type: "event_callback", event_id: "Ev2", event: { type: "app_mention", user: "U_ASKER", channel: "C_GENERAL", ts: "200.1", text: "<@U0BOT> 小売の販促事例は？" } });
    await h.runTasks();
    const inChannel = h.calls.filter((c) => c.channel === "C_GENERAL");
    check("メンション：チャンネルには本人にだけ見える案内しか出さない", inChannel.length === 1 && inChannel[0].method === "postEphemeral" && inChannel[0].user === "U_ASKER", inChannel.map((c) => c.method).join(", "));
    const inDm = h.calls.filter((c) => c.channel === "D-U_ASKER" && c.method !== "openDm");
    check("メンション：回答はDMに送る", inDm.length === 3 && inDm[0].method === "postMessage" && inDm[2].method === "updateMessage", inDm.map((c) => c.method).join(", "));
    check("メンション：質問文からメンションを取り除く", h.answerCalls[0].question === "小売の販促事例は？", h.answerCalls[0].question);
    check("メンション：DM側の回答に質問文を添える", inDm[2].text!.includes("小売の販促事例は？"));
  }

  // 5. 重複
  {
    const h = harness();
    await h.send(dm({}, "EvDup"));
    const second = await h.send(dm({}, "EvDup"));
    check("同じイベントIDの2回目は処理しない（Slackの再送）", second.json.ignored === "duplicate" && h.tasks.length === 1);
  }

  // 6. 無視するイベント
  {
    const h = harness();
    const ignored = [
      ["ボット自身の投稿", dm({ bot_id: "B1" }, "EvA")],
      ["メッセージの編集通知", dm({ subtype: "message_changed" }, "EvB")],
      ["メンションのないチャンネルの発言", dm({ channel_type: "channel", channel: "C_GENERAL" }, "EvC")],
      ["発言として届いたスラッシュコマンド（/invite @knowledge）", { type: "event_callback", event_id: "EvD", event: { type: "app_mention", user: "U_ASKER", channel: "C_GENERAL", ts: "400.1", text: "/invite <@U0BOT>" } }],
    ] as const;
    for (const [name, payload] of ignored) {
      const { json } = await h.send(payload);
      check(`無視する：${name}`, json.ignored === "not a question" && h.tasks.length === 0);
    }
  }

  // 7. スレッド内の追加質問
  {
    const thread = [
      { ts: "100.1", text: "クラウド移行の事例は？", fromBot: false },
      { ts: "100.2", text: "小売業Cの移行事例があります。", fromBot: true },
      { ts: "100.3", text: "その費用は？", fromBot: false },
    ];
    const h = harness({ thread });
    await h.send(dm({ ts: "100.3", thread_ts: "100.1", text: "その費用は？" }, "Ev7"));
    await h.runTasks();
    const history = h.answerCalls[0].history as { role: string; text: string }[];
    check("追加質問：それまでのやりとりを文脈として渡す（今回の質問は含めない）", history.length === 2 && history[0].role === "user" && history[1].role === "assistant", JSON.stringify(history));
    check("追加質問：同じスレッドに返信する", h.calls.find((c) => c.method === "postMessage")!.threadTs === "100.1");
  }

  // 8. 質問文が空
  {
    const h = harness();
    await h.send({ type: "event_callback", event_id: "Ev8", event: { type: "app_mention", user: "U_ASKER", channel: "C_GENERAL", ts: "300.1", text: "<@U0BOT>" } });
    await h.runTasks();
    check("メンションだけで質問がなければ、使い方を案内する", h.calls.some((c) => c.text === USAGE_MESSAGE.text) && h.answerCalls.length === 0);
  }

  // 9. 回答の作成に失敗
  {
    const h = harness({ answer: async () => { throw new Error("テスト用の失敗"); } });
    await h.send(dm({}, "Ev9"));
    await h.runTasks();
    check("回答に失敗したら「考え中…」をエラーの案内に書き換える", h.calls[h.calls.length - 1].text === ERROR_MESSAGE.text);
  }

  // 10. 本番のSupabaseでの重複排除
  {
    const eventId = `EvTEST-${Date.now()}`;
    const deps = defaultDeps(() => {});
    const first = await deps.claimEvent(eventId);
    const second = await deps.claimEvent(eventId);
    await createAdminClient().from("slack_events").delete().eq("event_id", eventId);
    check("本番のDB：同じイベントIDは1回目だけ受け付ける", first === true && second === false, `1回目 ${first} / 2回目 ${second}`);
  }

  // 11. 追加質問が実際に文脈を踏まえて答えられるか（Claudeを呼ぶ）
  {
    const strategy = TEST_USERS.find((u) => u.key === "strategy")!.slackUserId;
    const first = await answerQuestion(strategy, "地方銀行向けのDX提案はありますか？");
    const firstText = first.status === "answered" ? first.answer.overview : "";
    const followUp = await answerQuestion(strategy, "その初期投資の回収期間は？", {
      history: [{ role: "user", text: "地方銀行向けのDX提案はありますか？" }, { role: "assistant", text: firstText }],
    });
    const text = followUp.status === "answered" ? `${followUp.answer.overview} ${followUp.answer.documents.map((d) => d.summary).join(" ")}` : followUp.status;
    check("追加質問「その初期投資の回収期間は？」に、前の質問の文書から答える", followUp.status === "answered" && text.includes("2.5年"), text.slice(0, 90));
  }

  console.log(failed === 0 ? "\nすべて合格" : `\n${failed} 件不合格`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
