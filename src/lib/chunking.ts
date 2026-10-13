import { getEncoding } from "js-tiktoken";
import type { DocumentMetadata } from "./document-metadata";
import type { Line } from "./extract";

// OpenAIのEmbeddingモデルが使うトークナイザ。チャンクの大きさを測るために使う
const enc = getEncoding("cl100k_base");

export function countTokens(text: string): number {
  return enc.encode(text).length;
}

function takeLastTokens(text: string, maxTokens: number): string {
  const tokens = enc.encode(text);
  if (tokens.length <= maxTokens) return text;
  return enc.decode(tokens.slice(tokens.length - maxTokens));
}

// スコープ.md「チャンキング戦略」の値。長い文書での妥当性は未検証の初期値
export const CHUNK_MAX_TOKENS = 1000;
export const CHUNK_SPLIT_MIN_TOKENS = 600;
export const CHUNK_OVERLAP_TOKENS = 100;
export const SECTION_MIN_TOKENS = 30;

// 「1. 案件概要」「2.1 実施頻度」「第2章 休日・休暇」のような見出し行（PDF用。Wordは見出しスタイルで判定する）
const SECTION_HEADER_RE = /^(第[0-9〇一二三四五六七八九十百]+[章節][\s　].{0,40}|\d+(?:\.\d+)*[.．]?[\s　]+\S.{0,40})$/;

function isSectionHeader(line: Line): boolean {
  if (line.heading !== null) return line.heading;
  const text = line.text.trim();
  if (text.length === 0 || text.length > 50) return false;
  if (/[。、]$/.test(text)) return false; // 句読点で終わる行は本文とみなす
  return SECTION_HEADER_RE.test(text);
}

type Section = { title: string | null; lines: Line[] };

export type Chunk = {
  chunkIndex: number;
  sectionTitle: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  /** 保存・出典表示・Claudeに渡す本文（文脈の接頭辞は付けない） */
  content: string;
  /** Embeddingに渡す文字列（文書タイトルなどの文脈を先頭に付けたもの） */
  embeddingText: string;
  tokens: number;
};

