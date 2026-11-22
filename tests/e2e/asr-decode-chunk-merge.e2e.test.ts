import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { WavChunk } from "../../extension/asr/chunker.js";
import type { AsrChunkRecord, OffscreenChunkHost } from "../../extension/asr/offscreen-bridge.page.js";

const ASR_FIXTURE_DIR = join(process.cwd(), "tests", "asr", "fixtures");
const BILI_FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "bilibili");
const PLATFORM_FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "asr");
const ARTIFACT_DIR = join(process.cwd(), ".scratch", "tickets", "test-suite-trim", "artifacts");

const SMALL_FMP4 = new Uint8Array(readFileSync(join(ASR_FIXTURE_DIR, "fmp4-audio-sample.bin")));
const BIG_FMP4 = new Uint8Array(readFileSync(join(ASR_FIXTURE_DIR, "fmp4-1mb.bin")));

const PLAYURL_DASH = JSON.parse(
  readFileSync(join(BILI_FIXTURE_DIR, "bv1q9he6seyx-playurl-dash-audio.json"), "utf8")
);
const PLAYURL_HTML5 = JSON.parse(
  readFileSync(join(BILI_FIXTURE_DIR, "bv1q9he6seyx-playurl-html5-no-dash.json"), "utf8")
);

const SF_401 = JSON.parse(readFileSync(join(PLATFORM_FIXTURE_DIR, "siliconflow-transcriptions-401.json"), "utf8"));
const SF_404 = JSON.parse(readFileSync(join(PLATFORM_FIXTURE_DIR, "siliconflow-unknown-route-404.json"), "utf8"));

const WALKTHROUGH_CHUNK_SECONDS = 45;

function readU32BE(bytes: Uint8Array, p: number): number {
  return ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
}

function boxType(bytes: Uint8Array, p: number): string {
  return String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
}

function trunSizesOfMoof(bytes: Uint8Array, moofStart: number, moofEnd: number): number[] {
  const sizes: number[] = [];
  let q = moofStart + 8;
  while (q + 8 <= moofEnd) {
    const boxSize = readU32BE(bytes, q);
    if (boxSize < 8 || q + boxSize > moofEnd) break;
    if (boxType(bytes, q) === "traf") {
      const trafEnd = q + boxSize;
      let qq = q + 8;
      while (qq + 8 <= trafEnd) {
        const childSize = readU32BE(bytes, qq);
        if (childSize < 8 || qq + childSize > trafEnd) break;
        if (boxType(bytes, qq) === "trun") {
          const flags = (bytes[qq + 9] << 16) | (bytes[qq + 10] << 8) | bytes[qq + 11];
          const count = readU32BE(bytes, qq + 12);
          let pp = qq + 16 + (flags & 0x1 ? 4 : 0);
          const hasDuration = Boolean(flags & 0x100);
          const hasSize = Boolean(flags & 0x200);
          for (let i = 0; i < count; i += 1) {
            if (hasDuration) pp += 4;
            if (!hasSize) break;
            sizes.push(readU32BE(bytes, pp));
            pp += 4;
          }
        }
        qq += childSize;
      }
    }
    q += boxSize;
  }
  return sizes;
}

interface RealContainerFacts {
  moofCount: number;
  allSizes: number[];
  pairedSizes: number[];
  dropped: Array<{ samples: number; mdatClaimedBytes: number; mdatAvailableBytes: number }>;
}

function realContainerFacts(bytes: Uint8Array): RealContainerFacts {
  const boxes: Array<{ type: string; start: number; size: number; complete: boolean }> = [];
  let p = 0;
  while (p + 8 <= bytes.length) {
    const size = readU32BE(bytes, p);
    const complete = size >= 8 && p + size <= bytes.length;
    boxes.push({ type: boxType(bytes, p), start: p, size, complete });
    if (!complete) break;
    p += size;
  }

  const allSizes: number[] = [];
  const pairedSizes: number[] = [];
  const dropped: RealContainerFacts["dropped"] = [];
  let moofCount = 0;
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i];
    if (box.type !== "moof") continue;
    moofCount += 1;
    const sizes = trunSizesOfMoof(bytes, box.start, box.start + box.size);
    allSizes.push(...sizes);
    const next = boxes[i + 1];
    if (next?.type === "mdat" && next.complete) {
      pairedSizes.push(...sizes);
    } else {
      dropped.push({
        samples: sizes.length,
        mdatClaimedBytes: next?.type === "mdat" ? next.size : 0,
        mdatAvailableBytes: next?.type === "mdat" ? bytes.length - next.start : 0
      });
    }
  }
  return { moofCount, allSizes, pairedSizes, dropped };
}

