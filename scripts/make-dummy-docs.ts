/**
 * 検証用のダミー文書（Word）を作る。サンプルの無い「業務」「管理」の文書と、わざと部署を書いていない文書の3つ。
 *   npm run make:dummy        → docs/samples/dummy/ に出力
 * 実在の企業・案件とは関係のない、作り物の内容。
 */
import fs from "node:fs/promises";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";

type Dummy = { file: string; title: string; meta: string | null; sections: [string, string[]][] };

const NOTE = "検証用のダミー文書です。実在の企業・案件とは関係ありません。";

const DOCS: Dummy[] = [
  {
    file: "dummy-operations-logistics-bpr.docx",
    title: "物流会社E 業務プロセス改革 報告書（ダミー）",
    meta: "部署: 業務 / 客先: 物流会社E / 作成: 2025年 / 機密度: 社外秘",
    sections: [
      ["プロジェクト概要", ["物流会社Eの配車業務と請求業務を対象に、業務プロセスの見直しを行った。対象拠点は関東の5営業所。期間は8ヶ月。"]],
      ["現状の課題", ["配車計画を担当者の経験に頼って手作業で作成しており、1日あたり平均3時間かかっていた。", "請求書の発行が月末に集中し、誤請求が月平均12件発生していた。"]],
      ["実施した施策", ["配車計画に最適化ツールを導入し、担当者は例外対応に専念する運用に変更した。", "請求データを受注システムから自動連携し、月2回の分割発行に切り替えた。"]],
      ["成果", ["配車計画の作成時間を1日3時間から45分に短縮した。", "誤請求は月平均12件から2件に減少した。", "トラックの積載率が68%から79%に向上した。"]],
    ],
  },
  {
    file: "dummy-admin-office-relocation.docx",
    title: "本社オフィス移転 計画書（ダミー）",
    meta: "部署: 管理 / 客先: 社内 / 作成: 2025年 / 機密度: 社外秘",
    sections: [
      ["移転の目的", ["在宅勤務の定着により出社率が平均45%に下がったため、本社の床面積を見直し、固定費を下げる。"]],
      ["移転計画", ["現在の1,200平方メートルから800平方メートルのオフィスへ移転する。座席はフリーアドレスとし、会議室を6室から10室に増やす。", "移転は2026年4月の連休に実施する。"]],
      ["費用と効果", ["移転の初期費用は内装と引っ越しを合わせて4,500万円を見込む。", "賃料は月額960万円から月額620万円に下がり、年間およそ4,080万円の削減になる。初期費用は約13ヶ月で回収できる見込み。"]],
      ["リスクと対応", ["出社が集中する日に座席が不足するおそれがあるため、座席予約システムを導入し、部署ごとに出社推奨日を分散する。"]],
    ],
  },
  {
    // 部署の行が無い文書。取り込みで弾かれることを確かめるためのもの
    file: "dummy-no-department.docx",
    title: "部署の記載がない文書（ダミー）",
    meta: null,
    sections: [["概要", ["この文書には部署の記載がありません。部署を特定できない文書は取り込まれないことを確かめるために使います。"]]],
  },
];

async function main() {
  await fs.mkdir("docs/samples/dummy", { recursive: true });
  for (const doc of DOCS) {
    const children = [new Paragraph({ text: doc.title, heading: HeadingLevel.TITLE })];
    if (doc.meta) children.push(new Paragraph(doc.meta));
    children.push(new Paragraph(NOTE));
    doc.sections.forEach(([heading, paragraphs], i) => {
      children.push(new Paragraph({ text: `${i + 1}. ${heading}`, heading: HeadingLevel.HEADING_1 }));
      for (const text of paragraphs) children.push(new Paragraph(text));
    });
    await fs.writeFile(`docs/samples/dummy/${doc.file}`, await Packer.toBuffer(new Document({ sections: [{ children }] })));
    console.log(`✅ docs/samples/dummy/${doc.file}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
