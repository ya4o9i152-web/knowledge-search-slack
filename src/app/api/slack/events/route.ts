import { after } from "next/server";
import { defaultDeps, handleSlackRequest } from "@/lib/slack-events";

// レスポンス後に after() で実行する検索と要約が収まる時間（合格基準は回答まで60秒以内）
export const maxDuration = 120;

export async function POST(request: Request) {
  // 署名は「受け取ったままの本文」で検証するため、先に text() で読む（json() で読むと元の文字列が失われる）
  const rawBody = await request.text();
  return handleSlackRequest(
    rawBody,
    {
      timestamp: request.headers.get("x-slack-request-timestamp"),
      signature: request.headers.get("x-slack-signature"),
    },
    defaultDeps((task) => after(task)),
  );
}
