/**
 * 抽出・正規化・メタデータ・チャンキングのテスト（外部API・DBを使わない）。
 *   npm run test:chunking
 */
import fs from "node:fs/promises";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import { buildChunks, CHUNK_MAX_TOKENS, countTokens } from "../src/lib/chunking";
import { parseMetadata } from "../src/lib/document-metadata";
import type { Line } from "../src/lib/extract";
import { prepareDocument } from "../src/lib/ingest";
import { normalizeText } from "../src/lib/text-normalize";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? `  →  ${detail}` : ""}`);
}

const line = (text: string, page: number | null = 1): Line => ({ text, page, heading: null });
const META = "部署: 戦略 / 客先: 地方銀行A / 作成: 2024年 / 機密度: 社外秘";

async function main() {
  // 1. 文字の正規化
  check("正規化: 部首の文字を通常の漢字に戻す", normalizeText("銀⾏ ⼈事 ⻑い ⽅法 ⼩売") === "銀行 人事 長い 方法 小売", normalizeText("銀⾏ ⼈事 ⻑い ⽅法 ⼩売"));
  check("正規化: 全角の括弧や英数字は変えない", normalizeText("（サマリ版）ＡＢＣ") === "（サマリ版）ＡＢＣ");

  // 2. サンプルPDF 4本
  const expected: Record<string, { department: string; client: string; year: number }> = {
    "case7-doc1-strategy-dx-bank.pdf": { department: "戦略", client: "地方銀行A", year: 2024 },
    "case7-doc2-hr-engagement-report.pdf": { department: "人事", client: "製造業B", year: 2024 },
    "case7-doc3-it-cloud-migration.pdf": { department: "IT", client: "小売業C", year: 2023 },
    "case7-doc4-sales-proposal-retail.pdf": { department: "営業", client: "小売チェーンD", year: 2024 },
  };
  for (const [file, want] of Object.entries(expected)) {
    const prepared = await prepareDocument(await fs.readFile(`docs/samples/${file}`), file);
    const m = prepared.metadata;
    check(`${file}: メタデータ`, m.department === want.department && m.client === want.client && m.docYear === want.year, `${m.title} ／ ${m.department} ／ ${m.client} ／ ${m.docYear}`);
    const titles = prepared.chunks.map((c) => c.sectionTitle);
    // 先頭は見出しより前の前書き（見出しなし）。そのあとに「1. 」〜「5. 」の5セクションが続く
    check(`${file}: 前書き＋5つのセクションに分かれる`, prepared.chunks.length === 6 && titles[0] === null && titles.slice(1).every((t, i) => t?.startsWith(`${i + 1}. `)), titles.map((t) => t ?? "（見出しなし）").join(" | "));
    check(`${file}: 警告なし`, prepared.warnings.length === 0, prepared.warnings.join(" / "));
  }
  const doc1 = await prepareDocument(await fs.readFile("docs/samples/case7-doc1-strategy-dx-bank.pdf"), "case7-doc1-strategy-dx-bank.pdf");
  check("Embedding用の文字列では、折り返しで切れた単語がつながる", doc1.chunks[1].embeddingText.includes("窓口業務のデジタル化"), JSON.stringify(doc1.chunks[1].embeddingText.slice(-60)));
  check("箇条書きは別の行のまま", doc1.chunks[2].content.split("\n").length === 3, `${doc1.chunks[2].content.split("\n").length}行`);
  check("Embedding用の文字列に文脈が付く", doc1.chunks[4].embeddingText.startsWith("文書: 銀行A向け DX 推進提案書（サマリ版）（部署: 戦略 / 客先: 地方銀行A / 作成: 2024年）\nセクション: 4. ROI 試算"), JSON.stringify(doc1.chunks[4].embeddingText.slice(0, 80)));
  check("保存する本文には文脈を付けない", !doc1.chunks[4].content.includes("文書:"));

  // 3. 部署が読み取れない文書は取り込まない
  for (const [name, lines] of [
    ["部署の行が無い", [line("タイトル"), line("1. 概要"), line("本文です。")]],
    ["6部署に無い部署", [line("タイトル"), line("部署: 経理 / 客先: X / 作成: 2024年"), line("1. 概要"), line("本文です。")]],
  ] as const) {
    let message = "";
    try { parseMetadata([...lines]); } catch (err) { message = (err as Error).message; }
    check(`取り込まない: ${name}`, message.length > 0, message);
  }

  // 4. 長いセクション（複数ページにまたがる）の再分割
  const paragraph = "当社はクライアントの業務改革を支援するため、現状分析と課題の整理を行い、実行計画を策定した。".repeat(4);
  const longLines: Line[] = [line("長い報告書"), line(META), line("1. 背景")];
  // 1ページ3段落。4段落前後で1チャンクになるので、チャンクはページをまたぐ
  for (let page = 1; page <= 6; page++) for (let i = 0; i < 3; i++) longLines.push(line(`${paragraph}（p${page}-${i}）`, page));
  longLines.push(line("2. 結論", 6), line("以上の分析から、段階的な導入を推奨する。投資回収は3年を見込む。効果測定は四半期ごとに実施する。", 6));
  const long = parseMetadata(longLines);
  const longChunks = buildChunks(long.bodyLines, long.metadata);
  const section1 = longChunks.filter((c) => c.sectionTitle === "1. 背景");
  check("長いセクションは複数チャンクに分かれる", section1.length >= 3, `${section1.length}チャンク（${section1.map((c) => c.tokens).join(", ")}トークン）`);
  check("各チャンクが上限の1割増し以内", longChunks.every((c) => c.tokens <= CHUNK_MAX_TOKENS * 1.1), `最大 ${Math.max(...longChunks.map((c) => c.tokens))}`);
  check("開始・終了ページを持つ", section1[0].pageStart === 1 && section1[section1.length - 1].pageEnd === 6 && section1.some((c) => c.pageStart !== c.pageEnd), section1.map((c) => `p${c.pageStart}-${c.pageEnd}`).join(", "));
  check("2つ目以降は前のチャンクの末尾を重ねて持つ", section1[1].content.startsWith(section1[0].content.slice(-20)) || section1[0].content.includes(section1[1].content.slice(0, 20)), JSON.stringify(section1[1].content.slice(0, 30)));
  check("セクションをまたいで混ざらない", longChunks[longChunks.length - 1].sectionTitle === "2. 結論" && !longChunks[longChunks.length - 1].content.includes("（p6-2）"));

  // 5. 短いセクションの結合
  const shortDoc = parseMetadata([line("短い節のある文書"), line(META), line("1. はじめに"), line("概要。"), line("2. 本論"), line("本論では、対象業務の現状と課題を整理し、改善の方向性を三つの観点から示す。あわせて導入時の体制も述べる。")]);
  const shortChunks = buildChunks(shortDoc.bodyLines, shortDoc.metadata);
  check("本文が短いセクションは次のセクションに結合される", shortChunks.length === 1 && shortChunks[0].content.includes("概要。") && shortChunks[0].content.includes("2. 本論"), `${shortChunks.length}チャンク: ${JSON.stringify(shortChunks[0]?.content.slice(0, 40))}`);

  // 6. 見出しのない文書はページ単位
  const noHeading = parseMetadata([line("見出しのない文書"), line(META), line("1ページ目の本文。" + paragraph, 1), line("2ページ目の本文。" + paragraph, 2)]);
  const pageChunks = buildChunks(noHeading.bodyLines, noHeading.metadata);
  check("見出しがなければページ単位に分かれる", pageChunks.length === 2 && pageChunks[0].pageStart === 1 && pageChunks[1].pageStart === 2, pageChunks.map((c) => `p${c.pageStart}`).join(", "));

  // 7. Word（見出しスタイルで判定）
  const docx = new Document({
    sections: [{
      children: [
        new Paragraph({ text: "人事制度 改定 提案書", heading: HeadingLevel.TITLE }),
        new Paragraph("部署: 人事 / 客先: 製造業B / 作成: 2025年 / 機密度: 社外秘"),
        new Paragraph({ text: "背景と目的", heading: HeadingLevel.HEADING_1 }),
        new Paragraph("評価制度の納得感が低く、中堅層の離職が続いている。等級と報酬の対応を見直し、評価基準を公開することを目的とする。"),
        new Paragraph({ text: "提案内容", heading: HeadingLevel.HEADING_1 }),
        new Paragraph("等級を7段階から5段階に整理する。評価は半期ごとに行い、結果を本人に面談で伝える。管理職向けの評価者研修を年2回実施する。"),
      ],
    }],
  });
  const word = await prepareDocument(await Packer.toBuffer(docx), "hr-proposal.docx");
  check("Word: メタデータ", word.metadata.title === "人事制度 改定 提案書" && word.metadata.department === "人事" && word.metadata.docYear === 2025, `${word.metadata.title} ／ ${word.metadata.department} ／ ${word.metadata.docYear}`);
  check("Word: 番号のない見出しでも見出しスタイルで分かれる", word.chunks.length === 2 && word.chunks[0].sectionTitle === "背景と目的" && word.chunks[1].sectionTitle === "提案内容", word.chunks.map((c) => c.sectionTitle).join(" | "));
  check("Word: ページ番号は持たない", word.chunks.every((c) => c.pageStart === null));

  console.log(`\nトークン数の目安: サンプルの前書き ${countTokens(doc1.chunks[0].content)} ／ 1セクション ${countTokens(doc1.chunks[2].content)} トークン`);
  console.log(failed === 0 ? "すべて合格" : `${failed} 件不合格`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
