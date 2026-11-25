import { concatByteArrays } from "../shared/bytes.js";

export const YOUTUBE_SABR_CHANNEL = "biliscript-yt-sabr-v1" as const;
export const YOUTUBE_SABR_SNIFFER_SLOT_KEY = "biliscript.ytSabrSniffer.v1" as const;
export const YOUTUBE_SABR_WORKER_SLOT_KEY = "biliscript.ytSabrWorker.v1" as const;

export const SABR_BODY_LIMIT = 65536;
export const SABR_RESPONSE_SNIFF_LIMIT = 8 * 1024 * 1024;
export const SABR_EXPIRE_SAFETY_MARGIN_SEC = 30;

export const UMP_PART_MEDIA_HEADER = 20;
export const UMP_PART_MEDIA = 21;
export const UMP_PART_MEDIA_END = 22;
export const UMP_PART_NEXT_REQUEST_POLICY = 35;
export const UMP_PART_FORMAT_INIT_METADATA = 42;
export const UMP_PART_SABR_REDIRECT = 43;
export const UMP_PART_SABR_ERROR = 44;
export const UMP_PART_SABR_CONTEXT_UPDATE = 57;
export const UMP_PART_STREAM_PROTECTION_STATUS = 58;
export const UMP_PART_SABR_CONTEXT_SENDING_POLICY = 59;

export const STREAM_PROTECTION_REJECTED = 3;

const FLOAT32_ONE_BYTES = new Uint8Array([0, 0, 128, 63]);
const CPN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export interface ProtoField {
  fieldNumber: number;
  wireType: number;
  raw: Uint8Array;
  varint?: bigint;
  bytes?: Uint8Array;
}

export interface SabrFormatId {
  itag: number;
  lastModified: bigint;
  xtags: string;
}

export interface YoutubeAdaptiveFormatLike {
  itag?: unknown;
  mimeType?: unknown;
  bitrate?: unknown;
  lastModified?: unknown;
  approxDurationMs?: unknown;
  xtags?: unknown;
  audioTrack?: {
    id?: unknown;
    displayName?: unknown;
    audioIsDefault?: unknown;
  } | null;
}

export interface SelectedYoutubeAudioFormat {
  itag: number;
  lastModified: bigint;
  xtags: string;
  audioTrackId: string;
  mimeType: string;
  bitrate: number;
  approxDurationMs: number;
}

export interface UmpMediaHeader {
  headerId: number;
  videoId: string;
  itag: number;
  lastModified: bigint;
  xtags: string;
  isInitSeg: boolean;
  sequenceNumber: number;
  startMs: number;
  durationMs: number;
}

export interface UmpFormatInitMetadata {
  videoId: string;
  formatId: SabrFormatId | null;
  endTimeMs: number;
  endSegmentNumber: number;
  mimeType: string;
}

export interface UmpNextRequestPolicy {
  backoffTimeMs: number;
  playbackCookie: Uint8Array | null;
}

export interface UmpSabrContextUpdate {
  type: number;
  scope: number;
  sendByDefault: boolean;
  writePolicy: number;
  raw: Uint8Array;
}

export interface UmpSabrContextSendingPolicy {
  startPolicy: number[];
  stopPolicy: number[];
  discardPolicy: number[];
}

export interface UmpMediaSegment {
  header: UmpMediaHeader;
  data: Uint8Array;
}

export interface UmpParsedResponse {
  initMetadatas: UmpFormatInitMetadata[];
  mediaSegments: UmpMediaSegment[];
  nextRequestPolicy: UmpNextRequestPolicy | null;
  redirectUrl: string;
  sabrError: { type: string; code: number } | null;
  contextUpdates: UmpSabrContextUpdate[];
  contextSendingPolicies: UmpSabrContextSendingPolicy[];
  streamProtectionStatus: number | null;
}

export interface SabrBufferedRangeSpec {
  formatId: SabrFormatId;
  startTimeMs: number;
  durationMs: number;
  startSegmentIndex: number;
  endSegmentIndex: number;
}

