import { getErrorMessage } from "../shared/error-helpers.js";
import { state, clipState } from "../core/state.js";
import { getRuntimeVideoElement } from "./video-probe.js";
import { contentFetchJson } from "./content-transport.js";
import type { JsonTransport } from "./gateway-core.js";
import { logInfo, logWarn } from "../shared/logging.js";
import type { HotComment } from "./bili-api-shared.js";
import { fetchHotCommentsJson } from "./hot-comments.js";
export { fetchHotCommentsJson } from "./hot-comments.js";
export { fetchVideoMeta, fetchSubtitleBundle } from "./video-api.js";
export type { VideoPage, VideoMeta, SubtitleTrack, Chapter } from "./video-api.js";

declare global {
  interface Window {
    __INITIAL_STATE__?: { aid?: unknown };
  }
}

// 传输叶拆出（arch-slim-2/04）：isBiliUrl / bgFetchJson / JsonTransport 迁至
// gateway-core.ts（零 extension/ 内部依赖的叶子），SW 静态图不再经本模块拖入
// state/video-probe/selection→cache→cache-lru 链。此处 re-export 保持既有
// import 面兼容；视频元信息与字幕列表由 video-api.ts 承载，本模块只剩页面侧编排
//（getCurrentAid / readRuntimeVideoDuration / fetchHotComments / fetchSubtitleBody）。
// 轨道身份批后本模块对 subtitle/ 已无静态 import：映射改由本层的 native-payload.ts
// 提供（它只额外触达 subtitle/chapters 的归一叶）。
export { bgFetchJson, isBiliUrl } from "./gateway-core.js";
export { contentFetchJson } from "./content-transport.js";
export type { JsonTransport } from "./gateway-core.js";

// ===== content-side adapters =====

export function getCurrentAid(): number {
  let aid = Number(state.clip.aid) || 0;
  if (!aid && typeof window !== "undefined") {
    try {
      aid = Number(window.__INITIAL_STATE__?.aid) || 0;
    } catch {}
  }
  return aid;
}

export function readRuntimeVideoDuration(): number {
  const video = getRuntimeVideoElement();
  const duration = Number(video?.duration);
  if (Number.isFinite(duration) && duration > 0) {
    return duration;
  }
  return 0;
}

export async function fetchSubtitleBody<T = unknown>(url: string): Promise<{ body: T[] }> {
  logInfo("[BILISCRIPT] fetch subtitle body", { url });
  const body = await fetchSubtitleBodyJson<T>(contentFetchJson, url);
  return { body };
}

export async function fetchHotComments(count = 20): Promise<HotComment[]> {
  const safeCount = Math.max(0, Number(count) || 0);
  if (!safeCount) {
    return [];
  }

  const aid = getCurrentAid();
  if (!aid) {
    return [];
  }

  return fetchHotCommentsJson(contentFetchJson, aid, safeCount);
}

// 热评编排单源（arch-review-2026-09/07）：「getCurrentAid 判空 → fetchHotComments(20)
// → clipState.setHotComments 落账 → 失败降级空列表 + note」序列此前在
// core/context-assembly 与 entry/message-handler 逐字手抄两份，此处收口。
// message-handler 消费它包 sendResponse 外壳；context-assembly 缺省实现直接注入。
// deps 可注入 ledger/aid/拉取替身（测试），缺省全部取本模块与 core/state 真身。
export interface HotCommentsWithLedgerDeps {
  clipState?: { setHotComments(comments: HotComment[]): void };
  getCurrentAid?: () => number;
  fetchHotComments?: (count: number) => Promise<HotComment[]>;
}

export interface HotCommentsWithLedgerOutcome {
  comments: HotComment[];
  // 降级说明（无 aid / 拉取失败）；成功路径缺省。
  note?: string;
}

export async function fetchHotCommentsWithLedger(
  deps: HotCommentsWithLedgerDeps = {}
): Promise<HotCommentsWithLedgerOutcome> {
  const ledger = deps.clipState || clipState;
  const aidOf = deps.getCurrentAid || getCurrentAid;
  const fetchComments = deps.fetchHotComments || fetchHotComments;
  try {
    if (!aidOf()) {
      ledger.setHotComments([]);
      return { comments: [], note: "无法获取视频 aid" };
    }
    const comments = await fetchComments(20);
    ledger.setHotComments(comments);
    return { comments };
  } catch (error) {
    ledger.setHotComments([]);
    return { comments: [], note: getErrorMessage(error) };
  }
}

async function fetchSubtitleBodyJson<T>(transport: JsonTransport, url: string): Promise<T[]> {
  const payload = await transport(url);
  return Array.isArray((payload as { body?: unknown })?.body) ? (payload as { body: T[] }).body : [];
}
