import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASR_PENDING_CHUNKS_LIMIT_MESSAGE } from "../../extension/asr/protocol.js";
import { bytesToBase64 } from "../../extension/shared/bytes.js";
import { formatAsrFailureDetail } from "../../extension/core/asr-failure-notice.js";
import { HOST_INVALID_ORIGIN_HINT, HOST_PERMISSION_HINT } from "../../extension/core/host-permissions.js";
import { resolveAsrProvider, type AsrRuntimeConfig } from "../../extension/entry/offscreen-asr.js";
import {
  installMinimalChromeHost,
  type MinimalChromeHost,
  type MinimalChromeHostOptions
} from "../helpers/chrome-runtime-host.js";
import { clearSharedSlots, setupEnvironment } from "../setup.js";

const ASR_BASE_URL = "https://api.siliconflow.cn/v1";

const RUNTIME_CONFIG_BASE: AsrRuntimeConfig = {
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

const RUNTIME_CONFIG_RESPONSE = {
  ok: true,
  ...RUNTIME_CONFIG_BASE
};

function resetOffscreenState() {
  vi.resetModules();
  vi.useRealTimers();
  setupEnvironment();
  clearSharedSlots();
}

async function loadOffscreen() {
  return import("../../extension/entry/offscreen.js");
}

function connectAsrPort(host: MinimalChromeHost) {
  const listener = host.onConnectListeners.at(-1)!;
  expect(listener, "offscreen.js 应已在模块加载时注册 onConnect 监听").toBeTruthy();
  const listeners = new Set<(message: unknown) => void>();
  const port = {
    name: "asr-decode",
    postMessage: vi.fn(),
    onMessage: {
      addListener: (fn: (message: unknown) => void) => listeners.add(fn),
      removeListener: (fn: (message: unknown) => void) => listeners.delete(fn)
    },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    disconnect: vi.fn()
  };
  listener(port as unknown as chrome.runtime.Port);
  const emitPortMessage = (msg: unknown) => {
    for (const fn of [...listeners]) {
      fn(msg);
    }
  };
  return { port, taskListener: [...listeners][0], emitPortMessage };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("票 08 C5：首片确定性失败即中止整轮（真 offscreen 链路）", () => {
  const FTYP_SIZE = 32;
  const PLAYURL_URL = "https://api.bilibili.com/x/player/playurl";
  const AUDIO_URL = "https://upos-sz-mirror.bilivideo.com/audio.m4s";
  const TRANSCRIPTION_URL = `${ASR_BASE_URL}/audio/transcriptions`;
  const SAMPLES_PER_SEGMENT = 960_000;

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
      moof[trunStart + 9] = 0;
      moof[trunStart + 10] = 0x03;
      moof[trunStart + 11] = 0x01;
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

  const AUDIO_FIXTURE = buildFmp4WithTwoSegments();

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

  async function runDecodeTask() {
    await loadOffscreen();
    const { port, taskListener } = connectAsrPort(host);
    taskListener({ action: "asr-decode", task: { audioUrl: AUDIO_URL } });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled(), { timeout: 20000 });
    return { port, payload: port.postMessage.mock.calls[0][0] as Record<string, unknown> };
  }

  beforeEach(() => {
    resetOffscreenState();
    transcriptionRequests = [];
    host = installMinimalChromeHost({
      preserveExisting: true,
      onConnect: true,
      replies: {
        "get-asr-runtime-config": () => RUNTIME_CONFIG_RESPONSE,
        "check-provider-origin": () => ({ granted: true })
      }
    });
    installAudioContextStub();
  });

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

describe("ASR 转写链 host 权限预检", () => {
  let host: MinimalChromeHost;
  let fetchMock: ReturnType<typeof vi.fn>;
  let events: string[] = [];
  let checkReply: unknown;

  beforeEach(() => {
    resetOffscreenState();
    events = [];
    checkReply = { granted: true };
    host = installMinimalChromeHost({
      preserveExisting: true,
      onConnect: true,
      replyStyle: "both",
      replies: {
        "get-asr-runtime-config": () => {
          events.push("msg:get-asr-runtime-config");
          return RUNTIME_CONFIG_RESPONSE;
        },
        "check-provider-origin": () => {
          events.push("msg:check-provider-origin");
          return checkReply;
        }
      }
    });
    fetchMock = vi.fn(async (_url: unknown, init?: { method?: string }) => {
      events.push(`fetch:${init?.method || "GET"}`);
      return { ok: false, status: 500 };
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  async function runDecodeTask() {
    const { port, taskListener } = connectAsrPort(host);
    taskListener({ action: "asr-decode", task: { audioUrl: "https://x/a.m4s" } });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());
    return { port, payload: port.postMessage.mock.calls[0][0] as { type?: string; error?: string; code?: string } };
  }

  it("未授权（SW 回 { granted: false }）→ 可操作文案终态，连音频都不下载", async () => {
    await loadOffscreen();
    checkReply = { granted: false };

    const { payload } = await runDecodeTask();

    expect(payload).toEqual({ type: "error", error: HOST_PERMISSION_HINT, kind: "no-asr-config" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events.indexOf("msg:check-provider-origin")).toBeGreaterThan(events.indexOf("msg:get-asr-runtime-config"));
    expect(events.filter((event) => event.startsWith("fetch:"))).toEqual([]);
  });

  it("已授权（{ granted: true }）→ 预检放行，下载照常开始", async () => {
    await loadOffscreen();
    checkReply = { granted: true };

    const { payload } = await runDecodeTask();

    expect(payload).toEqual({ type: "error", error: "音频下载失败", kind: "asr-media" });
    expect(events.indexOf("msg:check-provider-origin")).toBeLessThan(events.indexOf("fetch:HEAD"));
    expect(fetchMock).toHaveBeenCalled();
  });

  it("无回包（旧 SW 不认识这条消息）→ fail-open，不新造拦截面", async () => {
    await loadOffscreen();
    checkReply = undefined;

    const { payload } = await runDecodeTask();

    expect(payload).toEqual({ type: "error", error: "音频下载失败", kind: "asr-media" });
    expect(payload.code).toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("ASR provider.baseUrl 非法 → 显式报 no-asr-config，不发 check-provider-origin 也不下载音频", async () => {
    host = installMinimalChromeHost({
      preserveExisting: true,
      onConnect: true,
      replyStyle: "both",
      replies: {
        "get-asr-runtime-config": () => ({
          ...RUNTIME_CONFIG_RESPONSE,
          providers: [{ ...RUNTIME_CONFIG_RESPONSE.providers![0], baseUrl: "oops" }]
        }),
        "check-provider-origin": () => {
          events.push("msg:check-provider-origin");
          return { granted: true, status: "granted" };
        }
      }
    });
    await loadOffscreen();

    const { payload } = await runDecodeTask();

    expect(payload).toEqual({ type: "error", error: HOST_INVALID_ORIGIN_HINT, kind: "no-asr-config" });
    expect(events).not.toContain("msg:check-provider-origin");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const PROBE_MODEL = "XingChenAGI/XingChenASR-V3.2";
const PROBE_TASK = {
  type: "openai-transcriptions",
  baseUrl: ASR_BASE_URL,
  model: PROBE_MODEL,
  apiKey: "sk-draft",
  language: "auto"
};

function createProbeContext() {
  resetOffscreenState();
  const requests: Array<{ url: string; init: any }> = [];
  const messages: string[] = [];
  let platformStatus = 200;
  let platformBody: unknown = { text: "" };
  let checkReply: unknown = { granted: true };

  const host = installMinimalChromeHost({
    preserveExisting: true,
    onConnect: true,
    replyStyle: "both",
    replies: {
      "check-provider-origin": () => checkReply,
      "get-asr-runtime-config": () => {
        messages.push("get-asr-runtime-config");
        return { ok: true };
      },
      "offscreen-request-close": () => {
        messages.push("offscreen-request-close");
        return { ok: true };
      }
    }
  });

  const fetchMock = vi.fn(async (url: unknown, init?: unknown) => {
    requests.push({ url: String(url), init });
    return {
      ok: platformStatus >= 200 && platformStatus < 300,
      status: platformStatus,
      json: async () => platformBody,
      text: async () => JSON.stringify(platformBody)
    };
  });
  vi.stubGlobal("fetch", fetchMock);

  async function runProbe(task: Record<string, unknown> = PROBE_TASK) {
    const { port, taskListener } = connectAsrPort(host);
    taskListener({ action: "asr-probe", task });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());
    return {
      port,
      payload: port.postMessage.mock.calls[0][0] as {
        type?: string;
        ok?: boolean;
        error?: string;
        kind?: string;
        status?: number;
      }
    };
  }

  return {
    fetchMock,
    requests,
    messages,
    runProbe,
    setCheckReply: (reply: unknown) => {
      checkReply = reply;
    },
    setPlatformResponse: (status: number, body: unknown) => {
      platformStatus = status;
      platformBody = body;
    }
  };
}

describe("探针走真链路：host 权限预检与实际转写同源", () => {
  let probe: ReturnType<typeof createProbeContext>;

  beforeEach(() => {
    probe = createProbeContext();
  });

  it("未授权（SW 回 { granted: false }）→ 同一道可操作文案，一个请求都不发", async () => {
    await loadOffscreen();
    probe.setCheckReply({ granted: false });

    const { payload } = await probe.runProbe();

    expect(payload).toEqual({
      type: "probe-result",
      ok: false,
      error: HOST_PERMISSION_HINT,
      kind: "no-asr-config"
    });
    expect(probe.fetchMock).not.toHaveBeenCalled();
  });

  it("无回包（旧 SW 不认识这条消息）→ fail-open 放行，探针照常打请求", async () => {
    await loadOffscreen();
    probe.setCheckReply(undefined);

    const { payload } = await probe.runProbe();

    expect(payload).toMatchObject({ type: "probe-result", ok: true });
    expect(probe.fetchMock).toHaveBeenCalled();
  });

  it("探针不读运行时配置：Key 随任务过来，不经 get-asr-runtime-config", async () => {
    await loadOffscreen();

    await probe.runProbe();

    expect(probe.messages).not.toContain("get-asr-runtime-config");
  });
});

describe("探针走真链路：请求构造与实际转写逐字同源", () => {
  let probe: ReturnType<typeof createProbeContext>;

  beforeEach(() => {
    probe = createProbeContext();
  });

  it("已授权 → 打真适配器：同 URL / 同 Authorization / 同 FormData 字段（2xx 无 segments 不重复上传）", async () => {
    await loadOffscreen();

    const { payload } = await probe.runProbe();

    expect(payload).toEqual({ type: "probe-result", ok: true });
    expect(probe.requests).toHaveLength(1);
    const { url, init } = probe.requests[0];
    expect(url).toBe(`${ASR_BASE_URL}/audio/transcriptions`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-draft");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers["Content-Type"]).toBeUndefined();
    expect((init.body as FormData).get("model")).toBe(PROBE_MODEL);
    expect((init.body as FormData).get("response_format")).toBe("verbose_json");
  });

  it("语言档位 en → ?language=english 由适配器的 URL 构造给出（探针不再自抄一份）", async () => {
    await loadOffscreen();

    await probe.runProbe({ ...PROBE_TASK, language: "en" });

    expect(probe.requests[0].url).toBe(`${ASR_BASE_URL}/audio/transcriptions?language=english`);
  });

  it("平台 401 → 文案 / kind / status 与实际转写同一串，且不再发第二次请求", async () => {
    await loadOffscreen();
    probe.setPlatformResponse(401, { code: 30014, data: null, message: "Token is invalid." });

    const { payload } = await probe.runProbe();

    expect(payload.type).toBe("probe-result");
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("HTTP 401");
    expect(payload.error).toContain("Token is invalid");
    expect(payload.kind).toBe("asr-auth");
    expect(payload.status).toBe(401);
    expect(probe.requests).toHaveLength(1);
  });
});

describe("探针走真链路：本地校验与端口簿记", () => {
  let probe: ReturnType<typeof createProbeContext>;

  beforeEach(() => {
    probe = createProbeContext();
  });

  it("baseUrl / 模型名缺失 → 各自可读文案，不发请求", async () => {
    await loadOffscreen();

    const noBaseUrl = await probe.runProbe({ ...PROBE_TASK, baseUrl: "" });
    const noModel = await probe.runProbe({ ...PROBE_TASK, model: "" });

    expect(noBaseUrl.payload).toEqual({ type: "probe-result", ok: false, error: "请填写 baseUrl" });
    expect(noModel.payload).toEqual({ type: "probe-result", ok: false, error: "请填写模型名" });
    expect(probe.fetchMock).not.toHaveBeenCalled();
  });

  it("类型不支持 → 可读文案，不发请求", async () => {
    await loadOffscreen();

    const { payload } = await probe.runProbe({ ...PROBE_TASK, type: "whisper-cli" });

    expect(payload).toEqual({
      type: "probe-result",
      ok: false,
      error: "暂不支持的平台类型：whisper-cli"
    });
    expect(probe.fetchMock).not.toHaveBeenCalled();
  });

  it("探针终态照走端口簿记：回执发完后在短宽限窗口到期触发文档自关判定", async () => {
    vi.useFakeTimers();
    try {
      await loadOffscreen();
      const { DEFAULT_ASR_IDLE_GRACE_MS } = await import("../../extension/entry/offscreen-lifecycle.js");

      await probe.runProbe();
      expect(probe.messages).not.toContain("offscreen-request-close");

      await vi.advanceTimersByTimeAsync(DEFAULT_ASR_IDLE_GRACE_MS);
      expect(probe.messages).toContain("offscreen-request-close");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resolveAsrProvider 结构化 skip 原因", () => {
  it("快照关闭（asrAutoFallback === false）：asr-skip 且 reason=asr-disabled", () => {
    expect(() => resolveAsrProvider({ ...RUNTIME_CONFIG_BASE, asrAutoFallback: false })).toThrowError(
      expect.objectContaining({
        code: "asr-skip",
        reason: "asr-disabled",
        message: "ASR 自动回退未开启"
      })
    );
  });

  it("平台列表为空：asr-skip 且 reason=no-asr-config", () => {
    expect(() => resolveAsrProvider({ ...RUNTIME_CONFIG_BASE, providers: [], activeAsrProviderId: "" })).toThrowError(
      expect.objectContaining({
        code: "asr-skip",
        reason: "no-asr-config",
        message: "没有激活的语音识别平台"
      })
    );
  });

  it("列表非空但 activeAsrProviderId 为空或悬空：自动回退到列表首项", () => {
    expect(resolveAsrProvider({ ...RUNTIME_CONFIG_BASE, activeAsrProviderId: "" })).toMatchObject({
      id: "p1",
      apiKey: "sk-test"
    });
    expect(resolveAsrProvider({ ...RUNTIME_CONFIG_BASE, activeAsrProviderId: "ghost" })).toMatchObject({
      id: "p1",
      apiKey: "sk-test"
    });
  });

  it("配置齐全：不抛错，provider 附 Key 与生效语言", () => {
    const provider = resolveAsrProvider(RUNTIME_CONFIG_BASE);

    expect(provider).toMatchObject({
      id: "p1",
      type: "openai-transcriptions",
      apiKey: "sk-test",
      language: "auto"
    });
  });
});

function createSkipHostContext() {
  resetOffscreenState();
  let host = installMinimalChromeHost({
    preserveExisting: true,
    onConnect: true,
    replyStyle: "both",
    replies: { "get-debug-log-gate": { ok: true } }
  });

  function swapHost(options: MinimalChromeHostOptions) {
    const registered = host.onConnectListeners.slice();
    host = installMinimalChromeHost({
      preserveExisting: true,
      onConnect: true,
      ...options
    });
    host.onConnectListeners.push(...registered);
  }

  return {
    getHost: () => host,
    swapHost
  };
}

describe("handleAsrDecodeTask 错误消息携带 reason（port 透传契约）", () => {
  let ctx: ReturnType<typeof createSkipHostContext>;

  function refuseSendMessage(): never {
    throw new Error("Extension context invalidated");
  }

  beforeEach(() => {
    ctx = createSkipHostContext();
  });

  it("asr-skip 的结构化 reason 随 { type: error } 消息 postMessage 回页面", async () => {
    await loadOffscreen();
    ctx.swapHost({
      replies: {
        "get-asr-runtime-config": { ok: true },
        "offscreen-request-close": { ok: true }
      }
    });
    const { port, taskListener } = connectAsrPort(ctx.getHost());

    taskListener({ action: "asr-decode", task: { audioUrl: "https://x/a.m4s" } });

    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(1));
    expect(port.postMessage.mock.calls[0][0]).toEqual({
      type: "error",
      error: "没有激活的语音识别平台",
      code: "asr-skip",
      reason: "no-asr-config"
    });
  });

  it("config 消息失败/超时的 asr-skip 不带 reason（未知，页面归 null）", async () => {
    await loadOffscreen();
    ctx.swapHost({
      replyStyle: "both",
      replies: {
        "get-debug-log-gate": refuseSendMessage,
        "get-asr-runtime-config": refuseSendMessage,
        "offscreen-request-close": refuseSendMessage
      }
    });
    const { port, taskListener } = connectAsrPort(ctx.getHost());

    taskListener({ action: "asr-decode", task: { audioUrl: "https://x/a.m4s" } });

    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(1));
    const payload = port.postMessage.mock.calls[0][0];
    expect(payload.type).toBe("error");
    expect(payload.code).toBe("asr-skip");
    expect(payload.reason).toBeUndefined();
    expect(payload.kind).toBeUndefined();
  });
});

describe("handleAsrDecodeTask 管线级失败携带 kind（port 透传契约）", () => {
  let ctx: ReturnType<typeof createSkipHostContext>;

  beforeEach(() => {
    ctx = createSkipHostContext();
  });

  async function runWithDownloadFailure() {
    await loadOffscreen();
    ctx.swapHost({
      replies: {
        "get-asr-runtime-config": RUNTIME_CONFIG_RESPONSE,
        "check-provider-origin": { granted: true },
        "offscreen-request-close": { ok: true }
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    const { port, taskListener } = connectAsrPort(ctx.getHost());
    taskListener({ action: "asr-decode", task: { audioUrl: "https://x/a.m4s" } });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(1));
    return port.postMessage.mock.calls[0][0] as Record<string, unknown>;
  }

  it("音轨下载失败（媒体来源）→ kind=asr-media", async () => {
    const payload = await runWithDownloadFailure();

    expect(payload.type).toBe("error");
    expect(payload.error).toBe("音频下载失败");
    expect(payload.kind).toBe("asr-media");
  });
});

describe("YouTube 推流解码模式（sourceMode=stream）与手动触发（trigger=manual）", () => {
  let ctx: ReturnType<typeof createSkipHostContext>;

  beforeEach(() => {
    ctx = createSkipHostContext();
  });

  function writeU32(arr: Uint8Array, p: number, value: number): void {
    arr[p] = (value >>> 24) & 0xff;
    arr[p + 1] = (value >>> 16) & 0xff;
    arr[p + 2] = (value >>> 8) & 0xff;
    arr[p + 3] = value & 0xff;
  }

  function makeBox(type: string, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(8 + payload.length);
    writeU32(out, 0, out.length);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(payload, 8);
    return out;
  }

  function buildStreamFixtures(): { init: Uint8Array; seg: Uint8Array } {
    const ftyp = makeBox("ftyp", new Uint8Array(12));
    const trun = new Uint8Array(8 + 8);
    const dv = new DataView(trun.buffer);
    dv.setUint32(0, 0x000200);
    dv.setUint32(4, 2);
    dv.setUint32(8, 16);
    dv.setUint32(12, 16);
    const moof = makeBox("moof", makeBox("traf", makeBox("trun", trun)));
    const mdat = makeBox("mdat", new Uint8Array(32).fill(0x2a));
    const seg = new Uint8Array(moof.length + mdat.length);
    seg.set(moof, 0);
    seg.set(mdat, moof.length);
    return { init: ftyp, seg };
  }

  it("resolveAsrProvider：manual=true 时绕过 asrAutoFallback=false 门禁", () => {
    const cfg: AsrRuntimeConfig = { ...RUNTIME_CONFIG_BASE, asrAutoFallback: false };
    expect(() => resolveAsrProvider(cfg)).toThrow(/未开启/);
    expect(resolveAsrProvider(cfg, { manual: true }).id).toBe("p1");
  });

  it("stream 模式完整握手：stream-ready → init/chunk + stream-ack → end → done", async () => {
    await loadOffscreen();
    ctx.swapHost({
      replies: {
        "get-asr-runtime-config": { ...RUNTIME_CONFIG_RESPONSE, asrAutoFallback: false },
        "check-provider-origin": { granted: true },
        "offscreen-request-close": { ok: true }
      }
    });

    const mono = () => {
      const data = new Float32Array(16_000 * 5);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.sin(i / 50) * 0.4;
      return data;
    };
    class FakeAudioContext {
      async decodeAudioData() {
        return { duration: 5, getChannelData: mono };
      }
      close() {}
    }
    class FakeOfflineAudioContext {
      destination = {};
      createBufferSource() {
        return { buffer: null, connect() {}, start() {} };
      }
      async startRendering() {
        return { getChannelData: mono };
      }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ text: "hello youtube", segments: [{ start: 0, end: 2, text: "hello youtube" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );

    const { port, emitPortMessage } = connectAsrPort(ctx.getHost());
    emitPortMessage({
      action: "asr-decode",
      task: { sourceMode: "stream", trigger: "manual" }
    });

    await vi.waitFor(() =>
      expect(port.postMessage.mock.calls.some(([m]) => m?.type === "stream-ready")).toBe(true)
    );

    const { init, seg } = buildStreamFixtures();
    emitPortMessage({ action: "asr-stream-init", dataBase64: bytesToBase64(init) });
    emitPortMessage({ action: "asr-stream-chunk", seq: 1, dataBase64: bytesToBase64(seg) });
    await vi.waitFor(() =>
      expect(port.postMessage.mock.calls.some(([m]) => m?.type === "stream-ack" && m?.seq === 1)).toBe(true)
    );
    emitPortMessage({ action: "asr-stream-end" });

    await vi.waitFor(() =>
      expect(port.postMessage.mock.calls.some(([m]) => m?.type === "done")).toBe(true)
    );
    const doneMsg = port.postMessage.mock.calls.find(([m]) => m?.type === "done")![0];
    expect(doneMsg.totalChunks).toBe(1);
    expect(doneMsg.failedChunks).toBe(0);
  });
});
