/**
 * 権限検証用のテストユーザー8名を登録する（何度実行しても同じ状態になる）。
 *   npm run seed:users
 * auth.users にユーザーを作り、slack_users と user_departments を設定する。
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createAdminClient } from "../src/lib/supabase-admin";
import { TEST_USERS } from "./lib/test-users";

async function findUserIdByEmail(email: string): Promise<string | null> {
  const admin = createAdminClient();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const found = data.users.find((u) => u.email === email);
    if (found) return found.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function main() {
  const admin = createAdminClient();

  for (const user of TEST_USERS) {
    let userId = await findUserIdByEmail(user.email);
    if (!userId) {
      const { data, error } = await admin.auth.admin.createUser({ email: user.email, email_confirm: true });
      if (error || !data.user) throw new Error(`${user.email} の作成に失敗: ${error?.message}`);
      userId = data.user.id;
    }

    const { error: slackError } = await admin
      .from("slack_users")
      .upsert({ slack_user_id: user.slackUserId, user_id: userId, display_name: user.displayName });
    if (slackError) throw new Error(`slack_users の登録に失敗（${user.key}）: ${slackError.message}`);

    const { error: deleteError } = await admin.from("user_departments").delete().eq("user_id", userId);
    if (deleteError) throw new Error(`user_departments の削除に失敗（${user.key}）: ${deleteError.message}`);
    if (user.departments.length > 0) {
      const { error: insertError } = await admin
        .from("user_departments")
        .insert(user.departments.map((department) => ({ user_id: userId, department })));
      if (insertError) throw new Error(`user_departments の登録に失敗（${user.key}）: ${insertError.message}`);
    }

    console.log(`✅ ${user.displayName}: ${user.departments.join("・") || "所属なし"}`);
  }
  console.log(`\n${TEST_USERS.length} 名を登録しました`);
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
