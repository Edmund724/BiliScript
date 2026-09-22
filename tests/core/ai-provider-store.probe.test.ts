// AI 连通性探针测试（候选 04：探针移至 ai/provider-test.js）。
// 覆盖 testAiConnection / probeAiChatCompletion 的 { ok, error } 形状契约：
// 输入预检、probe 请求负载（token 上限 1 + ping，参数名随模型类映射：reasoning
// 系 max_completion_tokens、其余 max_tokens）、成功判定 = response.ok、
// HTTP / 连接错误的文案包装（复用共享 helper，AI/ASR 逐字一致）。
//
// 传输层经 SW 代发（core/provider-http.js 的 providerFetchViaBackground）：
// content script 直连 fetch 服从网页 CORS，平台网关不支持浏览器预检时一律
// 「Failed to fetch」（模型列表能跑通只因它在 SW 里发）。故此处断言的是
// provider-http 出向载荷，而不是本地 fetch 调用；代发通道本身（URL 校验 /
// host 权限预检 / Response 合成 / 超时）在 tests/core/provider-http.test.ts。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

// provider-http 出向载荷（探针只发一次：url/method/headers/body）
type ProxyRequest = {
  type: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};
type ProxyResponse = { ok: boolean; status?: number; body?: string; error?: string };
type ProxyResponder = (message: unknown) => ProxyResponse | undefined;

let sent: ProxyRequest[];
let responder: ProxyResponder;

async function loadModule() {
  return import("../../extension/ai/provider-test.js");
}

// provider-http 消息总线：记录每次出向载荷，按 responder 回包（缺省 200 空体）。
function installProxyBus(next?: ProxyResponder) {
  responder = next || (() => ({ ok: true, status: 200, body: "" }));
  sent = [];
  chrome.runtime.sendMessage = vi.fn((message: unknown, callback?: (response?: unknown) => void) => {
    sent.push(message as ProxyRequest);
    callback?.(responder(message));
    return undefined;
  }) as unknown as typeof chrome.runtime.sendMessage;
}

// 最近一次代发请求的载荷（探针只发一次：url/method/headers/body）
function lastRequest() {
  return sent[sent.length - 1];
}

function stubChrome(overrides = {}) {
  const previous = globalThis.chrome;
  vi.stubGlobal("chrome", { ...previous, ...overrides });
  installProxyBus(responder);
}

beforeEach(() => {
  resetModuleState();
  installProxyBus();
  stubChrome({ permissions: { contains: vi.fn(async () => true) } });
});

describe("testAiConnection 输入预检", () => {
  it("缺 baseUrl / 缺模型名 → { ok:false, error } 且不发代发请求", async () => {
    const { testAiConnection } = await loadModule();

    const noBaseUrl = await testAiConnection({ baseUrl: "", apiKey: "sk", model: "m" });
    expect(noBaseUrl).toEqual({ ok: false, error: "请填写 baseUrl" });

    const noModel = await testAiConnection({ baseUrl: "https://x", apiKey: "sk", model: "  " });
    expect(noModel).toEqual({ ok: false, error: "请填写模型名" });

    expect(sent).toHaveLength(0);
  });

  it("baseUrl trim + 去尾斜杠后交给探针", async () => {
    const { testAiConnection } = await loadModule();

    const resp = await testAiConnection({ baseUrl: " https://api.example.com/v1// ", apiKey: "sk-1", model: "gpt" });

    expect(resp).toEqual({ ok: true });
    expect(lastRequest().url).toBe("https://api.example.com/v1/chat/completions");
  });
});

