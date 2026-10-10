// 端到端走查：ASR 解码→切片→合并全链（无字幕视频的语音转写链路）。
//
// 本文件跑全链真实模块，只假「平台能力」两头，并把假的位置与理由写在下面：
//
//   tests/asr/fixtures/fmp4-*.bin（真实 B 站 DASH 音轨 m4s 片段：ftyp/moov/sidx +
//   moof/mdat）
//     → extension/asr/adts        （真：fMP4 判定 / esds ASC / trun sample sizes /
//                                  ADTS 头组装 / 流式分段）
//     → [AAC 解码：平台能力，见下]  （假：本环境无解码器）
//     → extension/asr/stream-chunker + chunker + wav-encode（真：切片计划 / 流式切片 /
//                                  WAV 16bit PCM 编码，与全量切片逐字节对账）
//     → extension/asr/pipeline     （真：全局偏移合并 / 无 segments 的整片降级 /
//                                  越界截断 / 空结果诊断 / 失败面上报）
//     → [转写 POST：平台边界，见下] （假：转写调度在 offscreen，页面侧只收片结果）
//
// 真实 payload 清单（都在 tests/fixtures 下，出处逐字写在各自 _provenance）：
//   - tests/asr/fixtures/fmp4-audio-sample.bin / fmp4-1mb.bin：真 B 站音轨 m4s
//   - tests/fixtures/bilibili/bv1q9he6seyx-playurl-dash-audio.json：真 playurl 响应
//     （3 条 dash 音轨 + 真实签名 URL / backupUrl），驱动真实 audio-source 选轨
//   - tests/fixtures/bilibili/bv1q9he6seyx-playurl-html5-no-dash.json：真 playurl
//     响应（生产 buildPlayurlUrl 的 platform=html5 形状：无 dash、走 durl 回退）
//   - tests/fixtures/asr/siliconflow-transcriptions-401.json / siliconflow-unknown-route-404.json：
//     真硅基流动失败报文（线上抓取）
//
// 两处不可用真实数据、故显式停下（不是近似）：
//   ① AAC 解码：Node/jsdom 没有 AudioContext，仓库依赖里也没有任何音频解码器
//      （已核：node_modules 无 audio/aac/mp4/ffmpeg/wasm 解码包）。故 decodeSegment
//      由本文件注入，返回的采样**值**是合成的非静音波形；但每段的采样**个数**由
//      真 payload 推出（每段 ADTS 帧数 × AAC-LC 1024 采样/帧 @ 真 ASC 的 48kHz，
//      再按生产解码目标 16k 折算），切片边界、片内偏移、WAV 字节因此都是真输出。
//   ② 转写成功响应：仓库内没有任何真实转写响应（.scratch 与 git 历史都没有；
//      eval:run 的产物目录 eval/out 不存在、环境也没有 SILICONFLOW_API_KEY）。故
//      合并用例的片内文本是替身（片内相对秒是构造值）；**能**用真实报文驱动的那
//      半边是失败响应——见「④ 适配器边界（真平台失败报文回放）」。
//
// 走查末尾写出可复现工件（.scratch/tickets/test-suite-trim/artifacts/01-asr-chain-walkthrough.md）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { WavChunk } from "../../extension/asr/chunker.js";
import type { AsrChunkRecord, OffscreenChunkHost } from "../../extension/asr/offscreen-bridge.page.js";

// 单参 readFileSync 被 tests/reader/node-stubs.d.ts 的 string 返回重载抢先匹配
//（同 tests/asr/adts.test.ts 的处理），读二进制走本别名
const readBinary = readFileSync as unknown as (path: string) => Uint8Array;

const ASR_FIXTURE_DIR = join(process.cwd(), "tests", "asr", "fixtures");
const BILI_FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "bilibili");
const PLATFORM_FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "asr");
const ARTIFACT_DIR = join(process.cwd(), ".scratch", "tickets", "test-suite-trim", "artifacts");

// 真实 fMP4 音轨片段：98KB（2 对 moof/mdat）与 1MB（26 对）
const SMALL_FMP4 = new Uint8Array(readBinary(join(ASR_FIXTURE_DIR, "fmp4-audio-sample.bin")));
const BIG_FMP4 = new Uint8Array(readBinary(join(ASR_FIXTURE_DIR, "fmp4-1mb.bin")));

