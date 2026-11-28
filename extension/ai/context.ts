import {
  DEFAULT_AI_SYSTEM_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V5,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V6,
  getDefaultAiSystemPrompt
} from "../core/default-prompts.js";
import { detectSiteFromUrl, normalizeSiteId, type SiteId } from "../shared/site.js";
import {
  buildSummaryAnchorTurnPair,
  foldHistoricalToolResults,
  sliceActiveHistoryWithFallback,
  type SummaryAnchorLike
} from "./compaction.js";
import { normalizeImageParts } from "./conversation.js";
import { buildSubtitlePrompt } from "./subtitle-prompt.js";
import type { AiContext, ChatMessage, ChatToolCall, ImagePart, ThinkingBlock } from "./types.js";

export { getDefaultAiSystemPrompt };

const BUILTIN_DEFAULT_AI_SYSTEM_PROMPTS = new Set<string>([
  DEFAULT_AI_SYSTEM_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V5,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V6
]);

function resolveContextSite(ctx: AiContext): SiteId {
  return normalizeSiteId(ctx.site ?? (ctx.url ? detectSiteFromUrl(ctx.url) : undefined));
}

function resolveAiSystemPrompt(systemPrompt: unknown, site: SiteId): string {
  const customSystemPrompt = String(systemPrompt || "").trim();
  if (!customSystemPrompt || BUILTIN_DEFAULT_AI_SYSTEM_PROMPTS.has(customSystemPrompt)) {
    return getDefaultAiSystemPrompt(site);
  }
  return customSystemPrompt;
}

interface BuildMessagesInput {
  context?: AiContext | null;
  userPrompt?: unknown;
  history?: unknown[];
  summaryAnchor?: SummaryAnchorLike | null;
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

export function formatDynamicTurnUserContent(input: {
  hybridRetrievalMarkdown?: string;
  frameContextNote?: string;
  userPrompt: string;
}): string {
  const blocks: string[] = [];
  if (input.hybridRetrievalMarkdown?.trim()) {
    blocks.push(`<retrieved_subtitles>\n${input.hybridRetrievalMarkdown.trim()}\n</retrieved_subtitles>`);
  }
  if (input.frameContextNote?.trim()) {
    blocks.push(`<video_frame_context>\n${input.frameContextNote.trim()}\n</video_frame_context>`);
  }
  const trimmedPrompt = input.userPrompt.trim();
  if (trimmedPrompt || blocks.length === 0) {
    blocks.push(trimmedPrompt);
  }
  return blocks.join("\n\n");
}

export function buildMessages({ context, userPrompt, history, summaryAnchor, systemPrompt, includeToolHistory, images }: BuildMessagesInput = {}): ChatMessage[] {
  const ctx = context || {};
  const site = resolveContextSite(ctx);
  const sections: string[] = [];

  sections.push(resolveAiSystemPrompt(systemPrompt, site));

  sections.push(
    `当前用户正在看一个视频，标题：「${ctx.title || "未知"}」`,
    `作者：${ctx.author || "未知"} | 上传日期：${ctx.uploadDate || "未知"}`
  );

  const staticDirectory = String(ctx.staticDirectoryMarkdown || "").trim();
  const compressedSummary = String(ctx.compressedSummaryMarkdown || "").trim();
  const hybridRetrieval = String(ctx.hybridRetrievalMarkdown || "").trim();
  const fullSubtitleText =
    !staticDirectory && !compressedSummary
      ? buildSubtitlePrompt({
          body: ctx.subtitleBody,
          chapters: ctx.chapters,
          videoDuration: ctx.videoDuration,
          includeTimestampInBody: ctx.includeTimestampInBody
        })
      : "";
  if (staticDirectory) {
    sections.push(`以下是本视频的静态章节目录（按需召回的原始字幕片段将随每轮提问附在用户消息中）：\n\n${staticDirectory}`);
  } else if (compressedSummary) {
    sections.push(`以下是本视频此前的整理成果（分段小结与成稿笔记，非逐字字幕）：\n\n${compressedSummary}`);
  } else if (fullSubtitleText) {
    sections.push(`以下是视频的字幕全文：\n\n${fullSubtitleText}`);
  } else if (hybridRetrieval) {
    sections.push("本视频为长视频，按需召回的原始字幕片段将随每轮提问附在用户消息中。");
  } else {
    sections.push("（暂无字幕）");
  }

  const rawHistory = Array.isArray(history)
    ? history.filter((m): m is Record<string, unknown> => Boolean(m && typeof m === "object"))
    : [];
  const { activeRawHistory, anchorText } = sliceActiveHistoryWithFallback(rawHistory, summaryAnchor);

  let historyMessages: ChatMessage[] = activeRawHistory.flatMap((m) => {
    const projected = projectHistoryMessage(m, Boolean(includeToolHistory));
    return projected ? [projected] : [];
  });

  if (includeToolHistory) {
    historyMessages = foldHistoricalToolResults(historyMessages);
  }
  historyMessages = replaceEarlierImages(historyMessages, Boolean(images?.length));
  if (anchorText) {
    historyMessages = [...buildSummaryAnchorTurnPair(anchorText), ...historyMessages];
  }

  const userMessage: ChatMessage = {
    role: "user",
    content: formatDynamicTurnUserContent({
      hybridRetrievalMarkdown: hybridRetrieval,
      frameContextNote: String(ctx.frameContextNote || ""),
      userPrompt: String(userPrompt || "")
    })
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
