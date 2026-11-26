import {
  createHistoricalVideoFrameSession,
  type HistoricalVideoFrameSnapshot
} from "../chat/historical-video-frame.js";
import { getActiveReaderDocument, getActiveReaderWindow } from "../shared/active-host.js";
import { base64ToBytes, bytesToBase64 } from "../shared/bytes.js";
import { parseClock } from "../shared/clock-text.js";
import { logWarn } from "../shared/logging.js";
import {
  YOUTUBE_UNIT_CID,
  getSiteCapabilities,
  normalizeSiteId,
  type SiteId
} from "../shared/site.js";
import { buildNoteTimestampDeepLink } from "./template.js";
import type { NoteKeyframeCandidate } from "./turn-frame-cache.js";

export type { NoteKeyframeCandidate } from "./turn-frame-cache.js";

export const MAX_NOTE_KEYFRAMES = 6;
export const NOTE_KEYFRAME_CACHE_TOLERANCE_SECONDS = 2;
export const NOTE_KEYFRAME_MAX_WIDTH = 800;
export const NOTE_KEYFRAME_WEBP_QUALITY = 0.72;
export const NOTE_KEYFRAME_JPEG_QUALITY = 0.75;
export const DEFAULT_NOTE_KEYFRAME_CAPTION = "查看原片画面";

