// AI 平台存储归一化测试（multi-model-catalog 拍板 Q2/Q7/Q13）：
// AiProvider.model(string) 已改为 models(string[])，normalizeAiProvider 负责
// 旧数据无感迁移（单 model 包成单元素目录）与目录收口（trim / 去空串 / 去重）。
// 经 aiProviderStore.loadProviders 走真实存储读取路径（chrome.storage stub）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

async function loadProvidersFrom(storedList: unknown) {
  const syncGetMock = vi.fn(async () => ({ aiProviders: storedList }));
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    storage: { ...globalThis.chrome.storage, sync: { ...globalThis.chrome.storage.sync, get: syncGetMock } }
  });
  const { aiProviderStore } = await import("../../extension/core/ai-provider-store.js");
  return aiProviderStore.loadProviders();
}

beforeEach(() => {
  vi.resetModules();
  resetModuleState();
});

describe("normalizeAiProvider 模型目录归一化", () => {
  it("旧单模型记录无感迁移：model 包成单元素目录", async () => {
    const providers = await loadProvidersFrom([
      { id: "p1", presetId: "custom", name: "我的端点", baseUrl: "https://api.example.com/v1/", model: "gpt-4o-mini", requiresKey: true }
    ]);
    expect(providers).toHaveLength(1);
    expect(providers[0].models).toEqual(["gpt-4o-mini"]);
    expect(providers[0]).not.toHaveProperty("model");
  });

  it("迁移与归一 trim：model 首尾空白包入前收敛", async () => {
    const providers = await loadProvidersFrom([{ id: "p1", name: "x", model: "  glm-4  " }]);
    expect(providers[0].models).toEqual(["glm-4"]);
  });

  it("models 数组收口：trim、去空串、静默去重（拍板 Q7）", async () => {
    const providers = await loadProvidersFrom([
      { id: "p1", name: "x", models: [" deepseek-v4-flash ", "", "deepseek-v4-pro", "deepseek-v4-flash", null, "  "] }
    ]);
    expect(providers[0].models).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  });

  it("models 与旧 model 并存时目录优先；双空为合法零目录（拍板 Q13）", async () => {
    const providers = await loadProvidersFrom([
      { id: "p1", name: "x", model: "legacy", models: ["new"] },
      { id: "p2", name: "y", model: "", models: [] },
      { id: "p3", name: "z" }
    ]);
    expect(providers[0].models).toEqual(["new"]);
    expect(providers[1].models).toEqual([]);
    expect(providers[2].models).toEqual([]);
  });

  it("无 id 记录归一为 null 被过滤", async () => {
    const providers = await loadProvidersFrom([{ name: "x", model: "m" }, null, "junk"]);
    expect(providers).toEqual([]);
  });
});

describe("normalizeAiProvider 协议字段归一化（multi-protocol-ai）", () => {
  it("注册表词表内的协议值原样保留", async () => {
    const providers = await loadProvidersFrom([
      { id: "p1", name: "x", protocol: "anthropic" },
      { id: "p2", name: "y", protocol: "openai" }
    ]);
    expect(providers[0].protocol).toBe("anthropic");
    expect(providers[1].protocol).toBe("openai");
  });

  it("缺省/未知协议值不落盘字段（读侧 resolveAdapter 兜底 openai，存量记录零变化）", async () => {
    const providers = await loadProvidersFrom([
      { id: "p1", name: "x" },
      { id: "p2", name: "y", protocol: "gemini" },
      { id: "p3", name: "z", protocol: "" },
      // "responses"：适配器已移除，词表同步摘除后按未知值不落盘。
      { id: "p4", name: "w", protocol: "responses" }
    ]);
    expect(providers[0]).not.toHaveProperty("protocol");
    expect(providers[1]).not.toHaveProperty("protocol");
    expect(providers[2]).not.toHaveProperty("protocol");
    expect(providers[3]).not.toHaveProperty("protocol");
  });
});
