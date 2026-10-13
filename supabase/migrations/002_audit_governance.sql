-- ===========================================================
-- 002: 監査ログの強化と、機密文書の取り扱い（ガバナンス）
-- schema.sql を実行済みのデータベースに、追加で実行する。何度実行しても同じ結果になる。
-- ===========================================================

-- -----------------------------------------------------------
-- 1. 監査ログ：「どの文書が検索で取り出されたか」まで記録する
-- -----------------------------------------------------------

alter table search_logs
  add column if not exists retrieved_chunk_ids uuid[] not null default '{}',     -- 検索で取り出したチャンク（Claudeに渡したもの）
  add column if not exists retrieved_document_ids uuid[] not null default '{}',  -- 上のチャンクが属する文書
  add column if not exists channel text not null default 'slack',                -- どこからの質問か（slack / cli）
  add column if not exists redacted_chunk_count int not null default 0;          -- 文書の完全削除にともなって、この行から消したチャンクIDの数

-- result_document_ids は「回答に挙げた文書」。retrieved_document_ids は「検索で取り出した文書」。
-- 回答に挙げなかった文書も、質問者に関連する候補としてAIに渡っているので、監査では両方を追えるようにする

-- 検索した時点で 'searched' として記録し、回答が終わったら answered / no_match / error に更新する
alter table search_logs drop constraint if exists search_logs_status_check;
alter table search_logs add constraint search_logs_status_check
  check (status in ('searched', 'answered', 'no_match', 'unregistered', 'error'));

create index if not exists search_logs_user_created_idx on search_logs (user_id, created_at desc);

-- 監査ログを書く関数。検索関数（下の search_documents_logged）の中からだけ呼ぶ。
-- security definer：質問者本人（authenticated）には search_logs への書き込み権限を与えていないため、
-- この関数の中でだけ、決まった形の1行を書けるようにする。
-- user_id と所属部署は引数で受け取らず、auth.uid() から引く（他人になりすました記録を作れないようにする）
create or replace function record_search_log (
  p_question text,
  p_slack_user_id text,
  p_channel text,
  p_chunk_ids uuid[],
  p_document_ids uuid[]
)
returns uuid
language sql volatile
security definer
set search_path = public
as $$
  insert into search_logs (user_id, slack_user_id, question, departments, retrieved_chunk_ids, retrieved_document_ids, status, channel)
  values (
    auth.uid(),
    p_slack_user_id,
    p_question,
    coalesce((select array_agg(ud.department order by ud.department) from user_departments ud where ud.user_id = auth.uid()), '{}'),
    p_chunk_ids,
    p_document_ids,
    'searched',
    p_channel
  )
  returning id;
$$;

revoke all on function record_search_log from public;
grant execute on function record_search_log to authenticated;

-- 検索と監査ログの記録を、1回の呼び出し（＝1つのトランザクション）で行う関数。
-- 検索パイプラインは match_document_chunks を直接呼ばず、必ずこちらを呼ぶ。
--
-- 検索のあとに別の呼び出しでログを書くと、その間で失敗したときに「検索結果は返ったのに記録が無い」
-- 状態になりうる。1つの関数にまとめることで、ログが書けなければ検索結果も返らない。
-- 0件のときも記録を残すため、結果が無い場合は log_id だけが入った行を1行返す。
create or replace function search_documents_logged (
  query_embedding vector(1536),
  p_question text,
  p_slack_user_id text,
  p_channel text default 'slack',
  match_count int default 20,
  match_threshold float default 0.3
)
returns table (
  log_id uuid,
  chunk_id uuid,
  document_id uuid,
  title text,
  filename text,
  department text,
  client text,
  doc_year int,
  source_url text,
  section_title text,
  page_start int,
  page_end int,
  content text,
  similarity float
)
language sql volatile
security invoker
as $$
  with hits as materialized (
    select * from match_document_chunks(query_embedding, match_count, match_threshold)
  ),
  logged as materialized (
    select record_search_log(
      p_question,
      p_slack_user_id,
      p_channel,
      coalesce((select array_agg(h.chunk_id) from hits h), '{}'::uuid[]),
      coalesce((select array_agg(distinct h.document_id) from hits h), '{}'::uuid[])
    ) as log_id
  )
  select
    l.log_id, h.chunk_id, h.document_id, h.title, h.filename, h.department, h.client, h.doc_year,
    h.source_url, h.section_title, h.page_start, h.page_end, h.content, h.similarity
  from logged l
  left join hits h on true
  order by h.similarity desc nulls last;
