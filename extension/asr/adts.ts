import { concatByteArrays, concatBytes } from "../shared/bytes.js";

export interface AudioSpecificConfig {
  profile: number;
  freqIdx: number;
  chCfg: number;
}

export interface AdtsExtractorConfig {
  profile?: number;
  freqIdx?: number;
  chCfg?: number;
  moofsPerSegment?: number;
  defaultSampleSize?: number;
}

export interface AdtsExtractor {
  push(bytes: Uint8Array | ArrayBuffer): Uint8Array[];
  flush(): Uint8Array[];
  readonly frameCount: number;
}

export function isFragmentedMp4(bytes: Uint8Array | ArrayBuffer): boolean {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 12) return false;
  let p = 0;
  let hasMoof = false;
  while (p + 8 <= u8.length && p < 1 << 22) {
    const box = readBoxHeader(u8, p, u8.length);
    if (!box) break;
    if (box.type === "moof") hasMoof = true;
    p = box.end;
    if (hasMoof) return true;
  }
  return hasMoof;
}

export function createAdtsExtractor(config: AdtsExtractorConfig = {}): AdtsExtractor {
  const profile = Number(config.profile ?? 1);
  const freqIdx = Number(config.freqIdx ?? 3);
  const chCfg = Number(config.chCfg ?? 2);
  const rawMoofsPerSeg = Number(config.moofsPerSegment);
  const segmentMoofs =
    Number.isFinite(rawMoofsPerSeg) && rawMoofsPerSeg >= 1 ? Math.floor(rawMoofsPerSeg) : 10;

  let moovDefaultSampleSize =
    Number.isFinite(Number(config.defaultSampleSize)) && Number(config.defaultSampleSize) > 0
      ? Math.floor(Number(config.defaultSampleSize))
      : 0;
  let buf: Uint8Array | null = null;
  let pendingSizes: number[] | null = null;
  let lastSeqTyp = "";
  let curParts: Uint8Array[] = [];
  let moofsInSegment = 0;
  let frames = 0;
  let out: Uint8Array[] | null = null;

  const emitMdatFrames = (data: Uint8Array, dataStart: number, dataEnd: number, sizes: number[]): void => {
    let off = dataStart;
    let totalBytes = 0;
    let validCount = 0;
    for (const sampleSize of sizes) {
      if (sampleSize <= 0 || off + sampleSize > dataEnd) break;
      totalBytes += sampleSize + 7;
      off += sampleSize;
      validCount += 1;
    }
    if (validCount > 0) {
      const chunk = new Uint8Array(totalBytes);
      let srcOff = dataStart;
      let dstOff = 0;
      const b2 = ((profile & 3) << 6) | ((freqIdx & 0xf) << 2) | ((chCfg >> 2) & 1);
      const chHigh = (chCfg & 3) << 6;
      for (let i = 0; i < validCount; i += 1) {
        const sampleSize = sizes[i];
        const frameTotal = sampleSize + 7;
        chunk[dstOff] = 0xff;
        chunk[dstOff + 1] = 0xf1;
        chunk[dstOff + 2] = b2;
        chunk[dstOff + 3] = chHigh | ((frameTotal >> 11) & 3);
        chunk[dstOff + 4] = (frameTotal >> 3) & 0xff;
        chunk[dstOff + 5] = ((frameTotal & 7) << 5) | 0x1f;
        chunk[dstOff + 6] = 0xfc;
        chunk.set(data.subarray(srcOff, srcOff + sampleSize), dstOff + 7);
        srcOff += sampleSize;
        dstOff += frameTotal;
        frames += 1;
      }
      curParts.push(chunk);
    }
    moofsInSegment += 1;
    if (moofsInSegment >= segmentMoofs) {
      if (curParts.length > 0) {
        out!.push(curParts.length === 1 ? curParts[0] : concatByteArrays(curParts));
      }
      curParts = [];
      moofsInSegment = 0;
    }
  };

  const parse = (data: Uint8Array): void => {
    let p = 0;
    while (p + 8 <= data.length) {
      const box = readBoxHeader(data, p, data.length);
      if (!box) break;
      if (box.type === "moov") {
        const trexSize = parseTrexDefaultSampleSize(data, box.contentStart, box.end);
        if (trexSize > 0) {
          moovDefaultSampleSize = trexSize;
        }
        lastSeqTyp = "moov";
      } else if (box.type === "moof") {
        pendingSizes = parseTrunSampleSizes(data, box.contentStart, box.end, moovDefaultSampleSize);
        lastSeqTyp = "moof";
      } else if (box.type === "mdat") {
        if (lastSeqTyp === "moof" && pendingSizes && pendingSizes.length > 0) {
          emitMdatFrames(data, box.contentStart, box.end, pendingSizes);
        }
        lastSeqTyp = "mdat";
      }
      p = box.end;
    }
    buf = p < data.length ? data.slice(p) : null;
  };

  return {
    push(bytes: Uint8Array | ArrayBuffer): Uint8Array[] {
      const segments: Uint8Array[] = [];
      out = segments;
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      parse(buf ? concatBytes(buf, u8) : u8);
      out = null;
      return segments;
    },
    flush(): Uint8Array[] {
      const segments: Uint8Array[] = [];
      out = segments;
      if (curParts.length > 0) {
        segments.push(curParts.length === 1 ? curParts[0] : concatByteArrays(curParts));
      }
      curParts = [];
      moofsInSegment = 0;
      buf = null;
      out = null;
      return segments;
    },
    get frameCount(): number {
      return frames;
    }
  };
}

