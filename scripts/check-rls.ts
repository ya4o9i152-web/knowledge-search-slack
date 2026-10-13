/**
 * 本番のSupabaseで、部署別の閲覧制限が効いているかを確かめる（合格基準「権限」の検証）。
 *   npm run check:rls        ※先に npm run seed:users を実行しておく
 * 6部署ぶんの検証用文書を一時的に入れ、テストユーザー本人として読んで、終わったら消す。
 * Embedding APIは呼ばない（検証用の固定ベクトルを使う）。
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { DEPARTMENTS } from "../src/lib/departments";
import { EMBEDDING_DIMENSIONS } from "../src/lib/embeddings";
import { createAdminClient } from "../src/lib/supabase-admin";
import { createUserClient } from "../src/lib/supabase-user";
import { TEST_USERS } from "./lib/test-users";

const TEST_PATH_PREFIX = "test://rls/";
const TEST_VECTOR = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01);

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

async function cleanup() {
  const { error } = await createAdminClient().from("documents").delete().like("source_path", `${TEST_PATH_PREFIX}%`);
  if (error) throw new Error(`検証用文書の削除に失敗: ${error.message}`);
}

async function insertTestDocuments() {
  const admin = createAdminClient();
  for (const department of DEPARTMENTS) {
    const { data, error } = await admin
      .from("documents")
      .insert({
        filename: `rls-check-${department}.pdf`,
        title: `【権限検証用】${department}の文書`,
        department,
        file_type: "pdf",
        source_path: `${TEST_PATH_PREFIX}${department}`,
      })
      .select("id")
      .single();
    if (error) throw new Error(`検証用文書の追加に失敗（${department}）: ${error.message}`);

    const { error: chunkError } = await admin.from("document_chunks").insert({
      document_id: data.id,
      department,
      chunk_index: 0,
      section_title: "1. 概要",
      page_start: 1,
      page_end: 1,
      content: `${department}の検証用本文`,
      embedding: TEST_VECTOR,
    });
    if (chunkError) throw new Error(`検証用チャンクの追加に失敗（${department}）: ${chunkError.message}`);
  }
}

async function main() {
  const admin = createAdminClient();
  let failed = 0;
  const report = (ok: boolean, message: string) => {
    if (!ok) failed++;
    console.log(`${ok ? "✅" : "❌"} ${message}`);
  };

  await cleanup();
  await insertTestDocuments();

  try {
    for (const user of TEST_USERS) {
      const { data: mapping, error: mappingError } = await admin
        .from("slack_users")
        .select("user_id")
        .eq("slack_user_id", user.slackUserId)
        .maybeSingle();
      if (mappingError || !mapping) {
        report(false, `${user.displayName}: slack_users に未登録です（先に npm run seed:users を実行してください）`);
        continue;
      }
      const client = await createUserClient(mapping.user_id);

      // 1. 文書テーブルを直接読む
      const { data: docs, error: docsError } = await client
        .from("documents")
        .select("department")
        .like("source_path", `${TEST_PATH_PREFIX}%`);
      if (docsError) throw new Error(docsError.message);
      const visible = docs.map((d) => d.department as string);
      report(sameSet(visible, user.departments), `${user.displayName}: 直接読める文書 = [${visible.join("・")}]`);

      // 2. 検索関数。検証用以外の文書が入っていても、他部署の行が1件でも返れば不合格
      const { data: hits, error: rpcError } = await client.rpc("match_document_chunks", {
        query_embedding: TEST_VECTOR,
        match_count: 20,
        match_threshold: -1,
      });
      if (rpcError) throw new Error(rpcError.message);
      const hitDepartments = [...new Set((hits as { department: string }[]).map((h) => h.department))];
      const leaked = hitDepartments.filter((d) => !(user.departments as string[]).includes(d));
      report(leaked.length === 0, `${user.displayName}: 検索結果の部署 = [${hitDepartments.join("・")}]${leaked.length ? ` ← 他部署が漏れています: ${leaked.join("・")}` : ""}`);

      // 3. 質問者の権限では書き込めない
      const { error: writeError } = await client.from("documents").insert({
        filename: "x.pdf",
        title: "x",
        department: user.departments[0] ?? "人事",
        file_type: "pdf",
        source_path: `${TEST_PATH_PREFIX}write-attempt-${user.key}`,
      });
      report(writeError !== null, `${user.displayName}: 文書の追加は${writeError ? "拒否" : "通ってしまった"}`);
    }
  } finally {
    await cleanup();
  }

  console.log(failed === 0 ? "\nすべて合格" : `\n${failed} 件不合格`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
