import { getErrorMessage } from "../shared/error-helpers.js";
import type { HotComment } from "../shared/video-dto.js";
import {
  getYoutubeSameOriginFetch,
  type YoutubeSameOriginFetch
} from "./main-world-bridge.js";
import {
  assertWebInnertubeContext,
  buildWebInnertubeHeaders,
  readResponseJsonSafely
} from "./subtitle-fetcher.js";

type JsonObj = Record<string, unknown>;

function asObj(value: unknown): JsonObj | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObj) : null;
}

function readYoutubeText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const obj = asObj(value);
  if (!obj) {
    return "";
  }
  if (typeof obj.simpleText === "string") {
    return obj.simpleText;
  }
  if (Array.isArray(obj.runs)) {
    return obj.runs
      .map((run) => {
        const text = asObj(run)?.text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  if (typeof obj.content === "string") {
    return obj.content;
  }
  return "";
}

export function parseYoutubeLikeCount(raw: unknown): number {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
  }
  const text = String(raw ?? "")
    .replace(/[\u00a0\u202f,]/g, "")
    .trim();
  if (!text) {
    return 0;
  }
  const match = text.match(/(\d+(?:\.\d+)?)\s*([kmb千万萬亿億])?/i);
  if (!match) {
    return 0;
  }
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) {
    return 0;
  }
  const unit = (match[2] || "").toLowerCase();
  let multiplier = 1;
  if (unit === "k" || unit === "千") {
    multiplier = 1e3;
  } else if (unit === "万" || unit === "萬") {
    multiplier = 1e4;
  } else if (unit === "m") {
    multiplier = 1e6;
  } else if (unit === "亿" || unit === "億") {
    multiplier = 1e8;
  } else if (unit === "b") {
    multiplier = 1e9;
  }
  return Math.max(0, Math.round(base * multiplier));
}

function extractCommentEntityMap(payload: JsonObj): Map<string, HotComment> {
  const map = new Map<string, HotComment>();
  const mutations = asObj(asObj(payload.frameworkUpdates)?.entityBatchUpdate)?.mutations;
  if (!Array.isArray(mutations)) {
    return map;
  }
  for (const rawMutation of mutations) {
    const entity = asObj(asObj(asObj(rawMutation)?.payload)?.commentEntityPayload);
    if (!entity) {
      continue;
    }
    const key = typeof entity.key === "string" ? entity.key.trim() : "";
    const props = asObj(entity.properties);
    const message = readYoutubeText(props?.content).trim();
    if (!key || !message) {
      continue;
    }
    const author = asObj(entity.author);
    const uname =
      (typeof author?.displayName === "string" ? author.displayName.trim() : "") || "匿名";
    const toolbar = asObj(entity.toolbar);
    const like = parseYoutubeLikeCount(
      toolbar?.likeCountNotliked ||
        toolbar?.likeCountLiked ||
        toolbar?.likeCountA11y ||
        0
    );
    map.set(key, { uname, like, message });
  }
  return map;
}

function collectContinuationItems(payload: JsonObj): unknown[] {
  const endpoints = payload.onResponseReceivedEndpoints;
  if (!Array.isArray(endpoints)) {
    return [];
  }
  const items: unknown[] = [];
  for (const rawEndpoint of endpoints) {
    const endpoint = asObj(rawEndpoint);
    if (!endpoint) {
      continue;
    }
    const reloadItems = asObj(endpoint.reloadContinuationItemsCommand)?.continuationItems;
    if (Array.isArray(reloadItems)) {
      items.push(...reloadItems);
    }
    const appendItems = asObj(endpoint.appendContinuationItemsAction)?.continuationItems;
    if (Array.isArray(appendItems)) {
      items.push(...appendItems);
    }
  }
  return items;
}

function extractCommentFromThread(
  rawItem: unknown,
  entityMap: Map<string, HotComment>
): HotComment | null {
  const thread = asObj(asObj(rawItem)?.commentThreadRenderer);
  if (!thread) {
    return null;
  }

  const vm = asObj(asObj(thread.commentViewModel)?.commentViewModel);
  const commentKey = typeof vm?.commentKey === "string" ? vm.commentKey.trim() : "";
  if (commentKey) {
    const entity = entityMap.get(commentKey);
    if (entity) {
      return entity;
    }
  }

  const renderer = asObj(asObj(thread.comment)?.commentRenderer);
  if (!renderer) {
    return null;
  }
  const message = readYoutubeText(renderer.contentText).trim();
  if (!message) {
    return null;
  }
  const uname = readYoutubeText(renderer.authorText).trim() || "匿名";
  const voteAccessibility = asObj(asObj(renderer.voteCount)?.accessibility)?.accessibilityData;
  const like = parseYoutubeLikeCount(
    renderer.likeCount ??
      (readYoutubeText(renderer.voteCount) || asObj(voteAccessibility)?.label || 0)
  );
  return { uname, like, message };
}

export function parseYoutubeCommentsFromNextPayload(
  payload: unknown,
  limit = 20
): HotComment[] {
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  if (!safeLimit) {
    return [];
  }
  const root = asObj(payload);
  if (!root) {
    return [];
  }

  const entityMap = extractCommentEntityMap(root);
  const continuationItems = collectContinuationItems(root);
  const result: HotComment[] = [];
  const seen = new Set<string>();

  const pushUnique = (comment: HotComment | null) => {
    if (!comment || !comment.message) {
      return;
    }
    const dedupeKey = `${comment.uname}\0${comment.message}`;
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    result.push(comment);
  };

  for (const item of continuationItems) {
    if (result.length >= safeLimit) {
      break;
    }
    pushUnique(extractCommentFromThread(item, entityMap));
  }

  if (result.length === 0 && entityMap.size > 0) {
    for (const comment of entityMap.values()) {
      if (result.length >= safeLimit) {
        break;
      }
      pushUnique(comment);
    }
  }

  return result;
}

export async function fetchYoutubeHotCommentsFromNext({
  innertubeContext,
  innertubeApiKey = "",
  commentsContinuation,
  limit = 20,
  fetchFn = getYoutubeSameOriginFetch()
}: {
  innertubeContext: Record<string, unknown> | null | undefined;
  innertubeApiKey?: string;
  commentsContinuation: string;
  limit?: number;
  fetchFn?: YoutubeSameOriginFetch;
}): Promise<HotComment[]> {
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  const cleanContinuation = String(commentsContinuation || "").trim();
  if (!safeLimit || !cleanContinuation) {
    return [];
  }

  const safeContext = assertWebInnertubeContext(innertubeContext);
  const cleanKey = String(innertubeApiKey || "").trim();
  const requestUrl = cleanKey
    ? `https://www.youtube.com/youtubei/v1/next?key=${encodeURIComponent(cleanKey)}`
    : "https://www.youtube.com/youtubei/v1/next";

  const response = await fetchFn(requestUrl, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: buildWebInnertubeHeaders(safeContext),
    body: JSON.stringify({
      context: safeContext,
      continuation: cleanContinuation
    })
  }).catch((error: unknown) => {
    throw new Error(`热评请求失败：${getErrorMessage(error)}`);
  });

  const parsed = await readResponseJsonSafely(response);
  if (!parsed.ok) {
    throw new Error(`热评请求失败：HTTP ${parsed.status}`);
  }
  if (parsed.empty) {
    return [];
  }
  return parseYoutubeCommentsFromNextPayload(parsed.data, safeLimit);
}
