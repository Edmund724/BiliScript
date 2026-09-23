// conversation.ts
// 会话生命周期 + 上下文 key 计算的纯函数模块（Candidate 7 抽取）。
// 作为经典脚本加载，不依赖任何外部状态或 Chrome API。

import { extractBvid, extractPageIndexFromUrl } from "../bilibili/video-id-shared.js";
import type { AiContext, ChapterItem, HotComment, ImagePart } from "./types.js";

export const MAX_SAVED_CONVERSATIONS = 60;

// ============ 上下文 key ============

interface BuildContextKeyPayload {
  bvid?: unknown;
  cid?: unknown;
  aid?: unknown;
  url?: unknown;
}

export function buildContextKey(payload: BuildContextKeyPayload | null | undefined): string {
  if (!payload) {
    return "";
  }
  const bvid = String(payload.bvid || "").trim();
  const cid = String(payload.cid || "").trim();
  const aid = String(payload.aid || "").trim();
  if (bvid || cid || aid) {
    return `video:${bvid}|${cid || aid}`;
  }
  const normalizedUrl = normalizeContextUrlForKey(payload.url);
  return normalizedUrl ? `url:${normalizedUrl}` : "";
}

function normalizeContextUrlForKey(value: unknown): string {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  try {
    const parsed = new URL(text);
    parsed.hash = "";
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return text;
  }
}

// ============ 会话规范化 ============

// 会话消息：基础形状 { role, content } 上条件透传联网搜索的 tool 字段
//（spec §2.5，tool 轮消息从历史重建）——与 conversation-store 的
// normalizeHistoryMessage 同一透传语义，读取与持久化两处共用。
interface ConversationMessage {
  role: string;
  content: string;
  images?: ImagePart[];
  tool_calls?: unknown[];
  tool_call_id?: string;
}

// 图片白名单透传（image-input 路线 B，04 号票落盘策略）：数组非空且每项 mime/data
// 均为非空字符串才保留，非法项丢弃（同 tool_calls 的宽容归一）；全被丢弃或字段
// 缺失时返回 undefined——旧持久化记录零变化。conversation-store 加载侧复用同一
// 判定，避免「什么算合法图片」出现第二份。
export function normalizeImageParts(value: unknown): ImagePart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter((item): item is ImagePart => {
    const part = item as { mime?: unknown; data?: unknown };
    return Boolean(part) && typeof part.mime === "string" && Boolean(part.mime) && typeof part.data === "string" && Boolean(part.data);
  });
  return parts.length ? parts : undefined;
}

// 落盘保留策略（image-input 04 号票）：一个会话最多留最近一张图——最后一条带图
// 消息的最后一张，其余图片整条摘掉，最坏体积被压到每会话 ≤1MB。
// 这里**不写文本占位**：占位是请求组装期的事（ai/context 的 buildMessages），
// 写进 content 会让历史消息在界面上显示出占位文本。
// 非保留位一律摘掉 images 字段（含非法项 / 空数组）：与加载侧的白名单同向——
// 落盘记录里的 images 要么是那一张有效图，要么不存在。除 images 外的字段原样。
export function retainLatestImage<T extends object>(messages: T[]): T[] {
  const fields = messages.map((message) => (message as { images?: unknown }).images);
  let keepIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (normalizeImageParts(fields[i])) {
      keepIndex = i;
      break;
    }
  }
  if (!fields.some((value) => value !== undefined)) {
    // 全无 images 字段：原数组原样返回（旧记录零变化，不做无谓拷贝）。
    return messages;
  }
  return messages.map((message, index) => {
    const parts = normalizeImageParts(fields[index]);
    if (parts && index === keepIndex) {
      return { ...message, images: [parts[parts.length - 1]] };
    }
    if (fields[index] === undefined) {
      return message;
    }
    const next = { ...message } as T & { images?: unknown };
    delete next.images;
    return next as T;
  });
}

interface NormalizedConversation {
  id: string;
  title: string;
  contextKey: string;
  contextTitle: string;
  contextUrl: string;
  isVideoContext: boolean;
  createdAt: number;
  updatedAt: number;
  contextRef: AiContext;
  messages: ConversationMessage[];
}

