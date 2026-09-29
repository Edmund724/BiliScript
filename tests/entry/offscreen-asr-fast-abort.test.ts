// 票 08 验收 C5：中止（票 05）——第 1 片不可重试失败后未发起第 2 片请求、
// 不再新增切片；中止的失败原因不被 ASR_PENDING_CHUNKS_LIMIT_MESSAGE 顶替。
//
// 落点说明（验收表 C5 的第二处构造点）：本模块的用例跑在**真链路**上——
// entry/offscreen.js 的 onConnect 接线 + 懒装载的真 offscreen-asr.js + 真
// engine + 真适配器，只把三件外部世界的东西换成受控替身：
//   1. fetch：playurl（page 侧 playurl 走真实 contentFetchJson）+ 音轨 HEAD/GET
//      + 转写 POST，全按 URL 分发；
//   2. chrome.runtime.sendMessage：get-asr-runtime-config 回完整快照，
//      check-provider-origin 回已授权；
//   3. AudioContext / OfflineAudioContext：解码替身——每段解出固定采样，让
//      stream-chunker 按 chunkSeconds 切出多片（不真解码 ADTS）。
// 这样「首片 401 之后不再发起第 2 片 POST」是在离用户最近的一层断言的，而不是
// 只断言 engine 内部的计数（engine 层的同型用例见 tests/asr/engine.test.ts）。
//
// 音轨夹具复用 tests/asr/fixtures/fmp4-audio-sample.bin（fMP4 → ADTS 段），
// 片长用真链路的 buildChunkPlan（openai-transcriptions → 300s/片）；夹具时长
// 远短于 300s，故靠「AudioContext 替身放大每段采样数」造出多片。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resetModuleState } from "../setup.js";
import { ASR_PENDING_CHUNKS_LIMIT_MESSAGE } from "../../extension/asr/protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 单参 readFileSync 被 tests/reader/node-stubs.d.ts 的 string 返回重载抢先匹配
// （与 tests/entry/offscreen-audio-stream.test.ts 同处理），读二进制走本别名。
const readFileBytes = readFileSync as unknown as (path: string) => Uint8Array;
// 真实 fMP4 夹具只含 **1 个** ADTS 段（98KB / 2 对 moof+mdat / 10 moof 才封一段），
// 而本用例要判别的恰恰是「第 2 片」——故另造一份 20 对 moof+mdat 的合成音轨：
// createAdtsExtractor 按 SEGMENT_MOOFS=10 分组，第 10 对封第 1 段、第 20 对封第 2 段。
const AUDIO_FIXTURE = buildFmp4WithTwoSegments();

// ftyp box 的字节数（buildFmp4WithTwoSegments 的固定前缀）
const FTYP_SIZE = 32;