export function adtsFromFmp4(bytes: Uint8Array | ArrayBuffer, config: AdtsExtractorConfig = {}): Uint8Array[] {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const extractor = createAdtsExtractor(config);
  const segments = [...extractor.push(u8), ...extractor.flush()];
  if (extractor.frameCount === 0) return [];
  return segments;
}

export function parseAudioSpecificConfig(bytes: Uint8Array | ArrayBuffer): AudioSpecificConfig | null {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const found = findBoxDeep(u8, 0, u8.length, "esds", 0);
  if (found < 0) return null;
  const box = readBoxHeader(u8, found, u8.length);
  if (!box || box.contentStart + 4 > box.end) return null;
  const parsed = parseEsdsDescriptors(u8, box.contentStart + 4, box.end, 0);
  if (parsed) return parsed;
  for (let i = box.contentStart; i + 7 < box.end; i += 1) {
    if (
      u8[i] === 0x05 &&
      u8[i + 1] === 0x80 &&
      u8[i + 2] === 0x80 &&
      u8[i + 3] === 0x80 &&
      u8[i + 4] >= 0x02
    ) {
      return decodeAudioSpecificConfigBytes(u8[i + 5], u8[i + 6]);
    }
  }
  return null;
}

export function parseTrexDefaultSampleSize(
  u8: Uint8Array,
  start = 0,
  end = u8.length
): number {
  const trex = findBoxDeep(u8, start, end, "trex", 0);
  if (trex < 0) return 0;
  const box = readBoxHeader(u8, trex, end);
  if (!box || box.contentStart + 24 > box.end) return 0;
  return readU32(u8, box.contentStart + 16);
}

function decodeAudioSpecificConfigBytes(b0: number, b1: number): AudioSpecificConfig {
  const objectType = (b0 >> 3) & 0x1f;
  const freqIdx = ((b0 & 7) << 1) | ((b1 >> 7) & 1);
  const chCfg = (b1 >> 3) & 0xf;
  const adtsProfile =
    objectType === 5 || objectType === 29
      ? 1
      : objectType >= 1 && objectType <= 4
        ? objectType - 1
        : 1;
  return {
    profile: adtsProfile,
    freqIdx,
    chCfg
  };
}

function readDescriptorLength(
  u8: Uint8Array,
  pos: number,
  end: number
): { length: number; next: number } | null {
  let length = 0;
  let p = pos;
  for (let i = 0; i < 4; i += 1) {
    if (p >= end) return null;
    const b = u8[p];
    p += 1;
    length = (length << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) {
      return { length, next: p };
    }
  }
  return { length, next: p };
}

function parseEsdsDescriptors(
  u8: Uint8Array,
  start: number,
  end: number,
  depth: number
): AudioSpecificConfig | null {
  if (depth > 6) return null;
  let p = start;
  while (p + 2 <= end) {
    const tag = u8[p];
    const lenInfo = readDescriptorLength(u8, p + 1, end);
    if (!lenInfo) return null;
    const payloadStart = lenInfo.next;
    const payloadEnd = Math.min(end, payloadStart + lenInfo.length);
    if (payloadStart > payloadEnd) return null;

    if (tag === 0x05) {
      if (payloadStart + 2 <= payloadEnd) {
        return decodeAudioSpecificConfigBytes(u8[payloadStart], u8[payloadStart + 1]);
      }
      return null;
    }

    if (tag === 0x03) {
      let childStart = payloadStart + 3;
      if (childStart <= payloadEnd) {
        const flags = u8[payloadStart + 2];
        if (flags & 0x80) childStart += 2;
        if (flags & 0x40 && childStart < payloadEnd) {
          childStart += 1 + u8[childStart];
        }
        if (flags & 0x20) childStart += 2;
        if (childStart < payloadEnd) {
          const found = parseEsdsDescriptors(u8, childStart, payloadEnd, depth + 1);
          if (found) return found;
        }
      }
    } else if (tag === 0x04) {
      const childStart = payloadStart + 13;
      if (childStart < payloadEnd) {
        const found = parseEsdsDescriptors(u8, childStart, payloadEnd, depth + 1);
        if (found) return found;
      }
    }

    if (payloadEnd <= p) break;
    p = payloadEnd;
  }
  return null;
}

interface Mp4BoxHeader {
  type: string;
  contentStart: number;
  end: number;
}

