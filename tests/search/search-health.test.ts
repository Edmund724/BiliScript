// search/search-health.ts 引擎健康度与冷却测试（spec §12.4 / §12.5 第 3 行、
// §10 第 68–71 行、票 15 §4）。覆盖：
//   ① 纯逻辑（零 Chrome / 不取时间，now 注入、不改写入参）：
//      滑窗 20 次溢出丢头部、连败边界 2→3、触发 5min / 翻倍 10-20-40 / 封顶 60min、
//      冷却期内不再触发不延长、成功一次三者同清、脏延迟/脏计数归一、
//      normalizeSearchHealthMap 脏值防御、cooldownUntilByPresetId 只含未到期项；
//   ② 薄 storage 层：单键 biliscript_search_health、按 presetId 聚合（引擎级）、
//      读失败回落 {}、写失败静默、脏载荷 no-op、SW 冷启动后账仍在（无内存态）。
// 时间一律注入 / fake timers，storage 走内存 fixture，不测真实网络与墙钟。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SEARCH_COOLDOWN_BASE_MS,
  SEARCH_COOLDOWN_FAILURE_THRESHOLD,
  SEARCH_COOLDOWN_MAX_MS,
  SEARCH_HEALTH_KEY,
  SEARCH_HEALTH_WINDOW,
  applySearchAttempt,
  cooldownUntilByPresetId,
  normalizeSearchHealthMap,
  readSearchHealth,
  recordSearchAttempt,
  type SearchProviderHealth
} from "../../extension/search/search-health.js";

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

// ===== 内存 storage fixture（薄 storage 层的形状断言直接读它）=====

let localFixture: Record<string, unknown>;

function asKeys(keys: unknown): string[] {
  return (Array.isArray(keys) ? keys : keys && typeof keys === "object" ? Object.keys(keys) : [keys]) as string[];
}

function readFixture(fixture: Record<string, unknown>, keys: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of asKeys(keys)) {
    if (key in fixture) out[key] = fixture[key];
  }
  return out;
}

function stubLocalStorage(
  overrides: Partial<Record<"get" | "set" | "remove", ReturnType<typeof vi.fn>>> = {}
): void {
  localFixture = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (keys: unknown) => readFixture(localFixture, keys)),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(localFixture, items);
        }),
        remove: vi.fn(async (keys: unknown) => {
          for (const key of asKeys(keys)) delete localFixture[key];
        }),
        ...overrides
      }
    }
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ===== 纯逻辑夹具 =====

function fail(current: SearchProviderHealth | undefined, now: number, latencyMs = 10): SearchProviderHealth {
  return applySearchAttempt(current, false, latencyMs, now);
}

function pass(current: SearchProviderHealth | undefined, now: number, latencyMs = 10): SearchProviderHealth {
  return applySearchAttempt(current, true, latencyMs, now);
}

// 连败 3 次 = 一次触发（同一时刻三次失败：第 3 次触发，冷却期自 now 起算）。
function trigger(current: SearchProviderHealth | undefined, now: number): SearchProviderHealth {
  return fail(fail(fail(current, now), now), now);
}

describe("健康度常量（spec §12.4 / 票 15 §5 常量单源表）", () => {
  it("键 = biliscript_search_health；滑窗 20 / 阈值 3 / 初始 5min / 上限 60min", () => {
    expect(SEARCH_HEALTH_KEY).toBe("biliscript_search_health");
    expect(SEARCH_HEALTH_WINDOW).toBe(20);
    expect(SEARCH_COOLDOWN_FAILURE_THRESHOLD).toBe(3);
    expect(SEARCH_COOLDOWN_BASE_MS).toBe(5 * MINUTE);
    expect(SEARCH_COOLDOWN_MAX_MS).toBe(60 * MINUTE);
  });
});