describe("probeAiChatCompletion { ok, error } 形状", () => {
  it("HTTP 200 即通过；请求发到 /chat/completions，负载 max_tokens:1 + ping，带 Accept 头", async () => {
    const { probeAiChatCompletion } = await loadModule();

    const resp = await probeAiChatCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-1",
      model: "gpt"
    });

    expect(resp).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    const request = lastRequest();
    expect(request.type).toBe("provider-http");
    expect(request.url).toBe("https://api.example.com/v1/chat/completions");
    expect(request.method).toBe("POST");
    // 探针省略档位 ⇒ 回落 off ⇒ 经 thinking-profiles 查表：未知平台×模型无事实
    // → 不发任何思考字段（旧霰弹枪双发 thinking+enable_thinking 会令 OpenAI 探针必 400）
    expect(JSON.parse(request.body)).toEqual({
      model: "gpt",
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      max_tokens: 1
    });
    // Headers 归一化：代发载荷里的键统一小写（浏览器 fetch 语义同款）
    expect(request.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      authorization: "Bearer sk-1"
    });
  });

  it("OpenAI + reasoning 模型探针：off 查表落 reasoning_effort:none，token 上限写 max_completion_tokens:1（reasoning 系不认 max_tokens）", async () => {
    const { probeAiChatCompletion } = await loadModule();

    const resp = await probeAiChatCompletion({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-1",
      model: "gpt-5.1"
    });

    expect(resp).toEqual({ ok: true });
    expect(JSON.parse(lastRequest().body)).toEqual({
      model: "gpt-5.1",
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      max_completion_tokens: 1,
      reasoning_effort: "none"
    });
  });

  it("无 apiKey 时不出 Authorization 头", async () => {
    const { probeAiChatCompletion } = await loadModule();

    await probeAiChatCompletion({ baseUrl: "https://x", apiKey: "", model: "m" });

    expect(lastRequest().headers.authorization).toBeUndefined();
  });

  it("非 2xx → { ok:false, error: 'HTTP <status>: [协议名] <detail>' }（错误体经 adapter 提取，截前 200 字符）", async () => {
    installProxyBus(() => ({ ok: true, status: 401, body: JSON.stringify({ error: { message: "bad key" } }) }));
    const { probeAiChatCompletion } = await loadModule();

    const resp = await probeAiChatCompletion({ baseUrl: "https://x", apiKey: "sk", model: "m" });

    expect(resp.ok).toBe(false);
    // OpenAI 错误信封（error.message）经 adapter 提取，core 加协议名前缀。
    expect(resp.error).toBe("HTTP 401: [openai] bad key");
    expect(sent).toHaveLength(1); // 探针不重试
  });

  it("代发失败（网络层）→ { ok:false, error: '无法连接：<原始信息>' }（与 ASR 探针文案逐字一致）", async () => {
    installProxyBus(() => ({ ok: false, error: "network down" }));
    const { probeAiChatCompletion } = await loadModule();

    const resp = await probeAiChatCompletion({ baseUrl: "https://x", apiKey: "sk", model: "m" });

    expect(resp).toEqual({ ok: false, error: "无法连接：network down" });
  });

  it("HTTP 400 命中 context-length 溢出文案 → 仍按 HTTP 错误包装（不丢状态码语义）", async () => {
    installProxyBus(() => ({ ok: true, status: 400, body: "context_length_exceeded" }));
    const { probeAiChatCompletion } = await loadModule();

    const resp = await probeAiChatCompletion({ baseUrl: "https://x", apiKey: "sk", model: "m" });

    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("HTTP 400");
    expect(resp.error).toContain("context_length_exceeded");
  });

  it("接缝守卫（缺 model 直调探针）→ { ok:false, error: '模型未配置' }，不发代发请求", async () => {
    const { probeAiChatCompletion } = await loadModule();

    const resp = await probeAiChatCompletion({ baseUrl: "https://x", apiKey: "sk", model: "" });

    expect(resp).toEqual({ ok: false, error: "模型未配置" });
    expect(sent).toHaveLength(0);
  });
});

