import { generateAnswer, type Answer } from "./answer";
import { searchDocuments, type SearchAudit } from "./search";
import { createAdminClient } from "./supabase-admin";
import { createUserClient } from "./supabase-user";

export type PipelineResult =
  | { status: "answered"; answer: Extract<Answer, { found: true }>; latencyMs: number }
  | { status: "no_match"; latencyMs: number }
  /** SlackユーザーIDが未登録、または所属部署が1つも無い */
  | { status: "unregistered"; latencyMs: number };

export type ConversationTurn = { role: "user" | "assistant"; text: string };

export type AnswerOptions = {
  /** スレッド内の追加質問のとき、それまでのやりとり（古い順） */
  history?: ConversationTurn[];
  /** 進み具合の通知。Slackの「考え中…」の表示を更新するために使う */
  onProgress?: (stage: "searching" | "summarizing", detail: { documentCount: number }) => Promise<void>;
  /** どこからの質問か（監査ログに残す）。既定は slack */
  channel?: SearchAudit["channel"];
};

/**
 * 検索を行わなかった質問（未登録のユーザー）の監査ログ。
 * 検索した質問のログは、検索と同じトランザクションでDB側が書く（search_documents_logged）。
 * ここで書けなかった場合は例外にして、記録の無い応答を返さない。
 */
async function logWithoutSearch(entry: { userId: string | null; slackUserId: string; question: string; channel: string; latencyMs: number }) {
  const { error } = await createAdminClient().from("search_logs").insert({
    user_id: entry.userId,
    slack_user_id: entry.slackUserId,
    question: entry.question,
    status: "unregistered",
    channel: entry.channel,
    latency_ms: entry.latencyMs,
  });
  if (error) throw new Error(`監査ログの保存に失敗: ${error.message}`);
}

/**
 * 検索時に書かれた監査ログに、回答の結果（回答に挙げた文書・結果・かかった時間）を追記する。
 * 「誰が・いつ・何を質問し・どの文書が取り出されたか」は検索の時点で記録済みなので、
 * 追記に失敗しても回答は返す（失敗はサーバーのログに残す）
 */
async function finishLog(logId: string, result: { status: "answered" | "no_match" | "error"; documentIds: string[]; latencyMs: number }) {
  const { error } = await createAdminClient()
    .from("search_logs")
    .update({ status: result.status, result_document_ids: result.documentIds, latency_ms: result.latencyMs })
    .eq("id", logId);
  if (error) console.error(`監査ログへの追記に失敗（${logId}）: ${error.message}`);
}

/**
 * Slackの発言者の質問に答える。Slack連携（イベント受信）からも確認スクリプトからも、この関数を呼ぶ。
 *
 * 1. SlackユーザーIDをDBのユーザーに引き当て、所属部署を確認する（未登録なら検索しない）
 * 2. 質問者本人のクライアントで検索する（部署別のRLSが効く）。検索と同時に監査ログが書かれる
 * 3. Claudeで出典つきの要約を作る
 * 4. 監査ログに回答の結果を追記する
 */
export async function answerQuestion(slackUserId: string, question: string, options: AnswerOptions = {}): Promise<PipelineResult> {
  const startedAt = Date.now();
  const admin = createAdminClient();
  const elapsed = () => Date.now() - startedAt;
  const history = options.history ?? [];
  const channel = options.channel ?? "slack";

  const { data: mapping, error: mappingError } = await admin.from("slack_users").select("user_id").eq("slack_user_id", slackUserId).maybeSingle();
  if (mappingError) throw new Error(`ユーザーの確認に失敗: ${mappingError.message}`);
  if (!mapping) {
    await logWithoutSearch({ userId: null, slackUserId, question, channel, latencyMs: elapsed() });
    return { status: "unregistered", latencyMs: elapsed() };
  }
  const userId = mapping.user_id as string;

  const { count: departmentCount, error: departmentError } = await admin
    .from("user_departments")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);
  if (departmentError) throw new Error(`所属部署の確認に失敗: ${departmentError.message}`);
  if (!departmentCount) {
    await logWithoutSearch({ userId, slackUserId, question, channel, latencyMs: elapsed() });
    return { status: "unregistered", latencyMs: elapsed() };
  }

  await options.onProgress?.("searching", { documentCount: 0 });
  const userClient = await createUserClient(userId);
  // 追加質問は「それの費用は？」のように主語が省かれるので、直前の質問と合わせて検索する
  const previousQuestion = [...history].reverse().find((turn) => turn.role === "user")?.text;
  const searchQuery = previousQuestion ? `${previousQuestion}\n${question}` : question;
  const { logId, documents } = await searchDocuments(userClient, searchQuery, { question, slackUserId, channel });

  try {
    if (documents.length > 0) await options.onProgress?.("summarizing", { documentCount: documents.length });
    const answer = await generateAnswer(question, documents, history);

    if (!answer.found) {
      await finishLog(logId, { status: "no_match", documentIds: [], latencyMs: elapsed() });
      return { status: "no_match", latencyMs: elapsed() };
    }
    await finishLog(logId, { status: "answered", documentIds: answer.documents.map((d) => d.documentId), latencyMs: elapsed() });
    return { status: "answered", answer, latencyMs: elapsed() };
  } catch (err) {
    await finishLog(logId, { status: "error", documentIds: [], latencyMs: elapsed() });
    throw err;
  }
}

/** 回答を文字にする（確認スクリプト用。Slack向けの整形は slack-format.ts） */
export function formatResult(result: PipelineResult): string {
  if (result.status === "unregistered") return "所属部署が登録されていないため、検索できません。管理者に登録を依頼してください。";
  if (result.status === "no_match") return "該当する文書は見つかりませんでした。";
  const lines = [result.answer.overview, ""];
  result.answer.documents.forEach((doc, i) => {
    const attrs = [doc.department, doc.client, doc.docYear ? `${doc.docYear}年` : null].filter(Boolean).join("・");
    lines.push(`${i + 1}. ${doc.title}（${attrs}）`);
    lines.push(`   ${doc.summary}`);
    lines.push(`   出典: ${doc.filename} ／ ${doc.citations.map((c) => [c.sectionTitle ?? "前書き", c.pages].filter(Boolean).join(" ")).join(" ／ ")}`);
    if (doc.sourceUrl) lines.push(`   原本: ${doc.sourceUrl}`);
  });
  return lines.join("\n");
}
