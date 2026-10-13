import type { SupabaseClient } from "@supabase/supabase-js";
import { embedTexts } from "./embeddings";
import { normalizeText } from "./text-normalize";

export type ChunkHit = {
  chunk_id: string;
  document_id: string;
  title: string;
  filename: string;
  department: string;
  client: string | null;
  doc_year: number | null;
  source_url: string | null;
  section_title: string | null;
  page_start: number | null;
  page_end: number | null;
  content: string;
  similarity: number;
};

export type DocumentHit = {
  documentId: string;
  title: string;
  filename: string;
  department: string;
  client: string | null;
  docYear: number | null;
  sourceUrl: string | null;
  /** その文書の中で最も類似度が高かったチャンクの値 */
  similarity: number;
  /** 類似度の高い順 */
  chunks: ChunkHit[];
};

const CHUNK_CANDIDATES = 20;
export const TOP_DOCUMENTS = 5;

/**
 * 質問に関連する文書を上位5件まで返す。
 *
 * userClient には必ず createUserClient（質問者本人のクライアント）を渡す。
 * サービスロールのクライアントを渡すと、所属部署が引けないので常に0件になる（閲覧制限は破れない）。
 * 部署別の絞り込みはDB側（検索関数のwhere句とRLS）で行われるので、ここでは部署を扱わない。
 * 検索関数が返すのはチャンクなので、文書単位にまとめ直して上位5文書にする。
 */
export type SearchAudit = {
  /** 監査ログに残す質問文（追加質問のときも、検索用に前の質問を足す前の、利用者が入力した文そのもの） */
  question: string;
  slackUserId: string;
  /** どこからの質問か */
  channel: "slack" | "cli";
};

export type SearchResult = {
  /** この検索の監査ログ（search_logs）のID。回答が終わったら、結果をこの行に追記する */
  logId: string;
  documents: DocumentHit[];
};

export async function searchDocuments(userClient: SupabaseClient, searchQuery: string, audit: SearchAudit): Promise<SearchResult> {
  // 取り込み時と同じ正規化をかける（PDF由来の文字の揺れを質問側でも揃える）
  const [queryEmbedding] = await embedTexts([normalizeText(searchQuery)]);

  // 検索と監査ログの記録を、1回の呼び出し（1つのトランザクション）で行う。
  // ログを書けなければ検索結果も返らないので、「記録の無い検索」は起きない
  const { data, error } = await userClient.rpc("search_documents_logged", {
    query_embedding: queryEmbedding,
    p_question: audit.question,
    p_slack_user_id: audit.slackUserId,
    p_channel: audit.channel,
    match_count: CHUNK_CANDIDATES,
  });
  if (error) throw new Error(`検索に失敗しました: ${error.message}`);

  const rows = data as (ChunkHit & { log_id: string; chunk_id: string | null })[];
  const logId = rows[0]?.log_id;
  if (!logId) throw new Error("検索の監査ログを記録できませんでした");

  const byDocument = new Map<string, DocumentHit>();
  for (const hit of rows) {
    // 0件のときは、ログのIDだけが入った行が1行返る
    if (hit.chunk_id === null) continue;
    const existing = byDocument.get(hit.document_id);
    if (existing) {
      existing.chunks.push(hit);
    } else {
      byDocument.set(hit.document_id, {
        documentId: hit.document_id,
        title: hit.title,
        filename: hit.filename,
        department: hit.department,
        client: hit.client,
        docYear: hit.doc_year,
        sourceUrl: hit.source_url,
        similarity: hit.similarity,
        chunks: [hit],
      });
    }
  }
  // 検索関数は類似度順に返すので、Mapへの挿入順がそのまま文書の順位になる
  return { logId, documents: [...byDocument.values()].slice(0, TOP_DOCUMENTS) };
}
