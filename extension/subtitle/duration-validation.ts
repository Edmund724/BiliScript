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
