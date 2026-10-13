import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { ChunkHit, DocumentHit } from "./search";

const DEFAULT_MODEL = "claude-opus-5-5";

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!cachedClient) cachedClient = new Anthropic();
  return cachedClient;
}

/**
 * Claudeに返してもらう形。文書名・ページ・リンクなどの出典は返させず、
 * 「何番の文書の、何番の箇所を根拠にしたか」だけを番号で受け取る。
 * 出典の表示はDBの値からこちらで組み立てるので、存在しない文書名やページが回答に混ざらない。
 */
const AnswerSchema = z.object({
  found: z.boolean().describe("質問に答えられる文書が1件でもあれば true。どの文書も質問の内容を扱っていなければ false"),
  overview: z.string().describe("質問への端的な答え（1〜2文）。found が false のときは空文字"),
  documents: z
    .array(
      z.object({
        document_number: z.number().int().describe("根拠にした文書の番号（<document number=\"…\"> の値）"),
        summary: z.string().describe("その文書に書かれている、質問に関係する内容の要約（2〜3文）。数値は文書の表記のまま書く"),
        excerpt_numbers: z.array(z.number().int()).describe("要約の根拠にした箇所の番号（<excerpt number=\"…\"> の値）"),
      }),
    )
    .describe("質問に関係する文書だけを、関係の深い順に並べる。関係のない文書は含めない"),
});

const SYSTEM_PROMPT = `あなたはコンサルティング会社の社内ナレッジ検索アシスタントです。
社員の質問に対して、検索で見つかった過去の提案書・報告書の抜粋をもとに、関連する文書とその要点を答えます。

答え方
- 渡された抜粋に書かれていることだけを根拠にします。抜粋にない事実・数値・固有名詞は書きません。社員はこの要約をもとに原本を確認し、顧客への提案に使うため、推測が混ざると誤った提案につながります。
- 検索は「意味が近い順」に抜粋を拾ってくるだけなので、質問と関係のない文書が混ざっていることがあります。質問の主題（業界・テーマ・対象）を実際に扱っている文書だけを選び、関係のない文書は documents に含めません。
- 質問の主題を扱っている文書が1件もなければ、found を false にします。近い話題の文書があっても、質問そのものに答えていなければ false です。たとえば医療業界の提案書を探している質問に、小売業の提案書しかなければ false です。
- 要約は、質問に関係する内容に絞って2〜3文で書きます。金額・割合・期間などの数値は、文書の表記のまま書きます。
- 複数の文書を挙げるよう求められた質問では、該当する文書をすべて挙げます。
- <conversation> がある場合、それは同じスレッドでのこれまでのやりとりです。<question> は続きの質問なので、「それ」「その案件」などが何を指すかは会話から読み取ります。根拠にできるのは、今回渡された <documents> の抜粋だけです。
- 丁寧語（です・ます）で書きます。`;

function pageLabel(chunk: Pick<ChunkHit, "page_start" | "page_end">): string {
  if (chunk.page_start === null) return "";
  return chunk.page_end !== null && chunk.page_end !== chunk.page_start ? `p.${chunk.page_start}-${chunk.page_end}` : `p.${chunk.page_start}`;
}

export type HistoryTurn = { role: "user" | "assistant"; text: string };

function buildUserMessage(question: string, documents: DocumentHit[], history: HistoryTurn[]): string {
  const blocks = documents.map((doc, i) => {
    const attrs = [`部署: ${doc.department}`, doc.client ? `客先: ${doc.client}` : null, doc.docYear ? `作成: ${doc.docYear}年` : null].filter(Boolean).join(" / ");
    const excerpts = doc.chunks
      .map((chunk, j) => `<excerpt number="${j + 1}" section="${chunk.section_title ?? "（見出しなし）"}" pages="${pageLabel(chunk)}">\n${chunk.content}\n</excerpt>`)
      .join("\n");
    return `<document number="${i + 1}" title="${doc.title}" attributes="${attrs}">\n${excerpts}\n</document>`;
  });
  const conversation =
    history.length > 0
      ? `<conversation>\n${history.map((turn) => `<${turn.role === "user" ? "社員" : "アシスタント"}>\n${turn.text}\n</${turn.role === "user" ? "社員" : "アシスタント"}>`).join("\n")}\n</conversation>\n\n`
      : "";
  return `<documents>\n${blocks.join("\n")}\n</documents>\n\n${conversation}<question>\n${question}\n</question>`;
}

export type Citation = { sectionTitle: string | null; pages: string };

export type AnsweredDocument = {
  documentId: string;
  title: string;
  filename: string;
  department: string;
  client: string | null;
  docYear: number | null;
  sourceUrl: string | null;
  summary: string;
  citations: Citation[];
};

export type Answer =
  | { found: true; overview: string; documents: AnsweredDocument[]; model: string }
  | { found: false; model: string | null };

/**
 * 検索で見つかった文書をもとに、出典つきの要約を作る。
 * 検索結果が0件のときはClaudeを呼ばずに「見つかりませんでした」を返す。
 */
export async function generateAnswer(question: string, documents: DocumentHit[], history: HistoryTurn[] = []): Promise<Answer> {
  if (documents.length === 0) return { found: false, model: null };

  const response = await getClient().beta.messages.parse({
    model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
    max_tokens: 16000,
    // 抜粋の取捨選択と短い要約なので、深い推論より応答の速さを優先する（合格基準: 回答まで60秒以内）
    output_config: { effort: "low", format: betaZodOutputFormat(AnswerSchema) },
    // 安全性の判定でモデルが応答を断った場合に、Anthropicが推奨する別モデルで同じ依頼を実行し直す
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(question, documents, history) }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`Claudeが応答を断りました（${response.stop_details?.category ?? "理由不明"}）`);
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new Error(`Claudeの応答を読み取れませんでした（stop_reason: ${response.stop_reason}）`);

  // 番号を実際の文書・箇所に引き当てる。範囲外の番号や重複は捨てる
  const answered: AnsweredDocument[] = [];
  const seen = new Set<number>();
  for (const item of parsed.documents) {
    const doc = documents[item.document_number - 1];
    if (!doc || seen.has(item.document_number)) continue;
    seen.add(item.document_number);
    const cited = item.excerpt_numbers.map((n) => doc.chunks[n - 1]).filter((c): c is ChunkHit => Boolean(c));
    const citations = (cited.length > 0 ? cited : doc.chunks.slice(0, 1)).map((c) => ({ sectionTitle: c.section_title, pages: pageLabel(c) }));
    answered.push({
      documentId: doc.documentId,
      title: doc.title,
      filename: doc.filename,
      department: doc.department,
      client: doc.client,
      docYear: doc.docYear,
      sourceUrl: doc.sourceUrl,
      summary: item.summary,
      // 同じ箇所を2回並べない
      citations: citations.filter((c, i) => citations.findIndex((o) => o.sectionTitle === c.sectionTitle && o.pages === c.pages) === i),
    });
  }

  if (!parsed.found || answered.length === 0) return { found: false, model: response.model };
  return { found: true, overview: parsed.overview, documents: answered, model: response.model };
}