$$;

grant execute on function search_documents_logged to authenticated;

-- -----------------------------------------------------------
-- 2. 機密扱い：限られた人だけが見られる区分を追加する
-- -----------------------------------------------------------

-- 「機密」は部署ではなく閲覧区分だが、仕組みは部署と同じ（この区分に所属する人だけが読める）。
-- 文書を機密扱いにするには、文書の department を「機密」に変える（チャンクは複合外部キーで追従する）
insert into departments (name) values ('機密') on conflict (name) do nothing;

-- -----------------------------------------------------------
-- 3. 完全削除：文書を消し、監査ログからも参照を消し、二度と取り込まれないようにする
-- -----------------------------------------------------------

-- 削除した文書の記録。取り込み元にファイルが残っていても、ここにある source_path は定期取り込みで読み飛ばす
create table if not exists ingest_exclusions (
  source_path text primary key,
  document_id uuid,                -- 削除した文書のID（文書名は残さない。機密の文書名そのものが情報になるため）
  department text,
  reason text,
  redacted_log_count int not null default 0,  -- 参照を消した監査ログの行数
  excluded_at timestamptz not null default now()
);

alter table ingest_exclusions enable row level security;
grant select, insert, update, delete on ingest_exclusions to service_role;

-- 文書の完全削除。次の4つを1つのトランザクションで行う（途中で失敗したら、何も変わらない）。
--  1. 取り込み除外に登録する（取り込み元にファイルが残っていても再取り込みされない）
--  2. 監査ログから、この文書のチャンクIDと文書IDを取り除く（redact）。取り除いた数は redacted_chunk_count に残す
--  3. 文書を削除する（チャンクは外部キーの on delete cascade で一緒に消える）
--  4. 結果を返す
-- 監査ログの行そのもの（誰が・いつ・何を質問したか）は消さない。質問文に機密の内容が書かれている場合は、
-- ガバナンス手順書の手順に従って個別に確認する
create or replace function delete_document_with_redaction (p_document_id uuid, p_reason text)
returns jsonb
language plpgsql volatile
security invoker
as $$
declare
  v_doc documents%rowtype;
  v_chunk_ids uuid[];
  v_redacted int;
begin
  select * into v_doc from documents where id = p_document_id;
  if not found then
    raise exception '文書が見つかりません: %', p_document_id;
  end if;

  select coalesce(array_agg(id), '{}') into v_chunk_ids from document_chunks where document_id = p_document_id;

  update search_logs
  set
    redacted_chunk_count = redacted_chunk_count
      + coalesce(array_length(array(select unnest(retrieved_chunk_ids) intersect select unnest(v_chunk_ids)), 1), 0),
    retrieved_chunk_ids = array(select unnest(retrieved_chunk_ids) except select unnest(v_chunk_ids)),
    retrieved_document_ids = array_remove(retrieved_document_ids, p_document_id),
    result_document_ids = array_remove(result_document_ids, p_document_id)
  where retrieved_chunk_ids && v_chunk_ids
     or p_document_id = any(retrieved_document_ids)
     or p_document_id = any(result_document_ids);
  get diagnostics v_redacted = row_count;

  insert into ingest_exclusions (source_path, document_id, department, reason, redacted_log_count)
  values (v_doc.source_path, v_doc.id, v_doc.department, p_reason, v_redacted)
  on conflict (source_path) do update
    set document_id = excluded.document_id, department = excluded.department, reason = excluded.reason,
        redacted_log_count = excluded.redacted_log_count, excluded_at = now();

  delete from documents where id = p_document_id;

  return jsonb_build_object(
    'source_path', v_doc.source_path,
    'department', v_doc.department,
    'deleted_chunks', coalesce(array_length(v_chunk_ids, 1), 0),
    'redacted_logs', v_redacted
  );
end;
$$;

revoke all on function delete_document_with_redaction from public;
grant execute on function delete_document_with_redaction to service_role;
