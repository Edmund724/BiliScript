// 字幕正文 ✕ 视频时长的匹配校验叶（架构评审「轨道身份：selection.ts 按概念拆位」，
// 自 subtitle/selection.ts 逐字搬出，零逻辑改动）。
//
// 概念：给定一条轨的正文与视频时长，回答「这份正文配得上这个视频吗」——空体、
// 超长（12 秒 / 15% 上限容忍）、覆盖不足（180/300/600 三档覆盖率门槛）三类判据。
//
// 独立成叶的理由：判据有两个消费侧——subtitle/body.ts 的取体链（缓存命中与网络体
// 各校验一次）与 asr/fallback.ts 的缓存命中校验。本叶零 import，两侧各自 import 它
// 即可，不必为一条判据把对方的闭包（body 的 gateway 链 / fallback 的转写管线）拖进来。

export interface DurationValidationResult {
  ok: boolean;
  reason: string;
  videoDuration: number;
  maxTo: number;
}

export function validateSubtitleByDuration(body: unknown[], videoDuration: unknown): DurationValidationResult {
  const duration = Number(videoDuration || 0);
  if (!Array.isArray(body) || body.length === 0) {
    return { ok: false, reason: "empty", videoDuration: duration, maxTo: 0 };
  }

  let maxTo = 0;
  for (const item of body) {
    const to = Number((item as { to?: unknown }).to);
    const from = Number((item as { from?: unknown }).from);
    if (Number.isFinite(to) && to > maxTo) {
      maxTo = to;
    }
    if (Number.isFinite(from) && from > maxTo) {
      maxTo = from;
    }
  }

  if (!(duration > 0)) {
    return { ok: true, reason: "skip-no-video-duration", videoDuration: duration, maxTo };
  }

  const upperTolerance = Math.max(12, duration * 0.15);
  if (maxTo > duration + upperTolerance) {
    return { ok: false, reason: "too-long", videoDuration: duration, maxTo };
  }

  let minCoverageRatio = 0;
  if (duration >= 600) {
    minCoverageRatio = 0.18;
  } else if (duration >= 300) {
    minCoverageRatio = 0.22;
  } else if (duration >= 180) {
    minCoverageRatio = 0.25;
  }

  if (minCoverageRatio > 0 && maxTo < duration * minCoverageRatio) {
    return { ok: false, reason: "too-short", videoDuration: duration, maxTo };
  }

  return { ok: true, reason: "ok", videoDuration: duration, maxTo };
}