export interface RewriteSabrRequestOptions {
  templateBody: Uint8Array;
  targetFormat: SabrFormatId;
  positionMs: number;
  playbackCookie?: Uint8Array | null;
  bufferedRange?: SabrBufferedRangeSpec | null;
  sabrContexts?: readonly Uint8Array[];
  unsentContextTypes?: readonly number[];
}

export interface SynthesizeSabrTemplateOptions {
  clientName: number;
  clientVersion: string;
  ustreamerConfig: Uint8Array;
  poToken?: Uint8Array | null;
  targetFormat: SabrFormatId;
}

export function isValidGooglevideoUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== "googlevideo.com" && !host.endsWith(".googlevideo.com")) return false;
    return parsed.pathname === "/videoplayback";
  } catch {
    return false;
  }
}

export function extractGooglevideoExpireSec(rawUrl: string): number {
  try {
    const parsed = new URL(rawUrl);
    const raw = Number(parsed.searchParams.get("expire"));
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  } catch {
    return 0;
  }
}

export function isGooglevideoUrlFresh(
  rawUrl: string,
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  if (!isValidGooglevideoUrl(rawUrl)) return false;
  const expire = extractGooglevideoExpireSec(rawUrl);
  if (expire <= 0) return true;
  return expire > nowSec + SABR_EXPIRE_SAFETY_MARGIN_SEC;
}

export function generateCpn(length = 16): string {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CPN_ALPHABET[bytes[i] & 63];
  }
  return out;
}

export function buildSabrRequestUrl(baseUrl: string, cpn: string, rn: number): string {
  const parsed = new URL(baseUrl);
  parsed.searchParams.delete("rbuf");
  parsed.searchParams.delete("range");
  parsed.searchParams.set("cpn", cpn);
  parsed.searchParams.set("alr", "no");
  parsed.searchParams.set("rn", String(Math.max(0, Math.floor(rn))));
  return parsed.toString();
}

export function readProtoVarint(
  u8: Uint8Array,
  pos: number,
  end = u8.length
): { value: bigint; next: number } | null {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  while (p < end && shift <= 63n) {
    const byte = u8[p];
    p += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, next: p };
    }
    shift += 7n;
  }
  return null;
}

export function writeProtoVarint(rawValue: number | bigint): Uint8Array {
  let value = typeof rawValue === "bigint" ? rawValue : BigInt(Math.max(0, Math.trunc(rawValue)));
  if (value < 0n) {
    value = BigInt.asUintN(64, value);
  }
  const bytes: number[] = [];
  while (value >= 0x80n) {
    bytes.push(Number((value & 0x7fn) | 0x80n));
    value >>= 7n;
  }
  bytes.push(Number(value));
  return new Uint8Array(bytes);
}

export function encodeVarintField(fieldNumber: number, value: number | bigint): Uint8Array {
  const tag = writeProtoVarint((BigInt(fieldNumber) << 3n) | 0n);
  const val = writeProtoVarint(value);
  return concatByteArrays([tag, val]);
}

export function encodeBytesField(fieldNumber: number, payload: Uint8Array): Uint8Array {
  const tag = writeProtoVarint((BigInt(fieldNumber) << 3n) | 2n);
  const len = writeProtoVarint(payload.length);
  return concatByteArrays([tag, len, payload]);
}

export function encodeStringField(fieldNumber: number, text: string): Uint8Array {
  return encodeBytesField(fieldNumber, TEXT_ENCODER.encode(text));
}

export function encodeFixed32Field(fieldNumber: number, bytes4: Uint8Array): Uint8Array {
  const tag = writeProtoVarint((BigInt(fieldNumber) << 3n) | 5n);
  return concatByteArrays([tag, bytes4.subarray(0, 4)]);
}