// 真实 playurl 响应（含 dash 音轨 / 生产 html5 形状）
const PLAYURL_DASH = JSON.parse(
  readFileSync(join(BILI_FIXTURE_DIR, "bv1q9he6seyx-playurl-dash-audio.json"), "utf8")
);
const PLAYURL_HTML5 = JSON.parse(
  readFileSync(join(BILI_FIXTURE_DIR, "bv1q9he6seyx-playurl-html5-no-dash.json"), "utf8")
);

// 真实平台失败报文（线上抓取，见 fixture 的 _provenance）
const SF_401 = JSON.parse(readFileSync(join(PLATFORM_FIXTURE_DIR, "siliconflow-transcriptions-401.json"), "utf8"));
const SF_404 = JSON.parse(readFileSync(join(PLATFORM_FIXTURE_DIR, "siliconflow-unknown-route-404.json"), "utf8"));

// 生产片长（5 分钟）与走查自选片长：本 fixture 的真音频不足一片，走查另取 45s 片长
// 以覆盖多片偏移（与 tests/asr/pipeline.test.ts「自建 1200s/片」同法；生产片长本身
// 在下方用例里断言）。
const WALKTHROUGH_CHUNK_SECONDS = 45;

// ===== 测试侧独立复算（不 import 被测模块）=====
// 直接从真实容器字节读顶层 box 与 moof→traf→trun 的 sample sizes，与 adts.ts 的
// 产出逐项对账——两套实现独立，互为证据。

function readU32BE(bytes: Uint8Array, p: number): number {
  return ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
}

function boxType(bytes: Uint8Array, p: number): string {
  return String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
}

/** 单个 moof 内所有 trun 的逐 sample size（按容器顺序展开）。 */
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
  /** 全部 moof 的 sample sizes（含 mdat 不完整的那一对） */
  allSizes: number[];
  /** sample sizes：只有紧跟**完整** mdat 的 moof 才可提取（与真实提取器口径一致） */
  pairedSizes: number[];
  /** 被丢掉的 moof（容器尾部截断：mdat box 声称的字节超出文件实际长度） */
  dropped: Array<{ samples: number; mdatClaimedBytes: number; mdatAvailableBytes: number }>;
}

/** 真容器事实：顶层 box 序列 + moof/mdat 配对（截断的那一对不可提取）。 */
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

/** 产物事实：按 ADTS 头走一遍真输出字节流，返回帧数 / 每帧负载长度 / 编码参数。 */
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

/** WAV 头事实（44 字节 RIFF/WAVE + fmt + data）。 */
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

/** 逐字节比较（返回首个不同字节的下标，全同则 -1）：避免大数组 diff 输出。 */
function firstByteDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return -1;
}

// ===== 被测模块（每用例新鲜加载）=====

let adts: typeof import("../../extension/asr/adts.js");
let chunker: typeof import("../../extension/asr/chunker.js");
let streamChunker: typeof import("../../extension/asr/stream-chunker.js");
let pipeline: typeof import("../../extension/asr/pipeline.js");
let gateway: typeof import("../../extension/bilibili/gateway.js");

// runAsrPipeline 的取音轨走 gateway.contentFetchJson（audio-source 的真实默认 transport）；
// 只替换这一个传输口，其余 gateway 导出保持真身（URL 构造、选轨都在真模块里）。
vi.mock("../../extension/bilibili/gateway.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, contentFetchJson: vi.fn() };
});

