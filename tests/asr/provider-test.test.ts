// asr/provider-test.js 的输入预检与委派测试。
//
// 本模块现在只负责「探针入参」这一层：草稿归一化、baseUrl/模型名校验、Key 代查
// （表单重输优先，否则按 id 读已存 Key）、语言档位取全局设置，然后**把草稿交给
// offscreen 的真适配器**跑（asr/offscreen-bridge.page.js 的探针客户端）。
//
// 回归背景：旧实现在 content script 里自己拼 FormData 发 fetch，于是
// ① 页面侧没有 chrome.permissions，host 权限门必然 fail-open（域名未授权也照样
// 放行）；② 请求受网页 CORS 约束，与扩展文档里「只受 host 权限约束」的真转写出口
// 不是一回事；③ 验的是草稿 Key，真跑用的是已保存配置。三者叠加出「测试连接成功、
// 实际转写 401」的误导。本文件锁死：页面侧不再发任何请求，失败文案原样透传。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const probeClient = vi.hoisted(() => ({
  probeAsrProviderViaOffscreen: vi.fn(
    async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })
  )
}));

vi.mock("../../extension/asr/offscreen-bridge.page.js", () => probeClient);

let fetchMock: ReturnType<typeof vi.fn>;
let localStorage: Record<string, any>;

async function loadModule() {
  return import("../../extension/asr/provider-test.js");
}

beforeEach(() => {
  vi.resetModules();
  resetModuleState();
  localStorage = {};
  probeClient.probeAsrProviderViaOffscreen.mockClear();
  probeClient.probeAsrProviderViaOffscreen.mockResolvedValue({ ok: true });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    permissions: {
      contains: vi.fn(async () => true)
    },
    storage: {
      ...globalThis.chrome.storage,
      sync: {
        ...globalThis.chrome.storage.sync,
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {})
      },
      local: {
        ...globalThis.chrome.storage.local,
        get: vi.fn(async (keys) => {
          const names = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, any> = {};
          for (const k of names) out[k] = localStorage[k];
          return out;
        }),
        set: vi.fn(async (obj) => { Object.assign(localStorage, obj); })
      }
    }
  });
});

function baseProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1",
    presetId: "custom",
    name: "P1",
    type: "openai-transcriptions",
    baseUrl: "https://example.com/v1",
    model: "m",
    ...overrides
  };
}

describe("testAsrConnection 输入预检（不发请求、不连端口）", () => {
  it("非法 type 的 provider：回可读错误，探针客户端零调用", async () => {
    const { testAsrConnection } = await loadModule();
    const resp = await testAsrConnection({ id: "p1", type: "random-type", baseUrl: "x", model: "y" });
    expect(resp.ok).toBe(false);
    expect(resp.error).toBeTruthy();
    expect(probeClient.probeAsrProviderViaOffscreen).not.toHaveBeenCalled();
  });

  it("缺 id 且无 Key 随参（Modal 新增平台的输入残缺态）：同样不可探", async () => {
    const { testAsrConnection } = await loadModule();
    expect((await testAsrConnection({ type: "openai-transcriptions", baseUrl: "x", model: "y" })).ok).toBe(false);
    expect((await testAsrConnection(null)).ok).toBe(false);
    expect(probeClient.probeAsrProviderViaOffscreen).not.toHaveBeenCalled();
  });

  it("baseUrl / 模型名缺失：各自的本地文案，不连端口", async () => {
    const { testAsrConnection } = await loadModule();
    expect(await testAsrConnection(baseProvider({ baseUrl: "", apiKey: "sk-1" }))).toEqual({
      ok: false,
      error: "请填写 baseUrl"
    });
    expect(await testAsrConnection(baseProvider({ model: "", apiKey: "sk-1" }))).toEqual({
      ok: false,
      error: "请填写模型名"
    });
    expect(probeClient.probeAsrProviderViaOffscreen).not.toHaveBeenCalled();
  });
});

describe("testAsrConnection 委派：草稿入参原样交给 offscreen 真链路", () => {
  it("页面侧不发任何请求（请求构造归 offscreen 的真适配器）", async () => {
    const { testAsrConnection } = await loadModule();
    const resp = await testAsrConnection(baseProvider({ apiKey: "sk-1" }));
    expect(resp).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("已存平台：按 id 代查已存 Key 一并送进探针任务", async () => {
    localStorage.asrProviderKeys = { p1: "stored-key-1" };
    const { testAsrConnection } = await loadModule();
    await testAsrConnection(baseProvider());
    expect(probeClient.probeAsrProviderViaOffscreen).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "stored-key-1" })
    );
  });

  it("新增平台（无 id、Key 随参携带）：占位 id 放行，Key 用表单值", async () => {
    const { testAsrConnection } = await loadModule();
    const resp = await testAsrConnection({
      name: "SiliconFlow 硅基流动（免费）",
      type: "openai-transcriptions",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "XingChenAGI/XingChenASR-V3.2",
      apiKey: "sk-1"
    });
    expect(resp.ok).toBe(true);
    expect(probeClient.probeAsrProviderViaOffscreen).toHaveBeenCalledWith({
      type: "openai-transcriptions",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "XingChenAGI/XingChenASR-V3.2",
      apiKey: "sk-1",
      language: "auto"
    });
  });

  it("语言档位取全局设置 asrLanguage（探针与实际转写验同一条语言链路）", async () => {
    vi.mocked(globalThis.chrome.storage.sync.get).mockResolvedValue({ asrLanguage: "en" });
    const { testAsrConnection } = await loadModule();
    await testAsrConnection(baseProvider({ apiKey: "sk-1" }));
    expect(probeClient.probeAsrProviderViaOffscreen).toHaveBeenCalledWith(
      expect.objectContaining({ language: "en" })
    );
  });

  it("探针失败：文案原样透传，不二次改写", async () => {
    probeClient.probeAsrProviderViaOffscreen.mockResolvedValue({
      ok: false,
      error: 'HTTP 401: {"code":30014,"message":"Token is invalid."}'
    });
    const { testAsrConnection } = await loadModule();
    expect(await testAsrConnection(baseProvider({ apiKey: "bad" }))).toEqual({
      ok: false,
      error: 'HTTP 401: {"code":30014,"message":"Token is invalid."}'
    });
  });
});
