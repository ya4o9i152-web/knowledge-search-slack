/**
 * テスト質問で検索精度（Recall@5）と権限を確かめる。Claudeは呼ばない（検索まで）。
 *   npm run check:recall      ※先に npm run seed:users と npm run ingest を実行しておく
 *
 * 質問ごとに2通りで検索する。
 *  ・担当部署のユーザー：実際の使われ方。正解文書が上位5件に入るか（合格基準のRecall@5）
 *  ・全部署のユーザー　：部署の制限で候補が絞られない状態での順位（検索そのものの質を見る参考値）
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import fs from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { searchDocuments } from "../src/lib/search";
import { createAdminClient } from "../src/lib/supabase-admin";
import { createUserClient } from "../src/lib/supabase-user";
import { TEST_USERS } from "./lib/test-users";

type Question = { 番号: string; 質問: string; 正解文書: string; 種別: string };

const USER_BY_KIND: Record<string, string> = {
  "該当あり(戦略)": "strategy",
  "該当あり(人事)": "hr",
  "該当あり(IT)": "it",
  "該当あり(営業)": "sales",
  "該当あり(複数文書)": "multi",
};

const stem = (filename: string) => filename.replace(/\.[^.]+$/, "");

async function clientFor(key: string) {
  const user = TEST_USERS.find((u) => u.key === key)!;
  const { data, error } = await createAdminClient().from("slack_users").select("user_id").eq("slack_user_id", user.slackUserId).maybeSingle();
  if (error || !data) throw new Error(`${user.displayName} が未登録です（npm run seed:users を実行してください）`);
  return createUserClient(data.user_id);
}

async function main() {
  const questions = parse(await fs.readFile("docs/samples/case7-test-questions.csv"), { columns: true, bom: true }) as Question[];
  const clients = new Map<string, Awaited<ReturnType<typeof clientFor>>>();
  const getClient = async (key: string) => {
    if (!clients.has(key)) clients.set(key, await clientFor(key));
    return clients.get(key)!;
  };

  let failed = 0;
  let recallTotal = 0;
  let recallHit = 0;

  for (const q of questions) {
    const userKey = USER_BY_KIND[q.種別];
    if (userKey) {
      // 正解文書（「case7-doc1 / case7-doc3 / case7-doc4」のような前方一致の表記も含む）
      const answers = q.正解文書.split("/").map((s) => s.trim());
      const own = await searchDocuments(await getClient(userKey), q.質問);
      const all = await searchDocuments(await getClient("all"), q.質問);
      const found = answers.filter((a) => own.some((d) => stem(d.filename).startsWith(a)));
      const ok = found.length === answers.length;
      recallTotal++;
      if (ok) recallHit++; else failed++;
      const ranks = answers.map((a) => {
        const rank = all.findIndex((d) => stem(d.filename).startsWith(a));
        return rank === -1 ? "圏外" : `${rank + 1}位`;
      });
      console.log(`${ok ? "✅" : "❌"} Q${q.番号} ${q.質問}`);
      console.log(`     担当部署のユーザー: 上位${own.length}件に正解 ${found.length}/${answers.length} ／ 全部署のユーザーでの順位: ${ranks.join("・")}（1位の類似度 ${all[0]?.similarity.toFixed(3) ?? "-"}）`);
    } else if (q.種別.startsWith("該当なし")) {
      // 「該当なし」と答えられるかはClaudeの判断を含むため、ここでは類似度の参考値だけ出す
      const all = await searchDocuments(await getClient("all"), q.質問);
      console.log(`ℹ️  Q${q.番号} ${q.質問}`);
      console.log(`     該当なしの質問。全部署のユーザーでの1位: ${all[0] ? `${stem(all[0].filename)}（類似度 ${all[0].similarity.toFixed(3)}）` : "0件"} ← 回答生成の実装後に「見つかりませんでした」を検証`);
    } else if (q.種別.startsWith("RLS")) {
      const hr = await searchDocuments(await getClient("hr"), "クラウド移行でインフラ運用コストはどれだけ下がりましたか？");
      const leaked = hr.filter((d) => d.department !== "人事");
      if (leaked.length > 0) failed++;
      console.log(`${leaked.length === 0 ? "✅" : "❌"} Q${q.番号} ${q.質問}`);
      console.log(`     人事ユーザーがクラウド移行について検索 → 返った文書の部署: [${[...new Set(hr.map((d) => d.department))].join("・")}]（IT部の文書 ${hr.filter((d) => d.department === "IT").length} 件）`);
    }
  }

  console.log(`\nRecall@5: ${recallHit}/${recallTotal}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