describe("applySearchAttempt 滑窗与连败边界（§10 第 71、69 行）", () => {
  it("25 次记账 → 只留最近 20 条（旧 → 新，溢出丢头部）", () => {
    let health: SearchProviderHealth | undefined;
    for (let index = 0; index < 25; index += 1) {
      health = applySearchAttempt(health, index % 2 === 0, index, T0 + index);
    }

    expect(health!.attempts).toHaveLength(SEARCH_HEALTH_WINDOW);
    expect(health!.attempts[0].latencyMs).toBe(5);
    expect(health!.attempts[19].latencyMs).toBe(24);
  });

  it("attempts 记录 ok 与延迟；连败 2 次不触发（阈值边界 2→3）", () => {
    const health = fail(fail(undefined, T0, 12), T0 + 1, 34);

    expect(health.attempts).toEqual([
      { ok: false, latencyMs: 12 },
      { ok: false, latencyMs: 34 }
    ]);
    expect(health.consecutiveFailures).toBe(2);
    expect(health.cooldownLevel).toBe(0);
    expect(health.cooldownUntil).toBe(0);
  });

  it("第 3 次连续失败触发：level 1、until = now + 5min、连败计数归零（§12.4 第 3 条）", () => {
    const health = trigger(undefined, T0);

    expect(health.consecutiveFailures).toBe(0);
    expect(health.cooldownLevel).toBe(1);
    expect(health.cooldownUntil).toBe(T0 + 5 * MINUTE);
  });

  it("延迟脏值（非有限 / 负数）归 0；ok 非布尔按失败记账", () => {
    const health = applySearchAttempt(undefined, "yes", Number.NaN, T0) as SearchProviderHealth;
    const negative = applySearchAttempt(health, "no", -5, T0 + 1);

    expect(health.attempts).toEqual([{ ok: false, latencyMs: 0 }]);
    expect(negative.attempts[1]).toEqual({ ok: false, latencyMs: 0 });
  });

  it("纯函数不改写入参、返回新对象（成功与失败两条路径）", () => {
    const current: SearchProviderHealth = {
      attempts: [{ ok: false, latencyMs: 1 }],
      consecutiveFailures: 1,
      cooldownLevel: 0,
      cooldownUntil: 0
    };
    const snapshot = JSON.stringify(current);

    const failed = fail(current, T0);
    const succeeded = pass(current, T0);

    expect(JSON.stringify(current)).toBe(snapshot);
    expect(failed).not.toBe(current);
    expect(succeeded).not.toBe(current);
    expect(succeeded.attempts).toHaveLength(2);
  });
});

describe("冷却触发 / 翻倍 / 封顶 / 冷却期内不延长（§12.4 第 3 条 / §10 第 69 行）", () => {
  it("每再犯翻倍：5 / 10 / 20 / 40 / 60（封顶）/ 60 分钟，档位逐次 +1", () => {
    const durations: number[] = [];
    let health = trigger(undefined, T0);
    durations.push(health.cooldownUntil - T0);
    expect(health.cooldownLevel).toBe(1);

    for (let level = 2; level <= 6; level += 1) {
      const at = health.cooldownUntil + 1; // 冷却到期后的第一次尝试
      health = trigger(health, at);
      durations.push(health.cooldownUntil - at);
      expect(health.cooldownLevel).toBe(level);
    }

    expect(durations).toEqual([5, 10, 20, 40, 60, 60].map((minutes) => minutes * MINUTE));
  });

  it("冷却期内连败不再触发、不延长 cooldownUntil / 不推进档位", () => {
    const triggered = trigger(undefined, T0);

    const during = trigger(fail(triggered, T0 + 1_000), T0 + 2_000);

    expect(during.cooldownLevel).toBe(1);
    expect(during.cooldownUntil).toBe(triggered.cooldownUntil);
    // 连败计数照累加（只是不再触发）
    expect(during.consecutiveFailures).toBe(4);
  });

  it("now ≥ cooldownUntil 才允许再触发（到期即回链）", () => {
    const triggered = trigger(undefined, T0);

    const atDeadline = trigger(triggered, triggered.cooldownUntil);
    const beforeDeadline = trigger(triggered, triggered.cooldownUntil - 1);

    expect(atDeadline.cooldownLevel).toBe(2);
    expect(atDeadline.cooldownUntil).toBe(triggered.cooldownUntil + 10 * MINUTE);
    expect(beforeDeadline.cooldownLevel).toBe(1);
    expect(beforeDeadline.cooldownUntil).toBe(triggered.cooldownUntil);
  });
});

