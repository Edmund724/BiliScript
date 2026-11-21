import { DEFAULT_AI_SYSTEM_PROMPT } from "../core/default-prompts.js";
import { normalizeImageParts } from "./conversation.js";
import { buildSubtitlePrompt } from "./subtitle-prompt.js";
import type { AiContext, ChatMessage, ImagePart } from "./types.js";

interface BuildMessagesInput {
  context?: AiContext | null;
  userPrompt?: unknown;
  history?: unknown[];
  systemPrompt?: unknown;
  includeToolHistory?: boolean;
  images?: ImagePart[];
}

function formatImagePlaceholder(count: number): string {
  return count === 1 ? "[用户曾发送一张图片]" : `[用户曾发送 ${count} 张图片]`;
}

function replaceEarlierImages(historyMessages: ChatMessage[], hasCurrentImages: boolean): ChatMessage[] {
  let keepIndex = -1;
  if (!hasCurrentImages) {
    for (let i = historyMessages.length - 1; i >= 0; i -= 1) {
      if (normalizeImageParts(historyMessages[i].images)?.length) {
        keepIndex = i;
        break;
      }
    }
  }
  return historyMessages.map((message, index) => {
    const parts = normalizeImageParts(message.images);
    if (!parts || index === keepIndex) {
      return message;
    }
    const placeholder = formatImagePlaceholder(parts.length);
    const { images: _replaced, ...rest } = message;
    return { ...rest, content: message.content ? `${message.content}\n\n${placeholder}` : placeholder };
  });
}

export function buildMessages({ context, userPrompt, history, systemPrompt, includeToolHistory, images }: BuildMessagesInput = {}): ChatMessage[] {
  const ctx = context || {};
  const sections: string[] = [];

  const customSystemPrompt = String(systemPrompt || "").trim();
  sections.push(customSystemPrompt || DEFAULT_AI_SYSTEM_PROMPT);

  sections.push(
    `当前用户正在看一个视频，标题：「${ctx.title || "未知"}」`,
    `作者：${ctx.author || "未知"} | 上传日期：${ctx.uploadDate || "未知"}`
  );

  const hybridRetrieval = String(ctx.hybridRetrievalMarkdown || "");
  const compressedSummary = String(ctx.compressedSummaryMarkdown || "");
  const subtitleText =
    hybridRetrieval ||
    compressedSummary ||
    buildSubtitlePrompt({
      body: ctx.subtitleBody,
      chapters: ctx.chapters,
      videoDuration: ctx.videoDuration,
      includeTimestampInBody: ctx.includeTimestampInBody
    });
  if (subtitleText) {
    sections.push(
      hybridRetrieval
        ? `以下是本视频的章节目录与按需召回的原始字幕片段（含精确时间戳，非全片逐字全文）：\n\n${subtitleText}`
        : compressedSummary
          ? `以下是本视频此前的整理成果（分段小结与成稿笔记，非逐字字幕）：\n\n${subtitleText}`
          : `以下是视频的字幕全文：\n\n${subtitleText}`
    );
  } else {
    sections.push("（暂无字幕）");
  }

  let historyMessages: ChatMessage[] = [];
  if (Array.isArray(history)) {
    historyMessages = history.filter(function (m: unknown) {
      const item = m as { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown };
      if (!item) return false;
      if (includeToolHistory) {
        if (item.role === "assistant" && Array.isArray(item.tool_calls) && item.tool_calls.length) {
          return true;
        }
        if (item.role === "tool" && typeof item.tool_call_id === "string" && typeof item.content === "string") {
          return true;
        }
      }
      if (item.role === "tool") return false;
      if (item.role === "assistant" && !item.content && item.tool_calls != null) return false;
      return (item.role === "user" || item.role === "assistant") && typeof item.content === "string";
    }) as ChatMessage[];
  }

  historyMessages = replaceEarlierImages(historyMessages, Boolean(images?.length));

  const frameContextNote = String(ctx.frameContextNote || "").trim();
  const promptText = String(userPrompt || "");
  const userMessage: ChatMessage = {
    role: "user",
    content: frameContextNote ? `${promptText}\n\n${frameContextNote}` : promptText
  };
  if (images?.length) {
    userMessage.images = images;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: sections.join("\n\n") },
    ...historyMessages,
    userMessage
  ];
  return messages;
}
