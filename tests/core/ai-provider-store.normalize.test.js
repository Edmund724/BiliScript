// AI 平台存储归一化测试（multi-model-catalog 拍板 Q2/Q7/Q13）：
// AiProvider.model(string) 已改为 models(string[])，normalizeAiProvider 负责
// 旧数据无感迁移（单 model 包成单元素目录）与目录收口（trim / 去空串 / 去重）。
// 经 aiProviderStore.loadProviders 走真实存储读取路径（chrome.storage stub）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

async function loadProvidersFrom(storedList) {
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
      { id: "p1", presetId: "openai_compat", name: "我的端点", baseUrl: "https://api.example.com/v1/", model: "gpt-4o-mini", requiresKey: true }
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