describe("成功一次三者同清（§12.4 第 4 条 / §10 第 70 行）", () => {
  it("失败 ×2 + 成功 → 连败计数 / 冷却截止 / 档位全部归零", () => {
    const health = pass(fail(fail(undefined, T0), T0), T0);

    expect(health).toMatchObject({ consecutiveFailures: 0, cooldownLevel: 0, cooldownUntil: 0 });
    expect(health.attempts).toHaveLength(3);
  });

  it("已触发过的档位也清零：下次再犯从 5 分钟重新起算（不是 10 分钟）", () => {
    const triggered = trigger(undefined, T0);
    const cleared = pass(triggered, triggered.cooldownUntil + 1);

    expect(cleared).toMatchObject({ consecutiveFailures: 0, cooldownLevel: 0, cooldownUntil: 0 });

    const again = trigger(cleared, T0 + 100 * MINUTE);
    expect(again.cooldownLevel).toBe(1);
    expect(again.cooldownUntil).toBe(T0 + 100 * MINUTE + 5 * MINUTE);
  });
});

describe("normalizeSearchHealthMap 脏值防御与冷却图（§12.4 第 6 条）", () => {
  const VALID = {
    attempts: [{ ok: true, latencyMs: 5 }],
    consecutiveFailures: 0,
    cooldownLevel: 0,
    cooldownUntil: 0
  };

  it("整图非对象 / 数组 / null → {}（脏值整体作废，不抛）", () => {
    for (const raw of [null, undefined, "junk", 7, [], [{ presetId: "tavily" }]]) {
      expect(normalizeSearchHealthMap(raw)).toEqual({});
    }
  });

  it("单条形状不可信（非对象 / attempts 非数组）丢该条，其余保留；空 / 空白键丢弃", () => {
    const map = normalizeSearchHealthMap({
      tavily: VALID,
      firecrawl: "junk",
      exa: { attempts: "junk", consecutiveFailures: 1, cooldownLevel: 0, cooldownUntil: 0 },
      "  ": VALID
    });

    expect(Object.keys(map)).toEqual(["tavily"]);
    expect(map.tavily).toEqual(VALID);
  });

  it("条内计数 / 截止 / 尝试项逐项归一：非法项剔除、非有限数与负数归 0、超窗截断", () => {
    const attempts = Array.from({ length: 25 }, (_value, index) => ({ ok: index % 2 === 0, latencyMs: index }));
    const map = normalizeSearchHealthMap({
      doubao: {
        attempts: [...attempts, null, "junk", { ok: "yes", latencyMs: -3 }],
        consecutiveFailures: -2,
        cooldownLevel: 1.5,
        cooldownUntil: "soon"
      }
    });

    // 25 条合法尝试 + 1 条归一后的尝试 = 26 → 截断到最近 20 条（丢头部 6 条）
    expect(map.doubao.attempts).toHaveLength(SEARCH_HEALTH_WINDOW);
    expect(map.doubao.attempts[0].latencyMs).toBe(6);
    expect(map.doubao.attempts[19]).toEqual({ ok: false, latencyMs: 0 });
    expect(map.doubao).toMatchObject({ consecutiveFailures: 0, cooldownLevel: 0, cooldownUntil: 0 });
  });

  it("cooldownUntilByPresetId 只含 cooldownUntil > now 的项；到期 / 未冷却 / 空图不出现", () => {
    const map = normalizeSearchHealthMap({
      tavily: { ...VALID, cooldownUntil: 2_000 },
      firecrawl: { ...VALID, cooldownUntil: 1_000 },
      exa: { ...VALID, cooldownUntil: 0 }
    });

    expect(cooldownUntilByPresetId(map, 1_000)).toEqual({ tavily: 2_000 });
    expect(cooldownUntilByPresetId(map, 2_000)).toEqual({});
    expect(cooldownUntilByPresetId(null, 1_000)).toEqual({});
  });
});

