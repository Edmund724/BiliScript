import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createAdtsExtractor,
  adtsFromFmp4,
  parseAudioSpecificConfig,
  type AdtsExtractorConfig
} from "../../extension/asr/adts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = new Uint8Array(
  readFileSync(join(__dirname, "fixtures", "fmp4-audio-sample.bin"))
);
const big = new Uint8Array(readFileSync(join(__dirname, "fixtures", "fmp4-1mb.bin")));

function collectViaExtractor(bytes: Uint8Array, config: AdtsExtractorConfig): Uint8Array[] {
  const extractor = createAdtsExtractor(config);
  const segments = [...extractor.push(bytes), ...extractor.flush()];
  if (extractor.frameCount === 0) return [];
  return segments;
}

function collectViaChunkedPush(bytes: Uint8Array, chunkSizes: number[], config: AdtsExtractorConfig): Uint8Array[] {
  const extractor = createAdtsExtractor(config);
  const segments: Uint8Array[] = [];
  let off = 0;
  let i = 0;
  while (off < bytes.length) {
    const len = Math.min(chunkSizes[i % chunkSizes.length], bytes.length - off);
    segments.push(...extractor.push(bytes.subarray(off, off + len)));
    off += len;
    i += 1;
  }
  segments.push(...extractor.flush());
  return segments;
}

function makeBox(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function concatArrays(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}

function sliceInitBoxes(bytes: Uint8Array): Uint8Array {
  let off = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (off + 8 <= bytes.length) {
    const size = view.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    if (size < 8 || off + size > bytes.length) break;
    if (type !== "ftyp" && type !== "moov") break;
    off += size;
  }
  return bytes.subarray(0, off);
}

function makeMoofMdatPair(sampleSizes: number[], withDurationAndOffset: boolean): Uint8Array {
  const flags = withDurationAndOffset ? 0x000301 : 0x000200;
  const entryBytes = withDurationAndOffset ? 8 : 4;
  const trunPayload = new Uint8Array(8 + (withDurationAndOffset ? 4 : 0) + sampleSizes.length * entryBytes);
  const trunView = new DataView(trunPayload.buffer);
  trunView.setUint32(0, flags);
  trunView.setUint32(4, sampleSizes.length);
  let cursor = 8;
  if (withDurationAndOffset) {
    trunView.setUint32(cursor, 0);
    cursor += 4;
  }
  for (const sampleSize of sampleSizes) {
    if (withDurationAndOffset) {
      trunView.setUint32(cursor, 1024);
      cursor += 4;
    }
    trunView.setUint32(cursor, sampleSize);
    cursor += 4;
  }
  const moof = makeBox("moof", makeBox("traf", makeBox("trun", trunPayload)));
  const totalSampleBytes = sampleSizes.reduce((sum, size) => sum + size, 0);
  const payload = new Uint8Array(totalSampleBytes);
  for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31 + 7) & 0xff;
  const mdat = makeBox("mdat", payload);
  return concatArrays([moof, mdat]);
}

function firstDiffOffset(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.byteLength === b.byteLength ? -1 : len;
}

function expectSegmentsEqual(actual: Uint8Array[], expected: Uint8Array[]): void {
  expect(actual.map((seg) => seg.byteLength)).toEqual(expected.map((seg) => seg.byteLength));
  expect(actual.map((seg, i) => firstDiffOffset(seg, expected[i]))).toEqual(expected.map(() => -1));
}

const compactFixture = concatArrays([
  sliceInitBoxes(fixture),
  makeBox("sidx", new Uint8Array(16)),
  makeMoofMdatPair([19, 37, 61], true),
  makeMoofMdatPair([23, 41], false)
]);

const asc = parseAudioSpecificConfig(fixture) || {};

describe("createAdtsExtractor 非 fMP4 输入", () => {
  it("非 fMP4 输入：无段产出且 frameCount 为 0", () => {
    const extractor = createAdtsExtractor(asc);
    expect(extractor.push(new Uint8Array(100))).toEqual([]);
    expect(extractor.flush()).toEqual([]);
    expect(extractor.frameCount).toBe(0);
  });
});

describe("createAdtsExtractor 极端切分（残包边界）", () => {
  it("1 字节/次 push 与整块 push 输出一致（紧凑 fMP4 全量逐字节）", () => {
    const expected = collectViaExtractor(compactFixture, asc);
    expect(expected.length).toBe(1);
    expect(expected[0].byteLength).toBeGreaterThan(0);
    const actual = collectViaChunkedPush(compactFixture, [1], asc);
    expectSegmentsEqual(actual, expected);
  });

  it("混合奇数块长（7/13/1/4096）与整块 push 输出一致（1MB 样本）", () => {
    const expected = adtsFromFmp4(big, asc);
    const actual = collectViaChunkedPush(big, [7, 13, 1, 4096], asc);
    expectSegmentsEqual(actual, expected);
  });
});

describe("createAdtsExtractor flush 收尾", () => {
  it("满 10 moof 的段在 push 中产出，尾部不足 10 moof 由 flush 交出", () => {
    const extractor = createAdtsExtractor(asc);
    const pushed = extractor.push(big);
    const flushed = extractor.flush();
    expect(pushed.length).toBe(2);
    expect(flushed.length).toBe(1);
    expectSegmentsEqual([...pushed, ...flushed], adtsFromFmp4(big, asc));
  });

  it("总数不足 10 moof 时 push 不产段、flush 交出唯一段", () => {
    const extractor = createAdtsExtractor(asc);
    const pushed = extractor.push(fixture);
    expect(pushed).toEqual([]);
    const flushed = extractor.flush();
    expect(flushed.length).toBe(1);
    expectSegmentsEqual(flushed, adtsFromFmp4(fixture, asc));
  });

  it("整流后零音帧：frameCount 为 0、无段产出", () => {
    const bare = new Uint8Array(64);
    new DataView(bare.buffer).setUint32(0, 32);
    bare.set([0x66, 0x74, 0x79, 0x70], 4);
    const extractor = createAdtsExtractor(asc);
    expect([...extractor.push(bare), ...extractor.flush()]).toEqual([]);
    expect(extractor.frameCount).toBe(0);
  });
});