// testAiProviderConnection = 设置面板「测试」按钮入口，契约继承原 SW 侧
// ai-providers-test 处理器的输入装配（provider-handlers.js pickFlatTestProvider）：
// 直输 Key 优先，否则按 providerId 从 chrome.storage.local 代查，都没有为空串。
describe("testAiProviderConnection Key 代查", () => {
  const storageGet = () => vi.mocked(globalThis.chrome.storage.local.get);

  it("直输 Key 优先：已存 Key 不顶替直输值，Authorization 用重输值", async () => {
    storageGet().mockReset();
    storageGet().mockResolvedValue({ aiProviderKeys: { p1: "sk-saved" } });
    const { testAiProviderConnection } = await loadModule();

    const resp = await testAiProviderConnection({
      providerId: "p1",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-direct",
      model: "gpt"
    });

    expect(resp).toEqual({ ok: true });
    expect(lastRequest().headers.authorization).toBe("Bearer sk-direct");
  });

  it("未重输 Key → 按 providerId 代查已存 Key", async () => {
    storageGet().mockReset();
    storageGet().mockResolvedValue({ aiProviderKeys: { p1: "sk-saved" } });
    const { testAiProviderConnection } = await loadModule();

    const resp = await testAiProviderConnection({
      providerId: "p1",
      baseUrl: "https://api.example.com/v1",
      apiKey: "",
      model: "gpt"
    });

    expect(resp).toEqual({ ok: true });
    expect(storageGet()).toHaveBeenCalledWith(["aiProviderKeys"]);
    expect(lastRequest().headers.authorization).toBe("Bearer sk-saved");
  });

  it("未重输 Key 且无 providerId → 空 Key 探针（无 Authorization 头）", async () => {
    storageGet().mockReset();
    const { testAiProviderConnection } = await loadModule();

    await testAiProviderConnection({ providerId: "", baseUrl: "https://x", apiKey: "  ", model: "m" });

    expect(storageGet()).not.toHaveBeenCalled();
    expect(lastRequest().headers.authorization).toBeUndefined();
  });

  it("已存 Key 读取失败 → 容错按空 Key 继续探针（不吞探针结果）", async () => {
    storageGet().mockReset();
    storageGet().mockRejectedValue(new Error("storage down"));
    const { testAiProviderConnection } = await loadModule();

    const resp = await testAiProviderConnection({
      providerId: "p1",
      baseUrl: "https://x",
      apiKey: "",
      model: "m"
    });

    expect(resp).toEqual({ ok: true });
    expect(lastRequest().headers.authorization).toBeUndefined();
  });
});

// S2 收紧 host_permissions 后：探针在发起请求前先确认该平台域名已获 host
// 权限——缺权限时代发请求也只会以网络错误失败，看不出真正原因，因此权限缺失
// 直接短路成可操作提示（不消耗一次注定失败的往返）。
describe("testAiProviderConnection 的 host 权限预检", () => {
  it("域名未授权 → 返回可操作提示，且不发代发请求", async () => {
    stubChrome({ permissions: { contains: vi.fn(async () => false) } });
    const { testAiProviderConnection } = await loadModule();

    const resp = await testAiProviderConnection({
      providerId: "p1",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-1",
      model: "gpt"
    });

    expect(resp).toEqual({ ok: false, error: "该平台域名未授权，请在保存时允许权限" });
    expect(globalThis.chrome.permissions.contains).toHaveBeenCalledWith({
      origins: ["https://api.openai.com/*"]
    });
    expect(sent).toHaveLength(0);
  });

  it("已授权时探针错误原样返回（HTTP 401 不被权限文案覆盖）", async () => {
    stubChrome({ permissions: { contains: vi.fn(async () => true) } });
    installProxyBus(() => ({ ok: true, status: 401, body: JSON.stringify({ error: { message: "bad key" } }) }));
    const { testAiProviderConnection } = await loadModule();

    const resp = await testAiProviderConnection({
      providerId: "p1",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-1",
      model: "gpt"
    });

    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("HTTP 401");
    expect(sent).toHaveLength(1);
  });

  it("不持有 chrome.permissions 实现时按已授权处理（不阻塞既有探针行为）", async () => {
    stubChrome({ permissions: undefined });
    const { testAiProviderConnection } = await loadModule();

    const resp = await testAiProviderConnection({
      providerId: "p1",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-1",
      model: "gpt"
    });

    expect(resp).toEqual({ ok: true });
  });
});

