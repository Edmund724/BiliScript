import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { HOST_PERMISSION_HINT } from "../../extension/core/host-permissions.js";
import { installMinimalChromeHost, type MinimalChromeHost } from "../helpers/chrome-runtime-host.js";

const BASE_URL = "https://api.siliconflow.cn/v1";
const MODEL = "XingChenAGI/XingChenASR-V3.2";

let host: MinimalChromeHost;
let fetchMock: ReturnType<typeof vi.fn>;
let requests: Array<{ url: string; init: any }>;
let platformStatus = 200;
let platformBody: unknown = { text: "" };
let checkReply: unknown = { granted: true };
let messages: string[] = [];

function installHost() {
  host = installMinimalChromeHost({
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
}

beforeEach(() => {
  resetModuleState();
  requests = [];
  messages = [];
  platformStatus = 200;
  platformBody = { text: "" };
  checkReply = { granted: true };
  installHost();
  fetchMock = vi.fn(async (url: unknown, init?: unknown) => {
    requests.push({ url: String(url), init });
    return {
      ok: platformStatus >= 200 && platformStatus < 300,
      status: platformStatus,
      json: async () => platformBody,
      text: async () => JSON.stringify(platformBody)
    };
  });
  vi.stubGlobal("fetch", fetchMock);
});

async function loadOffscreen() {
  return import("../../extension/entry/offscreen.js");
}

function connectAsrPort() {
  const listener = host.onConnectListeners.at(-1)!;
  expect(listener, "offscreen.js 应已在模块加载时注册 onConnect 监听").toBeTruthy();
  const listeners = new Set<(message: unknown) => void>();
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
  listener(port);
  return { port, taskListener: [...listeners][0] };
}

const PROBE_TASK = {
  type: "openai-transcriptions",
  baseUrl: BASE_URL,
  model: MODEL,
  apiKey: "sk-draft",
  language: "auto"
};

async function runProbe(task: Record<string, unknown> = PROBE_TASK) {
  const { port, taskListener } = connectAsrPort();
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

describe("探针走真链路：host 权限预检与实际转写同源", () => {
  it("未授权（SW 回 { granted: false }）→ 同一道可操作文案，一个请求都不发", async () => {
    await loadOffscreen();
    checkReply = { granted: false };

    const { payload } = await runProbe();

    expect(payload).toEqual({
      type: "probe-result",
      ok: false,
      error: HOST_PERMISSION_HINT,
      kind: "no-asr-config"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("无回包（旧 SW 不认识这条消息）→ fail-open 放行，探针照常打请求", async () => {
    await loadOffscreen();
    checkReply = undefined;

    const { payload } = await runProbe();

    expect(payload).toMatchObject({ type: "probe-result", ok: true });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("探针不读运行时配置：Key 随任务过来，不经 get-asr-runtime-config", async () => {
    await loadOffscreen();

    await runProbe();

    expect(messages).not.toContain("get-asr-runtime-config");
  });
});

describe("探针走真链路：请求构造与实际转写逐字同源", () => {
  it("已授权 → 打真适配器：同 URL / 同 Authorization / 同 FormData 字段（2xx 无 segments 不重复上传）", async () => {
    await loadOffscreen();

    const { payload } = await runProbe();

    expect(payload).toEqual({ type: "probe-result", ok: true });
    expect(requests).toHaveLength(1);
    const { url, init } = requests[0];
    expect(url).toBe(`${BASE_URL}/audio/transcriptions`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-draft");
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers["Content-Type"]).toBeUndefined();
    expect((init.body as FormData).get("model")).toBe(MODEL);
    expect((init.body as FormData).get("response_format")).toBe("verbose_json");
  });

  it("语言档位 en → ?language=english 由适配器的 URL 构造给出（探针不再自抄一份）", async () => {
    await loadOffscreen();

    await runProbe({ ...PROBE_TASK, language: "en" });

    expect(requests[0].url).toBe(`${BASE_URL}/audio/transcriptions?language=english`);
  });

  it("平台 401 → 文案 / kind / status 与实际转写同一串，且不再发第二次请求", async () => {
    await loadOffscreen();
    platformStatus = 401;
    platformBody = { code: 30014, data: null, message: "Token is invalid." };

    const { payload } = await runProbe();

    expect(payload.type).toBe("probe-result");
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("HTTP 401");
    expect(payload.error).toContain("Token is invalid");
    expect(payload.kind).toBe("asr-auth");
    expect(payload.status).toBe(401);
    expect(requests).toHaveLength(1);
  });
});

describe("探针走真链路：本地校验与端口簿记", () => {
  it("baseUrl / 模型名缺失 → 各自可读文案，不发请求", async () => {
    await loadOffscreen();

    const noBaseUrl = await runProbe({ ...PROBE_TASK, baseUrl: "" });
    const noModel = await runProbe({ ...PROBE_TASK, model: "" });

    expect(noBaseUrl.payload).toEqual({ type: "probe-result", ok: false, error: "请填写 baseUrl" });
    expect(noModel.payload).toEqual({ type: "probe-result", ok: false, error: "请填写模型名" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("类型不支持 → 可读文案，不发请求", async () => {
    await loadOffscreen();

    const { payload } = await runProbe({ ...PROBE_TASK, type: "whisper-cli" });

    expect(payload).toEqual({
      type: "probe-result",
      ok: false,
      error: "暂不支持的平台类型：whisper-cli"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("探针终态照走端口簿记：回执发完后在短宽限窗口到期触发文档自关判定", async () => {
    vi.useFakeTimers();
    try {
      await loadOffscreen();
      const { DEFAULT_ASR_IDLE_GRACE_MS } = await import("../../extension/entry/offscreen-lifecycle.js");

      await runProbe();
      expect(messages).not.toContain("offscreen-request-close");

      await vi.advanceTimersByTimeAsync(DEFAULT_ASR_IDLE_GRACE_MS);
      expect(messages).toContain("offscreen-request-close");
    } finally {
      vi.useRealTimers();
    }
  });
});