export function normalizeConversations(value: unknown): NormalizedConversation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const messages = Array.isArray(item?.messages)
        ? item.messages
            .filter((msg: { role?: unknown; content?: unknown }) => msg && (msg.role === "user" || msg.role === "assistant" || msg.role === "tool") && typeof msg.content === "string")
            .map((msg: { role?: unknown; content?: unknown; images?: unknown; tool_calls?: unknown; tool_call_id?: unknown }) => {
              const base: ConversationMessage = { role: String(msg.role), content: String(msg.content) };
              const images = normalizeImageParts(msg.images);
              if (images) {
                base.images = images;
              }
              const calls = msg.tool_calls;
              if (Array.isArray(calls) && calls.length) {
                return { ...base, tool_calls: calls };
              }
              const callId = msg.tool_call_id;
              if (typeof callId === "string" && callId) {
                return { ...base, tool_call_id: callId };
              }
              return base;
            })
        : [];
      const id = String(item?.id || "").trim();
      if (!id || !messages.length) {
        return null;
      }
      const contextTitle = String(item?.contextTitle || "").trim();
      const contextRef = buildAiContextRef(item?.contextRef || item?.contextSnapshot || item);
      const contextUrl = String(item?.contextUrl || "").trim();
      return {
        id,
        title: normalizeConversationTitle(item?.title, contextTitle, contextRef, contextUrl),
        contextKey: resolveConversationStorageKey(item?.contextKey, contextRef, contextUrl),
        contextTitle,
        contextUrl,
        isVideoContext: item?.isVideoContext !== false,
        createdAt: Number(item?.createdAt) || Date.now(),
        updatedAt: Number(item?.updatedAt) || Date.now(),
        contextRef,
        messages
      };
    })
    .filter((item): item is NormalizedConversation => Boolean(item))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_SAVED_CONVERSATIONS);
}

export function resolveConversationStorageKey(rawKey: unknown, contextRef: AiContext, contextUrl = ""): string {
  const normalizedRefKey = buildContextKey(contextRef);
  if (normalizedRefKey) {
    return normalizedRefKey;
  }
  const normalizedUrlKey = buildContextKey({ url: contextUrl });
  if (normalizedUrlKey) {
    return normalizedUrlKey;
  }
  return String(rawKey || "").trim();
}

// ============ 上下文引用 ============

// AI 上下文 ref 单一构造器：15 字段（14 个视频身份/字幕轨字段 + chapters）。
// 原三份手写挑选清单（context-resolver 的解析入参归一化、会话持久化 contextRef、
// 占位上下文）统一收敛于此；bvid 缺失时从 url 回落提取；chapters 为数组时
// 透传、缺失/非法时 undefined（消费方均以 Array.isArray 容忍，旧持久化会话
// 的 ref 无此字段也自然落到 undefined）。
export function buildAiContextRef(context: unknown): AiContext {
  const value = context && typeof context === "object" ? (context as Record<string, unknown>) : {};
  const url = String(value.url || "").trim();
  return {
    title: String(value.title || "").trim(),
    url,
    author: String(value.author || "").trim(),
    uploadDate: String(value.uploadDate || "").trim(),
    bvid: String(value.bvid || extractBvid(url) || "").trim(),
    cid: String(value.cid || "").trim(),
    aid: String(value.aid || "").trim(),
    pageIndex: Number(value.pageIndex) > 0 ? Number(value.pageIndex) : 1,
    pageCount: Number(value.pageCount) > 0 ? Number(value.pageCount) : 0,
    pageTitle: String(value.pageTitle || "").trim(),
    subtitleLang: String(value.subtitleLang || "").trim(),
    selectedSubtitleId: String(value.selectedSubtitleId || "").trim(),
    selectedSubtitleUrl: String(value.selectedSubtitleUrl || "").trim(),
    chapters: Array.isArray(value.chapters) ? (value.chapters as ChapterItem[]) : undefined,
    isVideoContext: value.isVideoContext !== false
  };
}

export function buildContextPlaceholder(ref: unknown): AiContext | null {
  if (!ref || typeof ref !== "object") {
    return null;
  }
  return {
    ...buildAiContextRef(ref),
    hotComments: []
  };
}

// ============ 标题 ============

export function buildConversationTitle(context: AiContext | null | undefined): string {
  const rawTitle = String(context?.title || "当前页面").trim() || "当前页面";
  const baseTitle = extractConversationBaseTitle(rawTitle);
  return appendConversationPageSuffix(baseTitle, context || {});
}

