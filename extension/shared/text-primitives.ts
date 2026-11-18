// extension/shared/text-primitives.ts
// 零依赖纯文本、哈希与时间轴对齐原语：
// - getSharedZhWordSegmenter：惰性单例中文词粒度 Intl.Segmenter；
// - fnv1a32：32 位 FNV-1a 哈希（支持自定义初始种子）；
// - truncateWithEllipsis：UTF-16 代理对安全截断并追加省略号；
// - findNearestTimedLineIndex：基于时间距离与自定义打分的最近时间行查找。
// 约束：零 chrome / DOM / storage / 外部依赖，可安全进入任意入口与动态 chunk。

const FNV1A_OFFSET_BASIS = 0x811c9dc5;
const FNV1A_PRIME = 0x01000193;

let sharedZhWordSegmenter: Intl.Segmenter | null = null;

/**
 * 获取全局复用的中文词粒度 `Intl.Segmenter` 惰性单例；运行环境不支持时返回 `null`。
 */
export function getSharedZhWordSegmenter(): Intl.Segmenter | null {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") {
    return null;
  }
  if (!sharedZhWordSegmenter) {
    sharedZhWordSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
  }
  return sharedZhWordSegmenter;
}

/**
 * 计算 32 位无符号 FNV-1a 哈希值。
 * 未传 `seed` 时从标准偏移基准 `0x811c9dc5` 起算；传入 `seed` 时从 `(seed ^ 0x811c9dc5) >>> 0` 起算。
 */
export function fnv1a32(input: string, seed?: number): number {
  let hash = seed === undefined ? FNV1A_OFFSET_BASIS : (seed ^ FNV1A_OFFSET_BASIS) >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash ^ input.charCodeAt(i)) >>> 0;
    hash = Math.imul(hash, FNV1A_PRIME) >>> 0;
  }
  return hash >>> 0;
}

export interface TruncateWithEllipsisOptions {
  /** 为 true 时先将连续空白折叠为单空格并裁剪首尾空白。 */
  singleLine?: boolean;
}

/**
 * UTF-16 代理对安全截断：超出 `maxChars` 时追加 `…` 并确保总长度不超过 `maxChars`，
 * 同时避免从高/低代理项之间劈开四字节字符。
 */
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
  /** 允许的最大时间偏移（秒）；超出该阈值的行将被跳过。 */
  maxTimeDistanceSeconds?: number;
  /** 候选行综合打分函数（分值越高越优；默认按 `-distanceSeconds` 取时间最近行）。 */
  scoreLine?: (line: T, distanceSeconds: number) => number;
}

/**
 * 在带起始时间戳的文本行列表中查找与 `targetSeconds` 最匹配的行索引；无合法候选时返回 `-1`。
 */
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
