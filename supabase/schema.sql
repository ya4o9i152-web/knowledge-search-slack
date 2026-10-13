-- ===========================================================
-- ナレッジ検索AI（Slack連携）スキーマ
-- 取り込みパイプラインが書き込み、検索パイプラインが読み込む共通スキーマ
-- ===========================================================

-- pgvector拡張を有効化
create extension if not exists vector;

-- ===========================================================
-- 1. 部署・文書・チャンク
-- ===========================================================

-- 部署マスタ（6部署）。表記ゆれ（「IT」と「ＩＴ」等）で閲覧制限が外れるのを防ぐため、
-- 文書・所属の部署はこのテーブルへの外部キーにする
create table if not exists departments (
  name text primary key
);

insert into departments (name) values
  ('戦略'), ('業務'), ('IT'), ('人事'), ('営業'), ('管理')
on conflict (name) do nothing;

-- 文書テーブル。1ファイル＝1行。部署はここが正
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  title text not null,                -- 文書タイトル（出典表示・チャンクの文脈付与に使う）
  department text not null references departments(name),  -- 戦略/業務/IT/人事/営業/管理
  client text,                        -- 客先（文書冒頭のメタデータ行から抽出）
  doc_year int,                       -- 作成年
  confidentiality text,               -- 機密度（例: 社外秘）。MVPでは閲覧制限に使わない（役職階層はPhase 2）
  file_type text not null check (file_type in ('pdf', 'docx')),
  source_path text not null unique,   -- SharePoint上のパス。月次取り込みで同じファイルを二重に取り込まないためのキー
  source_url text,                    -- 原本を開くリンク（出典表示用）
  uploaded_at timestamptz not null default now(),
  -- チャンク側の部署を文書の部署と必ず一致させるための複合キー（下のdocument_chunksの外部キーが参照する）
  unique (id, department)
);

-- チャンクテーブル。1セクション＝1チャンク（長いセクションは段落境界で再分割）
create table if not exists document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  -- 部署を文書から複製して持つ。検索関数とRLSが文書テーブルを結合せずに部署で絞れるようにするため。
  -- 複合外部キーにより、文書の部署と食い違う値は入らない（文書の部署を変えるとチャンクも追従する）
  department text not null,
  chunk_index int not null,           -- 同一文書内でのチャンクの順序
  section_title text,                 -- セクション見出し（例: 4. ROI 試算）
  page_start int,                     -- セクションが複数ページにまたがるため、開始・終了の両方を持つ
  page_end int,
  content text not null,              -- 出典表示・Claudeに渡す本文
  embedding vector(1536) not null,    -- OpenAI text-embedding-3-large（dimensions=1536で生成）。pgvectorのHNSWインデックスは2000次元が上限のため、ネイティブの3072次元ではなくAPI呼び出し時に縮小する
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index),
  foreign key (document_id, department)
    references documents (id, department)
    on update cascade
    on delete cascade
);

-- ベクトル類似検索用インデックス（コサイン類似度）
create index if not exists document_chunks_embedding_idx
  on document_chunks using hnsw (embedding vector_cosine_ops);

create index if not exists document_chunks_department_idx
  on document_chunks (department);

-- ===========================================================
-- 2. ユーザーと所属部署
-- ===========================================================

-- ユーザーの所属部署。多対多（兼務・全部署を見てよい人は複数行を持つ）
create table if not exists user_departments (
  user_id uuid not null references auth.users(id) on delete cascade,
  department text not null references departments(name),
  primary key (user_id, department)
);

