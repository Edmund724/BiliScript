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
      { id: "p2", name: "y", protocol: "openai" },
      { id: "p3", name: "z", protocol: "gemini" }
    ]);
    expect(providers[0].protocol).toBe("anthropic");
    expect(providers[1].protocol).toBe("openai");
    expect(providers[2].protocol).toBe("gemini");
  });

  it("缺省/未知协议值不落盘字段（读侧 resolveAdapter 兜底 openai，存量记录零变化）", async () => {
    const providers = await loadProvidersFrom([
      { id: "p1", name: "x" },
      { id: "p2", name: "y", protocol: "unknown-proto" },
      { id: "p3", name: "z", protocol: "" },
      { id: "p4", name: "w", protocol: "responses" }
    ]);
    expect(providers[0]).not.toHaveProperty("protocol");
    expect(providers[1]).not.toHaveProperty("protocol");
    expect(providers[2]).not.toHaveProperty("protocol");
    expect(providers[3]).not.toHaveProperty("protocol");
  });
});

function installSplitStorageStub(
  syncData: Record<string, unknown> = {},
  localData: Record<string, unknown> = {}
) {
  const syncGet = vi.fn(async (keys: unknown) => {
    const names = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of names) {
      if (typeof k === "string" && k in syncData) out[k] = syncData[k];
    }
    return out;
  });
  const syncSet = vi.fn(async (obj: Record<string, unknown>) => {
    Object.assign(syncData, obj);
  });
  const localGet = vi.fn(async (keys: unknown) => {
    const names = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of names) {
      if (typeof k === "string" && k in localData) out[k] = localData[k];
    }
    return out;
  });
  const localSet = vi.fn(async (obj: Record<string, unknown>) => {
    Object.assign(localData, obj);
  });
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    storage: {
      ...globalThis.chrome.storage,
      sync: { ...globalThis.chrome.storage.sync, get: syncGet, set: syncSet },
      local: { ...globalThis.chrome.storage.local, get: localGet, set: localSet }
    }
  });
  return { syncData, localData, syncGet, syncSet, localGet, localSet };
}

