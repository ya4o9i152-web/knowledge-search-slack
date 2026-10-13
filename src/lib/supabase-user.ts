import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient, getSupabaseUrl } from "./supabase-admin";

/**
 * 指定したユーザー本人として動くクライアントを作る。文書の検索は必ずこれで行う。
 *
 * Slackボットはサーバー側で動くので、質問者はSupabaseにログインしていない。
 * そこでサーバー側で1回限りのログイン用トークンを発行し、その場で検証して
 * 本人のセッションを得る（メールは送信されない）。
 * 得られたクライアントの問い合わせには auth.uid() = userId が入るため、
 * 部署別のRLS（supabase/schema.sql）がそのまま適用される。
 *
 * JWTを自前で署名する方式にしなかったのは、Supabaseプロジェクトの署名鍵の方式
 * （共有シークレット／非対称鍵）に依存せずに済むため。
 */
export async function createUserClient(userId: string): Promise<SupabaseClient> {
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!anonKey) {
    throw new Error("SUPABASE_ANON_KEY が設定されていません（.env.local を確認してください）");
  }

  const admin = createAdminClient();
  const { data: userData, error: userError } = await admin.auth.admin.getUserById(userId);
  if (userError || !userData.user?.email) {
    throw new Error(`ユーザーを取得できません（${userId}）: ${userError?.message ?? "メールアドレスがありません"}`);
  }

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: userData.user.email,
  });
  if (linkError || !linkData.properties?.hashed_token) {
    throw new Error(`ログイン用トークンを発行できません: ${linkError?.message ?? "hashed_token がありません"}`);
  }

  // セッションを保持するのはこのクライアントだけ。adminクライアントでverifyOtpすると
  // サービスロールのクライアントが利用者のセッションに切り替わってしまうため、必ず別に作る
  const client = createClient(getSupabaseUrl(), anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: sessionData, error: verifyError } = await client.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: "magiclink",
  });
  if (verifyError || !sessionData.session) {
    throw new Error(`本人のセッションを取得できません: ${verifyError?.message ?? "session がありません"}`);
  }
  if (sessionData.session.user.id !== userId) {
    throw new Error("取得したセッションのユーザーが一致しません");
  }

  return client;
}
