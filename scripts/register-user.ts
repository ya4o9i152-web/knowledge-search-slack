/**
 * Slackユーザーを登録し、所属部署を設定する（MVPの所属管理。何度実行しても同じ状態になる）。
 *   npm run register:user -- U0123ABCD "山田 太郎" 戦略,IT
 * SlackユーザーID（メンバーID）は、Slackのプロフィール →「…」→「メンバーIDをコピー」で確認できる。
 * 部署を空にすると所属なし（何も検索できない状態）になる。
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { ACCESS_GROUPS } from "../src/lib/departments";
import { createAdminClient } from "../src/lib/supabase-admin";

async function main() {
  const [slackUserId, displayName, departmentArg = ""] = process.argv.slice(2);
  if (!slackUserId || !/^[UW][A-Z0-9]+$/.test(slackUserId) || !displayName) {
    console.error('使い方: npm run register:user -- <SlackユーザーID> "<表示名>" <部署をカンマ区切り>');
    console.error(`部署・区分: ${ACCESS_GROUPS.join(" / ")}`);
    process.exit(1);
  }
  const departments = departmentArg.split(",").map((d) => d.trim()).filter(Boolean);
  const unknown = departments.filter((d) => !ACCESS_GROUPS.includes(d));
  if (unknown.length > 0) {
    console.error(`登録されていない部署です: ${unknown.join("・")}（${ACCESS_GROUPS.join(" / ")} から選んでください）`);
    process.exit(1);
  }

  const admin = createAdminClient();
  const { data: existing, error: lookupError } = await admin.from("slack_users").select("user_id").eq("slack_user_id", slackUserId).maybeSingle();
  if (lookupError) throw new Error(lookupError.message);

  let userId = existing?.user_id as string | undefined;
  if (!userId) {
    // DB上のユーザーはSlackユーザーと1対1で作る。メールは識別用で、送信には使わない
    const { data, error } = await admin.auth.admin.createUser({ email: `slack-${slackUserId.toLowerCase()}@example.com`, email_confirm: true });
    if (error || !data.user) throw new Error(`ユーザーの作成に失敗: ${error?.message}`);
    userId = data.user.id;
  }

  const { error: slackError } = await admin.from("slack_users").upsert({ slack_user_id: slackUserId, user_id: userId, display_name: displayName });
  if (slackError) throw new Error(slackError.message);
  const { error: deleteError } = await admin.from("user_departments").delete().eq("user_id", userId);
  if (deleteError) throw new Error(deleteError.message);
  if (departments.length > 0) {
    const { error } = await admin.from("user_departments").insert(departments.map((department) => ({ user_id: userId, department })));
    if (error) throw new Error(error.message);
  }
  console.log(`✅ ${displayName}（${slackUserId}）: ${departments.join("・") || "所属なし"}`);
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
