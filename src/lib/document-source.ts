import { detectFileType } from "./extract";
import { createAdminClient } from "./supabase-admin";

/** 取り込み元にあるファイル1件 */
export type SourceFile = {
  /** documents.source_path に入れる値。取り込み済みかどうかの判定に使うので、同じファイルなら常に同じ値にする */
  sourcePath: string;
  filename: string;
  /** 原本を開くリンク（無ければ null） */
  sourceUrl: string | null;
};

/**
 * 文書の取り込み元。月次取り込みはこのインターフェースだけを使う。
 *
 * いまは Supabase Storage の「取り込み待ち」バケットを取り込み元にしている。
 * クライアントのSharePointに接続するときは、Microsoft Graph API で同じ2つの操作
 * （一覧と取得）を実装した SharePointSource を作り、getDocumentSource() の返り値を差し替える。
 */
export interface DocumentSource {
  list(): Promise<SourceFile[]>;
  download(file: SourceFile): Promise<Buffer>;
}

export const INCOMING_BUCKET = "incoming";
const SOURCE_PREFIX = `storage://${INCOMING_BUCKET}/`;

class SupabaseStorageSource implements DocumentSource {
  private async listFolder(folder: string): Promise<string[]> {
    const storage = createAdminClient().storage.from(INCOMING_BUCKET);
    const paths: string[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await storage.list(folder, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Error(`取り込み元の一覧に失敗: ${error.message}`);
      for (const entry of data) {
        const path = folder ? `${folder}/${entry.name}` : entry.name;
        // id が無いものはフォルダ。中をたどる
        if (entry.id === null) paths.push(...(await this.listFolder(path)));
        else paths.push(path);
      }
      if (data.length < 1000) break;
    }
    return paths;
  }

  async list(): Promise<SourceFile[]> {
    const paths = await this.listFolder("");
    return paths
      .filter((path) => detectFileType(path) !== null)
      .map((path) => ({ sourcePath: `${SOURCE_PREFIX}${path}`, filename: path.split("/").pop()!, sourceUrl: null }));
  }

  async download(file: SourceFile): Promise<Buffer> {
    const path = file.sourcePath.slice(SOURCE_PREFIX.length);
    const { data, error } = await createAdminClient().storage.from(INCOMING_BUCKET).download(path);
    if (error) throw new Error(`ファイルの取得に失敗: ${error.message}`);
    return Buffer.from(await data.arrayBuffer());
  }
}

export function getDocumentSource(): DocumentSource {
  return new SupabaseStorageSource();
}
