import OpenAI from "openai";

/**
 * Embeddingの呼び出しはこのファイルだけに閉じ込める。
 * 外部Embedding APIへの送信はクライアント情シスへの追加確認事項で、不許可の場合は
 * Bedrock上のEmbeddingに差し替える。その際に直すのはこのファイルだけにするため、
 * 他のファイルから openai パッケージを直接importしない。
 */
export const EMBEDDING_MODEL = "text-embedding-3-large";
// pgvectorのHNSWインデックスは2000次元が上限のため、ネイティブの3072次元ではなく1536次元に縮小する（supabase/schema.sqlのvector(1536)と一致させる）
export const EMBEDDING_DIMENSIONS = 1536;
const BATCH_SIZE = 20;

let cachedClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!cachedClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY が設定されていません（.env.local を確認してください）");
    }
    // 一括取り込みでは送信量の上限（429）に当たりやすい。SDKが待ち時間を空けて自動で再試行する回数を増やしておく
    cachedClient = new OpenAI({ apiKey, maxRetries: 6 });
  }
  return cachedClient;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const openai = getOpenAIClient();
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    results.push(...res.data.map((d) => d.embedding));
  }

  return results;
}
