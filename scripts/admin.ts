/**
 * 管理者用のコマンド（機密文書の取り扱いと、監査ログの確認）。管理画面の代わり。
 * 手順は docs/ガバナンス手順書.md を参照。
 *
 *   npm run admin -- documents [部署]                      取り込み済みの文書を一覧する
 *   npm run admin -- restrict <文書ID>                     文書を機密扱いにする（区分を「機密」に変える）
 *   npm run admin -- set-department <文書ID> <部署>        文書の部署・区分を変える
 *   npm run admin -- delete <文書ID> "<理由>"              文書を完全に削除する（監査ログからも参照を消す）
 *   npm run admin -- audit [--user <SlackユーザーID>] [--since 2026-10-01] [--document <文書ID>]
 *                                                          監査ログを確認する
 *   npm run admin -- report [2026-10]                      利用状況の月次レポートを表示する（省略時は先月）
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { buildAuditReport, formatAuditReport, previousMonth } from "../src/lib/audit-report";
import { ACCESS_GROUPS, RESTRICTED_GROUP } from "../src/lib/departments";
import { INCOMING_BUCKET } from "../src/lib/document-source";
import { createAdminClient } from "../src/lib/supabase-admin";

const admin = createAdminClient();

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function getDocument(id: string) {
  const { data, error } = await admin.from("documents").select("id, title, filename, department, source_path").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`文書が見つかりません: ${id}（npm run admin -- documents でIDを確認してください）`);
  return data;
}

async function setDepartment(id: string, department: string) {
  if (!ACCESS_GROUPS.includes(department)) throw new Error(`指定できるのは ${ACCESS_GROUPS.join(" / ")} です`);
  const doc = await getDocument(id);
  // チャンクの区分は複合外部キー（on update cascade）で一緒に変わる
  const { error } = await admin.from("documents").update({ department }).eq("id", id);
  if (error) throw new Error(error.message);
  const { count } = await admin.from("document_chunks").select("*", { count: "exact", head: true }).eq("document_id", id).eq("department", department);
  console.log(`✅ 「${doc.title}」の区分を ${doc.department} → ${department} に変更しました（チャンク ${count} 件も変更済み）`);
  console.log(`   以後、${department} に所属する人だけが検索できます。`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "documents") {
    let query = admin.from("documents").select("id, title, department, file_type, uploaded_at").order("department").order("title");
    if (args[0]) query = query.eq("department", args[0]);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    for (const d of data) console.log(`${d.id}  [${d.department}] ${d.title}（${d.file_type}・${String(d.uploaded_at).slice(0, 10)}）`);
    console.log(`\n${data.length} 件`);
  } else if (command === "restrict") {
    await setDepartment(args[0], RESTRICTED_GROUP);
  } else if (command === "set-department") {
    await setDepartment(args[0], args[1]);
  } else if (command === "delete") {
    const [id, reason] = args;
    if (!reason) throw new Error('理由を指定してください（例: npm run admin -- delete <文書ID> "契約上、取り込み不可の文書だった"）');
    const doc = await getDocument(id);
    const { data, error } = await admin.rpc("delete_document_with_redaction", { p_document_id: id, p_reason: reason });
    if (error) throw new Error(error.message);
    const result = data as { deleted_chunks: number; redacted_logs: number; source_path: string };
    console.log(`✅ 「${doc.title}」を完全に削除しました`);
    console.log(`   チャンク ${result.deleted_chunks} 件を削除 ／ 監査ログ ${result.redacted_logs} 件から参照を削除 ／ 取り込み除外に登録`);

    // 取り込み元（SharePointの代わりの置き場所）にあるファイルも消す
    const prefix = `storage://${INCOMING_BUCKET}/`;
    if (result.source_path.startsWith(prefix)) {
      const { error: removeError } = await admin.storage.from(INCOMING_BUCKET).remove([result.source_path.slice(prefix.length)]);
      console.log(removeError ? `   ⚠️ 取り込み元のファイルを削除できませんでした: ${removeError.message}` : "   取り込み元のファイルも削除しました");
    } else {
      console.log(`   ⚠️ 取り込み元の原本（${result.source_path}）は自動では消えません。保管場所から手作業で削除してください`);
    }
    console.log("   ※ 質問文そのものに機密の内容が書かれていないかは、次で確認できます:");
    console.log(`      npm run admin -- audit --since ${String(new Date().getFullYear())}-01-01`);
  } else if (command === "audit") {
    let query = admin
      .from("search_logs")
      .select("created_at, slack_user_id, departments, question, status, channel, retrieved_document_ids, result_document_ids, redacted_chunk_count")
      .order("created_at", { ascending: false })
      .limit(Number(option("--limit") ?? 50));
    const user = option("--user");
    const since = option("--since");
    const document = option("--document");
    if (user) query = query.eq("slack_user_id", user);
    if (since) query = query.gte("created_at", `${since}T00:00:00+09:00`);
    if (document) query = query.contains("retrieved_document_ids", [document]);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    for (const row of data.reverse()) {
      const when = new Date(row.created_at as string).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
      const redacted = row.redacted_chunk_count > 0 ? ` ／ 削除済み文書への参照 ${row.redacted_chunk_count} 件を消去` : "";
      console.log(`${when}  ${row.slack_user_id ?? "-"}  [${(row.departments as string[]).join("・") || "所属なし"}]  ${row.status}（${row.channel}）`);
      console.log(`   質問: ${row.question}`);
      console.log(`   取り出した文書 ${(row.retrieved_document_ids as string[]).length} 件 ／ 回答に挙げた文書 ${(row.result_document_ids as string[]).length} 件${redacted}`);
    }
    console.log(`\n${data.length} 件（新しい順に最大 ${option("--limit") ?? 50} 件を、古い順で表示）`);
  } else if (command === "report") {
    const target = args[0]?.match(/^(\d{4})-(\d{2})$/);
    const { year, month } = target ? { year: Number(target[1]), month: Number(target[2]) } : previousMonth();
    console.log(formatAuditReport(await buildAuditReport(year, month)));
  } else {
    console.error("使い方: npm run admin -- <documents | restrict | set-department | delete | audit | report>（詳しくは scripts/admin.ts の冒頭）");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