export function readProtoFields(
  u8: Uint8Array,
  start = 0,
  end = u8.length
): ProtoField[] {
  const fields: ProtoField[] = [];
  let p = start;
  while (p < end) {
    const fieldStart = p;
    const tag = readProtoVarint(u8, p, end);
    if (!tag || tag.value === 0n) break;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    p = tag.next;

    if (wireType === 0) {
      const v = readProtoVarint(u8, p, end);
      if (!v) break;
      p = v.next;
      fields.push({
        fieldNumber,
        wireType,
        raw: u8.subarray(fieldStart, p),
        varint: v.value
      });
    } else if (wireType === 1) {
      if (p + 8 > end) break;
      p += 8;
      fields.push({
        fieldNumber,
        wireType,
        raw: u8.subarray(fieldStart, p)
      });
    } else if (wireType === 2) {
      const len = readProtoVarint(u8, p, end);
      if (!len) break;
      const byteLen = Number(len.value);
      if (byteLen < 0 || len.next + byteLen > end) break;
      const bytes = u8.subarray(len.next, len.next + byteLen);
      p = len.next + byteLen;
      fields.push({
        fieldNumber,
        wireType,
        raw: u8.subarray(fieldStart, p),
        bytes
      });
    } else if (wireType === 5) {
      if (p + 4 > end) break;
      p += 4;
      fields.push({
        fieldNumber,
        wireType,
        raw: u8.subarray(fieldStart, p)
      });
    } else {
      break;
    }
  }
  return fields;
}

export function replaceProtoFields(
  u8: Uint8Array,
  replacements: Map<number, Uint8Array[] | null>
): Uint8Array {
  const parts: Uint8Array[] = [];
  const fields = readProtoFields(u8);
  for (const field of fields) {
    if (replacements.has(field.fieldNumber)) {
      continue;
    }
    parts.push(field.raw);
  }
  for (const [, replacementList] of replacements) {
    if (!replacementList) continue;
    for (const item of replacementList) {
      parts.push(item);
    }
  }
  return concatByteArrays(parts);
}

export function encodeFormatId(format: SabrFormatId): Uint8Array {
  const parts: Uint8Array[] = [encodeVarintField(1, format.itag)];
  if (format.lastModified > 0n) {
    parts.push(encodeVarintField(2, format.lastModified));
  }
  if (format.xtags) {
    parts.push(encodeStringField(3, format.xtags));
  }
  return concatByteArrays(parts);
}

export function parseFormatId(bytes: Uint8Array): SabrFormatId | null {
  const fields = readProtoFields(bytes);
  let itag = 0;
  let lastModified = 0n;
  let xtags = "";
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.varint !== undefined) {
      itag = Number(field.varint);
    } else if (field.fieldNumber === 2 && field.varint !== undefined) {
      lastModified = field.varint;
    } else if (field.fieldNumber === 3 && field.bytes) {
      xtags = TEXT_DECODER.decode(field.bytes);
    }
  }
  return itag > 0 ? { itag, lastModified, xtags } : null;
}

function encodeBufferedRange(range: SabrBufferedRangeSpec): Uint8Array {
  const durationMs = Math.max(0, Math.round(range.durationMs));
  const startTimeMs = Math.max(0, Math.round(range.startTimeMs));
  const timeRange = concatByteArrays([
    encodeVarintField(1, startTimeMs),
    encodeVarintField(2, durationMs),
    encodeVarintField(3, 1000)
  ]);
  return concatByteArrays([
    encodeBytesField(1, encodeFormatId(range.formatId)),
    encodeVarintField(2, startTimeMs),
    encodeVarintField(3, durationMs),
    encodeVarintField(4, Math.max(1, Math.floor(range.startSegmentIndex))),
    encodeVarintField(5, Math.max(1, Math.floor(range.endSegmentIndex))),
    encodeBytesField(6, timeRange)
  ]);
}

