/**
 * 1〜2日目の完了確認：各外部サービスに実際に接続できるかを1回ずつ確かめる。
 *   npm run check:connections
 * Embedding APIを1回だけ呼ぶ（数トークン）。Claudeはモデル情報の取得のみで、トークンは消費しない。
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import Anthropic from "@anthropic-ai/sdk";
import { DEPARTMENTS } from "../src/lib/departments";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, embedTexts } from "../src/lib/embeddings";
import { createAdminClient } from "../src/lib/supabase-admin";

type Check = { name: string; run: () => Promise<string> };

const TABLES = ["documents", "document_chunks", "user_departments", "slack_users", "slack_events", "search_logs"];

const checks: Check[] = [
  {
    name: "Supabase: departments（6部署）",
    run: async () => {
      const { data, error } = await createAdminClient().from("departments").select("name");
      if (error) throw new Error(error.message);
      const names = data.map((d) => d.name as string);
      const missing = DEPARTMENTS.filter((d) => !names.includes(d));
      if (missing.length > 0 || names.length !== DEPARTMENTS.length) {
        throw new Error(`部署が一致しません（DB: ${names.join("・")}）`);
      }
      return names.join("・");
    },
  },
  ...TABLES.map((table) => ({
    name: `Supabase: ${table} テーブル`,
    run: async () => {
      const { count, error } = await createAdminClient().from(table).select("*", { count: "exact", head: true });
      if (error) throw new Error(error.message);
      return `接続OK（現在 ${count} 件）`;
    },
  })),
  {
    name: `OpenAI: ${EMBEDDING_MODEL}`,
    run: async () => {
      const [embedding] = await embedTexts(["接続テスト"]);
      if (embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`次元数が ${embedding.length} です（期待: ${EMBEDDING_DIMENSIONS}）`);
      }
      return `${embedding.length} 次元`;
    },
  },
  {
    name: "Supabase: match_document_chunks 関数",
    run: async () => {
      // サービスロールには所属部署がないので0件が返る（＝関数が呼べることと、所属なしでは何も返らないことの確認）
      const { data, error } = await createAdminClient().rpc("match_document_chunks", {
        query_embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01),
        match_count: 1,
        match_threshold: -1,
      });
      if (error) throw new Error(error.message);
      const rows = (data as unknown[]).length;
      if (rows !== 0) throw new Error(`所属のないロールで ${rows} 件返りました（0件であるべき）`);
      return "呼び出しOK（所属なしで0件）";
    },
  },
  {
    name: "Claude: モデル",
    run: async () => {
      const model = process.env.CLAUDE_MODEL || "claude-opus-5-5";
      const info = await new Anthropic().models.retrieve(model);
      return `${info.id}（${info.display_name}）`;
    },
  },
];

async function main() {
  let failed = 0;
  for (const check of checks) {
    try {
      console.log(`✅ ${check.name}: ${await check.run()}`);
    } catch (err) {
      failed++;
      console.log(`❌ ${check.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} 件成功`);
  if (failed > 0) process.exitCode = 1;
}

main();
