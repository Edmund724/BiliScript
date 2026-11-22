import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { streamAudioSegments } from "../../extension/entry/offscreen-asr.js";
import { adtsFromFmp4, parseAudioSpecificConfig } from "../../extension/asr/adts.js";
import { ASR_DOWNLOAD_LIMIT_MESSAGE, MAX_AUDIO_BYTES } from "../../extension/asr/protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = new Uint8Array(
  readFileSync(join(__dirname, "../asr/fixtures", "fmp4-audio-sample.bin"))
);
const asc = parseAudioSpecificConfig(fixture) || {};

function readerFromChunks(chunks: Uint8Array[]) {
  let i = 0;
  return {
    read: async (): Promise<{ done: boolean; value?: Uint8Array }> =>
      i < chunks.length
        ? { done: false, value: chunks[i++] }
        : { done: true, value: undefined },
    cancel: vi.fn(async () => {})
  };
}

function stubFetch({
  headOk = true,
  headThrows = false,
  contentLength = "1000",
  getResponses
}: {
  headOk?: boolean;
  headThrows?: boolean;
  contentLength?: string;
  getResponses?: Array<() => unknown>;
} = {}) {
  const factories = [...getResponses!];
  const fetchMock = vi.fn(async (url, init) => {
    if (init?.method === "HEAD") {
      if (headThrows) {
        throw new TypeError("Failed to fetch");
      }
      return {
        ok: headOk,
        headers: { get: () => contentLength }
      };
    }
    const factory = factories.shift();
    if (!factory) throw new Error("unexpected GET: " + url);
    return factory();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function okStreamResponse(chunks: Uint8Array[]) {
  const reader = readerFromChunks(chunks);
  return { ok: true, body: { getReader: () => reader }, _reader: reader };
}

async function collect(gen: AsyncGenerator<{ segment?: Uint8Array }, void, unknown>) {
  const items: Array<{ segment?: Uint8Array }> = [];
  for await (const item of gen) items.push(item);
  return items;
}

function buildMinimalFmp4() {
  const ftyp = new Uint8Array(32);
  writeU32(ftyp, 0, 32);
  ftyp.set([0x66, 0x74, 0x79, 0x70], 4);
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

function writeU32(arr: Uint8Array, p: number, value: number): void {
  arr[p] = (value >>> 24) & 0xff;
  arr[p + 1] = (value >>> 16) & 0xff;
  arr[p + 2] = (value >>> 8) & 0xff;
  arr[p + 3] = value & 0xff;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamAudioSegments", () => {
  it("fMP4 流：增量喂入产出的段与 adtsFromFmp4 整段输出一致", async () => {
    const cut1 = 31711;
    const cut2 = 70001;
    const chunks = [fixture.subarray(0, cut1), fixture.subarray(cut1, cut2), fixture.subarray(cut2)];
    stubFetch({ getResponses: [() => okStreamResponse(chunks)] });

    const items = await collect(streamAudioSegments(["u1"], () => false));
    expect(items.length).toBeGreaterThan(0);
    const segments = items.map((item) => item.segment);
    expect(segments).toEqual(adtsFromFmp4(fixture, asc));
  });

  it("头部收满 4MB 即判定 fMP4 并喂解析器（不等流结束）", async () => {
    const synth = buildMinimalFmp4();
    const padSize = (1 << 22) - 200;
    const padded = new Uint8Array(padSize + synth.length);
    new DataView(padded.buffer).setUint32(0, padSize);
    padded.set([0x66, 0x72, 0x65, 0x65], 4);
    padded.set(synth, padSize);
    stubFetch({ getResponses: [() => okStreamResponse([padded])] });

    const items = await collect(streamAudioSegments(["u"], () => false));
    expect(items.map((item) => item.segment)).toEqual(adtsFromFmp4(synth, {}));
  });

  it("HEAD 抛网络错误不阻断下载：探大小只是尽力而为，走 GET 兜底", async () => {
    stubFetch({ headThrows: true, getResponses: [() => okStreamResponse([fixture])] });
    const items = await collect(streamAudioSegments(["u"], () => false));
    expect(items.map((item) => item.segment)).toEqual(adtsFromFmp4(fixture, asc));
  });

  it("主 URL GET 非 ok 换备用 URL 成功", async () => {
    stubFetch({
      getResponses: [
        () => ({ ok: false }),
        () => okStreamResponse([fixture])
      ]
    });
    const items = await collect(streamAudioSegments(["bad", "good"], () => false));
    expect(items.map((item) => item.segment)).toEqual(adtsFromFmp4(fixture, asc));
  });

  it("主 URL GET 抛网络错误换备用 URL 成功", async () => {
    stubFetch({
      getResponses: [
        () => {
          throw new TypeError("Failed to fetch");
        },
        () => okStreamResponse([fixture])
      ]
    });
    const items = await collect(streamAudioSegments(["bad", "good"], () => false));
    expect(items.map((item) => item.segment)).toEqual(adtsFromFmp4(fixture, asc));
  });

  it("全部 URL 失败抛「音频下载失败」", async () => {
    stubFetch({
      getResponses: [() => ({ ok: false }), () => ({ ok: true, body: { getReader: () => readerFromChunks([]) } })]
    });
    await expect(collect(streamAudioSegments(["a", "b"], () => false))).rejects.toThrow(
      "音频下载失败"
    );
  });

  it("abort 中途静默退出：不产段且 cancel 连接", async () => {
    let aborted = false;
    const response = okStreamResponse([fixture.subarray(0, 1024), fixture.subarray(1024)]);
    stubFetch({ getResponses: [() => response] });

    const gen = streamAudioSegments(["u"], () => aborted);
    const first = await gen.next();
    expect(first.done).toBe(false);
    aborted = true;
    const rest = await collect(gen);
    expect(rest).toEqual([]);
    expect(response._reader.cancel).toHaveBeenCalled();
  });

  it("非 fMP4 显式报错：仅支持 fMP4 音轨（无全量解码兜底）", async () => {
    const pcm = new Uint8Array(1000).fill(0x55);
    stubFetch({ getResponses: [() => okStreamResponse([pcm.subarray(0, 400), pcm.subarray(400)])] });
    await expect(collect(streamAudioSegments(["u"], () => false))).rejects.toThrow(/fMP4/);
  });
});

describe("累计下载量上限", () => {
  function bigChunks(count: number, size = 1024 * 1024) {
    return Array.from({ length: count }, () => new Uint8Array(size).fill(0x21));
  }

  it("GET 累计字节超上限：中止下载（cancel）、不再产段、抛可读错误", async () => {
    const response = okStreamResponse(bigChunks(4));
    stubFetch({ getResponses: [() => response] });

    await expect(
      collect(streamAudioSegments(["u"], () => false, { downloadCapBytes: 2 * 1024 * 1024 }))
    ).rejects.toThrow(ASR_DOWNLOAD_LIMIT_MESSAGE);
    expect(response._reader.cancel).toHaveBeenCalled();
  });

  it("主 URL 失败换备用后计数继续：备用 URL 超限同样中止", async () => {
    stubFetch({
      getResponses: [
        () => ({ ok: false }),
        () => okStreamResponse(bigChunks(3))
      ]
    });

    await expect(
      collect(streamAudioSegments(["a", "b"], () => false, { downloadCapBytes: 2.5 * 1024 * 1024 }))
    ).rejects.toThrow(ASR_DOWNLOAD_LIMIT_MESSAGE);
  });

  it("上限内的下载不受影响：正常产出段", async () => {
    stubFetch({ getResponses: [() => okStreamResponse([fixture])] });

    const items = await collect(
      streamAudioSegments(["u"], () => false, { downloadCapBytes: MAX_AUDIO_BYTES })
    );
    expect(items.map((item) => item.segment)).toEqual(adtsFromFmp4(fixture, asc));
  });
});
