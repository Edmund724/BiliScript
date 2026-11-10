// extension/live/moss-video-config.ts
// MOSS-LIVE 画面采集参数：media.configure.video 上行请求与 media.configured.video
// 回执共用同一份值域。页面侧抽帧按此缩放长边、选 JPEG 质量与抽帧间隔；
// standard 为服务端默认画质，low-bandwidth 为弱网档。

export interface MossVideoCaptureConfig {
  /** 画面长边上限（像素） */
  maxLongSide: number;
  /** JPEG 编码质量（0–1） */
  jpegQuality: number;
  /** 抽帧间隔（毫秒） */
  intervalMs: number;
}

export const MOSS_STANDARD_VIDEO_CONFIG: Readonly<MossVideoCaptureConfig> = Object.freeze({
  maxLongSide: 512,
  jpegQuality: 0.75,
  intervalMs: 1000
});

export const MOSS_LOW_BANDWIDTH_VIDEO_CONFIG: Readonly<MossVideoCaptureConfig> = Object.freeze({
  maxLongSide: 384,
  jpegQuality: 0.5,
  intervalMs: 2000
});

/** 低带宽开关对应的请求参数；关闭即 standard 默认。 */
export function resolveMossVideoConfig(lowBandwidth: boolean): MossVideoCaptureConfig {
  return lowBandwidth
    ? { ...MOSS_LOW_BANDWIDTH_VIDEO_CONFIG }
    : { ...MOSS_STANDARD_VIDEO_CONFIG };
}

function readPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/**
 * 把回执中的 video（蛇形字段，服务端可能只回部分键）并入回退值。
 * 非法值逐字段回退，不因单字段异常丢弃整份回执。
 */
export function normalizeMossVideoConfig(
  raw: unknown,
  fallback: MossVideoCaptureConfig = MOSS_STANDARD_VIDEO_CONFIG
): MossVideoCaptureConfig {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const maxLongSide = readPositiveNumber(source.max_long_side);
  const jpegQuality = readPositiveNumber(source.jpeg_quality);
  const intervalMs = readPositiveNumber(source.interval_ms);
  return {
    maxLongSide: maxLongSide !== undefined ? Math.round(maxLongSide) : fallback.maxLongSide,
    jpegQuality: jpegQuality !== undefined ? Math.min(1, jpegQuality) : fallback.jpegQuality,
    intervalMs: intervalMs !== undefined ? Math.round(intervalMs) : fallback.intervalMs
  };
}

/** media.configure.video 的上行字段（蛇形协议命名）。 */
export function buildMossMediaConfigureVideo(
  config: MossVideoCaptureConfig
): { max_long_side: number; jpeg_quality: number; interval_ms: number } {
  return {
    max_long_side: config.maxLongSide,
    jpeg_quality: config.jpegQuality,
    interval_ms: config.intervalMs
  };
}

/** media.configured.video 回执的原始蛇形形状：服务端可能只回部分键，值也未必合法。 */
export type MossVideoConfiguredReceipt = Partial<
  Record<"max_long_side" | "jpeg_quality" | "interval_ms", unknown>
>;