function parseAdtsStream(adts: Uint8Array): {
  frames: number;
  payloadLengths: number[];
  payloadBytes: number;
  profiles: number[];
  freqIdxs: number[];
  chCfgs: number[];
  trailingBytes: number;
} {
  const payloadLengths: number[] = [];
  const profiles: number[] = [];
  const freqIdxs: number[] = [];
  const chCfgs: number[] = [];
  let off = 0;
  while (off + 7 <= adts.length) {
    if (adts[off] !== 0xff || (adts[off + 1] & 0xf0) !== 0xf0) break;
    const length = ((adts[off + 3] & 3) << 11) | (adts[off + 4] << 3) | ((adts[off + 5] >> 5) & 7);
    if (length < 7 || off + length > adts.length) break;
    payloadLengths.push(length - 7);
    profiles.push((adts[off + 2] >> 6) & 3);
    freqIdxs.push((adts[off + 2] >> 2) & 0xf);
    chCfgs.push(((adts[off + 2] & 1) << 2) | ((adts[off + 3] >> 6) & 3));
    off += length;
  }
  return {
    frames: payloadLengths.length,
    payloadLengths,
    payloadBytes: payloadLengths.reduce((sum, value) => sum + value, 0),
    profiles,
    freqIdxs,
    chCfgs,
    trailingBytes: adts.length - off
  };
}

function parseWavHeader(bytes: Uint8Array): {
  riff: string;
  wave: string;
  fmtTag: string;
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataTag: string;
  dataSize: number;
  totalBytes: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (p: number, len: number) => String.fromCharCode(...bytes.subarray(p, p + len));
  return {
    riff: ascii(0, 4),
    wave: ascii(8, 4),
    fmtTag: ascii(12, 4),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    dataTag: ascii(36, 4),
    dataSize: view.getUint32(40, true),
    totalBytes: bytes.length
  };
}

function firstByteDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return -1;
}

let adts: typeof import("../../extension/asr/adts.js");
let chunker: typeof import("../../extension/asr/chunker.js");
let streamChunker: typeof import("../../extension/asr/stream-chunker.js");
let pipeline: typeof import("../../extension/asr/pipeline.js");
let contentTransport: typeof import("../../extension/bilibili/content-transport.js");

vi.mock("../../extension/bilibili/content-transport.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, contentFetchJson: vi.fn() };
});

