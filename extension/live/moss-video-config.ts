export interface MossVideoCaptureConfig {
  maxLongSide: number;
  jpegQuality: number;
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

export function resolveMossVideoConfig(lowBandwidth: boolean): MossVideoCaptureConfig {
  return lowBandwidth
    ? { ...MOSS_LOW_BANDWIDTH_VIDEO_CONFIG }
    : { ...MOSS_STANDARD_VIDEO_CONFIG };
}

function readPositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

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

export function buildMossMediaConfigureVideo(
  config: MossVideoCaptureConfig
): { max_long_side: number; jpeg_quality: number; interval_ms: number } {
  return {
    max_long_side: config.maxLongSide,
    jpeg_quality: config.jpegQuality,
    interval_ms: config.intervalMs
  };
}

export type MossVideoConfiguredReceipt = Partial<
  Record<"max_long_side" | "jpeg_quality" | "interval_ms", unknown>
>;
