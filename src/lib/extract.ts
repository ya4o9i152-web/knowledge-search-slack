import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { normalizeText } from "./text-normalize";

export type FileType = "pdf" | "docx";

/** 抽出した1行。チャンキングはこの行の並びを入力にする */
export type Line = {
  text: string;
  /** PDFのページ番号。Wordはページの概念が抽出できないため null */
  page: number | null;
  /** Wordの見出しスタイルによる判定。PDFは判定材料がないため null（見出しは行の形から推定する） */
  heading: boolean | null;
};

export type Extracted = { lines: Line[]; pageCount: number | null };

export function detectFileType(filename: string): FileType | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  return null;
}

/** 全角を2、半角を1として数えた表示幅 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return width;
}

const HEADING_LIKE = /^(第[0-9〇一二三四五六七八九十百]+[章節][\s　]|\d+(?:\.\d+)*[.．]?[\s　]+\S)/;

/**
 * PDFは1つの文が行幅で折り返されて複数行になる（例:「…窓口業」「務のデジタル化…」）。
 * 行幅いっぱいまで埋まっている行は折り返しとみなし、次の行とつなげる。
 * 箇条書きの各項目は行幅より短いことが多いので、別の行のまま残る。
 */
function joinWrappedLines(rawLines: string[]): string[] {
  const maxWidth = Math.max(0, ...rawLines.map(displayWidth));
  const wrapThreshold = maxWidth * 0.92;
  const result: string[] = [];
  let carry = "";
  rawLines.forEach((line, i) => {
    const current = carry + line;
    const next = rawLines[i + 1];
    const isWrapped =
      maxWidth >= 40 &&
      displayWidth(line) >= wrapThreshold &&
      next !== undefined &&
      !line.endsWith("。") && // 文が終わっている行は、幅いっぱいでも折り返しではない
      !HEADING_LIKE.test(line) &&
      !HEADING_LIKE.test(next); // 次が見出しなら、そこで段落が終わっている
    if (isWrapped) {
      carry = current;
    } else {
      result.push(current);
      carry = "";
    }
  });
  if (carry) result.push(carry);
  return result;
}

async function extractPdf(buffer: Buffer): Promise<Extracted> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    const lines: Line[] = [];
    for (const page of result.pages) {
      const rawLines = normalizeText(page.text)
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      for (const text of joinWrappedLines(rawLines)) {
        lines.push({ text, page: page.num, heading: null });
      }
    }
    return { lines, pageCount: result.pages.length };
  } finally {
    await parser.destroy();
  }
}

function decodeHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

async function extractDocx(buffer: Buffer): Promise<Extracted> {
  // HTMLに変換すると、Wordの見出しスタイルが <h1>〜<h6> として残る
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const lines: Line[] = [];
  for (const match of html.matchAll(/<(h[1-6]|p|li)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
    const [, tag, inner] = match;
    if (tag === "li" && /<p[\s>]/.test(inner)) continue; // 中の <p> が別に拾われる
    const text = normalizeText(decodeHtml(inner)).replace(/\s+/g, " ").trim();
    if (text) lines.push({ text, page: null, heading: tag.startsWith("h") });
  }
  return { lines, pageCount: null };
}

export async function extractLines(buffer: Buffer, fileType: FileType): Promise<Extracted> {
  return fileType === "pdf" ? extractPdf(buffer) : extractDocx(buffer);
}
