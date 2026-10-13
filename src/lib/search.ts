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
 * 部署別の絞り込みはDB側（検索関数のwhere句とRLS）で行われるので、ここでは部署を扱わない。
 * 検索関数が返すのはチャンクなので、文書単位にまとめ直して上位5文書にする。
 */
export async function searchDocuments(userClient: SupabaseClient, question: string): Promise<DocumentHit[]> {
  // 取り込み時と同じ正規化をかける（PDF由来の文字の揺れを質問側でも揃える）
  const [queryEmbedding] = await embedTexts([normalizeText(question)]);

  const { data, error } = await userClient.rpc("match_document_chunks", {
    query_embedding: queryEmbedding,
    match_count: CHUNK_CANDIDATES,
  });
  if (error) throw new Error(`検索に失敗しました: ${error.message}`);

  const byDocument = new Map<string, DocumentHit>();
  for (const hit of data as ChunkHit[]) {
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
  return [...byDocument.values()].slice(0, TOP_DOCUMENTS);
}
