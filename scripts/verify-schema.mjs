// supabase/schema.sql を組み込みPostgres（PGlite＋pgvector）で実行し、部署別の閲覧制限を検証する。
// 実行: npm run verify:schema
// authスキーマ・ロール・auth.uid() はSupabaseの代用を冒頭で作っている（本番のSupabaseでは不要）。

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { readFileSync, readdirSync } from "node:fs";

const schemaPath = process.argv[2];
const db = new PGlite({ extensions: { vector } });

// Supabaseが用意しているもの（authスキーマ・ロール・auth.uid()）の代用
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key);
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to authenticated, service_role;
  grant execute on function auth.uid() to authenticated, service_role;
  grant usage on schema public to authenticated, service_role;
`);

await db.exec(readFileSync(schemaPath, "utf8"));
// 追加のSQL（supabase/migrations/*.sql）を番号順に実行する。2回実行して、何度実行しても通ることも確かめる
const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
for (let round = 0; round < 2; round++) for (const file of migrations) await db.exec(readFileSync(new URL(file, migrationsDir), "utf8"));
console.log(`追加のSQL ${migrations.length} 本を2回実行OK: ${migrations.join(", ")}`);
const ver = await db.query(`select extversion from pg_extension where extname='vector'`);
console.log("schema.sql 実行OK / pgvector", ver.rows[0].extversion);

const U = { hr: "00000000-0000-0000-0000-000000000001", multi: "00000000-0000-0000-0000-000000000002", none: "00000000-0000-0000-0000-000000000003" };
const depts = ["戦略", "業務", "IT", "人事", "営業", "管理"];
const vec = (seed) => { let x = seed * 9301 + 49297; const a = []; for (let i = 0; i < 1536; i++) { x = (x * 9301 + 49297) % 233280; a.push((x / 233280 - 0.5).toFixed(4)); } return `[${a.join(",")}]`; };

for (const id of Object.values(U)) await db.query(`insert into auth.users values ($1)`, [id]);
await db.query(`insert into user_departments values ($1,'人事')`, [U.hr]);
for (const d of ["戦略", "IT", "営業"]) await db.query(`insert into user_departments values ($1,$2)`, [U.multi, d]);

// 各部署100文書 × 1チャンク = 600チャンク（1部署は全体の6分の1）
let n = 0;
for (const d of depts) for (let i = 0; i < 100; i++) {
  n++;
  const r = await db.query(`insert into documents (filename,title,department,file_type,source_path) values ($1,$2,$3,'pdf',$4) returning id`, [`f${n}.pdf`, `${d}の文書${i}`, d, `/sp/${n}.pdf`]);
  await db.query(`insert into document_chunks (document_id,department,chunk_index,section_title,page_start,page_end,content,embedding) values ($1,$2,0,'1. 概要',1,2,$3,$4)`, [r.rows[0].id, d, `本文${n}`, vec(n)]);
}

const asUser = async (uid, sql, params = []) => {
  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${uid}';`);
  try { return await db.query(sql, params); } finally { await db.exec(`reset role; reset request.jwt.claim.sub;`); }
};
const results = [];
const check = (name, ok, detail = "OK") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}  →  ${detail}`); };
const q = vec(4242);

let r = await asUser(U.hr, `select department, count(*)::int c from documents group by 1`);
check("人事ユーザー: 見える文書は人事だけ", r.rows.length === 1 && r.rows[0].department === "人事" && r.rows[0].c === 100, JSON.stringify(r.rows));
r = await asUser(U.hr, `select count(*)::int c from document_chunks where department = 'IT'`);
check("人事ユーザー: IT部のチャンクを直接読んでも0行", r.rows[0].c === 0, `${r.rows[0].c}行`);
r = await asUser(U.hr, `select distinct department from match_document_chunks($1::vector, 20, -1)`, [q]);
check("人事ユーザー: 検索関数の結果は人事だけ", r.rows.length === 1 && r.rows[0].department === "人事", JSON.stringify(r.rows.map(x => x.department)));
r = await asUser(U.multi, `select department, count(*)::int c from documents group by 1 order by 1`);
check("兼務ユーザー: 戦略・IT・営業の3部署が見える", r.rows.length === 3 && r.rows.every(x => ["戦略", "IT", "営業"].includes(x.department)), JSON.stringify(r.rows));
r = await asUser(U.none, `select count(*)::int c from documents`);
const r2 = await asUser(U.none, `select count(*)::int c from match_document_chunks($1::vector, 20, -1)`, [q]);
check("所属なしユーザー: 文書0件・検索0件", r.rows[0].c === 0 && r2.rows[0].c === 0, `文書${r.rows[0].c}件 / 検索${r2.rows[0].c}件`);

let denied = [];
for (const [label, sql] of [
  ["文書の追加", `insert into documents (filename,title,department,file_type,source_path) values ('x','x','人事','pdf','/x')`],
  ["自分の所属の追加", `insert into user_departments values ('${U.hr}','IT')`],
  ["slack_usersの読み取り", `select * from slack_users`],
  ["search_logsの読み取り", `select * from search_logs`],
]) { try { await asUser(U.hr, sql); denied.push(`${label}:通ってしまった`); } catch { denied.push(`${label}:拒否`); } }
check("人事ユーザー: 書き込みと管理テーブルの読み取りは拒否", denied.every(x => x.endsWith("拒否")), denied.join(" / "));

let mismatch = "入ってしまった";
try {
  const d = await db.query(`select id from documents where department='人事' limit 1`);
  await db.query(`insert into document_chunks (document_id,department,chunk_index,content,embedding) values ($1,'IT',9,'x',$2)`, [d.rows[0].id, vec(1)]);
} catch { mismatch = "拒否"; }
check("文書と違う部署のチャンクは入らない", mismatch === "拒否", mismatch);

const one = await db.query(`select id from documents where department='人事' limit 1`);
await db.query(`update documents set department='管理' where id=$1`, [one.rows[0].id]);
r = await db.query(`select department from document_chunks where document_id=$1`, [one.rows[0].id]);
check("文書の部署を変えるとチャンクも追従", r.rows[0].department === "管理", r.rows[0].department);
r = await asUser(U.hr, `select count(*)::int c from documents`);
check("部署を変えた文書は人事ユーザーから見えなくなる", r.rows[0].c === 99, `${r.rows[0].c}件`);

let dup = "入ってしまった";
try { await db.query(`insert into slack_events values ('Ev1')`); await db.query(`insert into slack_events values ('Ev1')`); } catch { dup = "拒否"; }
check("同じSlackイベントIDの2回目は拒否（重複排除）", dup === "拒否", dup);

// ---- 監査ログと完全削除（002_audit_governance.sql）----
{
  // 人事ユーザーとして、検索とログ記録を1回の呼び出しで行う
  r = await asUser(U.hr, `select log_id, chunk_id, document_id, department from search_documents_logged($1::vector, '離職率の推移は？', 'UHR', 'slack', 5, -1)`, [q]);
  const logId = r.rows[0].log_id;
  const log = (await db.query(`select * from search_logs where id = $1`, [logId])).rows[0];
  check("検索と同時に監査ログが書かれる（誰が・何を・どのチャンクを）", r.rows.length === 5 && log.user_id === U.hr && log.question === "離職率の推移は？" && log.retrieved_chunk_ids.length === 5 && log.status === "searched" && log.departments.join() === "人事", `チャンク${log.retrieved_chunk_ids.length}件 / 部署 ${log.departments} / ${log.status}`);
  check("検索結果は自部署だけ（ログつきの検索でも閲覧制限が効く）", r.rows.every((x) => x.department === "人事"));

  // 0件でも記録が残る
  r = await asUser(U.none, `select log_id, chunk_id from search_documents_logged($1::vector, '何か', 'UNONE', 'slack', 5, -1)`, [q]);
  const emptyLog = (await db.query(`select retrieved_chunk_ids, user_id from search_logs where id = $1`, [r.rows[0].log_id])).rows[0];
  check("0件のときも監査ログが残る", r.rows.length === 1 && r.rows[0].chunk_id === null && emptyLog.retrieved_chunk_ids.length === 0 && emptyLog.user_id === U.none);

  // 質問者の権限では、ログを読むことも直接書くこともできない
  const attempts = [];
  for (const [label, sql] of [
    ["監査ログの読み取り", `select * from search_logs`],
    ["監査ログへの直接の書き込み", `insert into search_logs (question, status) values ('x', 'answered')`],
    ["文書の完全削除", `select delete_document_with_redaction('${log.retrieved_document_ids[0]}', 'x')`],
  ]) { try { await asUser(U.hr, sql); attempts.push(`${label}:通ってしまった`); } catch { attempts.push(`${label}:拒否`); } }
  check("質問者の権限では、監査ログの読み書きも文書の削除もできない", attempts.every((x) => x.endsWith("拒否")), attempts.join(" / "));

  // 完全削除：文書とチャンクが消え、監査ログから参照が消え、取り込み除外に登録される
  const targetDoc = log.retrieved_document_ids[0];
  const targetPath = (await db.query(`select source_path from documents where id = $1`, [targetDoc])).rows[0].source_path;
  const result = (await db.query(`select delete_document_with_redaction($1, 'テスト：誤って取り込んだ') as r`, [targetDoc])).rows[0].r;
  const after = (await db.query(`select retrieved_chunk_ids, retrieved_document_ids, redacted_chunk_count, question from search_logs where id = $1`, [logId])).rows[0];
  const gone = (await db.query(`select (select count(*)::int from documents where id = $1) d, (select count(*)::int from document_chunks where document_id = $1) c`, [targetDoc])).rows[0];
  const excluded = (await db.query(`select reason, redacted_log_count from ingest_exclusions where source_path = $1`, [targetPath])).rows[0];
  check("完全削除：文書とチャンクが消える", gone.d === 0 && gone.c === 0 && result.deleted_chunks === 1, JSON.stringify(result));
  check("完全削除：監査ログから参照が消え、消した数が残る（質問の記録は残る）", after.retrieved_chunk_ids.length === 4 && !after.retrieved_document_ids.includes(targetDoc) && after.redacted_chunk_count === 1 && after.question === "離職率の推移は？", `残り${after.retrieved_chunk_ids.length}件 / 消した数 ${after.redacted_chunk_count}`);
  check("完全削除：取り込み除外に登録される（再取り込みされない）", excluded?.reason === "テスト：誤って取り込んだ" && excluded.redacted_log_count >= 1, JSON.stringify(excluded));

  // 機密扱い：department を「機密」に変えると、元の部署の人には見えなくなる
  const before = (await asUser(U.hr, `select count(*)::int c from documents`)).rows[0].c;
  const toRestrict = (await db.query(`select id from documents where department = '人事' limit 1`)).rows[0].id;
  await db.query(`update documents set department = '機密' where id = $1`, [toRestrict]);
  const afterCount = (await asUser(U.hr, `select count(*)::int c from documents`)).rows[0].c;
  const chunkDept = (await db.query(`select department from document_chunks where document_id = $1`, [toRestrict])).rows[0].department;
  await db.query(`insert into user_departments values ($1, '機密')`, [U.multi]);
  const multiSees = (await asUser(U.multi, `select count(*)::int c from documents where department = '機密'`)).rows[0].c;
  check("機密扱い：元の部署の人には見えなくなり、機密の区分に入っている人には見える", afterCount === before - 1 && chunkDept === "機密" && multiSees === 1, `人事ユーザー ${before}件 → ${afterCount}件 / チャンクの区分 ${chunkDept} / 機密の所属者 ${multiSees}件`);
}

// 要実測としていた懸念：HNSWを使うと部署の条件が後から適用され、件数が足りなくなるか
await db.exec(`set role authenticated; set request.jwt.claim.sub = '${U.hr}'; set enable_seqscan = off;`);
const plan = await db.query(`explain select c.id from document_chunks c where c.department in (select ud.department from user_departments ud where ud.user_id = (select auth.uid())) order by c.embedding <=> '${q}'::vector limit 20`);
const viaIdx = await db.query(`select count(*)::int c from (select c.id from document_chunks c where c.department in (select ud.department from user_departments ud where ud.user_id = (select auth.uid())) order by c.embedding <=> '${q}'::vector limit 20) t`);
await db.exec(`reset enable_seqscan; reset role; reset request.jwt.claim.sub;`);
const usesHnsw = plan.rows.some(x => x["QUERY PLAN"].includes("document_chunks_embedding_idx"));
console.log(`\n[実測] HNSWインデックス使用: ${usesHnsw} / 人事ユーザーが20件要求して返った件数: ${viaIdx.rows[0].c}件（人事の文書は99件ある）`);

console.log(`\n${results.filter(Boolean).length}/${results.length} PASS`);
process.exit(results.every(Boolean) ? 0 : 1);
