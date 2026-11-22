import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { ASR_PENDING_CHUNKS_LIMIT_MESSAGE } from "../../extension/asr/protocol.js";
import { formatAsrFailureDetail } from "../../extension/core/asr-failure-notice.js";
import { installMinimalChromeHost, type MinimalChromeHost } from "../helpers/chrome-runtime-host.js";

const AUDIO_FIXTURE = buildFmp4WithTwoSegments();

const FTYP_SIZE = 32;

function buildFmp4WithTwoSegments(pairs = 20): Uint8Array {
  const ftyp = new Uint8Array(32);
  writeU32(ftyp, 0, 32);
  ftyp.set([0x66, 0x74, 0x79, 0x70], 4);

  const moofSize = 8 + 16 + (8 + 24 + (8 + 4 + 4 + 4 + 8));
  const pairSize = moofSize + (8 + 171);
  const out = new Uint8Array(ftyp.length + pairSize * pairs);
  out.set(ftyp, 0);

  for (let i = 0; i < pairs; i += 1) {
    const base = ftyp.length + i * pairSize;
    const moof = out.subarray(base, base + moofSize);
    writeU32(moof, 0, moofSize);
    moof.set([0x6d, 0x6f, 0x6f, 0x66], 4);
    writeU32(moof, 8, 16);
    moof.set([0x6d, 0x66, 0x68, 0x64], 12);
    moof.set([0, 0, 0, 0], 16);
    writeU32(moof, 20, i + 1);
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

    const mdat = out.subarray(base + moofSize, base + pairSize);
    writeU32(mdat, 0, 8 + 171);
    mdat.set([0x6d, 0x64, 0x61, 0x74], 4);
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

function ftypAndMoofPairSize(): number {
  const moofSize = 8 + 16 + (8 + 24 + (8 + 4 + 4 + 4 + 8));
  return moofSize + (8 + 171);
}

const PLAYURL_URL = "https://api.bilibili.com/x/player/playurl";
const AUDIO_URL = "https://upos-sz-mirror.bilivideo.com/audio.m4s";
const ASR_BASE_URL = "https://api.siliconflow.cn/v1";
const TRANSCRIPTION_URL = `${ASR_BASE_URL}/audio/transcriptions`;

const SAMPLES_PER_SEGMENT = 960_000;

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

let host: MinimalChromeHost;
let transcriptionRequests: number[] = [];

function installAudioContextStub() {
  const mono = () => {
    const data = new Float32Array(SAMPLES_PER_SEGMENT);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.sin(i / 100) * 0.5;
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

function installFetchStub(transcriptionStatus: number | string) {
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

function installHost() {
  host = installMinimalChromeHost({
    preserveExisting: true,
    onConnect: true,
    replies: {
      "get-asr-runtime-config": () => RUNTIME_CONFIG,
      "check-provider-origin": () => ({ granted: true })
    }
  });
}

function connectAsrDecodePort() {
  const listener = host.onConnectListeners.at(-1)!;
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

async function runDecodeTask() {
  await import("../../extension/entry/offscreen.js");
  const { port, taskListener } = connectAsrDecodePort();
  taskListener({ action: "asr-decode", task: { audioUrl: AUDIO_URL } });
  await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled(), { timeout: 20000 });
  return { port, payload: port.postMessage.mock.calls[0][0] as Record<string, unknown> };
}

beforeEach(() => {
  resetModuleState();
  transcriptionRequests = [];
  installHost();
  installAudioContextStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("票 08 C5：首片确定性失败即中止整轮（真 offscreen 链路）", () => {
  it("首片 401 → 未发起第 2 片转写请求，终态为 DONE 带 asr-auth", async () => {
    installFetchStub(401);

    const { payload } = await runDecodeTask();

    expect(payload.type).toBe("done");
    expect(payload.totalChunks).toBe(0);
    expect(payload.failedChunks).toBe(1);
    expect(payload.failedKind).toBe("asr-auth");
    expect(payload.failedStatus).toBe(401);
    expect(payload.failedDetail).toContain("platform rejected with 401");
    expect(transcriptionRequests).toEqual([1]);
  }, 30000);

  it("中止后不再新增切片：内存上限文案不顶替真正的失败原因", async () => {
    installFetchStub(401);

    const { payload } = await runDecodeTask();

    expect(payload.error).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(ASR_PENDING_CHUNKS_LIMIT_MESSAGE);
    expect(payload.failedKind).toBe("asr-auth");
  }, 30000);

  it("可重试失败（500）不中止：切片继续，DONE 带 asr-server 且上传过不止一片", async () => {
    installFetchStub(500);

    const { payload } = await runDecodeTask();

    expect(payload.type).toBe("done");
    expect(payload.totalChunks).toBe(3);
    expect(transcriptionRequests.length).toBeGreaterThan(1);
    expect(payload.failedKind).toBe("asr-server");
    expect(payload.failedStatus).toBe(500);
  }, 30000);

  it("数字串状态码（\"401\"）照收：DONE 仍带 401，详情行拼得出「HTTP 401」", async () => {
    installFetchStub("401");

    const { payload } = await runDecodeTask();

    expect(payload.type).toBe("done");
    expect(payload.failedKind).toBe("asr-auth");
    expect(payload.failedStatus).toBe(401);
    const copy = formatAsrFailureDetail({
      status: payload.failedStatus as number,
      detail: payload.failedDetail as string
    });
    expect(copy).toContain("HTTP 401");
  }, 30000);
});