beforeEach(async () => {
  resetModuleState();
  adts = await import("../../extension/asr/adts.js");
  chunker = await import("../../extension/asr/chunker.js");
  streamChunker = await import("../../extension/asr/stream-chunker.js");
  pipeline = await import("../../extension/asr/pipeline.js");
  contentTransport = await import("../../extension/bilibili/content-transport.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("① 真 fMP4 → 真 ADTS 提取（真实容器字节 vs 真实提取器，双向对账）", () => {
  it("1MB 片段：帧数 / 每帧负载长度 / 字节总量与容器 trun 逐项一致", () => {
    expect(adts.isFragmentedMp4(BIG_FMP4)).toBe(true);
    const asc = adts.parseAudioSpecificConfig(BIG_FMP4);
    expect(asc).toEqual({ profile: 1, freqIdx: 3, chCfg: 2 });

    const extractor = adts.createAdtsExtractor(asc ?? {});
    const streamed: Uint8Array[] = [];
    for (let off = 0; off < BIG_FMP4.length; off += 64 * 1024) {
      streamed.push(...extractor.push(BIG_FMP4.subarray(off, off + 64 * 1024)));
    }
    streamed.push(...extractor.flush());
    const whole = adts.adtsFromFmp4(BIG_FMP4, asc ?? {});
    expect(streamed.map((segment) => segment.length)).toEqual(whole.map((segment) => segment.length));
    for (let i = 0; i < whole.length; i += 1) {
      expect(firstByteDifference(streamed[i], whole[i])).toBe(-1);
    }

    const container = realContainerFacts(BIG_FMP4);
    const parsedSegments = whole.map((segment) => parseAdtsStream(segment));
    expect(parsedSegments.every((parsed) => parsed.trailingBytes === 0)).toBe(true);
    const frames = parsedSegments.reduce((sum, parsed) => sum + parsed.frames, 0);

    expect(extractor.frameCount).toBe(frames);
    expect(frames).toBe(container.pairedSizes.length);
    expect(parsedSegments.flatMap((parsed) => parsed.payloadLengths)).toEqual(container.pairedSizes);
    expect(parsedSegments.every((parsed) => parsed.profiles.every((value) => value === 1))).toBe(true);
    expect(parsedSegments.every((parsed) => parsed.freqIdxs.every((value) => value === 3))).toBe(true);
    expect(parsedSegments.every((parsed) => parsed.chCfgs.every((value) => value === 2))).toBe(true);

    expect(container.dropped).toHaveLength(1);
    expect(container.pairedSizes.length).toBeLessThan(container.allSizes.length);
    expect(container.allSizes.length - container.pairedSizes.length).toBe(container.dropped[0].samples);
    expect(container.dropped[0].samples).toBeGreaterThan(0);
    expect(container.dropped[0].mdatClaimedBytes).toBeGreaterThan(container.dropped[0].mdatAvailableBytes);
  });

  it("98KB 片段：单段 flush 收尾，同样与容器逐项一致", () => {
    const asc = adts.parseAudioSpecificConfig(SMALL_FMP4);
    const segments = adts.adtsFromFmp4(SMALL_FMP4, asc ?? {});
    const container = realContainerFacts(SMALL_FMP4);

    expect(segments).toHaveLength(1);
    const parsed = parseAdtsStream(segments[0]);
    expect(parsed.trailingBytes).toBe(0);
    expect(container.dropped).toHaveLength(0);
    expect(parsed.frames).toBe(container.pairedSizes.length);
    expect(parsed.payloadLengths).toEqual(container.pairedSizes);
  });
});

interface ChainLayout {
  asc: { profile: number; freqIdx: number; chCfg: number };
  segments: Uint8Array[];
  framesPerSegment: number[];
  frames: number;
  audioDurationSec: number;
  sampleCounts: number[];
  decodedSamples: number;
  decodedDurationSec: number;
  sampleRate: number;
  chunks: Array<{
    index: number;
    startSec: number;
    durationSec: number;
    overlapLeadSec: number;
    wavBytes: Uint8Array;
    samples: number;
  }>;
  wholeChunks: WavChunk[];
  pcm: Float32Array;
}

async function buildChainLayout(chunkSeconds = WALKTHROUGH_CHUNK_SECONDS): Promise<ChainLayout> {
  const asc = adts.parseAudioSpecificConfig(BIG_FMP4);
  if (!asc) throw new Error("真 fixture 里应当能解析出 AudioSpecificConfig");
  const segments = adts.adtsFromFmp4(BIG_FMP4, asc);
  const framesPerSegment = segments.map((segment) => parseAdtsStream(segment).frames);
  const frames = framesPerSegment.reduce((sum, value) => sum + value, 0);
  const audioDurationSec = (frames * 1024) / 48000;

  const sampleRate = 16000;
  const sampleCounts = framesPerSegment.map((value) => Math.round((value * 1024 * sampleRate) / 48000));
  const decodedSamples = sampleCounts.reduce((sum, value) => sum + value, 0);

  const pcm = new Float32Array(decodedSamples);
  for (let i = 0; i < pcm.length; i += 1) {
    pcm[i] = (i % 200) / 100 - 1;
  }
  let segmentIndex = 0;
  const segmentViews = sampleCounts.map((count, i) => {
    const start = sampleCounts.slice(0, i).reduce((sum, value) => sum + value, 0);
    return pcm.subarray(start, start + count);
  });

  const chunks: ChainLayout["chunks"] = [];
  await streamChunker.streamWavChunks(segments, {
    chunkSeconds,
    sampleRate,
    decodeSegment: async () => {
      const view = segmentViews[segmentIndex];
      segmentIndex += 1;
      if (!view) throw new Error("decodeSegment 收到超出段数的调用");
      return view;
    },
    onChunk: async (chunk: WavChunk) => {
      const wavBytes = new Uint8Array(await chunk.wavBlob.arrayBuffer());
      chunks.push({
        index: chunk.index,
        startSec: chunk.startSec,
        durationSec: chunk.durationSec,
        overlapLeadSec: chunk.overlapLeadSec,
        wavBytes,
        samples: parseWavHeader(wavBytes).dataSize / 2
      });
    }
  });

  return {
    asc,
    segments,
    framesPerSegment,
    frames,
    audioDurationSec,
    sampleCounts,
    decodedSamples,
    decodedDurationSec: decodedSamples / sampleRate,
    sampleRate,
    chunks,
    wholeChunks: chunker.buildWavChunks(chunker.makeDecodedBuffer(pcm, { sampleRate }), { chunkSeconds }),
    pcm
  };
}

describe("② 真音频时长 → 真切片计划 / 真 WAV 编码（流式切片与全量切片对账）", () => {
  it("生产片长下 60s 分片多片；自选 45s 片长下多片边界连续且重叠区间严丝合缝", async () => {
    const layout = await buildChainLayout();
    const productionPlan = chunker.buildChunkPlan("openai-transcriptions");
    expect(productionPlan).toEqual({ chunkSeconds: 60 });
    expect(layout.decodedDurationSec).toBeGreaterThan(productionPlan.chunkSeconds);
    expect(chunker.decideChunks(layout.decodedDurationSec, productionPlan)).toHaveLength(3);

    expect(layout.chunks.length).toBe(layout.wholeChunks.length);
    expect(layout.chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < layout.wholeChunks.length; i += 1) {
      expect(layout.chunks[i].index).toBe(layout.wholeChunks[i].index);
      expect(layout.chunks[i].startSec).toBeCloseTo(layout.wholeChunks[i].startSec, 9);
      expect(layout.chunks[i].durationSec).toBeCloseTo(layout.wholeChunks[i].durationSec, 9);
      expect(layout.chunks[i].overlapLeadSec).toBeCloseTo(layout.wholeChunks[i].overlapLeadSec, 9);
    }
    const coveredDuration = layout.chunks.reduce(
      (sum, chunk) => sum + chunk.durationSec - chunk.overlapLeadSec,
      0
    );
    expect(coveredDuration).toBeCloseTo(layout.decodedDurationSec, 9);
    for (let i = 1; i < layout.chunks.length; i += 1) {
      expect(layout.chunks[i].startSec).toBeCloseTo(
        layout.chunks[i - 1].startSec + layout.chunks[i - 1].durationSec - layout.chunks[i].overlapLeadSec,
        9
      );
    }
  });

  it("每片 WAV：真编码头字段正确，与全量切片逐字节一致，去重片内采样数之和等于真解码采样数", async () => {
    const layout = await buildChainLayout();
    const { wholeChunks } = layout;
    expect(wholeChunks.length).toBe(layout.chunks.length);

    for (let i = 0; i < wholeChunks.length; i += 1) {
      const wholeBytes = new Uint8Array(await wholeChunks[i].wavBlob.arrayBuffer());
      const header = parseWavHeader(layout.chunks[i].wavBytes);
      expect(header).toMatchObject({
        riff: "RIFF",
        wave: "WAVE",
        fmtTag: "fmt ",
        audioFormat: 1,
        channels: 1,
        sampleRate: 16000,
        bitsPerSample: 16,
        dataTag: "data"
      });
      expect(header.totalBytes).toBe(44 + header.dataSize);
      expect(firstByteDifference(layout.chunks[i].wavBytes, wholeBytes)).toBe(-1);
    }

    expect(layout.chunks.every((chunk) => Number.isInteger(chunk.samples))).toBe(true);
    const uniqueSamples = layout.chunks.reduce(
      (sum, chunk) => sum + chunk.samples - Math.round(chunk.overlapLeadSec * layout.sampleRate),
      0
    );
    expect(uniqueSamples).toBe(layout.decodedSamples);
    expect(wholeChunks.map((chunk) => chunk.startSec)).toEqual(layout.chunks.map((chunk) => chunk.startSec));
    expect(wholeChunks.map((chunk) => chunk.index)).toEqual(layout.chunks.map((chunk) => chunk.index));
  });
});

describe("③ 真 pipeline 合并：全局偏移 / 整片降级 / 越界截断（片边界来自真音频）", () => {
  it("真 playurl 音轨选出最小带宽轨并交给任务宿主；乱序片结果按全局偏移归并", async () => {
    const layout = await buildChainLayout();
    const tracks = PLAYURL_DASH.data.dash.audio as Array<{
      baseUrl: string;
      backupUrl: string[];
      bandwidth: number;
    }>;
    const selected = tracks.reduce((min, track) => (track.bandwidth < min.bandwidth ? track : min), tracks[0]);

    vi.mocked(contentTransport.contentFetchJson).mockImplementation(async (url: string) => {
      if (url.includes("/x/player/playurl")) return PLAYURL_DASH;
      throw new Error(`unexpected url: ${url}`);
    });

    const [first, second, third] = layout.chunks;
    const records: AsrChunkRecord[] = [
      {
        index: third.index,
        startSec: third.startSec,
        durationSec: third.durationSec,
        overlapLeadSec: third.overlapLeadSec,
        result: { text: "片三", segments: [{ start: 1, end: 3, text: "片三句。" }] }
      },
      {
        index: first.index,
        startSec: first.startSec,
        durationSec: first.durationSec,
        overlapLeadSec: first.overlapLeadSec,
        result: {
          text: "片一",
          segments: [
            { start: 0.5, end: 2, text: "片一句甲。" },
            { start: first.durationSec - 1, end: 9999, text: "片一句乙。" }
          ]
        }
      },
      {
        index: second.index,
        startSec: second.startSec,
        durationSec: second.durationSec,
        overlapLeadSec: second.overlapLeadSec,
        result: { text: "片二整段。" }
      }
    ];

    const hostCalls: Array<{ audioUrl: string; backupUrls: string[] }> = [];
    const chunkHost: OffscreenChunkHost = async ({ audioUrl, backupUrls }) => {
      hostCalls.push({ audioUrl: String(audioUrl), backupUrls: backupUrls ?? [] });
      return { results: records, totalChunks: records.length, skippedSegments: 0, failedChunks: 0 };
    };

    const outcomes: Array<Record<string, unknown>> = [];
    const body = await pipeline.runAsrPipeline({
      bvid: "BV1q9He6SEyX",
      cid: "42428139464",
      onProgress: vi.fn(),
      chunkHost,
      onAttemptOutcome: (outcome) => outcomes.push(outcome as unknown as Record<string, unknown>)
    });

    expect(hostCalls).toHaveLength(1);
    expect(hostCalls[0].audioUrl).toBe(selected.baseUrl);
    expect(hostCalls[0].backupUrls).toEqual(selected.backupUrl);

    const seam01 = (first.startSec + first.durationSec - 1 + first.startSec + first.durationSec) / 2;
    const seam12 = (third.startSec + 1 + second.startSec + second.durationSec) / 2;
    expect(body).toEqual([
      { from: first.startSec + 0.5, to: first.startSec + 2, content: "片一句甲。" },
      { from: first.startSec + first.durationSec - 1, to: seam01, content: "片一句乙。" },
      { from: seam01, to: seam12, content: "片二整段。" },
      { from: seam12, to: third.startSec + 3, content: "片三句。" }
    ]);
    for (let i = 1; i < body.length; i += 1) {
      expect(body[i].from).toBeGreaterThanOrEqual(body[i - 1].to);
    }
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ totalChunks: 3, failedChunks: 0 });
    expect("failedKind" in outcomes[0]).toBe(false);
  });

  it("转写失败片不参与合并，空结果诊断带真片数与失败计数", async () => {
    const layout = await buildChainLayout();
    vi.mocked(contentTransport.contentFetchJson).mockImplementation(async () => PLAYURL_DASH);
    const [first, second, third] = layout.chunks;

    const diagnostics: string[] = [];
    const body = await pipeline.runAsrPipeline({
      bvid: "BV1q9He6SEyX",
      cid: "42428139464",
      chunkHost: async () => ({
        results: [
          { index: first.index, startSec: first.startSec, durationSec: first.durationSec, result: { text: "" } },
          { index: second.index, startSec: second.startSec, durationSec: second.durationSec, result: null },
          { index: third.index, startSec: third.startSec, durationSec: third.durationSec, result: { text: "   " } }
        ],
        totalChunks: 3,
        skippedSegments: 2,
        failedChunks: 1
      }),
      onEmptyDiagnostic: (text) => diagnostics.push(text)
    });

    expect(body).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("分片 3 片");
    expect(diagnostics[0]).toContain("各片文本长度[0,0,3]");
    expect(diagnostics[0]).toContain("1 片转写失败");
    expect(diagnostics[0]).toContain("2 段解码失败已跳过");
  });

  it("生产 playurl URL（platform=html5）无 dash 音轨：管线在取音轨处停下并报可读原因", async () => {
    vi.mocked(contentTransport.contentFetchJson).mockImplementation(async (url: string) => {
      expect(url).toContain("platform=html5");
      return PLAYURL_HTML5;
    });
    const chunkHost = vi.fn();

    await expect(
      pipeline.runAsrPipeline({ bvid: "BV1q9He6SEyX", cid: "42428139464", chunkHost })
    ).rejects.toThrow("该视频没有可用音轨，无法语音识别");
    expect(chunkHost).not.toHaveBeenCalled();
  });
});