export function normalizeConversationTitle(
  title: unknown,
  contextTitle = "",
  contextRef: AiContext | null = null,
  contextUrl = ""
): string {
  const preferredTitle = String(contextTitle || "").trim() || String(title || "").trim();
  const baseTitle = extractConversationBaseTitle(preferredTitle);
  return appendConversationPageSuffix(baseTitle || "历史对话", contextRef || { url: contextUrl });
}

function extractConversationBaseTitle(title: unknown): string {
  const raw = String(title || "").trim();
  if (!raw) {
    return "当前页面";
  }
  const normalizedRaw = raw.replace(/-P\d+$/i, "").trim();
  const parts = normalizedRaw
    .split(/\s+[|｜]\s+|\s+-\s+|\s+[—–]\s+|\s+[·•]\s+|\r?\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return parts[0] || normalizedRaw;
}

export function buildConversationTitleDisplay(title: unknown, maxChars = 22): { main: string; suffix: string } {
  const value = String(title || "").trim();
  const match = value.match(/^(.*?)(-P\d+)$/i);
  if (!match) {
    return {
      main: value.length > maxChars ? `${value.slice(0, maxChars)}...` : value,
      suffix: ""
    };
  }

  const suffix = String(match[2] || "").trim();
  const baseTitle = String(match[1] || "").trim();
  const reservedChars = Math.max(suffix.length + 3, 6);
  const availableChars = Math.max(maxChars - reservedChars, 8);
  return {
    main: baseTitle.length > availableChars ? `${baseTitle.slice(0, availableChars)}...` : baseTitle,
    suffix
  };
}

function appendConversationPageSuffix(title: string, context: AiContext | { url?: string }): string {
  const baseTitle = String(title || "").trim() || "历史对话";
  const existingSuffixMatch = baseTitle.match(/-P\d+$/i);
  const cleanTitle = existingSuffixMatch ? baseTitle.replace(/-P\d+$/i, "").trim() : baseTitle;
  const pageSuffix = extractConversationPageSuffix(context);
  return pageSuffix ? `${cleanTitle}${pageSuffix}` : cleanTitle;
}

function extractConversationPageSuffix(context: AiContext | { url?: string; pageIndex?: unknown; page?: unknown }): string {
  const pageIndex = Number(context?.pageIndex || context?.page || 0) || extractPageIndexFromUrl(context?.url || "");
  return pageIndex > 1 ? `-P${pageIndex}` : "";
}

// ============ ID / 时间 ============

export function generateConversationId(): string {
  return `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function formatConversationTimestamp(value: unknown): string {
  const date = new Date(Number(value) || Date.now());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

// ============ 匹配 / 比较 ============

export function doesConversationMatchCurrentContext(
  conversation: { contextKey?: unknown; contextRef?: unknown; contextUrl?: unknown } | null | undefined,
  currentRef: AiContext | null | undefined,
  targetContextKey = ""
): boolean {
  if (!conversation) {
    return false;
  }
  const normalizedConversationKey = resolveConversationStorageKey(
    conversation.contextKey,
    buildAiContextRef(conversation.contextRef),
    String(conversation.contextUrl || "")
  );
  const normalizedTargetKey = String(targetContextKey || buildContextKey(currentRef)).trim();
  if (normalizedConversationKey && normalizedTargetKey && normalizedConversationKey === normalizedTargetKey) {
    return true;
  }

  const conversationUrl = String(conversation.contextUrl || buildAiContextRef(conversation.contextRef).url || "").trim();
  const currentUrl = String(currentRef?.url || "").trim();
  if (conversationUrl && currentUrl) {
    return doesTabMatchContextUrl(currentUrl, conversationUrl);
  }
  return false;
}

export function doesTabMatchContextUrl(tabUrl: unknown, targetUrl: unknown): boolean {
  const current = extractVideoIdentity(tabUrl);
  const target = extractVideoIdentity(targetUrl);
  if (!current.bvid || !target.bvid) {
    return String(tabUrl || "").trim() === String(targetUrl || "").trim();
  }
  return current.bvid === target.bvid && current.page === target.page;
}

function extractVideoIdentity(url: unknown): { bvid: string; page: number } {
  const text = String(url || "").trim();
  const bvid = extractBvid(text);
  let page = 1;
  try {
    page = Number(new URL(text).searchParams.get("p") || "1");
    if (!Number.isFinite(page) || page <= 0) {
      page = 1;
    }
  } catch {
    page = 1;
  }
  return {
    bvid: String(bvid || "").trim(),
    page
  };
}