describe("aiProviderStore sync 8KB 防爆分离、跨设备回退与旧版迁移", () => {
  it("200 个模型的平台写入 sync 体积远低于 8192B，完整清单落盘 local 并读取合并", async () => {
    const { syncData, localData } = installSplitStorageStub();
    const {
      aiProviderStore,
      AI_PROVIDERS_STORAGE,
      AI_PROVIDER_MODELS_LOCAL_KEY,
      AI_PROVIDER_SYNC_MAX_MODELS_PER_PROVIDER,
      AI_PROVIDERS_SYNC_SOFT_BYTE_LIMIT
    } = await import("../../extension/core/ai-provider-store.js");

    const models200 = Array.from({ length: 200 }, (_, i) => `org/very-long-provider-model-id-${String(i + 1).padStart(3, "0")}`);
    const saved = await aiProviderStore.saveProviders([
      {
        id: "openrouter",
        presetId: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        models: models200,
        apiKey: "sk-or-secret"
      }
    ]);

    expect(saved[0].models).toEqual(models200);
    const syncList = syncData[AI_PROVIDERS_STORAGE] as Array<{ id: string; models: string[] }>;
    expect(syncList).toHaveLength(1);
    expect(syncList[0].models).toEqual(models200.slice(0, AI_PROVIDER_SYNC_MAX_MODELS_PER_PROVIDER));
    const syncBytes =
      new TextEncoder().encode(AI_PROVIDERS_STORAGE).length +
      new TextEncoder().encode(JSON.stringify(syncList)).length;
    expect(syncBytes).toBeLessThanOrEqual(AI_PROVIDERS_SYNC_SOFT_BYTE_LIMIT);
    expect(syncBytes).toBeLessThan(8192);

    const localMap = localData[AI_PROVIDER_MODELS_LOCAL_KEY] as Record<string, string[]>;
    expect(localMap.openrouter).toEqual(models200);

    const loaded = await aiProviderStore.loadProviders();
    expect(loaded[0].models).toEqual(models200);
    expect(loaded[0].hasSavedKey).toBe(true);
  });

  it("多平台长模型 ID 触发 6000B 预算缩剪时，仍保证每个非空平台在 sync 至少保留 1 个模型", async () => {
    const {
      buildSlimSyncAiProviders,
      AI_PROVIDERS_STORAGE,
      AI_PROVIDERS_SYNC_SOFT_BYTE_LIMIT
    } = await import("../../extension/core/ai-provider-store.js");

    const providers = Array.from({ length: 12 }, (_, idx) => ({
      id: `provider-${idx + 1}`,
      presetId: "custom",
      name: `Provider ${idx + 1}`,
      baseUrl: `https://api-${idx + 1}.example.com/v1`,
      models: Array.from(
        { length: 5 },
        (_, m) => `vendor-${idx + 1}/ultra-verbose-model-identifier-segment-${"x".repeat(45)}-${m + 1}`
      ),
      requiresKey: true,
      enabled: true
    }));

    const slim = buildSlimSyncAiProviders(providers);
    const bytes =
      new TextEncoder().encode(AI_PROVIDERS_STORAGE).length +
      new TextEncoder().encode(JSON.stringify(slim)).length;
    expect(bytes).toBeLessThanOrEqual(AI_PROVIDERS_SYNC_SOFT_BYTE_LIMIT);
    for (const item of slim) {
      expect(item.models.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("跨设备同步本机 local 为空时自动回退 sync 保留模型，双空才保留空数组", async () => {
    installSplitStorageStub(
      {
        aiProviders: [
          {
            id: "openai",
            presetId: "openai",
            name: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            models: ["gpt-4.1", "gpt-4.1-mini"]
          },
          {
            id: "legacy-single",
            presetId: "custom",
            name: "Legacy",
            baseUrl: "https://legacy.example.com/v1",
            model: "gpt-4.1"
          },
          {
            id: "empty-provider",
            presetId: "custom",
            name: "Empty",
            baseUrl: "https://empty.example.com/v1",
            models: []
          }
        ]
      },
      {}
    );
    const { aiProviderStore } = await import("../../extension/core/ai-provider-store.js");

    const loaded = await aiProviderStore.loadProviders();
    expect(loaded.find((p) => p.id === "openai")?.models).toEqual(["gpt-4.1", "gpt-4.1-mini"]);
    expect(loaded.find((p) => p.id === "legacy-single")?.models).toEqual(["gpt-4.1"]);
    expect(loaded.find((p) => p.id === "empty-provider")?.models).toEqual([]);
  });

  it("首次读取旧版内联大 models[] 时无损迁入 local 并回写瘦身 sync，删除平台同步清理 local 目录", async () => {
    const legacyModels = Array.from({ length: 24 }, (_, i) => `legacy-model-${i + 1}`);
    const { syncData, localData, syncSet, localSet } = installSplitStorageStub(
      {
        aiProviders: [
          {
            id: "legacy-big",
            presetId: "custom",
            name: "LegacyBig",
            baseUrl: "https://api.example.com/v1",
            models: legacyModels
          }
        ]
      },
      {}
    );
    const {
      aiProviderStore,
      AI_PROVIDERS_STORAGE,
      AI_PROVIDER_MODELS_LOCAL_KEY,
      AI_PROVIDER_SYNC_MAX_MODELS_PER_PROVIDER
    } = await import("../../extension/core/ai-provider-store.js");

    const loaded = await aiProviderStore.loadProviders();
    expect(loaded[0].models).toEqual(legacyModels);
    expect(localSet).toHaveBeenCalledTimes(1);
    expect(syncSet).toHaveBeenCalledTimes(1);
    expect((localData[AI_PROVIDER_MODELS_LOCAL_KEY] as Record<string, string[]>)["legacy-big"]).toEqual(legacyModels);
    const rewrittenSync = syncData[AI_PROVIDERS_STORAGE] as Array<{ id: string; models: string[] }>;
    expect(rewrittenSync[0].models).toEqual(legacyModels.slice(0, AI_PROVIDER_SYNC_MAX_MODELS_PER_PROVIDER));

    await aiProviderStore.deleteProvider("legacy-big");
    expect((localData[AI_PROVIDER_MODELS_LOCAL_KEY] as Record<string, string[]>)["legacy-big"]).toBeUndefined();
    expect(syncData[AI_PROVIDERS_STORAGE]).toEqual([]);
  });
});
