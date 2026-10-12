// 播放器视频元素探针（候选 id 打分 + WeakRef 快取）。
//
// 双实例纪律标记：BILISCRIPT_DUAL_INSTANCE_STATEFUL——模块级可变状态只有
// cachedVideoRef（上次命中元素的 WeakRef 快取）。ADR-0017 修订后常驻侧（预抓取的
// 元数据等待）与懒侧（reader/gateway/player-ai）各持一份实例，两份快取指向同一
// DOM 的同一批候选元素，纯优化、无跨实例一致性要求（快取失效即重查）。
import { state } from "../core/state.js";

export function findReaderPlayerHost(video: Element | null | undefined): Element | null {
  if (!video) {
    return null;
  }

  return (
    video.closest(".bpx-player-container") ||
    video.closest(".bpx-player-video-area") ||
    video.closest("#bilibili-player") ||
    video.parentElement
  );
}

function isIgnoredReaderVideoCandidate(video: Element | null | undefined): boolean {
  if (!video) {
    return true;
  }
  const host = findReaderPlayerHost(video);
  const blockedSelector = [
    ".bpx-player-mini-warp",
    ".bpx-player-mini-close",
    ".bpx-player-ending-panel",
    ".bpx-player-ending-related",
    "[class*='mini-player']",
    "[class*='picture-in-picture']",
    "[class*='adcard']",
    ".ad-report",
    "[class*='ad-report']",
    ".video-page-card-small",
    ".video-page-special-card-small",
    ".feed-card",
    ".bili-video-card"
  ].join(", ");
  return Boolean(video.closest(blockedSelector) || host?.closest?.(blockedSelector));
}

// 上次命中的视频元素的 WeakRef 快速缓存：getRuntimeVideoElement 在同步周期
// 内会被调用 20+ 次，缓存命中可跳过整次 querySelectorAll("video")。
let cachedVideoRef: WeakRef<HTMLVideoElement> | null = null;

export function getRuntimeVideoElement(): HTMLVideoElement | null {
  if (cachedVideoRef) {
    const cached = cachedVideoRef.deref();
    if (cached?.isConnected && !isIgnoredReaderVideoCandidate(cached)) {
      return cached;
    }
  }

  const readingVideoEl = state.reader.readingVideoEl as HTMLVideoElement | null | undefined;
  if (readingVideoEl?.isConnected) {
    const currentHost = findReaderPlayerHost(readingVideoEl);
    const currentRect = readingVideoEl.getBoundingClientRect();
    if (
      currentHost?.isConnected &&
      currentRect.width > 120 &&
      currentRect.height > 68 &&
      !isIgnoredReaderVideoCandidate(readingVideoEl)
    ) {
      cachedVideoRef = new WeakRef(readingVideoEl);
      return readingVideoEl;
    }
  }

  const candidates = Array.from(document.querySelectorAll("video")).filter(
    (item) => item.isConnected && !isIgnoredReaderVideoCandidate(item)
  );
  if (candidates.length === 0) {
    return null;
  }

  const visible = candidates
    .map((item) => {
      const rect = item.getBoundingClientRect();
      const host = findReaderPlayerHost(item);
      const inPlayer = Boolean(
        host &&
          (host.matches?.("#bilibili-player, .bpx-player-container, .bpx-player-video-area") ||
            host.querySelector?.(".bpx-player-video-area"))
      );
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const score =
        area +
        (inPlayer ? 1000000 : 0) +
        (!item.paused ? 20000 : 0) +
        Number(item.readyState || 0) * 2000 +
        (item.currentSrc ? 10000 : 0) +
        (item === readingVideoEl ? 500 : 0);
      return { item, rect, score };
    })
    .filter(({ rect }) => rect.width > 240 && rect.height > 120)
    .sort((a, b) => b.score - a.score)[0];

  const result = visible?.item || candidates[0] || null;
  if (result) {
    cachedVideoRef = new WeakRef(result);
  }
  return result;
}

// 等待视频元数据（时长可用）就绪。叶子事实出装配根（ADR-0017 修订，原居
// reader/lifecycle.ts）：本函数只轮询 getRuntimeVideoElement，与 reader 动态域
// 零实质耦合；页面预抓取与 reader 域内兜底抓取共用同一次序语义（150ms 轮询 /
// 5 秒上限），两侧现在静态 import 本函数。
export function waitForVideoMetadata(timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve) => {
    const start = Date.now();
    const check = () => {
      const video = getRuntimeVideoElement();
      const duration = Number(video?.duration);
      const ready = video && Number.isFinite(duration) && duration > 0;
      if (ready || Date.now() - start >= timeoutMs) {
        resolve();
        return;
      }
      window.setTimeout(check, 150);
    };
    check();
  });
}