// presetId 穿线（02 号票，探针链）：testAiProviderConnection 按 providerId 从
// 已存列表读记录的 presetId（preset 词表键，非记录 id）随探针请求下发，baseUrl
// host 推断退为兜底；旧记录（无 presetId 字段）经 normalize 落 "custom" → 回落
// host/模型名识别，与 01 落地行为一致。
describe("testAiProviderConnection presetId 穿线", () => {
  // 播种 chrome.storage.sync 的已存列表（loadProviders 读取 + normalize 的入口）
  function stubProviderStorage(list: unknown[]) {
    stubChrome({
      permissions: { contains: vi.fn(async () => true) },
      storage: {
        sync: { get: vi.fn(async () => ({ aiProviders: list })), set: vi.fn(async () => {}) },
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) }
      }
    });
  }

  it("记录的 presetId 随探针下发：host 反代无规则也按 preset 平台规则出思考字段", async () => {
    stubProviderStorage([{
      id: "p1",
      presetId: "ollama",
      name: "本地 Ollama",
      baseUrl: "https://thinking-proxy.example.com/v1",
      model: "llama3.2",
      requiresKey: false,
      enabled: true
    }]);
    const { testAiProviderConnection } = await loadModule();

    const resp = await testAiProviderConnection({
      providerId: "p1",
      baseUrl: "https://thinking-proxy.example.com/v1",
      model: "llama3.2"
    });

    expect(resp).toEqual({ ok: true });
    // 探针省略档位 ⇒ off ⇒ ollama unknownClass（effort 词汇）→ reasoning_effort:"none"；
    // 穿线断裂（host 无规则 + llama3.2 不在模式表）则落 unknown、字段全缺
    expect(JSON.parse(lastRequest().body)).toMatchObject({ reasoning_effort: "none" });
  });

  it("旧记录无 presetId 字段 → normalize 落 custom → 回落 host 推断（与 01 行为一致）", async () => {
    stubProviderStorage([{
      id: "p1",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.1",
      requiresKey: true,
      enabled: true
    }]);
    const { testAiProviderConnection } = await loadModule();

    const resp = await testAiProviderConnection({
      providerId: "p1",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-1",
      model: "gpt-5.1"
    });

    expect(resp).toEqual({ ok: true });
    // openai host 兜底命中 → gpt-5.1 off = effort none（01 golden 锁定）
    expect(JSON.parse(lastRequest().body)).toMatchObject({ reasoning_effort: "none" });
  });
});

