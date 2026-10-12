// tests/helpers/chrome-host.js 的契约用例：宿主即 seam，消费方是测试本身。
// 钉住四件事：键三形状（单键 / 键数组 / null ⇒ 全量快照）、值形状由宿主单源派生、
// 两种索引落盘格式（现代分键条目 { ts } vs 旧汇总清单数值 ts）不被互相现代化、
// failNextWrite 只拒绝下一次 set。

import { afterEach, describe, expect, it, vi } from "vitest";
import { installChromeHost } from "./chrome-host.js";
import { buildLruIndexEntryKey, LRU_MANIFEST_STORAGE_KEY } from "../../extension/core/cache-lru.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("installChromeHost：storage.local 键契约", () => {
  it("get 三形状：单键 / 键数组 / null 全量快照；缺失键不出现", async () => {
    const host = installChromeHost();
    await host.local.set({ a: 1, b: 2 });

    expect(await host.local.get("a")).toEqual({ a: 1 });
    expect(await host.local.get(["a", "missing"])).toEqual({ a: 1 });
    expect(await host.local.get(null)).toEqual({ a: 1, b: 2 });
    expect(await host.local.get("missing")).toEqual({});
    expect(host.snapshot()).toEqual({ a: 1, b: 2 });
  });

  it("get(undefined) 与 null 同义；remove 支持单键与键数组", async () => {
    const host = installChromeHost();
    await host.local.set({ a: 1, b: 2 });

    expect(await host.local.get(undefined)).toEqual({ a: 1, b: 2 });
    await host.local.remove("a");
    expect(host.snapshot()).toEqual({ b: 2 });
    await host.local.remove(["b"]);
    expect(host.snapshot()).toEqual({});
  });

  it("get/set/remove 都是 vi.fn：既有用例的 mock 面（mockImplementation / getMockImplementation）可用", async () => {
    const host = installChromeHost();
    expect(vi.isMockFunction(host.local.get)).toBe(true);
    expect(vi.isMockFunction(host.local.set)).toBe(true);
    expect(vi.isMockFunction(host.local.remove)).toBe(true);

    // 既有用例靠 getMockImplementation 包裹宿主默认写实现（reset-fetch-runid 的写窗口）
    const original = host.local.set.getMockImplementation();
    expect(typeof original).toBe("function");
    host.local.set.mockImplementation(async (items) => {
      await original?.(items);
    });
    await host.local.set({ wrapped: true });
    expect(host.snapshot()).toEqual({ wrapped: true });
  });

  it("sync 与 local 是两台独立的盘：map / syncMap 各自可直读", async () => {
    const host = installChromeHost();
    await host.local.set({ l: 1 });
    await host.sync.set({ s: 2 });

    expect(host.snapshot()).toEqual({ l: 1 });
    expect(host.map.get("l")).toBe(1);
    expect(host.syncMap.get("s")).toBe(2);
    expect(await host.sync.get(null)).toEqual({ s: 2 });
  });
});

