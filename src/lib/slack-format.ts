import type { PipelineResult } from "./pipeline";
import { escapeSlack, type SlackMessage } from "./slack";

/** 進み具合の表示。受け付けた直後に出し、処理が進むたびに同じメッセージを書き換える */
export function progressMessage(stage: "accepted" | "searching" | "summarizing", documentCount = 0): SlackMessage {
  const text =
    stage === "summarizing"
      ? `📄 関連する文書が ${documentCount} 件見つかりました。要点をまとめています…`
      : "🔎 考え中…（所属部署の文書を検索しています）";
  return { text };
}

export const USAGE_MESSAGE: SlackMessage = {
  text: "探したい内容を文章で送ってください。例：「製造業向けのDX提案の過去事例は？」\n所属部署の過去の提案書・報告書から、関連する文書と要点をお返しします。",
};

export const ERROR_MESSAGE: SlackMessage = {
  text: "⚠️ 回答の作成中にエラーが発生しました。少し時間をおいて、もう一度お試しください。",
};

export function resultMessage(result: PipelineResult, question?: string): SlackMessage {
  const quote = question ? `> ${escapeSlack(question).replace(/\n/g, "\n> ")}\n\n` : "";

  if (result.status === "unregistered") {
    return { text: `${quote}所属部署が登録されていないため、検索できません。管理者に登録を依頼してください。` };
  }
  if (result.status === "no_match") {
    return { text: `${quote}該当する文書は見つかりませんでした。\n（検索したのは、あなたの所属部署の文書です。言い方を変えると見つかることがあります）` };
  }

  const { answer } = result;
  const blocks: unknown[] = [];
  if (question) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `ご質問：${escapeSlack(question)}` }] });
  blocks.push({ type: "section", text: { type: "mrkdwn", text: escapeSlack(answer.overview) } });
  blocks.push({ type: "divider" });

  answer.documents.forEach((doc, i) => {
    const attrs = [doc.department, doc.client, doc.docYear ? `${doc.docYear}年` : null].filter(Boolean).join("・");
    const citations = doc.citations.map((c) => escapeSlack([c.sectionTitle ?? "前書き", c.pages].filter(Boolean).join(" "))).join(" ／ ");
    // 文書名の太字は rich_text で指定する。mrkdwn の *太字* は、閉じる * の直後が全角の文字（「（」など）だと
    // 太字にならず、* がそのまま表示されてしまうため
    const title = doc.sourceUrl
      ? { type: "link", url: doc.sourceUrl, text: doc.title, style: { bold: true } }
      : { type: "text", text: doc.title, style: { bold: true } };
    blocks.push({
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "text", text: `${i + 1}. `, style: { bold: true } },
            title,
            { type: "text", text: `\n${attrs}\n${doc.summary}` },
          ],
        },
      ],
    });
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `出典：${citations}` }] });
  });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "AIによる要約です。重要な判断の前に原本をご確認ください。続けて質問するときは、このスレッドに返信してください。" }],
  });

  // text は通知・検索用のプレーンテキスト、blocks が実際の表示
  return { text: `${answer.overview}（関連文書 ${answer.documents.length} 件）`, blocks };
}
