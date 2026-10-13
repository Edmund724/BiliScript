// tests/asr/provider-models.test.ts
// asr/provider-models.ts 的 listAsrModels（ASR 模型名下拉的数据源）契约：
// - GET `${baseUrl}/models?sub_type=speech-to-text`（SiliconFlow 语音模型过滤参数）；
// - 传输经 SW 代发（core/provider-http.ts 的 providerFetchViaBackground，与 AI 探针 /
//   搜索执行器同款）：设置面板跑在 content script，直连 fetch 服从网页 CORS，带
//   Authorization 的预检失败即「Failed to fetch」，而真转写在 offscreen（不受网页
//   CORS 约束）——同一平台「模型列表拉不到、真转写正常」的失败面由此消除；
// - host 权限判定单源在 SW 侧代发通道（provider-http.ts 的 handleProviderHttpRequest），
//   未授权回 HOST_PERMISSION_HINT；页面侧不再自查（content 无 chrome.permissions，
//   那道门恒放行），调用方 model-picker.ts 已先在用户手势上申请；
// - Key 代查：优先用户重输 apiKey，否则按 providerId 读已存 Key。
// 代发通道本身（URL 校验 / 权限预检 / Response 合成 / 超时）在 tests/core/provider-http.test.ts。

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

// provider-http 消息总线：记录每次出向载荷，按 responder 回包（缺省一条 OpenAI
// 兼容形状的模型列表）。
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
    // Headers 归一：代发载荷里的键统一小写（浏览器 fetch 语义同款）
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

  it("HTTP 非 2xx → 回状态码与正文前 200 字", async () => {
    installProxyBus(() => ({ ok: true, status: 401, body: "x".repeat(500) }));
    const { listAsrModels } = await loadModule();

    const resp = await listAsrModels({ baseUrl: "https://api.example.com/v1", apiKey: "sk-1" });

    expect(resp).toEqual({ ok: false, error: `HTTP 401: ${"x".repeat(200)}` });
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