export function rewriteSabrAbrRequest(options: RewriteSabrRequestOptions): Uint8Array {
  const topFields = readProtoFields(options.templateBody);
  const existingAbrState =
    topFields.find((f) => f.fieldNumber === 1 && f.bytes)?.bytes ?? new Uint8Array(0);
  const existingStreamerCtx =
    topFields.find((f) => f.fieldNumber === 19 && f.bytes)?.bytes ?? new Uint8Array(0);

  const nextAbrState = replaceProtoFields(
    existingAbrState,
    new Map<number, Uint8Array[] | null>([
      [28, [encodeVarintField(28, Math.max(0, Math.round(options.positionMs)))]],
      [35, [encodeFixed32Field(35, FLOAT32_ONE_BYTES)]],
      [40, [encodeVarintField(40, 1)]]
    ])
  );

  const streamerCtxReplacements = new Map<number, Uint8Array[] | null>([
    [
      3,
      options.playbackCookie && options.playbackCookie.length > 0
        ? [encodeBytesField(3, options.playbackCookie)]
        : null
    ],
    [
      5,
      options.sabrContexts && options.sabrContexts.length > 0
        ? options.sabrContexts.map((ctx) => encodeBytesField(5, ctx))
        : null
    ],
    [
      6,
      options.unsentContextTypes && options.unsentContextTypes.length > 0
        ? options.unsentContextTypes.map((t) => encodeVarintField(6, t))
        : null
    ]
  ]);
  const nextStreamerCtx = replaceProtoFields(existingStreamerCtx, streamerCtxReplacements);

  const formatIdBytes = encodeFormatId(options.targetFormat);
  const topReplacements = new Map<number, Uint8Array[] | null>([
    [1, [encodeBytesField(1, nextAbrState)]],
    [2, options.bufferedRange ? [encodeBytesField(2, formatIdBytes)] : null],
    [
      3,
      options.bufferedRange
        ? [encodeBytesField(3, encodeBufferedRange(options.bufferedRange))]
        : null
    ],
    [16, [encodeBytesField(16, formatIdBytes)]],
    [17, null],
    [18, null],
    [19, [encodeBytesField(19, nextStreamerCtx)]]
  ]);

  return replaceProtoFields(options.templateBody, topReplacements);
}

export function synthesizeSabrTemplateBody(options: SynthesizeSabrTemplateOptions): Uint8Array {
  const clientInfo = concatByteArrays([
    encodeVarintField(16, options.clientName || 1),
    ...(options.clientVersion ? [encodeStringField(17, options.clientVersion)] : [])
  ]);

  const streamerCtxParts: Uint8Array[] = [encodeBytesField(1, clientInfo)];
  if (options.poToken && options.poToken.length > 0) {
    streamerCtxParts.push(encodeBytesField(2, options.poToken));
  }

  const clientAbrState = concatByteArrays([
    encodeVarintField(28, 0),
    encodeFixed32Field(35, FLOAT32_ONE_BYTES),
    encodeVarintField(40, 1)
  ]);

  const formatIdBytes = encodeFormatId(options.targetFormat);

  return concatByteArrays([
    encodeBytesField(1, clientAbrState),
    ...(options.ustreamerConfig.length > 0
      ? [encodeBytesField(5, options.ustreamerConfig)]
      : []),
    encodeBytesField(16, formatIdBytes),
    encodeBytesField(19, concatByteArrays(streamerCtxParts))
  ]);
}

export function decodeBase64UrlToBytes(input: string): Uint8Array {
  const normalized = String(input || "")
    .trim()
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  if (!normalized) return new Uint8Array(0);
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function readUmpVarint(
  u8: Uint8Array,
  pos: number,
  end = u8.length
): { value: number; next: number } | null {
  if (pos >= end) return null;
  const prefix = u8[pos];
  if (prefix < 128) {
    return { value: prefix, next: pos + 1 };
  }
  if (prefix < 192) {
    if (pos + 2 > end) return null;
    return { value: (prefix & 0x3f) + (u8[pos + 1] << 6), next: pos + 2 };
  }
  if (prefix < 224) {
    if (pos + 3 > end) return null;
    return {
      value: (prefix & 0x1f) + (u8[pos + 1] << 5) + (u8[pos + 2] << 13),
      next: pos + 3
    };
  }
  if (prefix < 240) {
    if (pos + 4 > end) return null;
    return {
      value:
        ((prefix & 0x0f) +
          (u8[pos + 1] << 4) +
          (u8[pos + 2] << 12) +
          (u8[pos + 3] << 20)) >>>
        0,
      next: pos + 4
    };
  }
  if (pos + 5 > end) return null;
  return {
    value:
      (u8[pos + 1] | (u8[pos + 2] << 8) | (u8[pos + 3] << 16) | (u8[pos + 4] << 24)) >>> 0,
    next: pos + 5
  };
}

export function writeUmpVarint(value: number): Uint8Array {
  const v = value >>> 0;
  if (v < 128) {
    return new Uint8Array([v]);
  }
  if (v < 16384) {
    return new Uint8Array([0x80 | (v & 0x3f), (v >>> 6) & 0xff]);
  }
  if (v < 2097152) {
    return new Uint8Array([0xc0 | (v & 0x1f), (v >>> 5) & 0xff, (v >>> 13) & 0xff]);
  }
  if (v < 268435456) {
    return new Uint8Array([
      0xe0 | (v & 0x0f),
      (v >>> 4) & 0xff,
      (v >>> 12) & 0xff,
      (v >>> 20) & 0xff
    ]);
  }
  return new Uint8Array([
    0xf0,
    v & 0xff,
    (v >>> 8) & 0xff,
    (v >>> 16) & 0xff,
    (v >>> 24) & 0xff
  ]);
}

function parseTimeRangeMs(bytes: Uint8Array): { startMs: number; durationMs: number } {
  const fields = readProtoFields(bytes);
  let startTicks = 0;
  let durationTicks = 0;
  let timescale = 0;
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.varint !== undefined) startTicks = Number(field.varint);
    else if (field.fieldNumber === 2 && field.varint !== undefined) durationTicks = Number(field.varint);
    else if (field.fieldNumber === 3 && field.varint !== undefined) timescale = Number(field.varint);
  }
  if (timescale > 0) {
    return {
      startMs: Math.round((startTicks * 1000) / timescale),
      durationMs: Math.round((durationTicks * 1000) / timescale)
    };
  }
  return { startMs: 0, durationMs: 0 };
}