const FENCE_OPEN_RE = /^[ ]{0,3}(`{3,}|~{3,})/;
const FRAME_MARKER_LINE_RE =
  /^\s*\{\{\s*frame\s*:\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:\|\s*([\s\S]*?))?\s*\}\}\s*$/i;
const BASE64_DATA_URL_RE = /^data:([^;,]+);base64,([\s\S]+)$/i;

export interface NoteKeyframeResolveContext {
  site: SiteId;
  bvid: string;
  videoId: string;
  cid: string;
  pageUrl: string;
  includeKeyframes: boolean;
  capturedFrames?: readonly NoteKeyframeCandidate[];
}

export type ResolveNoteKeyframesFn = (
  markdown: string,
  context: NoteKeyframeResolveContext
) => Promise<string> | string;

export interface ParsedNoteKeyframeMarker {
  lineIndex: number;
  clock: string;
  seconds: number;
  caption: string;
  rawLine: string;
}

export interface NoteKeyframeHistoricalSession {
  capture(
    targetTime: number,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<readonly HistoricalVideoFrameSnapshot[]>;
  close(): void;
}

export interface NoteKeyframeEncodeInput {
  dataUrl: string;
  maxWidth: number;
  webpQuality: number;
  jpegQuality: number;
}

export interface DecodedKeyframeImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose?: () => void;
}

export interface ReencodeKeyframeDeps {
  decodeImage?: (dataUrl: string) => Promise<DecodedKeyframeImage>;
  createCanvas?: () => HTMLCanvasElement;
}

export interface ResolveNoteKeyframesOptions {
  supportsHistoricalFrameCapture?: boolean;
  maxKeyframes?: number;
  cacheToleranceSeconds?: number;
  maxWidth?: number;
  webpQuality?: number;
  jpegQuality?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  createHistoricalSession?: (input: {
    site: SiteId;
    bvid: string;
    cid: string;
  }) => NoteKeyframeHistoricalSession;
  reencodeDataUrl?: (input: NoteKeyframeEncodeInput) => Promise<string>;
}

export function sanitizeKeyframeAlt(text: string): string {
  return String(text ?? "")
    .replace(/[\[\]\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCaptionText(rawCaption: string | undefined): string {
  const cleaned = String(rawCaption ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || DEFAULT_NOTE_KEYFRAME_CAPTION;
}

export function parseNoteKeyframeMarkerLine(
  line: string
): Omit<ParsedNoteKeyframeMarker, "lineIndex"> | null {
  const match = String(line ?? "").match(FRAME_MARKER_LINE_RE);
  if (!match) {
    return null;
  }
  const clock = match[1].trim();
  const seconds = parseClock(clock);
  if (seconds === null) {
    return null;
  }
  return {
    clock,
    seconds,
    caption: normalizeCaptionText(match[2]),
    rawLine: line
  };
}

export function fitKeyframeDimensions(
  width: number,
  height: number,
  maxWidth: number = NOTE_KEYFRAME_MAX_WIDTH
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("无效的关键帧尺寸");
  }
  const safeMaxWidth = Math.max(1, Math.round(maxWidth));
  if (width <= safeMaxWidth) {
    return {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height))
    };
  }
  const scale = safeMaxWidth / width;
  return {
    width: safeMaxWidth,
    height: Math.max(1, Math.round(height * scale))
  };
}

async function decodeKeyframeDataUrlDefault(dataUrl: string): Promise<DecodedKeyframeImage> {
  const trimmed = String(dataUrl ?? "").trim();
  const match = trimmed.match(BASE64_DATA_URL_RE);
  if (match && typeof globalThis.createImageBitmap === "function") {
    const mime = match[1] || "image/jpeg";
    const bytes = new Uint8Array(base64ToBytes(match[2]));
    const activeWin = getActiveReaderWindow() as Window & { Blob?: typeof Blob };
    const BlobCtor = activeWin?.Blob ?? Blob;
    const blob = new BlobCtor([bytes], { type: mime });
    const bitmap = await globalThis.createImageBitmap(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      dispose: () => {
        try {
          bitmap.close?.();
        } catch {
        }
      }
    };
  }

  const activeWin = getActiveReaderWindow() as Window & { Image?: typeof Image };
  const ImageCtor = activeWin?.Image ?? Image;
  return await new Promise<DecodedKeyframeImage>((resolve, reject) => {
    const img = new ImageCtor();
    img.onload = () => {
      resolve({
        source: img,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height
      });
    };
    img.onerror = () => {
      reject(new Error("关键帧图像解码失败"));
    };
    img.src = trimmed;
  });
}

export async function reencodeKeyframeDataUrl(
  input: NoteKeyframeEncodeInput,
  deps: ReencodeKeyframeDeps = {}
): Promise<string> {
  const decodeImage = deps.decodeImage ?? decodeKeyframeDataUrlDefault;
  const createCanvas =
    deps.createCanvas ?? (() => getActiveReaderDocument().createElement("canvas"));

  const decoded = await decodeImage(input.dataUrl);
  try {
    const { width, height } = fitKeyframeDimensions(
      decoded.width,
      decoded.height,
      input.maxWidth
    );
    const canvas = createCanvas();
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("canvas 2d 上下文不可用");
    }
    ctx.drawImage(decoded.source, 0, 0, width, height);

    const webpUrl = canvas.toDataURL("image/webp", input.webpQuality);
    if (typeof webpUrl === "string" && webpUrl.startsWith("data:image/webp")) {
      return webpUrl;
    }
    const jpegUrl = canvas.toDataURL("image/jpeg", input.jpegQuality);
    if (typeof jpegUrl === "string" && jpegUrl.startsWith("data:image/jpeg")) {
      return jpegUrl;
    }
    throw new Error("关键帧画布重编码失败");
  } finally {
    decoded.dispose?.();
  }
}

function findFrontmatterEndLine(lines: readonly string[]): number {
  if (lines.length < 3 || lines[0].trim() !== "---") {
    return -1;
  }
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "---" || trimmed === "...") {
      return i;
    }
  }
  return -1;
}

function scanKeyframeMarkers(lines: readonly string[]): ParsedNoteKeyframeMarker[] {
  const frontmatterEnd = findFrontmatterEndLine(lines);
  const markers: ParsedNoteKeyframeMarker[] = [];
  let activeFenceChar = "";
  let activeFenceLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (frontmatterEnd !== -1 && index <= frontmatterEnd) {
      continue;
    }
    const line = lines[index];
    if (activeFenceChar) {
      const closeMatch = line.match(FENCE_OPEN_RE);
      if (
        closeMatch &&
        closeMatch[1][0] === activeFenceChar &&
        closeMatch[1].length >= activeFenceLength &&
        line.slice(closeMatch[0].length).trim() === ""
      ) {
        activeFenceChar = "";
        activeFenceLength = 0;
      }
      continue;
    }
    const openMatch = line.match(FENCE_OPEN_RE);
    if (openMatch) {
      activeFenceChar = openMatch[1][0];
      activeFenceLength = openMatch[1].length;
      continue;
    }
    const parsed = parseNoteKeyframeMarkerLine(line);
    if (parsed) {
      markers.push({ lineIndex: index, ...parsed });
    }
  }

  return markers;
}

function findClosestCandidateWithinTolerance(
  pool: readonly NoteKeyframeCandidate[],
  targetSeconds: number,
  toleranceSeconds: number
): NoteKeyframeCandidate | null {
  let best: NoteKeyframeCandidate | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const candidate of pool) {
    const delta = Math.abs(candidate.seconds - targetSeconds);
    if (delta <= toleranceSeconds && delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best;
}

function formatCaptionLine(
  marker: ParsedNoteKeyframeMarker,
  context: NoteKeyframeResolveContext
): string {
  const deepLink = buildNoteTimestampDeepLink(marker.seconds, {
    site: context.site,
    pageUrl: context.pageUrl,
    bvid: context.bvid,
    videoId: context.videoId
  });
  if (deepLink) {
    return `*▲ [${marker.clock}](${deepLink}) ${marker.caption}*`;
  }
  return `*▲ ${marker.clock} ${marker.caption}*`;
}

function formatEmbeddedKeyframe(
  marker: ParsedNoteKeyframeMarker,
  dataUrl: string,
  context: NoteKeyframeResolveContext,
  lineBreak: string
): string {
  const alt = sanitizeKeyframeAlt(`${marker.clock} ${marker.caption}`) || marker.clock;
  const captionLine = formatCaptionLine(marker, context);
  return `![${alt}](${dataUrl})${lineBreak}${captionLine}`;
}

function snapshotToCandidate(
  snapshot: HistoricalVideoFrameSnapshot
): NoteKeyframeCandidate | null {
  if (!snapshot?.jpegBytes || snapshot.jpegBytes.length === 0) {
    return null;
  }
  const seconds = Number(snapshot.currentTime);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return {
    seconds,
    dataUrl: `data:image/jpeg;base64,${bytesToBase64(snapshot.jpegBytes)}`
  };
}

export async function resolveNoteKeyframes(
  markdown: string,
  context: NoteKeyframeResolveContext,
  options: ResolveNoteKeyframesOptions = {}
): Promise<string> {
  const source = String(markdown ?? "");
  if (!source) {
    return source;
  }

  const lineBreak = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const markers = scanKeyframeMarkers(lines);
  if (markers.length === 0) {
    return source;
  }

  if (!context.includeKeyframes) {
    for (const marker of markers) {
      lines[marker.lineIndex] = formatCaptionLine(marker, context);
    }
    return lines.join(lineBreak);
  }

  const site = normalizeSiteId(context.site);
  const maxKeyframes = Math.max(0, options.maxKeyframes ?? MAX_NOTE_KEYFRAMES);
  const toleranceSeconds = Math.max(
    0,
    options.cacheToleranceSeconds ?? NOTE_KEYFRAME_CACHE_TOLERANCE_SECONDS
  );
  const maxWidth = options.maxWidth ?? NOTE_KEYFRAME_MAX_WIDTH;
  const webpQuality = options.webpQuality ?? NOTE_KEYFRAME_WEBP_QUALITY;
  const jpegQuality = options.jpegQuality ?? NOTE_KEYFRAME_JPEG_QUALITY;
  const supportsHistorical =
    options.supportsHistoricalFrameCapture ??
    getSiteCapabilities(site).supportsHistoricalFrameCapture;
  const createSession =
    options.createHistoricalSession ??
    ((input) => createHistoricalVideoFrameSession(input, { timeoutMs: options.timeoutMs }));
  const reencode = options.reencodeDataUrl ?? ((input) => reencodeKeyframeDataUrl(input));

  const candidatePool: NoteKeyframeCandidate[] = [];
  for (const frame of context.capturedFrames ?? []) {
    if (
      frame &&
      Number.isFinite(frame.seconds) &&
      frame.seconds >= 0 &&
      typeof frame.dataUrl === "string" &&
      frame.dataUrl.trim().startsWith("data:image/")
    ) {
      candidatePool.push({ seconds: frame.seconds, dataUrl: frame.dataUrl.trim() });
    }
  }

  const sessionBvid = site === "youtube" ? context.videoId || context.bvid : context.bvid || context.videoId;
  const sessionCid = site === "youtube" ? context.cid || YOUTUBE_UNIT_CID : context.cid;
  const canCaptureHistorical =
    supportsHistorical && (site === "youtube" ? Boolean(sessionBvid) : Boolean(sessionBvid && sessionCid));

  const encodedCache = new Map<string, string>();
  let historicalSession: NoteKeyframeHistoricalSession | null = null;

  try {
    for (let index = 0; index < markers.length; index += 1) {
      const marker = markers[index];
      if (index >= maxKeyframes || options.signal?.aborted) {
        lines[marker.lineIndex] = formatCaptionLine(marker, context);
        continue;
      }

      let rawCandidate = findClosestCandidateWithinTolerance(
        candidatePool,
        marker.seconds,
        toleranceSeconds
      );

      if (!rawCandidate && canCaptureHistorical) {
        try {
          if (!historicalSession) {
            historicalSession = createSession({
              site,
              bvid: sessionBvid,
              cid: sessionCid
            });
          }
          const snapshots = await historicalSession.capture(marker.seconds, {
            timeoutMs: options.timeoutMs,
            signal: options.signal
          });
          const captured: NoteKeyframeCandidate[] = [];
          for (const snapshot of snapshots ?? []) {
            const converted = snapshotToCandidate(snapshot);
            if (converted) {
              captured.push(converted);
              candidatePool.push(converted);
            }
          }
          if (captured.length > 0) {
            rawCandidate =
              findClosestCandidateWithinTolerance(captured, marker.seconds, Number.POSITIVE_INFINITY);
          }
        } catch (error) {
          logWarn("[BILISCRIPT] historical keyframe capture degraded", error);
        }
      }

      if (!rawCandidate) {
        lines[marker.lineIndex] = formatCaptionLine(marker, context);
        continue;
      }

      try {
        let encodedUrl = encodedCache.get(rawCandidate.dataUrl);
        if (!encodedUrl) {
          encodedUrl = await reencode({
            dataUrl: rawCandidate.dataUrl,
            maxWidth,
            webpQuality,
            jpegQuality
          });
          if (!encodedUrl || !encodedUrl.startsWith("data:image/")) {
            throw new Error("重编码结果不是有效的图片 Data URL");
          }
          encodedCache.set(rawCandidate.dataUrl, encodedUrl);
        }
        lines[marker.lineIndex] = formatEmbeddedKeyframe(marker, encodedUrl, context, lineBreak);
      } catch (error) {
        logWarn("[BILISCRIPT] keyframe re-encode degraded", error);
        lines[marker.lineIndex] = formatCaptionLine(marker, context);
      }
    }
  } finally {
    if (historicalSession) {
      try {
        historicalSession.close();
      } catch {
      }
    }
  }

  return lines.join(lineBreak);
}
