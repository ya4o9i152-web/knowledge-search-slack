import { buildChunks, type Chunk } from "./chunking";
import { parseMetadata, type DocumentMetadata } from "./document-metadata";
import { embedTexts } from "./embeddings";
import { detectFileType, extractLines, type FileType } from "./extract";
import { createAdminClient } from "./supabase-admin";
import { findUnmappedRadicals } from "./text-normalize";

export type PreparedDocument = {
  filename: string;
  fileType: FileType;
  metadata: DocumentMetadata;
  chunks: Chunk[];
  pageCount: number | null;
  warnings: string[];
};

export type IngestResult =
  | { status: "completed"; chunkCount: number; department: string; warnings: string[] }
  | { status: "skipped"; chunkCount: number; department: string; warnings: string[] };

const CHUNK_INSERT_BATCH = 50;

/**
 * 抽出 → メタデータ読み取り → チャンキングまで。外部APIもDBも使わないので、
 * ドライランやテスト、取り込み済みかどうかの判定（チャンク数の照合）にも使う。
 */
export async function prepareDocument(buffer: Buffer, filename: string): Promise<PreparedDocument> {
  const fileType = detectFileType(filename);
  if (!fileType) throw new Error("対応していない形式です（PDF・Wordのみ）");

  const { lines, pageCount } = await extractLines(buffer, fileType);
  if (lines.length === 0) {
    throw new Error("テキストを抽出できませんでした（スキャンPDFの可能性があります）");
  }
  const { metadata, bodyLines } = parseMetadata(lines);
  const chunks = buildChunks(bodyLines, metadata);
  if (chunks.length === 0) throw new Error("本文がありません");

  const warnings: string[] = [];
  const radicals = findUnmappedRadicals(chunks.map((c) => c.content).join(""));
  if (radicals.length > 0) warnings.push(`通常の漢字に戻せなかった文字があります: ${radicals.join(" ")}`);
  if (chunks.every((c) => c.sectionTitle === null)) warnings.push("見出しを検出できず、ページ単位で分割しました");

  return { filename, fileType, metadata, chunks, pageCount, warnings };
}

async function existingChunkCount(sourcePath: string): Promise<{ documentId: string; chunkCount: number } | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("documents").select("id").eq("source_path", sourcePath).maybeSingle();
  if (error) throw new Error(`取り込み済みの確認に失敗: ${error.message}`);
  if (!data) return null;
  const { count, error: countError } = await admin
    .from("document_chunks")
    .select("*", { count: "exact", head: true })
    .eq("document_id", data.id);
  if (countError) throw new Error(`チャンク数の確認に失敗: ${countError.message}`);
  return { documentId: data.id as string, chunkCount: count ?? 0 };
}

/**
 * 1文書を取り込む。何度実行しても結果が同じになるように作ってある。
 *
 * ・source_path が同じ文書がすでにあり、チャンク数も一致していれば何もしない（skipped）
 * ・文書はあるがチャンク数が合わない（前回の実行が途中で止まった）場合は、消して入れ直す
 * ・保存後にチャンク数を数え直し、合わなければ文書ごと消してエラーにする
 *   → 「文書はあるのにチャンクが欠けている」状態を残さない
 */
export async function ingestPrepared(
  prepared: PreparedDocument,
  source: { sourcePath: string; sourceUrl?: string | null },
): Promise<IngestResult> {
  const admin = createAdminClient();
  const { metadata, chunks } = prepared;
  const base = { chunkCount: chunks.length, department: metadata.department, warnings: prepared.warnings };

  const existing = await existingChunkCount(source.sourcePath);
  if (existing) {
    if (existing.chunkCount === chunks.length) return { status: "skipped", ...base };
    const { error } = await admin.from("documents").delete().eq("id", existing.documentId);
    if (error) throw new Error(`不完全な文書の削除に失敗: ${error.message}`);
  }

  // DBに書く前にEmbeddingを済ませる。ここで失敗してもDBには何も残らない
  const embeddings = await embedTexts(chunks.map((c) => c.embeddingText));

  const { data: doc, error: docError } = await admin
    .from("documents")
    .insert({
      filename: prepared.filename,
      title: metadata.title,
      department: metadata.department,
      client: metadata.client,
      doc_year: metadata.docYear,
      confidentiality: metadata.confidentiality,
      file_type: prepared.fileType,
      source_path: source.sourcePath,
      source_url: source.sourceUrl ?? null,
    })
    .select("id")
    .single();
  if (docError) throw new Error(`文書の保存に失敗: ${docError.message}`);

  try {
    for (let i = 0; i < chunks.length; i += CHUNK_INSERT_BATCH) {
      const rows = chunks.slice(i, i + CHUNK_INSERT_BATCH).map((chunk, j) => ({
        document_id: doc.id,
        department: metadata.department,
        chunk_index: chunk.chunkIndex,
        section_title: chunk.sectionTitle,
        page_start: chunk.pageStart,
        page_end: chunk.pageEnd,
        content: chunk.content,
        embedding: embeddings[i + j],
      }));
      const { error } = await admin.from("document_chunks").insert(rows);
      if (error) throw new Error(`チャンクの保存に失敗: ${error.message}`);
    }
    const saved = await existingChunkCount(source.sourcePath);
    if (!saved || saved.chunkCount !== chunks.length) {
      throw new Error(`保存後のチャンク数が合いません（期待 ${chunks.length} / 実際 ${saved?.chunkCount ?? 0}）`);
    }
  } catch (err) {
    await admin.from("documents").delete().eq("id", doc.id);
    throw err;
  }

  return { status: "completed", ...base };
}
