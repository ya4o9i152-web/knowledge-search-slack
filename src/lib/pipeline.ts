import { generateAnswer, type Answer } from "./answer";
import { searchDocuments, type DocumentHit } from "./search";
import { createAdminClient } from "./supabase-admin";
import { createUserClient } from "./supabase-user";

export type PipelineResult =
  | { status: "answered"; answer: Extract<Answer, { found: true }>; latencyMs: number }
  | { status: "no_match"; latencyMs: number }
  /** SlackユーザーIDが未登録、または所属部署が1つも無い */
  | { status: "unregistered"; latencyMs: number };

async function writeLog(entry: {
  userId: string | null;
  slackUserId: string;
  question: string;
  departments: string[];
  documentIds: string[];
  status: "answered" | "no_match" | "unregistered" | "error";
  latencyMs: number;
}) {
  // ログの失敗で回答を止めない
  const { error } = await createAdminClient().from("search_logs").insert({
    user_id: entry.userId,
    slack_user_id: entry.slackUserId,
    question: entry.question,
    departments: entry.departments,
    result_document_ids: entry.documentIds,
    status: entry.status,
    latency_ms: entry.latencyMs,
  });
  if (error) console.error(`検索ログの保存に失敗: ${error.message}`);
}

/**
 * Slackの発言者の質問に答える。Slack連携（イベント受信）からも確認スクリプトからも、この関数を呼ぶ。
 *
 * 1. SlackユーザーIDをDBのユーザーに引き当て、所属部署を確認する（未登録なら検索しない）
 * 2. 質問者本人のクライアントで検索する（部署別のRLSが効く）
 * 3. Claudeで出典つきの要約を作る
 * 4. 誰が・何を検索し・どの文書が返ったかを記録する
 */
export type ConversationTurn = { role: "user" | "assistant"; text: string };

export type AnswerOptions = {
  /** スレッド内の追加質問のとき、それまでのやりとり（古い順） */
  history?: ConversationTurn[];
  /** 進み具合の通知。Slackの「考え中…」の表示を更新するために使う */
  onProgress?: (stage: "searching" | "summarizing", detail: { documentCount: number }) => Promise<void>;
};

export async function answerQuestion(slackUserId: string, question: string, options: AnswerOptions = {}): Promise<PipelineResult> {
  const history = options.history ?? [];
  const startedAt = Date.now();
  const admin = createAdminClient();
  const elapsed = () => Date.now() - startedAt;
  const log = { slackUserId, question, userId: null as string | null, departments: [] as string[], documentIds: [] as string[] };

  try {
    const { data: mapping, error: mappingError } = await admin.from("slack_users").select("user_id").eq("slack_user_id", slackUserId).maybeSingle();
    if (mappingError) throw new Error(`ユーザーの確認に失敗: ${mappingError.message}`);
    if (!mapping) {
      await writeLog({ ...log, status: "unregistered", latencyMs: elapsed() });
      return { status: "unregistered", latencyMs: elapsed() };
    }
    log.userId = mapping.user_id as string;

    const { data: departments, error: departmentError } = await admin.from("user_departments").select("department").eq("user_id", log.userId);
    if (departmentError) throw new Error(`所属部署の確認に失敗: ${departmentError.message}`);
    log.departments = departments.map((d) => d.department as string);
    if (log.departments.length === 0) {
      await writeLog({ ...log, status: "unregistered", latencyMs: elapsed() });
      return { status: "unregistered", latencyMs: elapsed() };
    }

    await options.onProgress?.("searching", { documentCount: 0 });
    const userClient = await createUserClient(log.userId);
    // 追加質問は「それの費用は？」のように主語が省かれるので、直前の質問と合わせて検索する
    const previousQuestion = [...history].reverse().find((turn) => turn.role === "user")?.text;
    const searchQuery = previousQuestion ? `${previousQuestion}\n${question}` : question;
    const documents: DocumentHit[] = await searchDocuments(userClient, searchQuery);
    if (documents.length > 0) await options.onProgress?.("summarizing", { documentCount: documents.length });
    const answer = await generateAnswer(question, documents, history);

    if (!answer.found) {
      await writeLog({ ...log, status: "no_match", latencyMs: elapsed() });
      return { status: "no_match", latencyMs: elapsed() };
    }
    log.documentIds = answer.documents.map((d) => d.documentId);
    await writeLog({ ...log, status: "answered", latencyMs: elapsed() });
    return { status: "answered", answer, latencyMs: elapsed() };
  } catch (err) {
    await writeLog({ ...log, status: "error", latencyMs: elapsed() });
    throw err;
  }
}

/** 回答を文字にする（確認スクリプト用。Slack向けの整形はSlack連携で行う） */
export function formatResult(result: PipelineResult): string {
  if (result.status === "unregistered") return "所属部署が登録されていないため、検索できません。管理者に登録を依頼してください。";
  if (result.status === "no_match") return "該当する文書は見つかりませんでした。";
  const lines = [result.answer.overview, ""];
  result.answer.documents.forEach((doc, i) => {
    const attrs = [doc.department, doc.client, doc.docYear ? `${doc.docYear}年` : null].filter(Boolean).join("・");
    lines.push(`${i + 1}. ${doc.title}（${attrs}）`);
    lines.push(`   ${doc.summary}`);
    lines.push(`   出典: ${doc.citations.map((c) => [c.sectionTitle ?? "前書き", c.pages].filter(Boolean).join(" ")).join(" ／ ")}`);
    if (doc.sourceUrl) lines.push(`   原本: ${doc.sourceUrl}`);
  });
  return lines.join("\n");
}
