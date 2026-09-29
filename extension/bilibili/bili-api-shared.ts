// extension/bili-api-shared.ts
// Pure B站 (Bilibili) API primitives shared between the content-script side
// and the background service worker. This module centralizes reusable request
// builders, response mappers, and error helpers so both sides reuse the same
// API primitives and avoid behavior drift.
//
// Contains ONLY pure functions. It has NO transport logic (no fetch, no
// sendRuntimeMessage, no Chrome/browser APIs) and does NOT touch `state`,
// `getRuntimeVideoElement`, `window`, or the DOM.

import { toReadableText } from "../shared/error-helpers.js";

export interface HotComment {
  uname: string;
  like: number;
  message: string;
}

export function normalizeHotComments(comments: unknown, limit = 20): HotComment[] {
  if (!Array.isArray(comments)) {
    return [];
  }

  return comments
    .map((item) => ({
      uname: String((item as { uname?: unknown })?.uname || "匿名").trim() || "匿名",
      like: Number((item as { like?: unknown })?.like || 0) || 0,
      message: String((item as { message?: unknown })?.message || "").trim().slice(0, 500)
    }))
    .filter((item) => item.message)
    .slice(0, limit);
}

// 单条对象与数组都容错收口：数组逐项过滤，非对象/null 一律丢弃，避免产生空条目。
function toReplyList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.filter(isReplyObject);
  }
  return isReplyObject(value) ? [value] : [];
}

function isReplyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// rpid 缺失/类型不对时返回 null（该条不参与去重，原样保留，宁可多不可丢）。
function replyRpidKey(item: unknown): string | null {
  const rpid = (item as { rpid?: unknown })?.rpid;
  if (typeof rpid === "number" && Number.isFinite(rpid)) {
    return String(rpid);
  }
  if (typeof rpid === "string" && rpid) {
    return rpid;
  }
  return null;
}

// 热评接口（x/v2/reply/main）的置顶评论不在 data.replies 里：实跑证实 UP 置顶的
// 时间轴目录只出现在 data.top_replies[]（data.upper.top 同为该条，data.top 常为
// null），data.replies[] 只有普通评论——只读 replies 会整条漏掉置顶目录。
// 故把 data.top（单条或 null）、data.top_replies[]、data.upper.top（单条或 null）
// 与 data.replies[] 合并，置顶来源前置，按 rpid 去重（保留首个），再走既有
// normalizeHotComments 归一与 limit 裁剪。
export function mergeHotCommentsFromPayload(payload: unknown, limit = 20): HotComment[] {
  const data = (payload as { data?: unknown })?.data as
    | { top?: unknown; top_replies?: unknown; upper?: unknown; replies?: unknown }
    | null
    | undefined;

  const merged: unknown[] = [
    ...toReplyList(data?.top),
    ...toReplyList(data?.top_replies),
    ...toReplyList((data?.upper as { top?: unknown } | null | undefined)?.top),
    ...toReplyList(data?.replies)
  ];

  const seenRpid = new Set<string>();
  const picked: unknown[] = [];
  for (const item of merged) {
    const key = replyRpidKey(item);
    if (key !== null) {
      if (seenRpid.has(key)) {
        continue;
      }
      seenRpid.add(key);
    }
    picked.push(item);
  }

  return normalizeHotComments(
    picked.map((item) => ({
      uname: (item as { member?: { uname?: unknown } })?.member?.uname || "匿名",
      like: (item as { like?: unknown })?.like || 0,
      message: (item as { content?: { message?: unknown } })?.content?.message || ""
    })),
    limit
  );
}

export interface SubtitleInfoRequest {
  source: string;
  url: string;
}

export function buildSubtitleInfoRequests({
  bvid,
  cid,
  aid
}: {
  bvid?: string | number;
  cid?: string | number;
  aid?: string | number;
}): SubtitleInfoRequest[] {
  const safeBvid = encodeURIComponent(String(bvid || ""));
  const safeCid = encodeURIComponent(String(cid || ""));
  const safeAid = encodeURIComponent(String(aid || ""));
  const requests: SubtitleInfoRequest[] = [];

  // 参考 SubBatch：优先用 aid+cid 的 wbi 接口作为主来源。
  if (aid) {
    requests.push({
      source: "player-wbi-v2",
      url:
        "https://api.bilibili.com/x/player/wbi/v2" +
        `?aid=${safeAid}` +
        `&cid=${safeCid}` +
        (bvid ? `&bvid=${safeBvid}` : "")
    });
  }

  // 仅在主来源不可用时再回退到 player-v2。
  requests.push({
    source: "player-v2",
    url:
      "https://api.bilibili.com/x/player/v2" +
      (bvid ? `?bvid=${safeBvid}` : "?") +
      `${bvid ? "&" : ""}cid=${safeCid}` +
      (aid ? `&aid=${safeAid}` : "")
  });

  return requests;
}

export interface BiliApiError extends Error {
  code?: number | string;
  retryable?: boolean;
}

export function buildBiliApiError(payload: unknown, fallbackMessage: string): BiliApiError {
  const msg = toReadableText((payload as { message?: unknown })?.message, fallbackMessage);
  const error = new Error(msg) as BiliApiError;
  error.code = (payload as { code?: number | string })?.code;
  error.retryable = isRetryableError(error.code);
  return error;
}

function isRetryableError(code: number | string | undefined): boolean {
  // -509: 请求过于频繁
  // -3: 参数错误（可能是临时性的）
  // 其他负数错误码也可能是临时性的
  return code === -509 || code === -3 || (typeof code === "number" && code < 0);
}