function splitIntoSections(lines: Line[]): Section[] {
  const sections: Section[] = [];
  let current: Section = { title: null, lines: [] };
  for (const line of lines) {
    if (isSectionHeader(line)) {
      if (current.title !== null || current.lines.length > 0) sections.push(current);
      current = { title: line.text.trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.title !== null || current.lines.length > 0) sections.push(current);
  return sections;
}

/** 見出しが1つも無い文書は、ページ単位のセクションに切り替える（案件3と同じ方式） */
function splitByPage(lines: Line[]): Section[] {
  const byPage = new Map<number | null, Line[]>();
  for (const line of lines) {
    const list = byPage.get(line.page) ?? [];
    list.push(line);
    byPage.set(line.page, list);
  }
  return [...byPage.values()].map((pageLines) => ({ title: null, lines: pageLines }));
}

const sectionText = (section: Section) => section.lines.map((l) => l.text).join("\n");

/** 本文が短すぎるセクション（見出しだけ等）を、次のセクションに結合する。最後のセクションは前に結合する */
function mergeShortSections(sections: Section[]): Section[] {
  const merged: Section[] = [];
  let pending: Section | null = null;
  for (const section of sections) {
    let current = section;
    if (pending) {
      const carried: Line[] = pending.title
        ? [{ text: pending.title, page: pending.lines[0]?.page ?? section.lines[0]?.page ?? null, heading: null }, ...pending.lines]
        : pending.lines;
      const heading: Line[] = section.title
        ? [{ text: section.title, page: section.lines[0]?.page ?? null, heading: null }]
        : [];
      current = { title: pending.title ?? section.title, lines: [...carried, ...heading, ...section.lines] };
      pending = null;
    }
    if (countTokens(sectionText(current)) < SECTION_MIN_TOKENS) {
      pending = current;
    } else {
      merged.push(current);
    }
  }
  if (pending) {
    const last = merged.pop();
    if (last) {
      const heading: Line[] = pending.title ? [{ text: pending.title, page: pending.lines[0]?.page ?? null, heading: null }] : [];
      merged.push({ title: last.title, lines: [...last.lines, ...heading, ...pending.lines] });
    } else if (sectionText(pending).trim().length > 0 || pending.title) {
      merged.push(pending);
    }
  }
  return merged;
}

/** 1行が上限を超える場合は、文（句点）単位に割る */
function splitOversizedLine(line: Line): Line[] {
  if (countTokens(line.text) <= CHUNK_MAX_TOKENS) return [line];
  const sentences = line.text.split(/(?<=。)/).map((s) => s.trim()).filter(Boolean);
  return (sentences.length > 1 ? sentences : [line.text]).map((text) => ({ ...line, text }));
}

type Piece = { lines: Line[]; overlap: string };

/** 上限を超えるセクションを、段落（行）の境界で600〜1,000トークンに再分割する。前後を100トークン重ねる */
function splitSection(section: Section): Piece[] {
  if (countTokens(sectionText(section)) <= CHUNK_MAX_TOKENS) return [{ lines: section.lines, overlap: "" }];

  const pieces: Piece[] = [];
  let buffer: Line[] = [];
  let bufferTokens = 0;
  let overlap = "";
  const flush = () => {
    if (buffer.length === 0) return;
    pieces.push({ lines: buffer, overlap });
    overlap = takeLastTokens(buffer.map((l) => l.text).join("\n"), CHUNK_OVERLAP_TOKENS);
    buffer = [];
    bufferTokens = 0;
  };
  for (const line of section.lines.flatMap(splitOversizedLine)) {
    const tokens = countTokens(line.text);
    const overlapTokens = overlap ? CHUNK_OVERLAP_TOKENS : 0;
    if (buffer.length > 0 && bufferTokens + tokens + overlapTokens > CHUNK_MAX_TOKENS) flush();
    buffer.push(line);
    bufferTokens += tokens;
  }
  // 末尾の端数が小さければ、切らずに直前の塊へ足す（上限を少し超えるのは許容する）
  if (pieces.length > 0 && bufferTokens < CHUNK_SPLIT_MIN_TOKENS / 3) {
    pieces[pieces.length - 1].lines.push(...buffer);
  } else {
    flush();
  }
  return pieces;
}

function pageRange(lines: Line[]): { pageStart: number | null; pageEnd: number | null } {
  const pages = lines.map((l) => l.page).filter((p): p is number => p !== null);
  if (pages.length === 0) return { pageStart: null, pageEnd: null };
  return { pageStart: Math.min(...pages), pageEnd: Math.max(...pages) };
}

/** Embeddingに渡す文字列の先頭に付ける文脈。短いチャンクでも「どの文書のどの章か」が失われないようにする */
function contextPrefix(metadata: DocumentMetadata, sectionTitle: string | null): string {
  const attrs = [
    `部署: ${metadata.department}`,
    metadata.client ? `客先: ${metadata.client}` : null,
    metadata.docYear ? `作成: ${metadata.docYear}年` : null,
  ].filter(Boolean);
  return [`文書: ${metadata.title}（${attrs.join(" / ")}）`, sectionTitle ? `セクション: ${sectionTitle}` : null]
    .filter(Boolean)
    .join("\n");
}

/**
 * Embedding用に改行を取り除く。
 * PDFは文の途中で折り返されるが、箇条書きの改行と確実には見分けられない（行の位置情報が取れないため）。
 * 保存する本文は行の構造を残し、Embeddingに渡す文字列だけ、日本語どうしの改行は詰め、それ以外は空白にする。
 * これで「窓口業\n務」のように単語が途中で切れたまま検索対象になるのを防ぐ。
 */
function flattenForEmbedding(text: string): string {
  return text.replace(/([^\x00-\x7F])\n(?=[^\x00-\x7F])/g, "$1").replace(/\n/g, " ");
}

export function buildChunks(bodyLines: Line[], metadata: DocumentMetadata): Chunk[] {
  let sections = splitIntoSections(bodyLines);
  const hasHeading = sections.some((s) => s.title !== null);
  if (!hasHeading) sections = splitByPage(bodyLines);
  sections = mergeShortSections(sections);

  const chunks: Chunk[] = [];
  for (const section of sections) {
    for (const piece of splitSection(section)) {
      const body = piece.lines.map((l) => l.text).join("\n").trim();
      if (!body) continue;
      const content = piece.overlap ? `${piece.overlap}\n${body}` : body;
      chunks.push({
        chunkIndex: chunks.length,
        sectionTitle: section.title,
        ...pageRange(piece.lines),
        content,
        embeddingText: `${contextPrefix(metadata, section.title)}\n\n${flattenForEmbedding(content)}`,
        tokens: countTokens(content),
      });
    }
  }
  return chunks;
}
