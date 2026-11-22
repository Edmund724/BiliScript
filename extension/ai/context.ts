import { DEFAULT_AI_SYSTEM_PROMPT } from "../core/default-prompts.js";
import { normalizeImageParts } from "./conversation.js";
import { buildSubtitlePrompt } from "./subtitle-prompt.js";
import type { AiContext, ChatMessage, ChatToolCall, ImagePart, ThinkingBlock } from "./types.js";

interface BuildMessagesInput {
  context?: AiContext | null;
  userPrompt?: unknown;
  history?: unknown[];
  systemPrompt?: unknown;
  includeToolHistory?: boolean;
  images?: ImagePart[];
}

function isChatToolCall(value: unknown): value is ChatToolCall {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const fn = item.function as Record<string, unknown> | undefined;
  return (
    typeof item.id === "string" &&
    item.type === "function" &&
    Boolean(fn && typeof fn === "object" && typeof fn.name === "string" && typeof fn.arguments === "string")
  );
}

function isThinkingBlock(value: unknown): value is ThinkingBlock {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (item.type === "thinking") {
    return typeof item.thinking === "string" && typeof item.signature === "string";
  }
  if (item.type === "redacted_thinking") {
    return typeof item.data === "string";
  }
  return false;
}

function pickOptionalMessageFields(item: Record<string, unknown>): Partial<ChatMessage> {
  const extra: Partial<ChatMessage> = {};
  const images = normalizeImageParts(item.images);
  if (images) extra.images = images;
  if (typeof item.thoughtSignature === "string") extra.thoughtSignature = item.thoughtSignature;
  if (Array.isArray(item.thinkingBlocks)) {
    const blocks = item.thinkingBlocks.filter(isThinkingBlock);
    if (blocks.length) extra.thinkingBlocks = blocks;
  }
  if (Array.isArray(item.parts)) extra.parts = item.parts;
  if (typeof item.thinking === "string") extra.thinking = item.thinking;
  if (typeof item.stopped === "boolean") extra.stopped = item.stopped;
  return extra;
}

function projectHistoryMessage(raw: unknown, includeToolHistory: boolean): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const role = item.role;

  if (includeToolHistory) {
    if (role === "assistant" && Array.isArray(item.tool_calls)) {
      const toolCalls = item.tool_calls.filter(isChatToolCall);
      if (toolCalls.length > 0) {
        return {
          role: "assistant",
          content: typeof item.content === "string" ? item.content : "",
          tool_calls: toolCalls,
          ...pickOptionalMessageFields(item)
        };
      }
    }
    if (role === "tool" && typeof item.tool_call_id === "string" && typeof item.content === "string") {
      return {
        role: "tool",
        content: item.content,
        tool_call_id: item.tool_call_id,
        ...pickOptionalMessageFields(item)
      };
    }
  }

  if (role === "tool") return null;
  if (role === "assistant" && !item.content && item.tool_calls != null) return null;
  if ((role === "user" || role === "assistant") && typeof item.content === "string") {
    return {
      role,
      content: item.content,
      ...pickOptionalMessageFields(item)
    };
  }
  return null;
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

  let historyMessages: ChatMessage[] = Array.isArray(history)
    ? history.flatMap((m) => {
        const projected = projectHistoryMessage(m, Boolean(includeToolHistory));
        return projected ? [projected] : [];
      })
    : [];

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
