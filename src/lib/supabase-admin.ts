import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * service_roleキーを使うサーバー専用クライアント。RLSをバイパスする。
 *
 * 使ってよいのは、取り込み（documents / document_chunks への書き込み）、
 * ユーザー管理（slack_users / user_departments）、Slackイベントの重複排除、検索ログだけ。
 * 文書の検索には絶対に使わない。検索は createUserClient（supabase-user.ts）で
 * 質問者本人として実行し、部署別のRLSを効かせる。
 */
let cachedClient: SupabaseClient | null = null;

export function getSupabaseUrl(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) {
    throw new Error("SUPABASE_URL が設定されていません（.env.local を確認してください）");
  }
  // ダッシュボードから「…supabase.co/rest/v1/」ごとコピーしても動くよう、オリジンだけを使う
  return new URL(url).origin;
}

export function createAdminClient(): SupabaseClient {
  if (!cachedClient) {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY が設定されていません（.env.local を確認してください）");
    }
    cachedClient = createClient(getSupabaseUrl(), serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return cachedClient;
}