// 协议穿线（multi-protocol-ai 第五部分）：探针只调度——protocol 随 provider 透传
// chatCompletion，端点/鉴权头/请求体由 adapter 自然切换；本模块无任何协议分支
//（原手写 Authorization: Bearer 注入已删，鉴权归 adapter.authHeaders）。
describe("探针协议调度（multi-protocol-ai）", () => {
  it("protocol:anthropic → 端点 <baseUrl>/v1/messages、x-api-key 鉴权、无 Authorization", async () => {
    const { probeAiChatCompletion } = await loadModule();

    // anthropic endpoint 自补 /v1 路径：baseUrl 不带 /v1（如 https://api.anthropic.com）
    const resp = await probeAiChatCompletion({
      baseUrl: "https://api.example.com",
      apiKey: "sk-ant",
      model: "claude-sonnet-4-5",
      protocol: "anthropic"
    });

    expect(resp).toEqual({ ok: true });
    const request = lastRequest();
    expect(request.url).toBe("https://api.example.com/v1/messages");
    expect(request.headers["x-api-key"]).toBe("sk-ant");
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request.headers.authorization).toBeUndefined();
    // max_tokens 必填：probe 特化 maxTokens=1 由 core 代劳
    expect(JSON.parse(request.body)).toMatchObject({ model: "claude-sonnet-4-5", max_tokens: 1 });
  });

  it("protocol:responses → 端点 /v1/responses、Bearer 鉴权（负载内联 tools 词表无关探针）", async () => {
    const { probeAiChatCompletion } = await loadModule();

    const resp = await probeAiChatCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-resp",
      model: "gpt-5.1",
      protocol: "responses"
    });

    expect(resp).toEqual({ ok: true });
    const request = lastRequest();
    expect(request.url).toBe("https://api.example.com/v1/responses");
    expect(request.headers.authorization).toBe("Bearer sk-resp");
    expect(JSON.parse(request.body)).toMatchObject({ model: "gpt-5.1", store: false });
  });

  it("未知 protocol 值 → resolveAdapter 兜底 openai（/chat/completions，行为零变化）", async () => {
    const { probeAiChatCompletion } = await loadModule();

    const resp = await probeAiChatCompletion({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-1",
      model: "gpt",
      protocol: "gemini"
    });

    expect(resp).toEqual({ ok: true });
    expect(lastRequest().url).toBe("https://api.example.com/v1/chat/completions");
    expect(lastRequest().headers.authorization).toBe("Bearer sk-1");
  });

  it("缺 protocol（存量记录）→ openai：Authorization 仍由 adapter 提供（Bearer sk-1）", async () => {
    const { probeAiChatCompletion } = await loadModule();

    const resp = await probeAiChatCompletion({ baseUrl: "https://x/v1", apiKey: "sk-1", model: "gpt" });

    expect(resp).toEqual({ ok: true });
    expect(lastRequest().headers.authorization).toBe("Bearer sk-1");
  });

  it("testAiProviderConnection：未直传协议 → 按 providerId 代查已存记录的 protocol", async () => {
    stubChrome({
      permissions: { contains: vi.fn(async () => true) },
      storage: {
        sync: {
          get: vi.fn(async () => ({
            aiProviders: [{
              id: "p1",
              presetId: "custom",
              name: "Claude",
              baseUrl: "https://api.example.com",
              model: "claude-sonnet-4-5",
              requiresKey: true,
              enabled: true,
              protocol: "anthropic"
            }]
          })),
          set: vi.fn(async () => {})
        },
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) }
      }
    });
    const { testAiProviderConnection } = await loadModule();

    const resp = await testAiProviderConnection({
      providerId: "p1",
      baseUrl: "https://api.example.com",
      apiKey: "sk-ant",
      model: "claude-sonnet-4-5"
    });

    expect(resp).toEqual({ ok: true });
    expect(lastRequest().url).toBe("https://api.example.com/v1/messages");
  });

  it("testAiProviderConnection：直传协议优先于已存记录（表单改了协议未保存，探针按表单走）", async () => {
    stubChrome({
      permissions: { contains: vi.fn(async () => true) },
      storage: {
        sync: {
          get: vi.fn(async () => ({
            aiProviders: [{
              id: "p1",
              presetId: "custom",
              name: "旧记录",
              baseUrl: "https://api.example.com/v1",
              model: "gpt",
              requiresKey: true,
              enabled: true,
              protocol: "openai"
            }]
          })),
          set: vi.fn(async () => {})
        },
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) }
      }
    });
    const { testAiProviderConnection } = await loadModule();

    const resp = await testAiProviderConnection({
      providerId: "p1",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-1",
      model: "gpt",
      protocol: "responses"
    });

    expect(resp).toEqual({ ok: true });
    expect(lastRequest().url).toBe("https://api.example.com/v1/responses");
  });
});