function readBoxHeader(u8: Uint8Array, pos: number, limit: number): Mp4BoxHeader | null {
  if (pos + 8 > limit) return null;
  const rawSize = readU32(u8, pos);
  const type = readAscii(u8, pos + 4, 4);
  if (rawSize === 1) {
    if (pos + 16 > limit) return null;
    const high = readU32(u8, pos + 8);
    const low = readU32(u8, pos + 12);
    const size = high * 0x100000000 + low;
    if (size < 16 || pos + size > limit) return null;
    return { type, contentStart: pos + 16, end: pos + size };
  }
  if (rawSize < 8 || pos + rawSize > limit) return null;
  return { type, contentStart: pos + 8, end: pos + rawSize };
}

function readU32(u8: Uint8Array, p: number): number {
  return ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
}

function readAscii(u8: Uint8Array, p: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i += 1) s += String.fromCharCode(u8[p + i]);
  return s;
}

function parseTfhdDefaultSampleSize(u8: Uint8Array, contentStart: number, boxEnd: number): number {
  if (contentStart + 8 > boxEnd) return 0;
  const flags = (u8[contentStart + 1] << 16) | (u8[contentStart + 2] << 8) | u8[contentStart + 3];
  let pp = contentStart + 8;
  if (flags & 0x000001) pp += 8;
  if (flags & 0x000002) pp += 4;
  if (flags & 0x000008) pp += 4;
  if (flags & 0x000010) {
    if (pp + 4 <= boxEnd) {
      return readU32(u8, pp);
    }
  }
  return 0;
}

function parseTrunSampleSizes(
  u8: Uint8Array,
  moofContentStart: number,
  moofEnd: number,
  moovDefaultSampleSize: number
): number[] {
  const sizes: number[] = [];
  let q = moofContentStart;
  let sawTrun = false;
  while (q + 8 <= moofEnd) {
    const trafBox = readBoxHeader(u8, q, moofEnd);
    if (!trafBox) break;
    if (trafBox.type === "traf") {
      let tfhdDefaultSampleSize = 0;
      let qq = trafBox.contentStart;
      while (qq + 8 <= trafBox.end) {
        const sub = readBoxHeader(u8, qq, trafBox.end);
        if (!sub) break;
        if (sub.type === "tfhd") {
          tfhdDefaultSampleSize = parseTfhdDefaultSampleSize(u8, sub.contentStart, sub.end);
        } else if (sub.type === "trun") {
          sawTrun = true;
          if (sub.contentStart + 8 <= sub.end) {
            const flags =
              (u8[sub.contentStart + 1] << 16) |
              (u8[sub.contentStart + 2] << 8) |
              u8[sub.contentStart + 3];
            const n = readU32(u8, sub.contentStart + 4);
            let pp = sub.contentStart + 8;
            if (flags & 0x000001) pp += 4;
            if (flags & 0x000004) pp += 4;
            const hasDuration = Boolean(flags & 0x000100);
            const hasSize = Boolean(flags & 0x000200);
            const hasFlags = Boolean(flags & 0x000400);
            const hasCto = Boolean(flags & 0x000800);
            const fallbackSize =
              tfhdDefaultSampleSize > 0 ? tfhdDefaultSampleSize : moovDefaultSampleSize;
            for (let i = 0; i < n; i += 1) {
              if (hasDuration) {
                if (pp + 4 > sub.end) break;
                pp += 4;
              }
              if (hasSize) {
                if (pp + 4 > sub.end) break;
                sizes.push(readU32(u8, pp));
                pp += 4;
              } else if (fallbackSize > 0) {
                sizes.push(fallbackSize);
              } else {
                sizes.push(-1);
                break;
              }
              if (hasFlags) {
                if (pp + 4 > sub.end) break;
                pp += 4;
              }
              if (hasCto) {
                if (pp + 4 > sub.end) break;
                pp += 4;
              }
            }
          }
        }
        qq = sub.end;
      }
    }
    q = trafBox.end;
  }
  return sawTrun ? sizes : [];
}

function findBoxDeep(u8: Uint8Array, start: number, end: number, target: string, depth: number): number {
  if (depth > 8) return -1;
  let q = start;
  while (q + 8 <= end) {
    const box = readBoxHeader(u8, q, end);
    if (!box) break;
    if (box.type === target) return q;
    if (
      box.type === "moov" ||
      box.type === "mvex" ||
      box.type === "trak" ||
      box.type === "mdia" ||
      box.type === "minf" ||
      box.type === "stbl" ||
      box.type === "stsd" ||
      box.type === "mp4a" ||
      box.type === "wave"
    ) {
      const childStart =
        box.type === "mp4a"
          ? box.contentStart + 28
          : box.type === "stsd"
            ? box.contentStart + 8
            : box.contentStart;
      if (childStart < box.end) {
        const found = findBoxDeep(u8, childStart, box.end, target, depth + 1);
        if (found >= 0) return found;
      }
    }
    q = box.end;
  }
  return -1;
}
