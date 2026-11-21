import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSendMessageHost } from "../helpers/chrome-runtime-host.js";

type ProxyRequest = {
  type: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};
type ProxyResponse = { ok: boolean; status?: number; body?: string; error?: string };
type ProxyResponder = (message: unknown) => ProxyResponse | undefined;

let sent: ProxyRequest[];
let responder: ProxyResponder;
let fetchMock: ReturnType<typeof vi.fn>;
let containsMock: ReturnType<typeof vi.fn>;

async function loadModule() {
  return import("../../extension/asr/provider-models.js");
}

function installProxyBus(next?: ProxyResponder) {
  responder = next || (() => ({ ok: true, status: 200, body: JSON.stringify({ data: [{ id: "m1" }] }) }));
  const host = installSendMessageHost<ProxyRequest>({ "provider-http": (message: unknown) => responder(message) });
  sent = host.sent;
}

function lastRequest() {
  return sent[sent.length - 1];
}

beforeEach(() => {
  vi.resetModules();
  resetModuleState();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  containsMock = vi.fn(async () => true);
  vi.stubGlobal("chrome", { ...globalThis.chrome, permissions: { contains: containsMock } });
  installProxyBus();
});

describe("listAsrModels", () => {
  it("已授权 → 经 SW 代发 GET /models?sub_type=speech-to-text 并回模型列表", async () => {
    installProxyBus(() => ({
      ok: true,
      status: 200,
      body: JSON.stringify({ data: [{ id: "FunAudioLLM/SenseVoiceSmall" }, { id: "m2" }] })
    }));
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKey: "sk-1"
    });

    expect(resp).toEqual({ ok: true, models: ["FunAudioLLM/SenseVoiceSmall", "m2"] });
    expect(sent).toHaveLength(1);
    const request = lastRequest();
    expect(request.type).toBe("provider-http");
    expect(request.url).toBe("https://api.siliconflow.cn/v1/models?sub_type=speech-to-text");
    expect(request.method).toBe("GET");
    expect(request.body).toBeUndefined();
    expect(request.headers).toEqual({ accept: "application/json", authorization: "Bearer sk-1" });
  });

  it("页面侧不发本地 fetch、不自查 chrome.permissions（门与传输都在 SW 侧）", async () => {
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({ baseUrl: "https://api.siliconflow.cn/v1", apiKey: "sk-1" });

    expect(resp.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(containsMock).not.toHaveBeenCalled();
  });

  it("未填 apiKey 时按 providerId 读已存 Key", async () => {
    globalThis.chrome.storage.local.get = vi.fn(async () => ({ asrProviderKeys: { asr1: "sk-saved" } }));
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({ baseUrl: "https://api.siliconflow.cn/v1", providerId: "asr1" });

    expect(resp.ok).toBe(true);
    expect(lastRequest().headers.authorization).toBe("Bearer sk-saved");
  });

  it("本地 Whisper 无 Key → 裸 GET 不带 Authorization", async () => {
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({ baseUrl: "http://localhost:8000/v1" });

    expect(resp).toEqual({ ok: true, models: ["m1"] });
    expect(lastRequest().headers.authorization).toBeUndefined();
  });

  it("SW 侧判未授权 → 回可操作提示（原文透传，不二次包装）", async () => {
    installProxyBus(() => ({ ok: false, error: "该平台域名未授权，请在保存时允许权限" }));
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({ baseUrl: "https://api.siliconflow.cn/v1", apiKey: "sk-1" });

    expect(resp).toEqual({ ok: false, error: "该平台域名未授权，请在保存时允许权限" });
  });

  it("HTTP 非 2xx 且非 JSON → 回状态码与正文前 200 字", async () => {
    installProxyBus(() => ({ ok: true, status: 502, body: "x".repeat(500) }));
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({ baseUrl: "https://api.example.com/v1", apiKey: "sk-1" });

    expect(resp).toEqual({ ok: false, error: `HTTP 502: ${"x".repeat(200)}` });
  });

  it("HTTP 401 / 403 → 转译为 API Key 无效或未授权", async () => {
    installProxyBus(() => ({ ok: true, status: 401, body: JSON.stringify({ code: 30014, message: "Token is invalid." }) }));
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({ baseUrl: "https://api.example.com/v1", apiKey: "sk-1" });

    expect(resp).toEqual({ ok: false, error: "HTTP 401: API Key 无效或未授权" });
  });

  it("HTTP 非 2xx JSON 错误带 message → 提取 message", async () => {
    installProxyBus(() => ({ ok: true, status: 500, body: JSON.stringify({ message: "Internal error" }) }));
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({ baseUrl: "https://api.example.com/v1", apiKey: "sk-1" });

    expect(resp).toEqual({ ok: false, error: "HTTP 500: Internal error" });
  });

  it("响应体非 JSON → 无法解析模型列表", async () => {
    installProxyBus(() => ({ ok: true, status: 200, body: "<html>login</html>" }));
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({ baseUrl: "https://api.example.com/v1", apiKey: "sk-1" });

    expect(resp).toEqual({ ok: false, error: "无法解析模型列表" });
  });

  it("data 非数组 → ok:true 但模型列表为空", async () => {
    installProxyBus(() => ({ ok: true, status: 200, body: JSON.stringify({ object: "list" }) }));
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({ baseUrl: "https://api.example.com/v1", apiKey: "sk-1" });

    expect(resp).toEqual({ ok: true, models: [] });
  });

  it("通道异常（SW 未起 / 消息抛错）→ 回错误文案，不吞异常", async () => {
    chrome.runtime.sendMessage = vi.fn(() => {
      throw new Error("Could not establish connection");
    }) as unknown as typeof chrome.runtime.sendMessage;
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({ baseUrl: "https://api.example.com/v1", apiKey: "sk-1" });

    expect(resp).toEqual({ ok: false, error: "Could not establish connection" });
  });

  it("baseUrl 为空 → 直接提示，不发代发请求", async () => {
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({ baseUrl: "" });

    expect(resp).toEqual({ ok: false, error: "请先填写 baseUrl" });
    expect(sent).toHaveLength(0);
  });
});