beforeEach(async () => {
  resetModuleState();
  adts = await import("../../extension/asr/adts.js");
  chunker = await import("../../extension/asr/chunker.js");
  streamChunker = await import("../../extension/asr/stream-chunker.js");
  pipeline = await import("../../extension/asr/pipeline.js");
  gateway = await import("../../extension/bilibili/gateway.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ===== ① 真 fMP4 → 真 ADTS =====

describe("① 真 fMP4 → 真 ADTS 提取（真实容器字节 vs 真实提取器，双向对账）", () => {
  it("1MB 片段：帧数 / 每帧负载长度 / 字节总量与容器 trun 逐项一致", () => {
    expect(adts.isFragmentedMp4(BIG_FMP4)).toBe(true);
    const asc = adts.parseAudioSpecificConfig(BIG_FMP4);
    expect(asc).toEqual({ profile: 1, freqIdx: 3, chCfg: 2 });

    // 流式路径（生产下载侧逐块喂入）与整段路径输出逐字节一致
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

    // 独立复算（测试侧读容器）vs 产物（真提取器读同一容器）
    const container = realContainerFacts(BIG_FMP4);
    const parsedSegments = whole.map((segment) => parseAdtsStream(segment));
    expect(parsedSegments.every((parsed) => parsed.trailingBytes === 0)).toBe(true); // 段内无半帧
    const frames = parsedSegments.reduce((sum, parsed) => sum + parsed.frames, 0);

    expect(extractor.frameCount).toBe(frames);
    expect(frames).toBe(container.pairedSizes.length);
    expect(parsedSegments.flatMap((parsed) => parsed.payloadLengths)).toEqual(container.pairedSizes);
    expect(parsedSegments.every((parsed) => parsed.profiles.every((value) => value === 1))).toBe(true);
    expect(parsedSegments.every((parsed) => parsed.freqIdxs.every((value) => value === 3))).toBe(true);
    expect(parsedSegments.every((parsed) => parsed.chCfgs.every((value) => value === 2))).toBe(true);

    // 真 fixture 是**截断**的 1MiB 片段：最后一个 mdat 声称的字节数超出文件实际长度，
    // 它的 moof 因此不可提取（提取器整对丢弃，不产半帧）。锁定这个真实事实，
    // 免得把「容器比产物多出来的 sample 数」误读成提取器丢帧。
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
    expect(container.dropped).toHaveLength(0); // 98KB 片段两对 moof/mdat 都完整
    expect(parsed.frames).toBe(container.pairedSizes.length);
    expect(parsed.payloadLengths).toEqual(container.pairedSizes);
  });
});

// ===== ② 真帧数 → 真时长 → 切片计划 → 真流式切片 =====

interface ChainLayout {
  asc: { profile: number; freqIdx: number; chCfg: number };
  segments: Uint8Array[];
  framesPerSegment: number[];
  frames: number;
  /** 真 payload 推导：帧数 × 1024 采样/帧（AAC-LC）@ 真 ASC 的 48kHz → 音频时长 */
  audioDurationSec: number;
  /** 生产解码目标 16kHz 下每段的采样数（48k→16k 折算后取整） */
  sampleCounts: number[];
  decodedSamples: number;
  decodedDurationSec: number;
  sampleRate: number;
  /** 真流式切片的产出（片边界 + WAV 字节 + 片内采样数） */
  chunks: Array<{ index: number; startSec: number; durationSec: number; wavBytes: Uint8Array; samples: number }>;
  /** 同一份 PCM 走全量切片（buildWavChunks）的基线产出 */
  wholeChunks: WavChunk[];
  pcm: Float32Array;
}

/** 一次走完「真 fMP4 → 真 ADTS → 真切片」，返回每一步的真事实。 */
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

  // 解码替身（边界见文件头 ①）：采样个数由真帧数推出，采样值是与音频内容无关的
  // 确定性非静音波形（峰值 1.0，避开「疑似静音」校验，同时让 WAV 字节可复现）。
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
  it("生产片长下整段一片；自选 45s 片长下多片边界连续无缝、末片收尾", async () => {
    const layout = await buildChainLayout();
    const productionPlan = chunker.buildChunkPlan("openai-transcriptions");
    expect(productionPlan).toEqual({ chunkSeconds: 300 });
    // 真时长不足生产片长：这就是走查另取自选片长的原因
    expect(layout.decodedDurationSec).toBeLessThan(productionPlan.chunkSeconds);
    expect(chunker.decideChunks(layout.decodedDurationSec, productionPlan)).toHaveLength(1);

    const expected = chunker.decideChunks(layout.decodedDurationSec, { chunkSeconds: WALKTHROUGH_CHUNK_SECONDS });
    expect(layout.chunks.length).toBe(expected.length);
    expect(layout.chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < expected.length; i += 1) {
      expect(layout.chunks[i].index).toBe(expected[i].index);
      expect(layout.chunks[i].startSec).toBeCloseTo(expected[i].startSec, 9);
      expect(layout.chunks[i].durationSec).toBeCloseTo(expected[i].durationSec, 9);
    }
    // 连续无缝：片首尾相接，总时长等于真解码时长
    const totalDuration = layout.chunks.reduce((sum, chunk) => sum + chunk.durationSec, 0);
    expect(totalDuration).toBeCloseTo(layout.decodedDurationSec, 9);
    for (let i = 1; i < layout.chunks.length; i += 1) {
      expect(layout.chunks[i].startSec).toBeCloseTo(
        layout.chunks[i - 1].startSec + layout.chunks[i - 1].durationSec,
        9
      );
    }
  });

  it("每片 WAV：真编码头字段正确，与全量切片逐字节一致，片内采样数之和等于真解码采样数", async () => {
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
        audioFormat: 1, // PCM
        channels: 1,
        sampleRate: 16000,
        bitsPerSample: 16,
        dataTag: "data"
      });
      expect(header.totalBytes).toBe(44 + header.dataSize);
      expect(firstByteDifference(layout.chunks[i].wavBytes, wholeBytes)).toBe(-1);
    }

    // 片内采样数（WAV dataSize/2）之和等于真解码采样数：无空隙、无重复
    expect(layout.chunks.every((chunk) => Number.isInteger(chunk.samples))).toBe(true);
    expect(layout.chunks.reduce((sum, chunk) => sum + chunk.samples, 0)).toBe(layout.decodedSamples);
    expect(wholeChunks.map((chunk) => chunk.startSec)).toEqual(layout.chunks.map((chunk) => chunk.startSec));
    expect(wholeChunks.map((chunk) => chunk.index)).toEqual(layout.chunks.map((chunk) => chunk.index));
  });
});

