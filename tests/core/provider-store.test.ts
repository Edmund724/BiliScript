import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createProviderStore } from "../../extension/core/provider-store.js";

let syncStorage: Record<string, any>;
let localStorage: Record<string, any>;

function normalizeProvider(item: any) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "").trim();
  if (!id) return null;
  return {
    id,
    name: String(item.name || "").trim(),
    model: String(item.model || "").trim()
  };
}

function makeStore() {
  return createProviderStore({
    listStorageKey: "testProviders",
    keysStorageKey: "testProviderKeys",
    normalizeProvider
  });
}

beforeEach(() => {
  resetModuleState();
  syncStorage = {};
  localStorage = {};
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    storage: {
      ...globalThis.chrome.storage,
      sync: {
        ...globalThis.chrome.storage.sync,
        get: vi.fn(async (keys: unknown) => {
          const out: Record<string, any> = {};
          const names = Array.isArray(keys) ? keys : [keys];
          for (const k of names) out[k] = syncStorage[k];
          return out;
        }),
        set: vi.fn(async (obj) => { Object.assign(syncStorage, obj); })
      },
      local: {
        ...globalThis.chrome.storage.local,
        get: vi.fn(async (keys: unknown) => {
          const out: Record<string, any> = {};
          const names = Array.isArray(keys) ? keys : [keys];
          for (const k of names) out[k] = localStorage[k];
          return out;
        }),
        set: vi.fn(async (obj) => { Object.assign(localStorage, obj); })
      }
    }
  });
});

function provider(id: string, overrides: Record<string, unknown> = {}) {
  return { id, name: "P " + id, model: "m-" + id, ...overrides };
}

describe("loadProviders / saveProviders 往返", () => {
  it("空存储返回空列表", async () => {
    const store = makeStore();
    expect(await store.loadProviders()).toEqual([]);
  });

  it("保存后读取往返一致，apiKey 收割进 local 的 Key 存储", async () => {
    const store = makeStore();
    const saved = await store.saveProviders([
      provider("p1", { apiKey: "secret-1" }),
      provider("p2", { apiKey: "secret-2" })
    ]);
    expect(saved).toHaveLength(2);
    expect(saved[0].id).toBe("p1");

    expect(localStorage.testProviderKeys).toEqual({ p1: "secret-1", p2: "secret-2" });
    expect(JSON.stringify(syncStorage.testProviders)).not.toContain("secret-1");
    expect(JSON.stringify(syncStorage.testProviders)).not.toContain("secret-2");
    expect(syncStorage.testProviders[0]).not.toHaveProperty("apiKey");

    const list = await store.loadProviders();
    expect(list).toEqual([
      { id: "p1", name: "P p1", model: "m-p1", hasSavedKey: true },
      { id: "p2", name: "P p2", model: "m-p2", hasSavedKey: true }
    ]);
  });

  it("保存时未带 apiKey 的项不写入 Key 存储；再保存带 Key 的才收割", async () => {
    const store = makeStore();
    await store.saveProviders([provider("p1")]);
    expect(localStorage.testProviderKeys).toEqual({});

    await store.saveProviders([provider("p1", { apiKey: "  k1  " })]);
    expect(localStorage.testProviderKeys).toEqual({ p1: "k1" });
  });

  it("保存时不带 apiKey 保留已存 Key（不清除）；归一化失败的项被丢弃", async () => {
    const store = makeStore();
    await store.saveProviders([provider("p1", { apiKey: "k1" })]);
    await store.saveProviders([provider("p1"), { id: "   " }]);
    expect(localStorage.testProviderKeys).toEqual({ p1: "k1" });
    const list = await store.loadProviders();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("p1");
    expect(list[0].hasSavedKey).toBe(true);
  });
});

describe("hasSavedKey 装饰", () => {
  it("有 Key 的项 hasSavedKey=true，无 Key 的为 false，且不回传明文", async () => {
    const store = makeStore();
    await store.saveProviders([
      provider("p1", { apiKey: "k1" }),
      provider("p2")
    ]);
    const list = await store.loadProviders();
    expect(list.find((p) => p.id === "p1")!.hasSavedKey).toBe(true);
    expect(list.find((p) => p.id === "p2")!.hasSavedKey).toBe(false);
    for (const item of list) {
      expect(item).not.toHaveProperty("apiKey");
    }
  });
});

describe("deleteProvider", () => {
  it("删除平台时其已存 Key 一并清理，其它平台不受影响", async () => {
    const store = makeStore();
    await store.saveProviders([
      provider("p1", { apiKey: "k1" }),
      provider("p2", { apiKey: "k2" })
    ]);
    const after = await store.deleteProvider("p1");
    expect(after).toEqual([{ id: "p2", name: "P p2", model: "m-p2", hasSavedKey: true }]);
    expect(localStorage.testProviderKeys).toEqual({ p2: "k2" });
    expect(syncStorage.testProviders).toEqual([
      { id: "p2", name: "P p2", model: "m-p2" }
    ]);
  });

  it("删除不存在的平台不抛错、不清理其它 Key", async () => {
    const store = makeStore();
    await store.saveProviders([provider("p1", { apiKey: "k1" })]);
    const after = await store.deleteProvider("nonexistent");
    expect(after).toHaveLength(1);
    expect(localStorage.testProviderKeys).toEqual({ p1: "k1" });
  });
});

describe("Key 侧通道：loadKeys / getKey / resolveDraftApiKey", () => {
  it("getKey 返回 trim 后的 Key，空 id 返回空串", async () => {
    const store = makeStore();
    await store.saveProviders([provider("p1", { apiKey: "  spaced  " })]);
    expect(await store.getKey("p1")).toBe("spaced");
    expect(await store.getKey("missing")).toBe("");
    expect(await store.getKey("")).toBe("");
    expect(await store.getKey(null)).toBe("");
  });

  it("resolveDraftApiKey：直传非空 apiKey 优先，不读取存储", async () => {
    const store = makeStore();
    await store.saveProviders([provider("p1", { apiKey: "stored-key" })]);
    vi.mocked(chrome.storage.local.get).mockClear();

    expect(await store.resolveDraftApiKey("  direct-key  ", "p1")).toBe("direct-key");
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  it("resolveDraftApiKey：直传为空白时按 providerId 回落已存 Key；无 id 或读取异常兜底空串", async () => {
    const store = makeStore();
    await store.saveProviders([provider("p1", { apiKey: "stored-key" })]);

    expect(await store.resolveDraftApiKey("   ", "p1")).toBe("stored-key");
    expect(await store.resolveDraftApiKey(null, "missing")).toBe("");
    expect(await store.resolveDraftApiKey("", "")).toBe("");
    expect(await store.resolveDraftApiKey(undefined, undefined)).toBe("");

    vi.mocked(chrome.storage.local.get).mockRejectedValueOnce(new Error("storage failure"));
    expect(await store.resolveDraftApiKey("", "p1")).toBe("");
  });
});