// 手工构造 fMP4：ftyp + 2N 对 (moof + mdat)，每对 1 个 171 字节样本。
// 结构逐字段与 tests/asr/adts.test.ts 的 buildMinimalFmp4 一致（同仓库已验证
// 的最小 mfhd/tfhd/trun 布局），只是重复成对被 SEGMENT_MOOFS 分组。
function buildFmp4WithTwoSegments(pairs = 20): Uint8Array {
  const ftyp = new Uint8Array(32);
  writeU32(ftyp, 0, 32);
  ftyp.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"

  const moofSize = 8 + 16 + (8 + 24 + (8 + 4 + 4 + 4 + 8));
  const pairSize = moofSize + (8 + 171);
  const out = new Uint8Array(ftyp.length + pairSize * pairs);
  out.set(ftyp, 0);

  for (let i = 0; i < pairs; i += 1) {
    const base = ftyp.length + i * pairSize;
    const moof = out.subarray(base, base + moofSize);
    writeU32(moof, 0, moofSize);
    moof.set([0x6d, 0x6f, 0x6f, 0x66], 4); // "moof"
    writeU32(moof, 8, 16);
    moof.set([0x6d, 0x66, 0x68, 0x64], 12); // "mfhd"
    moof.set([0, 0, 0, 0], 16);
    writeU32(moof, 20, i + 1); // sequence
    const trafStart = 24;
    writeU32(moof, trafStart, 8 + 24 + (8 + 4 + 4 + 4 + 8));
    moof.set([0x74, 0x72, 0x61, 0x66], trafStart + 4); // "traf"
    const tfhdStart = trafStart + 8;
    writeU32(moof, tfhdStart, 24);
    moof.set([0x74, 0x66, 0x68, 0x64], tfhdStart + 4); // "tfhd"
    moof.set([0, 0, 0, 0], tfhdStart + 8);
    writeU32(moof, tfhdStart + 12, 1);
    writeU32(moof, tfhdStart + 16, 1024);
    writeU32(moof, tfhdStart + 20, 171);
    const trunStart = tfhdStart + 24;
    writeU32(moof, trunStart, 8 + 4 + 4 + 4 + 8);
    moof.set([0x74, 0x72, 0x75, 0x6e], trunStart + 4); // "trun"
    moof[trunStart + 8] = 0; // version=0
    moof[trunStart + 9] = 0x03; // flags：data_offset + duration + size
    moof[trunStart + 10] = 0x01;
    writeU32(moof, trunStart + 12, 1); // sample_count
    writeU32(moof, trunStart + 16, 8); // data_offset
    writeU32(moof, trunStart + 20, 1024); // sample duration
    writeU32(moof, trunStart + 24, 171); // sample size

    const mdat = out.subarray(base + moofSize, base + pairSize);
    writeU32(mdat, 0, 8 + 171);
    mdat.set([0x6d, 0x64, 0x61, 0x74], 4); // "mdat"
    mdat.fill(0x21, 8);
  }
  return out;
}

function writeU32(arr: Uint8Array, p: number, value: number): void {
  arr[p] = (value >>> 24) & 0xff;
  arr[p + 1] = (value >>> 16) & 0xff;
  arr[p + 2] = (value >>> 8) & 0xff;
  arr[p + 3] = value & 0xff;
}

// ftyp(32) + 一对 (moof + mdat) 的字节数：上面 buildFmp4WithTwoSegments 的
// 布局常量，供切块点计算（切在第 1 段封段处）。
function ftypAndMoofPairSize(): number {
  const moofSize = 8 + 16 + (8 + 24 + (8 + 4 + 4 + 4 + 8));
  return moofSize + (8 + 171);
}

const PLAYURL_URL = "https://api.bilibili.com/x/player/playurl";
const AUDIO_URL = "https://upos-sz-mirror.bilivideo.com/audio.m4s";
const ASR_BASE_URL = "https://api.siliconflow.cn/v1";
const TRANSCRIPTION_URL = `${ASR_BASE_URL}/audio/transcriptions`;

// 每段解码产出的采样数：恰好让夹具的**单个** ADTS 段就切满 1 片——片长取
// buildChunkPlan("openai-transcriptions") 的 300s @16kHz = 4_800_000 采样。
// 夹具（fmp4-audio-sample.bin）经解复用得到 2 段，故第 1 段即触发首个转写请求，
// 第 2 段要等第 1 段消费完才被解码（stream-chunker 逐段消费）——这正是中止能否
// 拦住「第 2 片」的判别点：中止路径下请求数停在 1，非中止路径下继续往上走。
const SAMPLES_PER_SEGMENT = 4_800_000;

const RUNTIME_CONFIG = {
  ok: true,
  asrAutoFallback: true,
  activeAsrProviderId: "p1",
  providers: [
    {
      id: "p1",
      type: "openai-transcriptions",
      name: "硅基流动",
      presetId: "preset-siliconflow",
      baseUrl: ASR_BASE_URL,
      model: "FunASR-Nano-2512",
      supportsTimestamps: true,
      enabled: true
    }
  ],
  activeKey: "sk-test",
  asrLanguage: "auto"
};

let onConnectListeners: Array<(port: chrome.runtime.Port) => void> = [];
// 转写 POST 的到达顺序（断言「第 2 片从未发起」的唯一事实源）
let transcriptionRequests: number[] = [];

