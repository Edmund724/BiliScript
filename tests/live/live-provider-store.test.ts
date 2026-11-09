// tests/live/live-provider-store.test.ts
// MOSS-LIVE Provider 归一化与存储单元测试

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  normalizeLiveProvider,
  resolveActiveLiveProviderId
} from "../../extension/live/live-provider-store.js";
import {
  liveProviderStore,
  LIVE_PROVIDERS_STORAGE,
  LIVE_PROVIDER_KEYS_STORAGE,
  resolveLiveModelsUrl,
  listLiveModels,
  testLiveConnection
} from "../../extension/live/live-provider-store.js";

function installStorageStub() {
  const sync: Record<string, unknown> = {};
  const local: Record<string, unknown> = {};
  vi.stubGlobal("chrome", {
    runtime: { lastError: null },
    storage: {
      sync: {
        get: vi.fn(async (keys: unknown) => {
          const names = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || {});
          const res: Record<string, unknown> = {};
          for (const k of names) {
            if (k in sync) res[k] = sync[k];
          }
          return res;
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(sync, obj);
        })
      },
      local: {
        get: vi.fn(async (keys: unknown) => {
          const names = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || {});
          const res: Record<string, unknown> = {};
          for (const k of names) {
            if (k in local) res[k] = local[k];
          }
          return res;
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          Object.assign(local, obj);
        })
      }
    }
  });
  return { sync, local };
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
});

describe("normalizeLiveProvider", () => {
  it("normalizes a valid live provider with defaults", () => {
    const normalized = normalizeLiveProvider({
      id: "moss-1"
    });
    expect(normalized).toEqual({
      id: "moss-1",
      presetId: "moss-live",
      name: "MOSS Live",
      type: "moss-live",
      baseUrl: "https://api.mosi.cn",
      model: "moss-live-1.0",
      enabled: true
    });
  });

  it("returns null for non-moss-live type or missing id", () => {
    expect(normalizeLiveProvider({ id: "p1", type: "openai" })).toBeNull();
    expect(normalizeLiveProvider({ type: "moss-live" })).toBeNull();
    expect(normalizeLiveProvider(null)).toBeNull();
  });
});

describe("resolveActiveLiveProviderId", () => {
  it("returns requested id when present in provider list", () => {
    const providers = [{ id: "p1" }, { id: "p2" }];
    expect(resolveActiveLiveProviderId(providers, "p2")).toBe("p2");
  });

  it("falls back to first provider when requested id is not found", () => {
    const providers = [{ id: "p1" }, { id: "p2" }];
    expect(resolveActiveLiveProviderId(providers, "p99")).toBe("p1");
    expect(resolveActiveLiveProviderId(providers, "")).toBe("p1");
  });

  it("returns empty string when list is empty", () => {
    expect(resolveActiveLiveProviderId([], "p1")).toBe("");
  });
});

describe("liveProviderStore CRUD and storage isolation", () => {
  it("saves provider list to sync and API key to local storage", async () => {
    const { sync, local } = installStorageStub();

    await liveProviderStore.saveProviders([
      {
        id: "moss-live-1",
        presetId: "moss-live",
        name: "MOSS Live",
        type: "moss-live",
        baseUrl: "https://api.mosi.cn",
        model: "moss-live-1.0",
        enabled: true,
        apiKey: "sk-moss-secret-123"
      }
    ]);

    expect(sync[LIVE_PROVIDERS_STORAGE]).toBeDefined();
    const savedSyncList = sync[LIVE_PROVIDERS_STORAGE] as any[];
    expect(savedSyncList).toHaveLength(1);
    expect(savedSyncList[0].id).toBe("moss-live-1");
    expect(savedSyncList[0].apiKey).toBeUndefined(); // Key must NOT be in sync storage

    expect(local[LIVE_PROVIDER_KEYS_STORAGE]).toBeDefined();
    const savedKeys = local[LIVE_PROVIDER_KEYS_STORAGE] as Record<string, string>;
    expect(savedKeys["moss-live-1"]).toBe("sk-moss-secret-123");

    const loaded = await liveProviderStore.loadProviders();
    expect(loaded[0].hasSavedKey).toBe(true);
  });

  it("deletes provider from sync list and removes its key from local storage", async () => {
    const { sync, local } = installStorageStub();

    await liveProviderStore.saveProviders([
      {
        id: "moss-1",
        presetId: "moss-live",
        name: "MOSS 1",
        type: "moss-live",
        baseUrl: "https://api.mosi.cn",
        model: "moss-live-1.0",
        enabled: true,
        apiKey: "sk-1"
      },
      {
        id: "moss-2",
        presetId: "moss-live",
        name: "MOSS 2",
        type: "moss-live",
        baseUrl: "https://api.mosi.cn",
        model: "moss-live-1.0",
        enabled: true,
        apiKey: "sk-2"
      }
    ]);

    await liveProviderStore.deleteProvider("moss-1");

    const syncList = sync[LIVE_PROVIDERS_STORAGE] as any[];
    expect(syncList.map((p) => p.id)).toEqual(["moss-2"]);

    const keys = local[LIVE_PROVIDER_KEYS_STORAGE] as Record<string, string>;
    expect(keys["moss-1"]).toBeUndefined();
    expect(keys["moss-2"]).toBe("sk-2");
  });
});

describe("resolveLiveModelsUrl, listLiveModels & testLiveConnection", () => {
  it("normalizes baseUrl into /v1/models HTTP endpoint", () => {
    expect(resolveLiveModelsUrl("https://api.mosi.cn")).toBe("https://api.mosi.cn/v1/models");
    expect(resolveLiveModelsUrl("https://api.mosi.cn/v1")).toBe("https://api.mosi.cn/v1/models");
    expect(resolveLiveModelsUrl("https://api.mosi.cn/v1/realtime")).toBe("https://api.mosi.cn/v1/models");
  });

  it("fetches /v1/models via background proxy and guarantees moss-live-1.0 in list", async () => {
    installStorageStub();
    (globalThis as any).chrome.runtime.sendMessage = vi.fn((msg: any, cb: (r: any) => void) => {
      if (msg?.type === "provider-http") {
        cb({
          ok: true,
          status: 200,
          body: JSON.stringify({ data: [{ id: "moss-tts-2.0" }] })
        });
      }
    });

    const listRes = await listLiveModels({
      baseUrl: "https://api.mosi.cn",
      apiKey: "sk-moss-test"
    });
    expect(listRes).toEqual({
      ok: true,
      models: ["moss-live-1.0", "moss-tts-2.0"]
    });

    const testRes = await testLiveConnection({
      baseUrl: "https://api.mosi.cn",
      model: "moss-live-1.0",
      apiKey: "sk-moss-test"
    });
    expect(testRes).toEqual({ ok: true });
  });
});