function parseMediaHeader(payload: Uint8Array): UmpMediaHeader | null {
  const fields = readProtoFields(payload);
  let headerId = -1;
  let videoId = "";
  let itag = 0;
  let lastModified = 0n;
  let xtags = "";
  let isInitSeg = false;
  let sequenceNumber = 0;
  let startMs = 0;
  let durationMs = 0;
  let timeRangeMs: { startMs: number; durationMs: number } | null = null;

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.varint !== undefined) {
      headerId = Number(field.varint);
    } else if (field.fieldNumber === 2 && field.bytes) {
      videoId = TEXT_DECODER.decode(field.bytes);
    } else if (field.fieldNumber === 3 && field.varint !== undefined) {
      itag = Number(field.varint);
    } else if (field.fieldNumber === 4 && field.varint !== undefined) {
      lastModified = field.varint;
    } else if (field.fieldNumber === 5 && field.bytes) {
      xtags = TEXT_DECODER.decode(field.bytes);
    } else if (field.fieldNumber === 8 && field.varint !== undefined) {
      isInitSeg = field.varint !== 0n;
    } else if (field.fieldNumber === 9 && field.varint !== undefined) {
      sequenceNumber = Number(field.varint);
    } else if (field.fieldNumber === 11 && field.varint !== undefined) {
      startMs = Number(field.varint);
    } else if (field.fieldNumber === 12 && field.varint !== undefined) {
      durationMs = Number(field.varint);
    } else if (field.fieldNumber === 13 && field.bytes) {
      const fmt = parseFormatId(field.bytes);
      if (fmt) {
        if (!itag) itag = fmt.itag;
        if (!lastModified) lastModified = fmt.lastModified;
        if (!xtags) xtags = fmt.xtags;
      }
    } else if (field.fieldNumber === 15 && field.bytes) {
      timeRangeMs = parseTimeRangeMs(field.bytes);
    }
  }
  if (headerId < 0) return null;
  if (durationMs <= 0 && timeRangeMs) {
    startMs = timeRangeMs.startMs;
    durationMs = timeRangeMs.durationMs;
  }
  return {
    headerId,
    videoId,
    itag,
    lastModified,
    xtags,
    isInitSeg,
    sequenceNumber: isInitSeg ? 0 : sequenceNumber,
    startMs,
    durationMs
  };
}

