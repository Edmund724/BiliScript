import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isFragmentedMp4,
  adtsFromFmp4,
  parseAudioSpecificConfig
} from "../../extension/asr/adts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = new Uint8Array(
  readFileSync(join(__dirname, "fixtures", "fmp4-audio-sample.bin"))
);

function buildMinimalFmp4(asc = [0x11, 0x90]) {
  const ftyp = new Uint8Array(32);
  writeU32(ftyp, 0, 32);
  ftyp.set([0x66, 0x74, 0x79, 0x70], 4);
  ftyp.set([0x69, 0x73, 0x6f, 0x35], 8);

  const moofSize = 8 + 16 + (8 + 24 + (8 + 4 + 4 + 4 + 8));
  const moof = new Uint8Array(moofSize);
  writeU32(moof, 0, moofSize);
  moof.set([0x6d, 0x6f, 0x6f, 0x66], 4);
  writeU32(moof, 8, 16);
  moof.set([0x6d, 0x66, 0x68, 0x64], 12);
  moof.set([0, 0, 0, 0], 16);
  writeU32(moof, 20, 1);
  const trafStart = 24;
  writeU32(moof, trafStart, 8 + 24 + (8 + 4 + 4 + 4 + 8));
  moof.set([0x74, 0x72, 0x61, 0x66], trafStart + 4);
  const tfhdStart = trafStart + 8;
  writeU32(moof, tfhdStart, 24);
  moof.set([0x74, 0x66, 0x68, 0x64], tfhdStart + 4);
  moof.set([0, 0, 0, 0], tfhdStart + 8);
  writeU32(moof, tfhdStart + 12, 1);
  writeU32(moof, tfhdStart + 16, 1024);
  writeU32(moof, tfhdStart + 20, 171);
  const trunStart = tfhdStart + 24;
  writeU32(moof, trunStart, 8 + 4 + 4 + 4 + 8);
  moof.set([0x74, 0x72, 0x75, 0x6e], trunStart + 4);
  moof[trunStart + 8] = 0;
  moof[trunStart + 9] = 0x03;
  moof[trunStart + 10] = 0x01;
  writeU32(moof, trunStart + 12, 1);
  writeU32(moof, trunStart + 16, 8);
  writeU32(moof, trunStart + 20, 1024);
  writeU32(moof, trunStart + 24, 171);

  const mdat = new Uint8Array(8 + 171);
  writeU32(mdat, 0, 8 + 171);
  mdat.set([0x6d, 0x64, 0x61, 0x74], 4);
  mdat.fill(0x21, 8);

  const out = new Uint8Array(ftyp.length + moof.length + mdat.length);
  out.set(ftyp, 0);
  out.set(moof, ftyp.length);
  out.set(mdat, ftyp.length + moof.length);
  return out;
}

function writeU32(arr: Uint8Array, p: number, value: number) {
  arr[p] = (value >>> 24) & 0xff;
  arr[p + 1] = (value >>> 16) & 0xff;
  arr[p + 2] = (value >>> 8) & 0xff;
  arr[p + 3] = value & 0xff;
}

describe("isFragmentedMp4", () => {
  it("真实 B 站 fMP4 样本判定为 fragmented", () => {
    expect(isFragmentedMp4(fixture)).toBe(true);
  });

  it("非 fMP4（如 WAV/PCM 或常规 MP4）判定为 false", () => {
    const wav = new Uint8Array(44);
    wav.set([0x52, 0x49, 0x46, 0x46], 0);
    expect(isFragmentedMp4(wav)).toBe(false);
    const mp4 = new Uint8Array(64);
    writeU32(mp4, 0, 32);
    mp4.set([0x66, 0x74, 0x79, 0x70], 4);
    writeU32(mp4, 32, 32);
    mp4.set([0x6d, 0x6f, 0x6f, 0x76], 36);
    expect(isFragmentedMp4(mp4)).toBe(false);
  });
});

describe("parseAudioSpecificConfig", () => {
  it("从真实样本提取 ASC（AAC-LC/48k/双声道）", () => {
    const asc = parseAudioSpecificConfig(fixture);
    expect(asc).toEqual({ profile: 1, freqIdx: 3, chCfg: 2 });
  });

  it("无 esds 时返回 null", () => {
    const bare = new Uint8Array(100);
    expect(parseAudioSpecificConfig(bare)).toBeNull();
  });
});

describe("adtsFromFmp4", () => {
  it("真实样本提取出 ADTS 段数组且首段帧数 > 0", () => {
    const segments = adtsFromFmp4(fixture, { profile: 1, freqIdx: 3, chCfg: 2 });
    expect(Array.isArray(segments)).toBe(true);
    expect(segments.length).toBeGreaterThan(0);
    const first = segments[0];
    expect(first[0]).toBe(0xff);
    expect(first[1] & 0xf0).toBe(0xf0);
  });

  it("ADTS 头字段正确（AAC-LC/48k/立体声/长度）", () => {
    const segments = adtsFromFmp4(fixture, { profile: 1, freqIdx: 3, chCfg: 2 });
    if (!segments || segments.length === 0) throw new Error("adts segments empty");
    const adts = segments[0];
    const b0 = adts[2];
    const profile = (b0 >> 6) & 3;
    const freqIdx = (b0 >> 2) & 0xf;
    expect(profile).toBe(1);
    expect(freqIdx).toBe(3);
    const chMask = (b0 & 1) << 2 | ((adts[3] >> 6) & 3);
    expect(chMask).toBe(2);
    const b1 = adts[3];
    const b2 = adts[4];
    const len = ((b1 & 3) << 11) | (b2 << 3) | ((adts[5] >> 5) & 7);
    expect(len).toBeGreaterThan(100);
  });

  it("非 fMP4 输入返回空数组", () => {
    const wav = new Uint8Array(100);
    expect(adtsFromFmp4(wav)).toEqual([]);
  });
});

describe("真实 1MB 样本（26 对 moof/mdat）", () => {
  const big = new Uint8Array(
    readFileSync(join(__dirname, "fixtures", "fmp4-1mb.bin"))
  );
  it("提取的 ADTS 段总帧数 > 3000 且字节流无断点", () => {
    const asc = parseAudioSpecificConfig(big);
    expect(asc).toEqual({ profile: 1, freqIdx: 3, chCfg: 2 });
    const segments = adtsFromFmp4(big, asc || {});
    expect(segments.length).toBeGreaterThan(0);
    let frames = 0;
    for (const adts of segments) {
      let off = 0;
      while (off + 7 <= adts.length) {
        if (adts[off] !== 0xff || (adts[off + 1] & 0xf0) !== 0xf0) break;
        const len = ((adts[off + 3] & 3) << 11) | (adts[off + 4] << 3) | ((adts[off + 5] >> 5) & 7);
        if (len < 7 || off + len > adts.length) break;
        frames++;
        off += len;
      }
    }
    expect(frames).toBeGreaterThanOrEqual(5800);
    expect(frames).toBeLessThanOrEqual(6110);
  });
});
