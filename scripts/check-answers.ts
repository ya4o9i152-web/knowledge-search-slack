/**
 * テスト質問12問を、質問から回答までの一連の処理で確かめる（合格基準の検証）。
 *   npm run check:answers
 * 質問ごとにClaudeを1回呼ぶ（計12回）。
 *
 *  ・該当あり：担当部署のユーザーで質問し、正解文書が回答に挙がること、根拠の語句が回答に含まれること
 *  ・該当なし：全部署のユーザーで質問し、「見つかりませんでした」になること（捏造0件）
 *  ・権限　　：人事ユーザーがIT部の文書の内容を質問し、「見つかりませんでした」になること
 *  ・応答時間：すべて60秒以内
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import fs from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { answerQuestion, formatResult } from "../src/lib/pipeline";
import { TEST_USERS } from "./lib/test-users";

type Question = { 番号: string; 質問: string; 正解文書: string; 正解の根拠: string; 種別: string };

const USER_BY_KIND: Record<string, string> = {
  "該当あり(戦略)": "strategy",
  "該当あり(人事)": "hr",
  "該当あり(IT)": "it",
  "該当あり(営業)": "sales",
  "該当あり(複数文書)": "multi",
};

// CSVの「正解の根拠」から、回答に必ず含まれるべき語句を抜き出したもの（どれか1つではなく、すべて含むこと）
const REQUIRED_PHRASES: Record<string, string[]> = {
  "1": ["ROI"],
  "2": ["1.2億円"],
  "3": ["3〜5年目"],
  "4": ["キャリアパス", "1on1"],
  "5": ["480万円", "310万円"],
  "6": ["Aurora PostgreSQL"],
  "7": ["クーポン", "レコメンド"],
  "8": ["5%"],
};

// 正解文書のファイル名（CSVの表記）と、DB上の文書タイトルの対応
const TITLE_BY_FILE: Record<string, string> = {
  "case7-doc1": "銀行A向け DX 推進提案書",
  "case7-doc2": "従業員エンゲージメント調査 報告書",
  "case7-doc3": "基幹システム クラウド移行 報告書",
  "case7-doc4": "小売チェーンD 販促戦略 提案書",
};
const titleFor = (answer: string) => Object.entries(TITLE_BY_FILE).find(([file]) => answer.startsWith(file))?.[1] ?? answer;

const slackIdOf = (key: string) => TEST_USERS.find((u) => u.key === key)!.slackUserId;
const LATENCY_LIMIT_MS = 60_000;

async function main() {
  const questions = parse(await fs.readFile("docs/samples/case7-test-questions.csv"), { columns: true, bom: true }) as Question[];
  let failed = 0;
  const latencies: number[] = [];
  const verbose = process.argv.includes("--verbose");

  for (const q of questions) {
    const problems: string[] = [];
    let userKey: string;
    let question = q.質問;

    if (USER_BY_KIND[q.種別]) userKey = USER_BY_KIND[q.種別];
    else if (q.種別.startsWith("該当なし")) userKey = "all";
    else {
      // 権限の質問は、人事ユーザーがIT部の報告書の中身を尋ねる形で確かめる
      userKey = "hr";
      question = "クラウド移行でインフラ運用コストはどれだけ下がりましたか？";
    }

    const result = await answerQuestion(slackIdOf(userKey), question, { channel: "cli" });
    latencies.push(result.latencyMs);
    const text = formatResult(result);
    if (result.latencyMs > LATENCY_LIMIT_MS) problems.push(`応答に${(result.latencyMs / 1000).toFixed(1)}秒かかった`);

    if (USER_BY_KIND[q.種別]) {
      if (result.status !== "answered") {
        problems.push(`回答が得られなかった（${result.status}）`);
      } else {
        const titles = result.answer.documents.map((d) => d.title);
        for (const answer of q.正解文書.split("/").map((s) => s.trim())) {
          if (!titles.some((t) => t.startsWith(titleFor(answer)))) problems.push(`正解文書が挙がっていない: ${titleFor(answer)}`);
        }
        for (const phrase of REQUIRED_PHRASES[q.番号] ?? []) {
          if (!text.includes(phrase)) problems.push(`根拠の語句がない: ${phrase}`);
        }
        if (result.answer.documents.some((d) => d.citations.length === 0)) problems.push("出典のない文書がある");
      }
    } else if (result.status !== "no_match") {
      problems.push(`「見つかりませんでした」になるべきところ、回答が返った`);
    }

    if (problems.length > 0) failed++;
    const label = result.status === "answered" ? `${result.answer.documents.length}文書` : "見つかりませんでした";
    console.log(`${problems.length === 0 ? "✅" : "❌"} Q${q.番号}［${TEST_USERS.find((u) => u.key === userKey)!.displayName}］${question}`);
    console.log(`     → ${label}（${(result.latencyMs / 1000).toFixed(1)}秒）${problems.length ? ` ← ${problems.join(" ／ ")}` : ""}`);
    if (verbose || problems.length > 0) console.log(text.split("\n").map((l) => `     | ${l}`).join("\n"));
  }

  const max = Math.max(...latencies);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  console.log(`\n合格 ${questions.length - failed}/${questions.length} ／ 応答時間 平均 ${(avg / 1000).toFixed(1)}秒・最大 ${(max / 1000).toFixed(1)}秒（基準 60秒以内）`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