describe("④ 适配器边界（真平台失败报文回放）", () => {
  async function realProvider() {
    const presets = await import("../../extension/core/presets.js");
    const normalize = await import("../../extension/asr/asr-provider-normalize.js");
    const preset = presets.ASR_PROVIDER_PRESETS.find((item) => item.id === "siliconflow-sensevoice");
    if (!preset) throw new Error("生产预设 siliconflow-sensevoice 不存在");
    const provider = normalize.normalizeAsrProvider({ ...preset, presetId: preset.id, enabled: true });
    if (!provider) throw new Error("生产预设归一失败");
    return { ...provider, apiKey: "sk-biliscript-e2e-invalid-key", language: "auto" };
  }

  function stubPlatformResponse(fixture: { status: number; body: string }) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: false, status: fixture.status, text: async () => fixture.body };
      })
    );
    return calls;
  }

  it("真 401（扁平 code/message/data，非 OpenAI 嵌套形状）→ asr-auth，且不降级重传", async () => {
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    const provider = await realProvider();
    const calls = stubPlatformResponse(SF_401);

    let caught: (Error & { status?: number; kind?: string; detail?: string }) | null = null;
    try {
      await adapter.transcribe({
        wavBlob: new Blob([new Uint8Array(64)], { type: "audio/wav" }),
        startSec: 0,
        durationSec: 45,
        provider
      });
    } catch (error) {
      caught = error as Error & { status?: number; kind?: string; detail?: string };
    }

    expect(caught).not.toBeNull();
    expect(caught?.status).toBe(401);
    expect(caught?.kind).toBe("asr-auth");
    expect(caught?.detail).toBe(SF_401.body.slice(0, 200));
    expect(caught?.message).toBe(`HTTP 401: ${SF_401.body}`);
    expect(JSON.parse(SF_401.body)).toEqual({ code: 30014, data: null, message: "Token is invalid." });
    expect(calls).toHaveLength(1);

    expect(calls[0].url).toBe("https://api.siliconflow.cn/v1/audio/transcriptions");
    const form = calls[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe(provider.model);
    expect(form.get("model")).toBe("XingChenAGI/XingChenASR-V3.2");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("language")).toBeNull();
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-biliscript-e2e-invalid-key"
    );
  });

  it("真 404（纯文本 Not Found，非 JSON）→ no-asr-config，detail 为报文原文", async () => {
    const adapter = await import("../../extension/asr/adapters/openai-transcriptions.js");
    const provider = await realProvider();
    const calls = stubPlatformResponse(SF_404);
    expect(() => JSON.parse(SF_404.body)).toThrow();

    let caught: (Error & { status?: number; kind?: string; detail?: string }) | null = null;
    try {
      await adapter.transcribe({
        wavBlob: new Blob([new Uint8Array(8)]),
        startSec: 0,
        durationSec: 45,
        provider
      });
    } catch (error) {
      caught = error as Error & { status?: number; kind?: string; detail?: string };
    }

    expect(caught).toMatchObject({ status: 404, kind: "no-asr-config", detail: "Not Found" });
    expect(caught?.message).toBe("HTTP 404: Not Found");
    expect(calls).toHaveLength(1);
  });
});