describe("search-health 薄 storage 层（§12.4 第 6–7、10 条）", () => {
  it("记账落 chrome.storage.local 单键、按 presetId 聚合、条目只含 ok 与延迟", async () => {
    stubLocalStorage();

    await recordSearchAttempt("tavily", true, 42, T0);
    await recordSearchAttempt("tavily", false, 7, T0 + 1);

    expect(Object.keys(localFixture)).toEqual([SEARCH_HEALTH_KEY]);
    const stored = localFixture[SEARCH_HEALTH_KEY] as Record<string, { attempts: unknown[] }>;
    expect(Object.keys(stored)).toEqual(["tavily"]);
    expect(stored.tavily.attempts).toEqual([
      { ok: true, latencyMs: 42 },
      { ok: false, latencyMs: 7 }
    ]);
    // 隐私：只存 ok / 延迟，无查询词 / 结果 / Key 字段
    expect(Object.keys(stored.tavily.attempts[0] as object)).toEqual(["ok", "latencyMs"]);
  });

  it("引擎级聚合：同一 presetId 的多次尝试落同一个 key（与记录 id 无关）", async () => {
    stubLocalStorage();

    await recordSearchAttempt("firecrawl", false, 1, T0);
    await recordSearchAttempt("firecrawl", false, 1, T0 + 1);
    await recordSearchAttempt("firecrawl", false, 1, T0 + 2);

    const stored = localFixture[SEARCH_HEALTH_KEY] as Record<string, SearchProviderHealth>;
    expect(Object.keys(stored)).toEqual(["firecrawl"]);
    expect(stored.firecrawl.cooldownLevel).toBe(1);
    expect(stored.firecrawl.cooldownUntil).toBe(T0 + 2 + 5 * MINUTE);
  });

  it("缺省 now = 当前时刻（SW 侧盖时间戳）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    stubLocalStorage();

    await recordSearchAttempt("tavily", false, 1);
    await recordSearchAttempt("tavily", false, 1);
    await recordSearchAttempt("tavily", false, 1);

    const stored = localFixture[SEARCH_HEALTH_KEY] as Record<string, SearchProviderHealth>;
    expect(stored.tavily.cooldownUntil).toBe(T0 + 5 * MINUTE);
  });

  it("读失败（storage.get 抛）→ readSearchHealth 回落 {}，不抛", async () => {
    stubLocalStorage({ get: vi.fn(async () => Promise.reject(new Error("storage failure"))) });

    await expect(readSearchHealth()).resolves.toEqual({});
  });

  it("读回脏值（整图 / 单条非法）→ 防御归一，不抛", async () => {
    stubLocalStorage();
    localFixture[SEARCH_HEALTH_KEY] = { tavily: "junk", firecrawl: null };

    await expect(readSearchHealth()).resolves.toEqual({});
  });

  it("写失败（storage.set 抛）→ 静默 no-op，不抛", async () => {
    stubLocalStorage({ set: vi.fn(async () => Promise.reject(new Error("quota exceeded"))) });

    await expect(recordSearchAttempt("tavily", false, 1, T0)).resolves.toBeUndefined();
  });

  it("脏载荷（presetId 空 / 空白 / ok 非布尔）→ 不写盘", async () => {
    stubLocalStorage();

    await recordSearchAttempt("", true, 1, T0);
    await recordSearchAttempt("   ", true, 1, T0);
    await recordSearchAttempt("tavily", "yes", 1, T0);
    await recordSearchAttempt(undefined, undefined, 1, T0);

    expect(localFixture[SEARCH_HEALTH_KEY]).toBeUndefined();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("SW 冷启动：模块零内存态，重新 import 后账仍在 storage 里（冷却不丢）", async () => {
    stubLocalStorage();
    const first = await import("../../extension/search/search-health.js");
    await first.recordSearchAttempt("tavily", false, 1, T0);
    await first.recordSearchAttempt("tavily", false, 1, T0 + 1);
    await first.recordSearchAttempt("tavily", false, 1, T0 + 2);

    vi.resetModules();
    const restarted = await import("../../extension/search/search-health.js");
    const map = await restarted.readSearchHealth();

    expect(map.tavily.attempts).toHaveLength(3);
    expect(map.tavily.cooldownLevel).toBe(1);
    expect(map.tavily.cooldownUntil).toBe(T0 + 2 + 5 * MINUTE);
  });
});
