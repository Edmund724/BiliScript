import { toReadableText } from "../shared/error-helpers.js";
import { hasOutlineTimestampLine } from "../shared/chapter-outline.js";
import type { HotComment } from "../shared/video-dto.js";

export type { HotComment } from "../shared/video-dto.js";

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

function toReplyList(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.filter(isReplyObject);
  }
  return isReplyObject(value) ? [value] : [];
}

function isReplyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function mergedReplyItems(payload: unknown): unknown[] {
  const data = (payload as { data?: unknown })?.data as
    | { top?: unknown; top_replies?: unknown; replies?: unknown }
    | null
    | undefined;

  const merged: unknown[] = [
    ...toReplyList((data?.top as { upper?: unknown } | null | undefined)?.upper),
    ...toReplyList(data?.top_replies),
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

export function subReplyRootIds(payload: unknown): (number | string)[] {
  return mergedReplyItems(payload)
    .filter((item) => hasOutlineTimestampLine(replyContentMessage(item)))
    .map((item) => (item as { rpid?: unknown }).rpid)
    .filter((rpid): rpid is number | string => typeof rpid === "number" || (typeof rpid === "string" && !!rpid));
}

export function highLikedReplyRootIds(payload: unknown, limit = 5): (number | string)[] {
  return mergedReplyItems(payload)
    .filter((item) => Number((item as { like?: unknown }).like) > 0)
    .sort((a, b) => Number((b as { like?: unknown }).like || 0) - Number((a as { like?: unknown }).like || 0))
    .slice(0, limit)
    .map((item) => (item as { rpid?: unknown }).rpid)
    .filter((rpid): rpid is number | string => typeof rpid === "number" || (typeof rpid === "string" && !!rpid));
}

export function subReplyMessages(payload: unknown): string[] {
  const data = (payload as { data?: unknown })?.data as { replies?: unknown } | null | undefined;
  return toReplyList(data?.replies)
    .map(replyContentMessage)
    .filter(Boolean);
}

export interface SubReplyInput {
  root: number | string;
  messages: string[];
}

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
  return code === -509 || code === -3 || (typeof code === "number" && code < 0);
}

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