-- SlackユーザーIDとauth.usersの対応表。
-- Slackボットはこの表でSlackの発言者をauth.usersのユーザーに引き当て、そのユーザーとして検索する
-- （サービスロールで検索するとRLSが効かないため）
create table if not exists slack_users (
  slack_user_id text primary key,     -- 例: U0123ABCD
  user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

-- ===========================================================
-- 3. 部署別アクセス制御（RLS）
-- ===========================================================

alter table departments enable row level security;
alter table documents enable row level security;
alter table document_chunks enable row level security;
alter table user_departments enable row level security;
alter table slack_users enable row level security;

-- 部署マスタは認証済みユーザーなら読める（機密情報を含まない）
create policy "departments_readable"
  on departments for select
  to authenticated
  using (true);

-- 自分の所属だけ読める。
-- 下の2つのポリシーは「自分の所属部署」をこのテーブルから引くため、このポリシーがないと
-- サブクエリが0行になり、どの文書も見えなくなる
create policy "own_departments"
  on user_departments for select
  to authenticated
  using (user_id = (select auth.uid()));

-- 自分の所属部署の文書だけ閲覧可
create policy "department_scoped"
  on documents for select
  to authenticated
  using (
    department in (
      select ud.department from user_departments ud
      where ud.user_id = (select auth.uid())
    )
  );

-- チャンクも同じ条件で制御する。
-- pgvectorの類似検索は通常のSQLなので、このポリシーがベクトル検索にもそのまま適用される
create policy "chunks_department_scoped"
  on document_chunks for select
  to authenticated
  using (
    department in (
      select ud.department from user_departments ud
      where ud.user_id = (select auth.uid())
    )
  );

-- slack_usersにはauthenticated向けのポリシーを作らない（サービスロールだけが読み書きする）

-- ===========================================================
-- 4. 検索関数
-- ===========================================================

-- 類似チャンク検索関数。検索パイプラインは、質問者本人のトークンでこの関数をRPC呼び出しする。
--
-- ・security invoker（既定）のまま使う。security definerにするとRLSが効かなくなる
-- ・部署の絞り込みは、where句（この関数）とRLS（上のポリシー）の二重にしている。
--   片方を書き換えても、もう片方が残る
-- ・返すのはチャンク。「上位5文書」はアプリ側で文書単位にまとめて作るため、
--   match_countは5より多め（既定20）に取る
-- ・match_thresholdはノイズ除去程度（案件3の実測で0.7は厳しすぎた）。
--   「関連あり/なし」の最終判断はClaudeへのプロンプト側に委ねる
-- ・hnsw.iterative_scan（pgvector 0.8.0以降）を必ず有効にする。
--   HNSWインデックスは近傍を取り出した「後」に部署の条件を適用するため、既定のままだと
--   1部署が全体の6分の1のとき、20件要求しても4件しか返らなかった（1,800チャンクでの実測）。
--   反復スキャンを有効にすると、件数が埋まるまでインデックスを読み進めて20件返る。
--   relaxed_orderは順序がわずかに前後しうるため、外側で距離順に並べ直している。
--   ※pgvectorが0.8.0未満だとこの関数の作成に失敗する。
--     select extversion from pg_extension where extname = 'vector'; で確認すること
create or replace function match_document_chunks (
  query_embedding vector(1536),
  match_count int default 20,
  match_threshold float default 0.3
)
returns table (
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
language sql stable
security invoker
set hnsw.iterative_scan = relaxed_order
as $$
  with nearest as materialized (
    select
      c.id,
      c.document_id,
      c.department,
      c.section_title,
      c.page_start,
      c.page_end,
      c.content,
      c.embedding <=> query_embedding as distance
    from document_chunks c
    where c.department in (
        select ud.department from user_departments ud
        where ud.user_id = (select auth.uid())
      )
      and 1 - (c.embedding <=> query_embedding) > match_threshold
    order by c.embedding <=> query_embedding
    limit match_count
  )
  select
    n.id,
    n.document_id,
    d.title,
    d.filename,
    n.department,
    d.client,
    d.doc_year,
    d.source_url,
    n.section_title,
    n.page_start,
    n.page_end,
    n.content,
    1 - n.distance as similarity
  from nearest n
  join documents d on d.id = n.document_id
  order by n.distance;
$$;

-- ===========================================================
-- 5. Slack連携・検索ログ（サービスロールだけが読み書きする）
-- ===========================================================

-- Slackイベントの重複排除。Slackは3秒以内に200が返らないと同じイベントを再送するため、
-- event_idを主キーにして、挿入に成功したときだけ処理する
create table if not exists slack_events (
  event_id text primary key,
  received_at timestamptz not null default now()
);

-- 検索ログ。誰が・いつ・何を検索し・どの文書が返ったか
create table if not exists search_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  slack_user_id text,
  question text not null,
  departments text[] not null default '{}',          -- 検索時点の所属部署
  result_document_ids uuid[] not null default '{}',  -- 回答に使った文書
  status text not null check (status in ('answered', 'no_match', 'unregistered', 'error')),
  latency_ms int,                                    -- 質問の受信から回答の投稿まで（合格基準: 60秒以内）
  created_at timestamptz not null default now()
);

create index if not exists search_logs_created_at_idx
  on search_logs (created_at desc);

alter table slack_events enable row level security;
alter table search_logs enable row level security;

-- ===========================================================
-- 6. 権限
-- ===========================================================

-- 「Automatically expose new tables」をOFFにしている前提のため、テーブル権限を明示的に付与する
-- （service_roleはRLSをバイパスするが、テーブルへのGRANT自体は別途必要。案件3の教訓）
grant select, insert, update, delete on
  departments, documents, document_chunks, user_departments, slack_users, slack_events, search_logs
  to service_role;

-- 質問者本人のトークン（authenticated）に許すのは読み取りだけ
grant select on departments, documents, document_chunks, user_departments to authenticated;

grant execute on function match_document_chunks to authenticated, service_role;