function parseFormatInitMetadata(payload: Uint8Array): UmpFormatInitMetadata {
  const fields = readProtoFields(payload);
  let videoId = "";
  let formatId: SabrFormatId | null = null;
  let endTimeMs = 0;
  let endSegmentNumber = 0;
  let mimeType = "";
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.bytes) {
      videoId = TEXT_DECODER.decode(field.bytes);
    } else if (field.fieldNumber === 2 && field.bytes) {
      formatId = parseFormatId(field.bytes);
    } else if (field.fieldNumber === 3 && field.varint !== undefined) {
      endTimeMs = Number(field.varint);
    } else if (field.fieldNumber === 4 && field.varint !== undefined) {
      endSegmentNumber = Number(field.varint);
    } else if (field.fieldNumber === 5 && field.bytes) {
      mimeType = TEXT_DECODER.decode(field.bytes);
    }
  }
  return { videoId, formatId, endTimeMs, endSegmentNumber, mimeType };
}

function parseNextRequestPolicy(payload: Uint8Array): UmpNextRequestPolicy {
  const fields = readProtoFields(payload);
  let backoffTimeMs = 0;
  let playbackCookie: Uint8Array | null = null;
  for (const field of fields) {
    if (field.fieldNumber === 4 && field.varint !== undefined) {
      backoffTimeMs = Number(field.varint);
    } else if (field.fieldNumber === 7 && field.bytes) {
      playbackCookie = field.bytes.slice();
    }
  }
  return { backoffTimeMs, playbackCookie };
}

function parseContextUpdate(payload: Uint8Array): UmpSabrContextUpdate | null {
  const fields = readProtoFields(payload);
  let type = 0;
  let scope = 0;
  let sendByDefault = false;
  let writePolicy = 1;
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.varint !== undefined) type = Number(field.varint);
    else if (field.fieldNumber === 2 && field.varint !== undefined) scope = Number(field.varint);
    else if (field.fieldNumber === 4 && field.varint !== undefined) sendByDefault = field.varint !== 0n;
    else if (field.fieldNumber === 5 && field.varint !== undefined) writePolicy = Number(field.varint);
  }
  if (!type) return null;
  return { type, scope, sendByDefault, writePolicy, raw: payload.slice() };
}

function parsePackedOrRepeatedVarints(field: ProtoField): number[] {
  if (field.varint !== undefined) {
    return [Number(field.varint)];
  }
  if (field.bytes) {
    const out: number[] = [];
    let p = 0;
    while (p < field.bytes.length) {
      const v = readProtoVarint(field.bytes, p, field.bytes.length);
      if (!v) break;
      out.push(Number(v.value));
      p = v.next;
    }
    return out;
  }
  return [];
}

function parseContextSendingPolicy(payload: Uint8Array): UmpSabrContextSendingPolicy {
  const fields = readProtoFields(payload);
  const startPolicy: number[] = [];
  const stopPolicy: number[] = [];
  const discardPolicy: number[] = [];
  for (const field of fields) {
    if (field.fieldNumber === 1) startPolicy.push(...parsePackedOrRepeatedVarints(field));
    else if (field.fieldNumber === 2) stopPolicy.push(...parsePackedOrRepeatedVarints(field));
    else if (field.fieldNumber === 3) discardPolicy.push(...parsePackedOrRepeatedVarints(field));
  }
  return { startPolicy, stopPolicy, discardPolicy };
}

