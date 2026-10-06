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
import { hasOutlineTimestampLine } from "../shared/chapter-outline.js";

export interface HotComment {
  uname: string;
  like: number;
  message: string;
  /**
   * 楼中楼续篇正文（置顶目录评论的第二段目录），仅目录解析消费
   * （shared/chapter-outline 的 hotCommentsText）；聊天展示只用 message。
   * 无续篇时不出现该字段。
   */
  subMessages?: string[];
}

// 热评数据通道保存正文全文（F1）：置顶长评论是章节目录的载体，任何截断都会把
// 目录行拦腰切断。展示侧的 500 字截断由 ai/context.ts 的评论块单独负责。
export function normalizeHotComments(comments: unknown, limit = 20): HotComment[] {
  if (!Array.isArray(comments)) {
    return [];
  }

  return comments
    .map((item) => {
      const subMessages = Array.isArray((item as { subMessages?: unknown })?.subMessages)
        ? ((item as { subMessages?: unknown[] }).subMessages || [])
            .map((sub) => String((sub as unknown) ?? "").trim())
            .filter(Boolean)
        : [];
      const normalized: HotComment = {
        uname: String((item as { uname?: unknown })?.uname || "匿名").trim() || "匿名",
        like: Number((item as { like?: unknown })?.like || 0) || 0,
        message: String((item as { message?: unknown })?.message || "").trim()
      };
      if (subMessages.length) {
        normalized.subMessages = subMessages;
      }
      return normalized;
    })
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

// 热评接口（x/v2/reply/main）的置顶评论不在 data.replies 里，实抓 payload
// （BV1q9He6SEyX，2026-10-06，tests/fixtures/bilibili/bv1q9he6seyx-reply-main.json）
// 的形状是：
//   data.top          = { admin, upper, vote } 容器，置顶评论在 data.top.upper
//   data.top_replies  = [置顶评论]（与 data.top.upper 同一 rpid，同一条）
//   data.upper        = { mid }，**没有 top**（旧注释写的 data.upper.top 是错的）
//   data.replies      = 普通评论
// 只读 replies 会整条漏掉置顶目录；容器 data.top 本身会被当成一条无正文的评论
// 进 merged（normalizeHotComments 的空正文过滤掉，不影响产物），dedup 保证
// top.upper 与 top_replies 只出一条。
function mergedReplyItems(payload: unknown): unknown[] {
  const data = (payload as { data?: unknown })?.data as
    | { top?: unknown; top_replies?: unknown; upper?: unknown; replies?: unknown }
    | null
    | undefined;

  const merged: unknown[] = [
    ...toReplyList(data?.top),
    ...toReplyList((data?.top as { upper?: unknown } | null | undefined)?.upper),
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
  return picked;
}

function replyContentMessage(item: unknown): string {
  return String((item as { content?: { message?: unknown } })?.content?.message || "").trim();
}

/**
 * 楼中楼续篇补抓目标（F3）：mergedReplyItems 里**正文含时间戳行**的顶层评论 rpid。
 * 置顶目录评论常把「后半段目录」发在自己的楼中楼里，只为这类评论拉续篇——
 * 精准覆盖且省请求，其余评论零请求。
 */
export function subReplyRootIds(payload: unknown): (number | string)[] {
  return mergedReplyItems(payload)
    .filter((item) => hasOutlineTimestampLine(replyContentMessage(item)))
    .map((item) => (item as { rpid?: unknown }).rpid)
    .filter((rpid): rpid is number | string => typeof rpid === "number" || (typeof rpid === "string" && !!rpid));
}

/**
 * x/v2/reply/reply 响应 → 楼中楼续篇正文列表（按接口顺序，trim 后去空）。
 * 只取子评论正文（data.replies[]），不取 data.root 回显。
 */
export function subReplyMessages(payload: unknown): string[] {
  const data = (payload as { data?: unknown })?.data as { replies?: unknown } | null | undefined;
  return toReplyList(data?.replies)
    .map(replyContentMessage)
    .filter(Boolean);
}

/** 楼中楼续篇输入：root 顶层评论 rpid + 该评论下的续篇正文（按序）。 */
export interface SubReplyInput {
  root: number | string;
  messages: string[];
}

// 归一 + limit 裁剪走既有 normalizeHotComments；subReplies（可选）按 rpid 把楼中楼
// 续篇正文挂到对应顶层评论的 subMessages 上（无续篇不落字段）。
export function mergeHotCommentsFromPayload(
  payload: unknown,
  limit = 20,
  subReplies: SubReplyInput[] = []
): HotComment[] {
  const subByKey = new Map<string, string[]>();
  for (const sub of subReplies) {
    const messages = (Array.isArray(sub?.messages) ? sub.messages : [])
      .map((message) => String((message as unknown) ?? "").trim())
      .filter(Boolean);
    if (messages.length) {
      subByKey.set(String(sub.root), messages);
    }
  }

  return normalizeHotComments(
    mergedReplyItems(payload).map((item) => {
      const key = replyRpidKey(item);
      const subMessages = key !== null ? subByKey.get(key) : undefined;
      return {
        uname: (item as { member?: { uname?: unknown } })?.member?.uname || "匿名",
        like: (item as { like?: unknown })?.like || 0,
        message: replyContentMessage(item),
        ...(subMessages ? { subMessages } : {})
      };
    }),
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

// 热评接口的业务错误码 → 人话错误（返回 null 表示 payload 没有报错，照常解析）。
// 为什么不能沿用 buildBiliApiError：热评接口出错时 message 就是裸码（"-352"），
// 直接抛出去用户看不懂。为什么不能静默折成空数组：空评论区与「拉不到」在用户侧
// 长得一模一样——都是「没有评论目录」，但后者让概览整段退回 AI 自由分章，
// 必须能出声（subtitle/core 的 refreshHotComments 把这条错误写进状态行）。
// -352 = B 站风控校验失败：未登录裸请求或请求过密时整段置顶目录都拿不到。
export function buildHotCommentsApiError(payload: unknown): BiliApiError | null {
  const code = (payload as { code?: unknown })?.code;
  if (typeof code !== "number" || code === 0) {
    return null;
  }
  const message =
    code === -352
      ? "B 站风控校验失败（-352），拿不到热评目录"
      : code === -404
        ? "评论不存在或已关闭（-404）"
        : `热评接口返回错误码 ${code}`;
  const error = new Error(message) as BiliApiError;
  error.code = code;
  error.retryable = isRetryableError(code);
  return error;
}