// 解码替身：decodeAudioData 返回 {duration, numberOfChannels, sampleRate,
// length, getChannelData}——resampleTo16kMono 只消费这些字段；startRendering
// 返回同一形状的 16k mono 结果。
function installAudioContextStub() {
  const mono = () => {
    const data = new Float32Array(SAMPLES_PER_SEGMENT);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.sin(i / 100) * 0.5; // 非静音（峰值检查会拒全零采样）
    }
    return data;
  };
  const bufferStub = () => ({
    duration: SAMPLES_PER_SEGMENT / 16000,
    numberOfChannels: 1,
    sampleRate: 16000,
    length: 0,
    getChannelData: mono
  });
  class FakeAudioContext {
    decodeAudioData = vi.fn(async () => bufferStub());
    close = vi.fn(async () => {});
  }
  class FakeOfflineAudioContext {
    constructor(_channels: number, _length: number, _sampleRate: number) {}
    createBufferSource() {
      return { buffer: null, connect: vi.fn(), start: vi.fn() };
    }
    destination = {};
    startRendering = vi.fn(async () => ({
      getChannelData: mono
    }));
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
}

// fetch 替身：按 URL/method 分发（playurl / 音轨 HEAD / 音轨 GET / 转写 POST）。
// transcriptionStatus 决定转写响应——首个响应按它返回，后续请求若真的发生也
// 会被记进 transcriptionRequests（用例据此断言「没有第 2 次」）。
function installFetchStub(transcriptionStatus: number) {
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    const target = String(url);
    if (target.startsWith(PLAYURL_URL)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: { dash: { audio: [{ baseUrl: AUDIO_URL, backupUrl: [], bandwidth: 64000 }] } }
        })
      };
    }
    if (target.startsWith(AUDIO_URL)) {
      if (init?.method === "HEAD") {
        return { ok: true, status: 200, headers: { get: () => String(AUDIO_FIXTURE.length) } };
      }
      // 分两块投喂，切点落在**第 1 段封段的那一对 moof+mdat 之后**：第 1 段
      // （10 对）在第一个 read 里完整产出，第 2 段只由第二个 read 补齐——而
      // streamWavChunks 是 `for await` 逐段消费的，第 2 段必须等第 1 段的
      // onChunk 返回才被拉取。这正是「中止能否拦住第 2 片」的判别点：中止路径
      // 下 onChunk 的 stop() 先抛哨兵，第 2 段永远拿不到。
      const pairs = 20;
      const cut = FTYP_SIZE + ftypAndMoofPairSize() * (pairs / 2);
      const parts = [AUDIO_FIXTURE.subarray(0, cut), AUDIO_FIXTURE.subarray(cut)];
      let step = 0;
      const reader = {
        read: async () =>
          step < parts.length ? { done: false, value: parts[step++] } : { done: true, value: undefined },
        cancel: vi.fn(async () => {})
      };
      return { ok: true, status: 200, body: { getReader: () => reader } };
    }
    if (target.startsWith(TRANSCRIPTION_URL)) {
      transcriptionRequests.push(transcriptionRequests.length + 1);
      return {
        ok: false,
        status: transcriptionStatus,
        text: async () =>
          JSON.stringify({ error: { message: `platform rejected with ${transcriptionStatus}`, type: "platform_error" } })
      };
    }
    throw new Error(`unexpected fetch: ${target}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubChromeRuntime() {
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    runtime: {
      ...globalThis.chrome.runtime,
      onConnect: {
        addListener: vi.fn((fn: (port: chrome.runtime.Port) => void) => onConnectListeners.push(fn))
      },
      sendMessage: vi.fn(async (message: { type?: string }) => {
        if (message?.type === "get-asr-runtime-config") {
          return RUNTIME_CONFIG;
        }
        if (message?.type === "check-provider-origin") {
          return { granted: true };
        }
        return { ok: true };
      })
    }
  });
}

function connectAsrDecodePort() {
  const listener = onConnectListeners[onConnectListeners.length - 1];
  expect(listener, "offscreen.js 应已在模块加载时注册 onConnect 监听").toBeTruthy();
  const listeners = new Set<(message: unknown) => void>();
  const terminal = vi.fn();
  const port = {
    name: "asr-decode",
    postMessage: vi.fn(),
    onMessage: {
      addListener: (fn: (message: unknown) => void) => listeners.add(fn),
      removeListener: vi.fn()
    },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    disconnect: vi.fn()
  };
  listener(port as unknown as chrome.runtime.Port);
  return { port, taskListener: [...listeners][0], terminal };
}

// 跑一次解码任务直到终态消息落地，返回该消息
async function runDecodeTask() {
  await import("../../extension/entry/offscreen.js");
  const { port, taskListener } = connectAsrDecodePort();
  taskListener({ action: "asr-decode", task: { audioUrl: AUDIO_URL } });
  await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled(), { timeout: 20000 });
  return { port, payload: port.postMessage.mock.calls[0][0] as Record<string, unknown> };
}

beforeEach(() => {
  resetModuleState();
  onConnectListeners = [];
  transcriptionRequests = [];
  stubChromeRuntime();
  installAudioContextStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("票 08 C5：首片确定性失败即中止整轮（真 offscreen 链路）", () => {
  it("首片 401 → 未发起第 2 片转写请求，终态为 DONE 带 asr-auth", async () => {
    installFetchStub(401);

    const { payload } = await runDecodeTask();

    // 中止不借 ERROR 的管线级语义（票 03 Q2）：片级失败仍走 DONE，靠
    // failedChunks + failedKind 说话。totalChunks: 0 是中止收尾的指纹——
    // 第 1 片的失败在 engine 结算前就到站，收尾用的是中止分支的定值
    // （非中止路径会带 engine 结算出的真实片数）。
    expect(payload.type).toBe("done");
    expect(payload.totalChunks).toBe(0);
    expect(payload.failedChunks).toBe(1);
    expect(payload.failedKind).toBe("asr-auth");
    expect(payload.failedStatus).toBe(401);
    expect(payload.failedDetail).toContain("platform rejected with 401");
    // C5 的正面断言：第 1 片失败后**未再发起任何转写请求**——上游切片被 stop()
    // 的哨兵同步叫停（流水线是 for await 逐段消费，第 2 段必须等第 1 段的
    // onChunk 返回才被拉取），第 2 段从未解码成片，也就没有第 2 次上传。
    // 上传侧全仓零计量，这条请求计数是唯一可断言的收益。
    expect(transcriptionRequests).toEqual([1]);
  }, 30000);

  it("中止后不再新增切片：内存上限文案不顶替真正的失败原因", async () => {
    installFetchStub(401);

    const { payload } = await runDecodeTask();

    // 上游切片被 stop() 的哨兵叫停，绝不走到「push 拒绝 → 排队上限」那条路：
    // 报错文案必须是 401 的归因，不是 ASR_PENDING_CHUNKS_LIMIT_MESSAGE
    expect(payload.error).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(ASR_PENDING_CHUNKS_LIMIT_MESSAGE);
    expect(payload.failedKind).toBe("asr-auth");
  }, 30000);

  it("可重试失败（500）不中止：切片继续，DONE 带 asr-server 且上传过不止一片", async () => {
    installFetchStub(500);

    const { payload } = await runDecodeTask();

    expect(payload.type).toBe("done");
    // 与 401 用例互为对照：可重试类（isRetryableNetworkError）不触发中止，
    // 切片照常推进——两段都切出片（totalChunks: 2），每片按 1 次首发 + 2 次
    // 重试共 3 次上传，故请求数远多于中止路径的那 1 次。
    expect(payload.totalChunks).toBe(2);
    expect(transcriptionRequests.length).toBeGreaterThan(1);
    expect(payload.failedKind).toBe("asr-server");
    expect(payload.failedStatus).toBe(500);
  }, 30000);
});
