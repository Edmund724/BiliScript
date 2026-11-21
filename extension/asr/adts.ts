import { concatBytes } from "../shared/bytes.js";

export interface AudioSpecificConfig {
  profile: number;
  freqIdx: number;
  chCfg: number;
}

export interface AdtsExtractorConfig {
  profile?: number;
  freqIdx?: number;
  chCfg?: number;
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
    const sz = readU32(u8, p);
    if (sz < 8 || p + sz > u8.length) break;
    const typ = readAscii(u8, p + 4, 4);
    if (typ === "moof") hasMoof = true;
    if (typ === "moov" || typ === "sidx") p += sz;
    else p += sz;
    if (hasMoof) return true;
  }
  return hasMoof;
}

export function createAdtsExtractor(config: AdtsExtractorConfig = {}): AdtsExtractor {
  const profile = Number(config.profile ?? 1);
  const freqIdx = Number(config.freqIdx ?? 3);
  const chCfg = Number(config.chCfg ?? 2);

  const SEGMENT_MOOFS = 10;

  let buf: Uint8Array | null = null;
  let pendingSizes: number[] | null = null;
  let lastSeqTyp = "";
  let cur: number[] = [];
  let moofsInSegment = 0;
  let frames = 0;
  let out: Uint8Array[] | null = null;

  const emitMdatFrames = (data: Uint8Array, dataStart: number, dataEnd: number, sizes: number[]): void => {
    let off = dataStart;
    for (const sampleSize of sizes) {
      if (off + sampleSize > dataEnd) break;
      const frameTotal = sampleSize + 7;
      cur.push(
        0xff,
        0xf1,
        ((profile & 3) << 6) | ((freqIdx & 0xf) << 2) | ((chCfg >> 2) & 1),
        ((chCfg & 3) << 6) | ((frameTotal >> 11) & 3),
        (frameTotal >> 3) & 0xff,
        ((frameTotal & 7) << 5) | 0x1f,
        0xfc
      );
      for (let k = 0; k < sampleSize; k += 1) cur.push(data[off + k]);
      off += sampleSize;
      frames += 1;
    }
    moofsInSegment += 1;
    if (moofsInSegment >= SEGMENT_MOOFS) {
      out!.push(new Uint8Array(cur));
      cur = [];
      moofsInSegment = 0;
    }
  };

  const parse = (data: Uint8Array): void => {
    let p = 0;
    while (p + 8 <= data.length) {
      const sz = readU32(data, p);
      if (sz < 8 || p + sz > data.length) break;
      const typ = readAscii(data, p + 4, 4);
      if (typ === "moof") {
        pendingSizes = parseTrunSampleSizes(data, p, sz);
        lastSeqTyp = "moof";
      } else if (typ === "mdat") {
        if (lastSeqTyp === "moof" && pendingSizes && pendingSizes.length > 0) {
          emitMdatFrames(data, p + 8, p + sz, pendingSizes);
        }
        lastSeqTyp = "mdat";
      }
      p += sz;
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
      if (cur.length > 0) segments.push(new Uint8Array(cur));
      cur = [];
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
  const boxEnd = found + readU32(u8, found);
  for (let i = found + 8; i + 7 < boxEnd; i += 1) {
    if (
      u8[i] === 0x05 &&
      u8[i + 1] === 0x80 &&
      u8[i + 2] === 0x80 &&
      u8[i + 3] === 0x80 &&
      u8[i + 4] === 0x02
    ) {
      const b0 = u8[i + 5];
      const b1 = u8[i + 6];
      return {
        profile: ((b0 >> 3) & 0x1f) - 1,
        freqIdx: ((b0 & 7) << 1) | ((b1 >> 7) & 1),
        chCfg: (b1 >> 3) & 0xf
      };
    }
  }
  return null;
}

function readU32(u8: Uint8Array, p: number): number {
  return (u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3];
}

function readAscii(u8: Uint8Array, p: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i += 1) s += String.fromCharCode(u8[p + i]);
  return s;
}

function parseTrunSampleSizes(u8: Uint8Array, moofStart: number, moofSize: number): number[] {
  const sizes: number[] = [];
  const moofEnd = moofStart + moofSize;
  let q = moofStart + 8;
  let sawTrun = false;
  while (q + 8 <= moofEnd) {
    const bsz = readU32(u8, q);
    if (bsz < 8 || q + bsz > moofEnd) break;
    const btyp = readAscii(u8, q + 4, 4);
    if (btyp === "traf") {
      const trafEnd = q + bsz;
      let qq = q + 8;
      while (qq + 8 <= trafEnd) {
        const s2 = readU32(u8, qq);
        if (s2 < 8 || qq + s2 > trafEnd) break;
        const t2 = readAscii(u8, qq + 4, 4);
        if (t2 === "trun") {
          sawTrun = true;
          const flags = (u8[qq + 9] << 16) | (u8[qq + 10] << 8) | u8[qq + 11];
          const n = readU32(u8, qq + 12);
          let pp = qq + 16;
          if (flags & 0x1) pp += 4;
          const hasDuration = Boolean(flags & 0x100);
          const hasSize = Boolean(flags & 0x200);
          for (let i = 0; i < n; i += 1) {
            if (hasDuration) pp += 4;
            if (hasSize) {
              if (pp + 4 > qq + s2) break;
              sizes.push(readU32(u8, pp));
              pp += 4;
            } else {
              sizes.push(-1);
              break;
            }
          }
        }
        qq += s2;
      }
    }
    q += bsz;
  }
  return sawTrun ? sizes : [];
}

function findBoxDeep(u8: Uint8Array, start: number, end: number, target: string, depth: number): number {
  if (depth > 8) return -1;
  let q = start;
  while (q + 8 <= end) {
    const sz = readU32(u8, q);
    if (sz < 8 || q + sz > end) break;
    const typ = readAscii(u8, q + 4, 4);
    if (typ === target) return q;
    if (
      typ === "moov" ||
      typ === "trak" ||
      typ === "mdia" ||
      typ === "minf" ||
      typ === "stbl" ||
      typ === "stsd" ||
      typ === "mp4a" ||
      typ === "wave"
    ) {
      const childStart = typ === "mp4a" ? q + 36 : typ === "stsd" ? q + 16 : q + 8;
      const found = findBoxDeep(u8, childStart, q + sz, target, depth + 1);
      if (found >= 0) return found;
    }
    q += sz;
  }
  return -1;
}
