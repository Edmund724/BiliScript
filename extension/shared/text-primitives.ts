const FNV1A_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;

let sharedZhWordSegmenter: Intl.Segmenter | null = null;

export function getSharedZhWordSegmenter(): Intl.Segmenter | null {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") {
    return null;
  }
  if (!sharedZhWordSegmenter) {
    sharedZhWordSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
  }
  return sharedZhWordSegmenter;
}

export function fnv1a32(input: string, seed?: number): number {
  let hash = seed === undefined ? FNV1A_OFFSET_BASIS : (seed ^ FNV1A_OFFSET_BASIS) >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash ^ input.charCodeAt(i)) >>> 0;
    hash = Math.imul(hash, FNV1A_PRIME) >>> 0;
  }
  return hash >>> 0;
}

export interface TruncateWithEllipsisOptions {
  singleLine?: boolean;
}

export function truncateWithEllipsis(
  text: unknown,
  maxChars: number,
  options?: TruncateWithEllipsisOptions
): string {
  const limit = Math.max(0, Math.floor(Number(maxChars) || 0));
  const raw = String(text ?? "");
  const normalized = options?.singleLine ? raw.replace(/\s+/g, " ").trim() : raw;
  if (limit === 0 || !normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  if (limit === 1) {
    return "…";
  }
  let end = limit - 1;
  const prev = normalized.charCodeAt(end - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) {
    end -= 1;
  }
  const prefix = normalized.slice(0, end).trimEnd();
  return prefix ? `${prefix}…` : "…";
}

export interface FindNearestTimedLineOptions<T extends { from: number; content: string }> {
  maxTimeDistanceSeconds?: number;
  scoreLine?: (line: T, distanceSeconds: number) => number;
}

export function findNearestTimedLineIndex<T extends { from: number; content: string }>(
  lines: readonly T[],
  targetSeconds: number,
  options?: FindNearestTimedLineOptions<T>
): number {
  if (!Array.isArray(lines) || lines.length === 0 || !Number.isFinite(targetSeconds)) {
    return -1;
  }
  const maxDistance = options?.maxTimeDistanceSeconds;
  const hasMaxDistance = typeof maxDistance === "number" && !Number.isNaN(maxDistance);
  const scoreLine = options?.scoreLine ?? ((_line: T, distanceSeconds: number) => -distanceSeconds);

  let bestIdx = -1;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const from = Number(line.from);
    if (!Number.isFinite(from)) {
      continue;
    }
    const distanceSeconds = Math.abs(from - targetSeconds);
    if (hasMaxDistance && distanceSeconds > maxDistance) {
      continue;
    }
    const score = scoreLine(line, distanceSeconds);
    if (Number.isFinite(score) && score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx;
}
