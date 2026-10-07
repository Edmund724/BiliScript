// search/search-health-handler.js SW 端消息 handler 工厂测试（arch-review-2026-09/08）：
// 直调 createSearchHealthHandler（同 ai/segment-cache-handler.test.ts 形态），不再起
// 真 background 入口 + chrome 桩（原 tests/entry/search-health-message.test.ts 的记账
// 半边下沉至此）。覆盖：record 落 local 单键、SW 侧盖时间戳、连败 3 次触发冷却、
// 成功清零连败、脏载荷静默 no-op、未知 op → ok:false（不静默吞）、落盘后健康度快照
// inline 失效（写后读立刻消费新账）、来源口径（不进 offscreen-only 名单）。
//
// 与 resolve-search-provider 消费冷却图的整合面（真实入口 + 路由）仍在
// tests/entry/search-health-message.test.ts。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { SEARCH_HEALTH_KEY } from "../../extension/search/search-health.js";
import { OFFSCREEN_ONLY_MESSAGE_TYPES } from "../../extension/shared/messaging-protocol.js";
import type { SearchHealthMessage, SearchHealthResponse } from "../../extension/shared/messaging-protocol.js";

let storage: ReturnType<typeof createMemoryStorage>;
let handler: ReturnType<typeof import("../../extension/search/search-health-handler.js").createSearchHealthHandler>;

function createMemoryStorage() {
  const map = new Map<string, unknown>();
  const local = {
    get: vi.fn(async (keys: unknown) => {
      const want = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of want as string[]) {
        if (map.has(key)) out[key] = map.get(key);
      }
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) map.set(key, value);
    }),
    remove: vi.fn(async (keys: unknown) => {
      for (const key of (Array.isArray(keys) ? keys : [keys]) as string[]) map.delete(key);
    })
  };
  return { map, local };
}

async function importModules() {
  resetModuleState();
  storage = createMemoryStorage();
  vi.stubGlobal("chrome", { storage: { local: storage.local } });
  const mod = await import("../../extension/search/search-health-handler.js");
  handler = mod.createSearchHealthHandler();
}

function request(message: SearchHealthMessage): Promise<SearchHealthResponse> {
  return new Promise<SearchHealthResponse>((resolve) => handler(message, {}, resolve));
}

function recordHealth(message: Partial<SearchHealthMessage> = {}): Promise<SearchHealthResponse> {
  return request({ type: "search-health", op: "record", presetId: "tavily", ok: false, latencyMs: 5, ...message });
}

// 健康度快照位的 storage.local.get 次数（键面命中计数）。
function healthReads(): number {
  return vi
    .mocked(storage.local.get)
    .mock.calls.filter(([keys]) => (Array.isArray(keys) ? keys : [keys]).includes(SEARCH_HEALTH_KEY)).length;
}

function storedHealth(): Record<string, any> {
  return storage.map.get(SEARCH_HEALTH_KEY) as Record<string, any>;
}

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("search-health 记账消息族（spec §12.4 第 7–8 条 / §12.5 第 11 行）", () => {
  it("record：落 chrome.storage.local 单键、SW 侧盖时间戳（回包只带 ok）", async () => {
    const response = await recordHealth({ latencyMs: 12 });

    expect(response).toEqual({ ok: true });
    expect([...storage.map.keys()]).toEqual([SEARCH_HEALTH_KEY]);
    const stored = storedHealth();
    expect(Object.keys(stored)).toEqual(["tavily"]);
    expect(stored.tavily.attempts).toEqual([{ ok: false, latencyMs: 12 }]);
    expect(stored.tavily.consecutiveFailures).toBe(1);
    expect(stored.tavily.cooldownUntil).toBe(0);
  });

  it("连败 3 次触发冷却（SW 侧时间戳）：cooldownLevel 1、cooldownUntil ≈ now + 5min", async () => {
    for (let index = 0; index < 3; index += 1) {
      expect(await recordHealth()).toEqual({ ok: true });
    }

    const stored = storedHealth();
    expect(stored.tavily.cooldownLevel).toBe(1);
    expect(stored.tavily.consecutiveFailures).toBe(0);
    expect(stored.tavily.cooldownUntil).toBeGreaterThan(Date.now());
    expect(stored.tavily.cooldownUntil).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  it("成功记账清零连败（账照记，单选不消费冷却但记账口径一致）", async () => {
    await recordHealth();
    await recordHealth({ ok: true, latencyMs: 9 });

    const stored = storedHealth();
    expect(stored.tavily.attempts).toEqual([
      { ok: false, latencyMs: 5 },
      { ok: true, latencyMs: 9 }
    ]);
    expect(stored.tavily.consecutiveFailures).toBe(0);
  });

  it("脏载荷（presetId 空 / ok 非布尔）→ ok:true 但零落盘", async () => {
    await recordHealth({ presetId: "", latencyMs: 1 });
    await recordHealth({ ok: "yes" as unknown as boolean });

    expect(storage.local.set).not.toHaveBeenCalled();
    expect(storage.map.get(SEARCH_HEALTH_KEY)).toBeUndefined();
  });

  it("未知 op → ok:false + 错误文案（不静默吞）", async () => {
    const response = await request({ type: "search-health", op: "clear" } as unknown as SearchHealthMessage);

    expect(response.ok).toBe(false);
    expect(response.error).toContain("不支持的搜索健康度操作");
  });

  it("记账失败静默（写抛）→ 回包仍 ok:true（记账绝不影响回答）", async () => {
    storage.local.set.mockRejectedValueOnce(new Error("quota"));

    expect(await recordHealth()).toEqual({ ok: true });
  });

  it("落盘后健康度快照 inline 失效：写后读立刻拿到新账（不命中旧快照）", async () => {
    const snapshot = await import("../../extension/core/settings-snapshot.js");

    await snapshot.getSearchHealth();
    await snapshot.getSearchHealth();
    expect(healthReads()).toBe(1);

    // 记账 handler 自身读-改-写读一次（第 2 次），落盘后 inline 失效快照位
    await recordHealth({ ok: true, latencyMs: 3 });
    expect(healthReads()).toBe(2);

    // 若缺失效则是缓存命中（仍为 2）；失效后重读一次得新账
    const health = await snapshot.getSearchHealth();
    expect(healthReads()).toBe(3);
    expect(health.tavily.consecutiveFailures).toBe(0);
  });

  it("来源口径：本族不进 offscreen-only 名单（发送者含 content；行为面由 tests/entry/offscreen-message-guard.test.ts 钉）", () => {
    expect([...OFFSCREEN_ONLY_MESSAGE_TYPES]).not.toContain("search-health");
  });
});
