import { isDepartment, type Department } from "./departments";
import type { Line } from "./extract";

export type DocumentMetadata = {
  title: string;
  department: Department;
  client: string | null;
  docYear: number | null;
  confidentiality: string | null;
};

const METADATA_LINE = /部署\s*[:：]/;

function field(line: string, label: string): string | null {
  const match = line.match(new RegExp(`${label}\\s*[:：]\\s*([^/／]+)`));
  return match ? match[1].trim() : null;
}

/**
 * 文書冒頭の「部署: 戦略 / 客先: 地方銀行A / 作成: 2024年 / 機密度: 社外秘」の行を読み取る。
 *
 * 部署が読み取れない、または6部署のどれでもない文書は取り込まない（エラーにする）。
 * 部署は閲覧制限の根拠なので、推測で埋めると見せてはいけない部署に見える事故になる。
 */
export function parseMetadata(lines: Line[]): { metadata: DocumentMetadata; bodyLines: Line[] } {
  const head = lines.slice(0, 10);
  const metaIndex = head.findIndex((l) => METADATA_LINE.test(l.text));
  if (metaIndex === -1) {
    throw new Error("冒頭10行に「部署:」の行がありません（部署を特定できないため取り込みません）");
  }
  const metaLine = head[metaIndex].text;
  const department = field(metaLine, "部署");
  if (!department || !isDepartment(department)) {
    throw new Error(`部署「${department ?? ""}」は登録された6部署にありません（取り込みません）`);
  }

  const titleLine = head.slice(0, metaIndex).find((l) => l.text.length > 0);
  if (!titleLine) {
    throw new Error("タイトル行がありません（「部署:」の行より前に文書タイトルが必要です）");
  }

  const year = field(metaLine, "作成")?.match(/(\d{4})/)?.[1];
  return {
    metadata: {
      title: titleLine.text,
      department,
      client: field(metaLine, "客先"),
      docYear: year ? Number(year) : null,
      confidentiality: field(metaLine, "機密度"),
    },
    bodyLines: lines.filter((l) => l !== titleLine && l !== head[metaIndex]),
  };
}
