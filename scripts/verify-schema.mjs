// supabase/schema.sql を組み込みPostgres（PGlite＋pgvector）で実行し、部署別の閲覧制限を検証する。
// 実行: npm run verify:schema
// authスキーマ・ロール・auth.uid() はSupabaseの代用を冒頭で作っている（本番のSupabaseでは不要）。

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { readFileSync } from "node:fs";

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
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}  →  ${detail}`); };
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

// 要実測としていた懸念：HNSWを使うと部署の条件が後から適用され、件数が足りなくなるか
await db.exec(`set role authenticated; set request.jwt.claim.sub = '${U.hr}'; set enable_seqscan = off;`);
const plan = await db.query(`explain select c.id from document_chunks c where c.department in (select ud.department from user_departments ud where ud.user_id = (select auth.uid())) order by c.embedding <=> '${q}'::vector limit 20`);
const viaIdx = await db.query(`select count(*)::int c from (select c.id from document_chunks c where c.department in (select ud.department from user_departments ud where ud.user_id = (select auth.uid())) order by c.embedding <=> '${q}'::vector limit 20) t`);
await db.exec(`reset enable_seqscan; reset role; reset request.jwt.claim.sub;`);
const usesHnsw = plan.rows.some(x => x["QUERY PLAN"].includes("document_chunks_embedding_idx"));
console.log(`\n[実測] HNSWインデックス使用: ${usesHnsw} / 人事ユーザーが20件要求して返った件数: ${viaIdx.rows[0].c}件（人事の文書は99件ある）`);

console.log(`\n${results.filter(Boolean).length}/${results.length} PASS`);
process.exit(results.every(Boolean) ? 0 : 1);
