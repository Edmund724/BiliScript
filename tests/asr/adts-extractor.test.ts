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
  it("1 字节/次 push 与整块 push 输出一致（98KB fixture 全量逐字节）", () => {
    const expected = collectViaExtractor(fixture, asc);
    const actual = collectViaChunkedPush(fixture, [1], asc);
    expect(actual).toEqual(expected);
  });

  it("混合奇数块长（7/13/1/4096）与整块 push 输出一致（1MB 样本）", () => {
    const expected = adtsFromFmp4(big, asc);
    const actual = collectViaChunkedPush(big, [7, 13, 1, 4096], asc);
    expect(actual).toEqual(expected);
  });
});

describe("createAdtsExtractor flush 收尾", () => {
  it("满 10 moof 的段在 push 中产出，尾部不足 10 moof 由 flush 交出", () => {
    const extractor = createAdtsExtractor(asc);
    const pushed = extractor.push(big);
    const flushed = extractor.flush();
    expect(pushed.length).toBe(2);
    expect(flushed.length).toBe(1);
    expect([...pushed, ...flushed]).toEqual(adtsFromFmp4(big, asc));
  });

  it("总数不足 10 moof 时 push 不产段、flush 交出唯一段", () => {
    const extractor = createAdtsExtractor(asc);
    const pushed = extractor.push(fixture);
    expect(pushed).toEqual([]);
    const flushed = extractor.flush();
    expect(flushed.length).toBe(1);
    expect(flushed).toEqual(adtsFromFmp4(fixture, asc));
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