describe("⑤ 走查工件（重跑逐字节一致，末尾与真实产物对账）", () => {
  it("写出 01-asr-chain-walkthrough.md 并与链上真事实对账", async () => {
    const layout = await buildChainLayout();
    const container = realContainerFacts(BIG_FMP4);
    const parsedSegments = layout.segments.map((segment) => parseAdtsStream(segment));
    const wholeBytesByChunk = await Promise.all(
      layout.wholeChunks.map(async (chunk) => new Uint8Array(await chunk.wavBlob.arrayBuffer()))
    );

    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const artifactPath = join(ARTIFACT_DIR, "01-asr-chain-walkthrough.md");
    writeFileSync(
      artifactPath,
      [
        "# ASR 解码→切片→合并走查工件（由 tests/e2e/asr-decode-chunk-merge.e2e.test.ts 生成）",
        "",
        "## ① 真 fMP4 → 真 ADTS（tests/asr/fixtures/fmp4-1mb.bin，1,048,576 字节）",
        `- 容器：顶层 moof ${container.moofCount} 个，trun 逐 sample size ${container.allSizes.length} 条`,
        `- 提取器 frameCount：${layout.frames}；段数：${layout.segments.length}；每段帧数：${layout.framesPerSegment.join(" / ")}`,
        `- 每段负载字节：${parsedSegments.map((parsed) => parsed.payloadBytes).join(" / ")}`,
        `- 逐帧负载长度与容器 trun size 序列逐项相等：${JSON.stringify(
          parsedSegments.flatMap((parsed) => parsed.payloadLengths)
        ) === JSON.stringify(container.pairedSizes)}`,
        `- 尾部截断：${container.dropped.length} 对 moof/mdat 不可提取（${container.dropped
          .map((item) => `${item.samples} sample，mdat 声称 ${item.mdatClaimedBytes} 字节 / 实际剩 ${item.mdatAvailableBytes} 字节`)
          .join("；")}）`,
        `- ADTS 头参数：profile=${layout.asc.profile} freqIdx=${layout.asc.freqIdx} chCfg=${layout.asc.chCfg}（真 esds ASC）`,
        "",
        "## ② 真时长 → 切片（AAC-LC 1024 采样/帧 @48kHz → 16kHz 单声道）",
        `- 真音频时长：${layout.audioDurationSec.toFixed(6)}s（${layout.frames} 帧 × 1024 采样 ÷ 48000）`,
        `- 生产片长：${chunker.buildChunkPlan("openai-transcriptions").chunkSeconds}s → ${
          chunker.decideChunks(layout.decodedDurationSec, chunker.buildChunkPlan("openai-transcriptions")).length
        } 片`,
        `- 走查自选片长：${WALKTHROUGH_CHUNK_SECONDS}s`,
        `- 解码采样数（由真帧数推出）：${layout.decodedSamples}（${layout.sampleCounts.join(" + ")}）`,
        `- 解码时长：${layout.decodedDurationSec.toFixed(6)}s`,
        "",
        "| 片 | index | startSec | durationSec | overlapLeadSec | 片内采样 | WAV 字节 | 与全量切片逐字节一致 |",
        "|---|---|---|---|---|---|---|---|",
        ...layout.chunks.map(
          (chunk, i) =>
            `| ${i} | ${chunk.index} | ${chunk.startSec} | ${chunk.durationSec} | ${chunk.overlapLeadSec} | ${chunk.samples} | ${
              chunk.wavBytes.length
            } | ${firstByteDifference(chunk.wavBytes, wholeBytesByChunk[i]) === -1 ? "是" : "否"} |`
        ),
        "",
        "## ③ 真 pipeline 合并（片边界同上；片内文本是替身，见测试文件头 ②）",
        "| from | to | content |",
        "|---|---|---|",
        `| ${layout.chunks[0].startSec + 0.5} | ${layout.chunks[0].startSec + 2} | 片一句甲。 |`,
        `| ${layout.chunks[0].startSec + layout.chunks[0].durationSec - 1} | ${
          (layout.chunks[0].startSec + layout.chunks[0].durationSec - 1 + layout.chunks[0].startSec + layout.chunks[0].durationSec) / 2
        } | 片一句乙（片内越界 → 按片长截断并取重叠中点衔接） |`,
        `| ${
          (layout.chunks[0].startSec + layout.chunks[0].durationSec - 1 + layout.chunks[0].startSec + layout.chunks[0].durationSec) / 2
        } | ${
          (layout.chunks[2].startSec + 1 + layout.chunks[1].startSec + layout.chunks[1].durationSec) / 2
        } | 片二整段（无 segments → 整片降级） |`,
        `| ${
          (layout.chunks[2].startSec + 1 + layout.chunks[1].startSec + layout.chunks[1].durationSec) / 2
        } | ${layout.chunks[2].startSec + 3} | 片三句。 |`,
        "",
        "## ④ 适配器边界（真线上失败报文，tests/fixtures/asr/）",
        `- siliconflow-transcriptions-401.json：HTTP ${SF_401.status} / ${SF_401.contentType} / ${SF_401.byteLength} 字节 → kind=asr-auth（不发第二次 POST）`,
        `- siliconflow-unknown-route-404.json：HTTP ${SF_404.status} / ${SF_404.contentType} / ${SF_404.byteLength} 字节（纯文本）→ kind=no-asr-config`,
        "- 成功响应（verbose_json segments / 仅 text 的 json 降级）在本仓库无任何真实报文，走查不伪造",
        "",
        "## ⑤ 停点（不是近似，是明确的边界）",
        "- AAC 解码：Node/jsdom 无 AudioContext、依赖里无解码器 → decodeSegment 采样值合成（采样个数由真帧数推出）",
        "- 转写成功响应：无真实报文 → 片内文本为替身；真平台失败报文已在上节回放",
        "",
        "## ⑥ 结论",
        `- 真容器 → 真 ADTS：${layout.frames} 帧、逐帧负载长度与 trun 完全一致、零残字节（尾部截断的 1 对 moof/mdat 整对丢弃）`,
        `- 真帧数 → 真时长 ${layout.audioDurationSec.toFixed(6)}s → 片边界 ${layout.chunks
          .map((chunk) => `${chunk.startSec}~${(chunk.startSec + chunk.durationSec).toFixed(6)}`)
          .join("、")}`,
        "- 流式切片与全量切片每片 WAV 逐字节一致；片内采样数之和等于真解码采样数",
        ""
      ].join("\n")
    );

    const artifact = readFileSync(artifactPath, "utf8");
    expect(artifact).toContain(`容器：顶层 moof ${container.moofCount} 个`);
    expect(artifact).toContain(`提取器 frameCount：${layout.frames}`);
    expect(artifact).toContain(`真音频时长：${layout.audioDurationSec.toFixed(6)}s`);
    expect(artifact).toContain(`- 解码采样数（由真帧数推出）：${layout.decodedSamples}`);
    expect(artifact).toContain(
      `| 0 | 0 | 0 | ${layout.chunks[0].durationSec} | ${layout.chunks[0].overlapLeadSec} | ${layout.chunks[0].samples} | ${layout.chunks[0].wavBytes.length} | 是 |`
    );
  });
});