export function parseUmpResponse(u8: Uint8Array): UmpParsedResponse {
  const initMetadatas: UmpFormatInitMetadata[] = [];
  const mediaSegments: UmpMediaSegment[] = [];
  const headersById = new Map<number, UmpMediaHeader>();
  const chunksById = new Map<number, Uint8Array[]>();
  let nextRequestPolicy: UmpNextRequestPolicy | null = null;
  let redirectUrl = "";
  let sabrError: { type: string; code: number } | null = null;
  const contextUpdates: UmpSabrContextUpdate[] = [];
  const contextSendingPolicies: UmpSabrContextSendingPolicy[] = [];
  let streamProtectionStatus: number | null = null;

  let p = 0;
  while (p < u8.length) {
    const partTypeInfo = readUmpVarint(u8, p, u8.length);
    if (!partTypeInfo) break;
    const partSizeInfo = readUmpVarint(u8, partTypeInfo.next, u8.length);
    if (!partSizeInfo) break;
    const payloadStart = partSizeInfo.next;
    const payloadEnd = payloadStart + partSizeInfo.value;
    if (payloadEnd > u8.length) break;
    const payload = u8.subarray(payloadStart, payloadEnd);
    p = payloadEnd;

    switch (partTypeInfo.value) {
      case UMP_PART_MEDIA_HEADER: {
        const header = parseMediaHeader(payload);
        if (header) {
          headersById.set(header.headerId, header);
          chunksById.set(header.headerId, []);
        }
        break;
      }
      case UMP_PART_MEDIA: {
        const idInfo = readUmpVarint(payload, 0, payload.length);
        if (idInfo) {
          const list = chunksById.get(idInfo.value);
          if (list && idInfo.next < payload.length) {
            list.push(payload.subarray(idInfo.next));
          }
        }
        break;
      }
      case UMP_PART_MEDIA_END: {
        const idInfo = readUmpVarint(payload, 0, payload.length);
        if (idInfo) {
          const header = headersById.get(idInfo.value);
          const list = chunksById.get(idInfo.value);
          if (header && list && list.length > 0) {
            mediaSegments.push({
              header,
              data: list.length === 1 ? list[0].slice() : concatByteArrays(list)
            });
          }
          headersById.delete(idInfo.value);
          chunksById.delete(idInfo.value);
        }
        break;
      }
      case UMP_PART_NEXT_REQUEST_POLICY: {
        nextRequestPolicy = parseNextRequestPolicy(payload);
        break;
      }
      case UMP_PART_FORMAT_INIT_METADATA: {
        initMetadatas.push(parseFormatInitMetadata(payload));
        break;
      }
      case UMP_PART_SABR_REDIRECT: {
        const fields = readProtoFields(payload);
        const urlField = fields.find((f) => f.fieldNumber === 1 && f.bytes);
        if (urlField?.bytes) {
          redirectUrl = TEXT_DECODER.decode(urlField.bytes);
        }
        break;
      }
      case UMP_PART_SABR_ERROR: {
        const fields = readProtoFields(payload);
        let type = "";
        let code = 0;
        for (const f of fields) {
          if (f.fieldNumber === 1 && f.bytes) type = TEXT_DECODER.decode(f.bytes);
          else if (f.fieldNumber === 2 && f.varint !== undefined) code = Number(f.varint);
        }
        sabrError = { type, code };
        break;
      }
      case UMP_PART_SABR_CONTEXT_UPDATE: {
        const update = parseContextUpdate(payload);
        if (update) contextUpdates.push(update);
        break;
      }
      case UMP_PART_STREAM_PROTECTION_STATUS: {
        const fields = readProtoFields(payload);
        const statusField = fields.find((f) => f.fieldNumber === 1 && f.varint !== undefined);
        if (statusField?.varint !== undefined) {
          streamProtectionStatus = Number(statusField.varint);
        }
        break;
      }
      case UMP_PART_SABR_CONTEXT_SENDING_POLICY: {
        contextSendingPolicies.push(parseContextSendingPolicy(payload));
        break;
      }
      default:
        break;
    }
  }

  return {
    initMetadatas,
    mediaSegments,
    nextRequestPolicy,
    redirectUrl,
    sabrError,
    contextUpdates,
    contextSendingPolicies,
    streamProtectionStatus
  };
}

export function extractVideoIdFromUmpBytes(u8: Uint8Array): {
  videoId: string;
  observedAudioItag: number;
  observedAudioXtags: string;
} {
  const parsed = parseUmpResponse(u8);
  let videoId = "";
  let observedAudioItag = 0;
  let observedAudioXtags = "";

  for (const meta of parsed.initMetadatas) {
    if (!videoId && meta.videoId) {
      videoId = meta.videoId;
    }
    if (meta.mimeType.startsWith("audio/") && meta.formatId) {
      observedAudioItag = meta.formatId.itag;
      observedAudioXtags = meta.formatId.xtags;
    }
  }
  for (const seg of parsed.mediaSegments) {
    if (!videoId && seg.header.videoId) {
      videoId = seg.header.videoId;
    }
  }
  return { videoId, observedAudioItag, observedAudioXtags };
}

function parseLastModifiedBigInt(raw: unknown): bigint {
  const text = String(raw ?? "").trim();
  if (!text || !/^\d+$/.test(text)) return 0n;
  try {
    return BigInt(text);
  } catch {
    return 0n;
  }
}