// ===== ③ 真管线合并（片边界来自真音频时长）=====

describe("③ 真 pipeline 合并：全局偏移 / 整片降级 / 越界截断（片边界来自真音频）", () => {
  it("真 playurl 音轨选出最小带宽轨并交给任务宿主；乱序片结果按全局偏移归并", async () => {
    const layout = await buildChainLayout();
    const tracks = PLAYURL_DASH.data.dash.audio as Array<{
      baseUrl: string;
      backupUrl: string[];
      bandwidth: number;
    }>;
    const selected = tracks.reduce((min, track) => (track.bandwidth < min.bandwidth ? track : min), tracks[0]);

    // 真 playurl 响应驱动真 audio-source 选轨（页面 transport 只按 URL 路由）
    vi.mocked(gateway.contentFetchJson).mockImplementation(async (url: string) => {
      if (url.includes("/x/player/playurl")) return PLAYURL_DASH;
      throw new Error(`unexpected url: ${url}`);
    });

    // 片边界取自真音频推出的切片布局；片内文本是替身（边界见文件头 ②）
    const [first, second, third] = layout.chunks;
    const records: AsrChunkRecord[] = [
      {
        index: third.index,
        startSec: third.startSec,
        durationSec: third.durationSec,
        result: { text: "片三", segments: [{ start: 1, end: 3, text: "片三句" }] }
      },
      {
        index: first.index,
        startSec: first.startSec,
        durationSec: first.durationSec,
        result: {
          text: "片一",
          segments: [
            { start: 0.5, end: 2, text: "片一句甲" },
            // 片内越界：合并必须按片长截断
            { start: first.durationSec - 1, end: 9999, text: "片一句乙" }
          ]
        }
      },
      {
        index: second.index,
        startSec: second.startSec,
        durationSec: second.durationSec,
        // 无 segments（json 降级形状）→ 整片一条粗粒度字幕
        result: { text: "片二整段" }
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

    // 取音轨：真 fixture 的最小带宽轨（含真实 backupUrl 列表）
    expect(hostCalls).toHaveLength(1);
    expect(hostCalls[0].audioUrl).toBe(selected.baseUrl);
    expect(hostCalls[0].backupUrls).toEqual(selected.backupUrl);

    // 合并：全局偏移 = 片起点 + 片内相对秒；越界按片长截断；无 segments 走整片降级；
    // 输入乱序 → 输出按 from 升序
    expect(body).toEqual([
      { from: first.startSec + 0.5, to: first.startSec + 2, content: "片一句甲" },
      { from: first.startSec + first.durationSec - 1, to: first.startSec + first.durationSec, content: "片一句乙" },
      { from: second.startSec, to: second.startSec + second.durationSec, content: "片二整段" },
      { from: third.startSec + 1, to: third.startSec + 3, content: "片三句" }
    ]);
    for (let i = 1; i < body.length; i += 1) {
      expect(body[i].from).toBeGreaterThan(body[i - 1].from);
    }
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ totalChunks: 3, failedChunks: 0 });
    expect("failedKind" in outcomes[0]).toBe(false);
  });

  it("转写失败片不参与合并，空结果诊断带真片数与失败计数", async () => {
    const layout = await buildChainLayout();
    vi.mocked(gateway.contentFetchJson).mockImplementation(async () => PLAYURL_DASH);
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
    vi.mocked(gateway.contentFetchJson).mockImplementation(async (url: string) => {
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

// ===== ④ 适配器边界：唯一有真实报文的半边 =====

describe("④ 适配器边界（真平台失败报文回放）", () => {
  async function realProvider() {
    const presets = await import("../../extension/core/presets.js");
    const normalize = await import("../../extension/asr/asr-provider-normalize.js");
    const preset = presets.ASR_PROVIDER_PRESETS.find((item) => item.id === "siliconflow-sensevoice");
    if (!preset) throw new Error("生产预设 siliconflow-sensevoice 不存在");
    const provider = normalize.normalizeAsrProvider({ ...preset, presetId: preset.id, enabled: true });
    if (!provider) throw new Error("生产预设归一失败");
    // apiKey / language 不落盘，运行时由消费方注入（normalize 不产出）
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
    // 真报文是扁平形状：没有 OpenAI 的 error.message 可读（判定靠状态码 + 真报文原文）
    expect(JSON.parse(SF_401.body)).toEqual({ code: 30014, data: null, message: "Token is invalid." });
    // 非 2xx 是确定性失败：绝不发第二次全量 POST（单片 wav 38MB 级）
    expect(calls).toHaveLength(1);

    // 请求构造：真预设的 baseUrl/model + 适配器写的 multipart 字段；language=auto 不带查询参数
    expect(calls[0].url).toBe("https://api.siliconflow.cn/v1/audio/transcriptions");
    const form = calls[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe(provider.model);
    expect(form.get("model")).toBe("XingChenAGI/XingChenASR-V3.2-Ultra");
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

// ===== ⑤ 走查工件：可复现、可对账 =====

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
        } 片（真时长不足一片）`,
        `- 走查自选片长：${WALKTHROUGH_CHUNK_SECONDS}s`,
        `- 解码采样数（由真帧数推出）：${layout.decodedSamples}（${layout.sampleCounts.join(" + ")}）`,
        `- 解码时长：${layout.decodedDurationSec.toFixed(6)}s`,
        "",
        "| 片 | index | startSec | durationSec | 片内采样 | WAV 字节 | 与全量切片逐字节一致 |",
        "|---|---|---|---|---|---|---|",
        ...layout.chunks.map(
          (chunk, i) =>
            `| ${i} | ${chunk.index} | ${chunk.startSec} | ${chunk.durationSec} | ${chunk.samples} | ${
              chunk.wavBytes.length
            } | ${firstByteDifference(chunk.wavBytes, wholeBytesByChunk[i]) === -1 ? "是" : "否"} |`
        ),
        "",
        "## ③ 真 pipeline 合并（片边界同上；片内文本是替身，见测试文件头 ②）",
        "| from | to | content |",
        "|---|---|---|",
        `| ${layout.chunks[0].startSec + 0.5} | ${layout.chunks[0].startSec + 2} | 片一句甲 |`,
        `| ${layout.chunks[0].startSec + layout.chunks[0].durationSec - 1} | ${
          layout.chunks[0].startSec + layout.chunks[0].durationSec
        } | 片一句乙（片内越界 → 按片长截断） |`,
        `| ${layout.chunks[1].startSec} | ${layout.chunks[1].startSec + layout.chunks[1].durationSec} | 片二整段（无 segments → 整片降级） |`,
        `| ${layout.chunks[2].startSec + 1} | ${layout.chunks[2].startSec + 3} | 片三句 |`,
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

    // 工件与真实产物对账（防工件说谎）
    const artifact = readFileSync(artifactPath, "utf8");
    expect(artifact).toContain(`容器：顶层 moof ${container.moofCount} 个`);
    expect(artifact).toContain(`提取器 frameCount：${layout.frames}`);
    expect(artifact).toContain(`真音频时长：${layout.audioDurationSec.toFixed(6)}s`);
    expect(artifact).toContain(`- 解码采样数（由真帧数推出）：${layout.decodedSamples}`);
    expect(artifact).toContain(
      `| 0 | 0 | 0 | ${layout.chunks[0].durationSec} | ${layout.chunks[0].samples} | ${layout.chunks[0].wavBytes.length} | 是 |`
    );
  });
});