describe("installChromeHost：盘上布局单源", () => {
  it("seedCacheEntry 单源派生 { body, timestamp }（缺省数值时间戳，可显式指定）", () => {
    const host = installChromeHost();
    const body = [{ from: 0, to: 1, content: "x" }];

    host.seedCacheEntry("biliscript_subtitle_cache_BV1a_1_id_x", body);
    expect(host.map.get("biliscript_subtitle_cache_BV1a_1_id_x")).toEqual({
      body,
      timestamp: expect.any(Number)
    });

    host.seedCacheEntry("biliscript_subtitle_cache_BV1b_1_id_x", body, 42);
    expect(host.map.get("biliscript_subtitle_cache_BV1b_1_id_x")).toEqual({ body, timestamp: 42 });
  });

  it("seedIndexEntry 经生产装配点落 { ts } 分键条目", () => {
    const host = installChromeHost();
    host.seedIndexEntry("biliscript_lvs_raw_", "BV1a", "biliscript_lvs_raw_BV1a_1_a_1", 100);

    expect(host.map.get(buildLruIndexEntryKey("biliscript_lvs_raw_", "BV1a", "biliscript_lvs_raw_BV1a_1_a_1"))).toEqual({
      ts: 100
    });
    expect(host.snapshot()).toEqual({
      [buildLruIndexEntryKey("biliscript_lvs_raw_", "BV1a", "biliscript_lvs_raw_BV1a_1_a_1")]: { ts: 100 }
    });
  });

  it("seedLegacyManifest 落旧汇总清单（数值 ts）并跨族/跨 bvid 合并；两种格式互不现代化", () => {
    const host = installChromeHost();
    host.seedIndexEntry("biliscript_lvs_raw_", "BV1a", "biliscript_lvs_raw_BV1a_1_a_1", 100);
    host.seedLegacyManifest("biliscript_lvs_raw_", "BV1old", 10);
    host.seedLegacyManifest("biliscript_lvs_raw_", "BV1a", 100);
    host.seedLegacyManifest("biliscript_subtitle_cache_", "BV1old", 1);

    expect(host.map.get(LRU_MANIFEST_STORAGE_KEY)).toEqual({
      biliscript_lvs_raw_: { BV1old: 10, BV1a: 100 },
      biliscript_subtitle_cache_: { BV1old: 1 }
    });
    // 索引条目仍是 { ts }，旧清单仍是数值 ts——两条 seed 各写各的格式
    expect(host.map.get(buildLruIndexEntryKey("biliscript_lvs_raw_", "BV1a", "biliscript_lvs_raw_BV1a_1_a_1"))).toEqual({
      ts: 100
    });
  });
});

describe("installChromeHost：failNextWrite 与装配面", () => {
  it("failNextWrite 只拒绝下一次 set，之后的写入照常", async () => {
    const host = installChromeHost();
    host.failNextWrite();

    await expect(host.local.set({ a: 1 })).rejects.toThrow();
    expect(host.snapshot()).toEqual({});
    await host.local.set({ a: 1 });
    expect(host.snapshot()).toEqual({ a: 1 });
  });

  it("failNextWrite 对任一已装 area 生效（sync 的下一次 set 也拒绝一次）", async () => {
    const host = installChromeHost();
    host.failNextWrite();

    await expect(host.sync.set({ s: 1 })).rejects.toThrow();
    expect(await host.sync.get(null)).toEqual({});
    await host.local.set({ a: 1 });
    expect(host.snapshot()).toEqual({ a: 1 });
  });

  it("装进 globalThis.chrome：请求的 storage 面 + onChanged + runtime 都在；areas 子集与 merge 语义", () => {
    const previous = {
      runtime: { sendMessage: vi.fn(), getURL: vi.fn() },
      storage: { sync: { get: vi.fn(), set: vi.fn(), remove: vi.fn() } },
      offscreen: { closeDocument: vi.fn() }
    };
    vi.stubGlobal("chrome", previous);

    const host = installChromeHost({ areas: ["local"], runtime: { custom: 1 } });

    expect(globalThis.chrome.storage.local).toBe(host.local);
    // areas 未含 sync：既有 sync 原样保留
    expect(globalThis.chrome.storage.sync).toBe(previous.storage.sync);
    expect(globalThis.chrome.storage.onChanged.addListener).toBeTypeOf("function");
    // 既有 runtime 成员保留，options.runtime 覆盖
    expect(globalThis.chrome.runtime.sendMessage).toBe(previous.runtime.sendMessage);
    expect(globalThis.chrome.runtime.getURL).toBe(previous.runtime.getURL);
    expect((globalThis.chrome.runtime as unknown as { custom: number }).custom).toBe(1);
    // 其余 namespace 不丢
    expect((globalThis.chrome as unknown as { offscreen: unknown }).offscreen).toBe(previous.offscreen);
  });

  it("缺省装 local + sync 两个面（自成一体，不依赖 setup 先跑）", async () => {
    const host = installChromeHost();

    expect(globalThis.chrome.storage.local).toBe(host.local);
    expect(globalThis.chrome.storage.sync).toBe(host.sync);
    await globalThis.chrome.storage.sync.set({ s: 1 });
    expect(await globalThis.chrome.storage.local.get(null)).toEqual({});
    expect(await globalThis.chrome.storage.sync.get(null)).toEqual({ s: 1 });
  });
});