function isMp4AacMime(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  return lower.startsWith("audio/mp4") && lower.includes("mp4a.40.");
}

function isAacLcMime(mimeType: string): boolean {
  return mimeType.toLowerCase().includes("mp4a.40.2");
}

function normalizeTrackId(raw: unknown): string {
  return String(raw ?? "").trim();
}

export function selectTargetYoutubeAudioFormat(
  adaptiveFormats: readonly YoutubeAdaptiveFormatLike[] | null | undefined,
  options: {
    activeAudioTrackId?: string;
    preferredXtags?: string;
    observedAudioItag?: number;
  } = {}
): SelectedYoutubeAudioFormat | null {
  if (!Array.isArray(adaptiveFormats) || adaptiveFormats.length === 0) {
    return null;
  }

  let resolvedTrackId = normalizeTrackId(options.activeAudioTrackId);
  let resolvedXtags = String(options.preferredXtags ?? "").trim();

  if (!resolvedTrackId && options.observedAudioItag) {
    const observed = adaptiveFormats.find(
      (f) => Number(f?.itag) === options.observedAudioItag && (!resolvedXtags || String(f?.xtags ?? "").trim() === resolvedXtags)
    );
    if (observed?.audioTrack?.id) {
      resolvedTrackId = normalizeTrackId(observed.audioTrack.id);
    }
    if (!resolvedXtags && observed?.xtags) {
      resolvedXtags = String(observed.xtags).trim();
    }
  }

  const mp4Candidates: SelectedYoutubeAudioFormat[] = [];
  for (const raw of adaptiveFormats) {
    if (!raw || typeof raw !== "object") continue;
    const itag = Number(raw.itag);
    const mimeType = String(raw.mimeType ?? "").trim();
    if (!Number.isFinite(itag) || itag <= 0 || !isMp4AacMime(mimeType)) {
      continue;
    }
    mp4Candidates.push({
      itag,
      lastModified: parseLastModifiedBigInt(raw.lastModified),
      xtags: String(raw.xtags ?? "").trim(),
      audioTrackId: normalizeTrackId(raw.audioTrack?.id),
      mimeType,
      bitrate: Number(raw.bitrate) || 0,
      approxDurationMs: Number(raw.approxDurationMs) || 0
    });
  }

  if (mp4Candidates.length === 0) {
    return null;
  }

  let pool = mp4Candidates;
  if (resolvedTrackId) {
    const trackMatches = pool.filter((item) => item.audioTrackId === resolvedTrackId);
    if (trackMatches.length > 0) {
      pool = trackMatches;
    }
  } else {
    const defaultTrack = adaptiveFormats.find(
      (f) => f?.audioTrack?.audioIsDefault === true && normalizeTrackId(f.audioTrack?.id)
    );
    const defaultId = normalizeTrackId(defaultTrack?.audioTrack?.id);
    if (defaultId) {
      const defaultMatches = pool.filter((item) => item.audioTrackId === defaultId);
      if (defaultMatches.length > 0) {
        pool = defaultMatches;
      }
    }
  }

  if (resolvedXtags) {
    const xtagMatches = pool.filter((item) => item.xtags === resolvedXtags);
    if (xtagMatches.length > 0) {
      pool = xtagMatches;
    }
  } else {
    const nonDrc = pool.filter((item) => !item.xtags.includes("drc=1"));
    if (nonDrc.length > 0) {
      pool = nonDrc;
    }
  }

  pool.sort((a, b) => {
    const score = (item: SelectedYoutubeAudioFormat): number => {
      if (item.itag === 140) return 0;
      if (isAacLcMime(item.mimeType) && item.itag !== 139) return 1;
      if (item.itag === 139) return 3;
      return 2;
    };
    const diff = score(a) - score(b);
    if (diff !== 0) return diff;
    return a.bitrate - b.bitrate;
  });

  return pool[0] ?? null;
}

export function sanitizeAudioTrackIdForCacheKey(rawTrackId: unknown): string {
  const text = String(rawTrackId ?? "").trim();
  if (!text) return "";
  return text.replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
}
