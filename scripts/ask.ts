/**
 * テストユーザーとして質問し、回答を表示する。
 *   npm run ask -- "クラウド移行でコストはどれだけ下がりましたか？" --user it
 * --user は scripts/lib/test-users.ts の key（strategy / operations / it / hr / sales / admin / multi / all / none）。既定は all。
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { answerQuestion, formatResult } from "../src/lib/pipeline";
import { TEST_USERS } from "./lib/test-users";

async function main() {
  const userFlag = process.argv.indexOf("--user");
  const userKey = userFlag !== -1 ? process.argv[userFlag + 1] : "all";
  const question = process.argv.slice(2).find((arg, i, all) => !arg.startsWith("--") && all[i - 1] !== "--user");
  const user = TEST_USERS.find((u) => u.key === userKey);
  if (!question || !user) {
    console.error('使い方: npm run ask -- "質問" --user <key>');
    process.exit(1);
  }
  console.log(`質問者: ${user.displayName}\n質問: ${question}\n`);
  const result = await answerQuestion(user.slackUserId, question, { channel: "cli" });
  console.log(formatResult(result));
  console.log(`\n（${(result.latencyMs / 1000).toFixed(1)}秒）`);
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
