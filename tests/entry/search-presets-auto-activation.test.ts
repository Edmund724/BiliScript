// 免 Key 预设自动激活（spec §1 S2 / §2「自动激活规则（S2 展开）」/ §3 落点表第 12 行
// / §10 第 56 行）：
//   ① 决策半边是纯函数 entry/settings-migration.ts 的 planSearchPresetsAutoActivation
//      ——本文件第一个 describe 覆盖决策面（补齐集合、链首、flag、幂等）；
//   ② background onInstalled 的接线面——写入顺序固定「记录 → 链首 → flag」，flag
//      最后写，任一步失败时下一次 onInstalled 重试整段；判据按 presetId 查缺使重试安全。
// chrome stub 手法与 tests/core/settings-normalization.test.ts 同款（真实 background
// 入口 + onInstalled 监听器直调 + 写回 fixture 的真实存储替身）。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";
import { SEARCH_PROVIDER_PRESETS } from "../../extension/core/presets.js";
import { SMART_SEARCH_ACTIVE_ID } from "../../extension/core/search-mode.js";
import { planSearchPresetsAutoActivation } from "../../extension/entry/settings-migration.js";

const KEYLESS_PRESETS = SEARCH_PROVIDER_PRESETS.filter((preset) => preset.access === "keyless");

// 自动补齐的记录形状（spec §2：「id = "search_" + preset.id、presetId / name / type /
// baseUrl 取预设、enabled: true、无 Key」——不带 apiKey，也不带 access 副本）。
const EXPECTED_KEYLESS_RECORDS = KEYLESS_PRESETS.map((preset) => ({
  id: `search_${preset.id}`,
  presetId: preset.id,
  name: preset.name,
  type: preset.type,
  baseUrl: preset.baseUrl,
  enabled: true
}));

describe("planSearchPresetsAutoActivation 决策", () => {
  it("未置位：补齐四条 keyless 记录 + 写智能哨兵 + 置 flag（§10 第 84 行）", () => {
    const decision = planSearchPresetsAutoActivation({}, []);

    expect(decision.providersToAdd).toEqual(EXPECTED_KEYLESS_RECORDS);
    expect(decision.activeSearchProviderId).toBe(SMART_SEARCH_ACTIVE_ID);
    expect(decision.shouldWriteFlag).toBe(true);
  });

  it("豆包 / Exa（free-quota）不自动建", () => {
    const ids = planSearchPresetsAutoActivation({}, []).providersToAdd.map((record) => record.id);

    expect(ids).not.toContain("search_doubao");
    expect(ids).not.toContain("search_exa");
    expect(ids).toEqual(["search_firecrawl", "search_tavily", "search_anysearch", "search_parallel"]);
  });

  it("已有同 presetId 记录（含生成式 id）→ 不重建、不返回改写（判据是 presetId 而非 id）", () => {
    const decision = planSearchPresetsAutoActivation({}, [{ id: "my-firecrawl", presetId: "firecrawl" }]);

    expect(decision.providersToAdd.map((record) => record.id)).toEqual([
      "search_tavily",
      "search_anysearch",
      "search_parallel"
    ]);
  });

  it("已有链首指向存在记录 → 不重排不改写（决策不携带 activeSearchProviderId）", () => {
    const decision = planSearchPresetsAutoActivation({ activeSearchProviderId: "my-firecrawl" }, [
      { id: "my-firecrawl", presetId: "firecrawl" }
    ]);

    expect(decision.activeSearchProviderId).toBeUndefined();
    expect(decision.shouldWriteFlag).toBe(true);
  });

  it("链首为空或悬空（指向不存在的记录）→ 写智能哨兵（不再写 search_firecrawl）", () => {
    for (const activeId of ["", "  ", "search_brave"]) {
      const decision = planSearchPresetsAutoActivation({ activeSearchProviderId: activeId }, [
        { id: "tavily-picked", presetId: "tavily" }
      ]);

      expect(decision.activeSearchProviderId).toBe(SMART_SEARCH_ACTIVE_ID);
    }
  });

  it("链首已是智能哨兵 → 不重写（哨兵不算悬空，§6.8）", () => {
    const decision = planSearchPresetsAutoActivation({ activeSearchProviderId: SMART_SEARCH_ACTIVE_ID }, [
      { id: "tavily-picked", presetId: "tavily" }
    ]);

    expect(decision.activeSearchProviderId).toBeUndefined();
    expect(decision.shouldWriteFlag).toBe(true);
  });

  it("flag 已置位 → 整体跳过：不加记录、不动链首、不重写 flag", () => {
    const decision = planSearchPresetsAutoActivation(
      { searchPresetsAutoActivated: true, activeSearchProviderId: "" },
      []
    );

    expect(decision).toEqual({ providersToAdd: [], shouldWriteFlag: false });
  });

  it("重跑幂等：补齐后的记录集下第二次无写入（flag 未落盘的重试同样不重复补）", () => {
    const first = planSearchPresetsAutoActivation({}, []);
    const applied = first.providersToAdd.map((record) => ({ ...record }));

    const second = planSearchPresetsAutoActivation(
      { searchPresetsAutoActivated: true, activeSearchProviderId: first.activeSearchProviderId },
      applied
    );
    expect(second).toEqual({ providersToAdd: [], shouldWriteFlag: false });

    const retryWithoutFlag = planSearchPresetsAutoActivation(
      { activeSearchProviderId: first.activeSearchProviderId },
      applied
    );
    expect(retryWithoutFlag.providersToAdd).toEqual([]);
  });
});

// ===== background onInstalled 接线 =====

let syncFixture: Record<string, unknown>;
let localFixture: Record<string, unknown>;
let syncSetMock: Mock;
let localSetMock: Mock;
// 首次记录写入失败的重试用例开关
let failProviderWrite: boolean;

function readFixture(fixture: Record<string, unknown>, keys: unknown): Record<string, unknown> {
  const requested = (
    Array.isArray(keys) ? keys : keys && typeof keys === "object" ? Object.keys(keys) : [keys]
  ) as string[];
  const out: Record<string, unknown> = {};
  for (const key of requested) {
    if (key in fixture) out[key] = fixture[key];
  }
  return out;
}

function stubBackgroundStorage() {
  syncFixture = {};
  localFixture = {};
  failProviderWrite = false;
  syncSetMock = vi.fn(async (obj: Record<string, unknown>) => {
    if (failProviderWrite && "searchProviders" in obj) {
      throw new Error("QUOTA_BYTES_PER_ITEM quota exceeded");
    }
    Object.assign(syncFixture, obj);
  });
  localSetMock = vi.fn(async (obj: Record<string, unknown>) => {
    Object.assign(localFixture, obj);
  });
  vi.stubGlobal("chrome", {
    ...globalThis.chrome,
    runtime: {
      ...globalThis.chrome?.runtime,
      lastError: null,
      getURL: (path: string) => `chrome-extension://test/${path}`,
      sendMessage: vi.fn((_message, callback) => {
        callback?.({ ok: true });
        return undefined;
      }),
      getManifest: vi.fn(() => ({ version: "2.0.0" })),
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn() }
    },
    tabs: { ...globalThis.chrome?.tabs, onUpdated: { addListener: vi.fn() } },
    storage: {
      ...globalThis.chrome?.storage,
      sync: {
        ...globalThis.chrome?.storage?.sync,
        get: vi.fn(async (keys: unknown) => readFixture(syncFixture, keys)),
        set: syncSetMock
      },
      local: {
        ...globalThis.chrome?.storage?.local,
        get: vi.fn(async (keys: unknown) => readFixture(localFixture, keys)),
        set: localSetMock
      }
    }
  });
}

async function importOnInstalledListener(): Promise<() => Promise<void>> {
  await import("../../extension/entry/background.js");
  return vi.mocked(chrome.runtime.onInstalled.addListener).mock.calls[0][0] as unknown as () => Promise<void>;
}

function syncWriterPayloads(): Array<Record<string, unknown>> {
  return syncSetMock.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

beforeEach(() => {
  resetModuleState();
  stubBackgroundStorage();
});

describe("onInstalled 免 Key 预设自动激活接线", () => {
  it("首次安装：补齐四条 keyless 记录 + 写智能哨兵，flag 最后写，且不写任何 Key", async () => {
    const onInstalled = await importOnInstalledListener();

    await onInstalled();

    expect(syncFixture.searchProviders).toEqual(EXPECTED_KEYLESS_RECORDS);
    expect(syncFixture.activeSearchProviderId).toBe(SMART_SEARCH_ACTIVE_ID);
    expect(syncFixture.searchPresetsAutoActivated).toBe(true);
    // 自动补齐的记录不带 Key：local 侧只有 provider-store 写回的同一份空映射
    expect(localFixture.searchProviderKeys).toEqual({});

    // 写入顺序 = 记录 → 链首 → flag（flag 是最后一次 sync.set）
    const payloads = syncWriterPayloads();
    const providerWriteIndex = payloads.findIndex((obj) => "searchProviders" in obj);
    const activeWriteIndex = payloads.findIndex((obj) => Object.keys(obj).join(",") === "activeSearchProviderId");
    const flagWriteIndex = payloads.findIndex((obj) => Object.keys(obj).join(",") === "searchPresetsAutoActivated");
    expect(providerWriteIndex).toBeGreaterThan(-1);
    expect(activeWriteIndex).toBeGreaterThan(providerWriteIndex);
    expect(flagWriteIndex).toBeGreaterThan(activeWriteIndex);
    expect(flagWriteIndex).toBe(payloads.length - 1);
  });

  it("已有链首指向存在记录 → 不重排不改写；补齐不新增同 presetId 记录", async () => {
    syncFixture.activeSearchProviderId = "tavily-picked";
    syncFixture.searchProviders = [
      { id: "tavily-picked", presetId: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com", enabled: true }
    ];
    const onInstalled = await importOnInstalledListener();

    await onInstalled();

    expect(syncFixture.activeSearchProviderId).toBe("tavily-picked");
    const records = syncFixture.searchProviders as Array<Record<string, unknown>>;
    expect(records.filter((record) => record.presetId === "tavily")).toEqual([
      { id: "tavily-picked", presetId: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com", enabled: true }
    ]);
    expect(records.map((record) => record.id)).toEqual([
      "tavily-picked",
      "search_firecrawl",
      "search_anysearch",
      "search_parallel"
    ]);
  });

  it("手加过生成式 id 的 Firecrawl 记录：补齐后仍只有一条 Firecrawl，其 id / Key / enabled 均未变", async () => {
    syncFixture.searchProviders = [
      {
        id: "my-firecrawl",
        presetId: "firecrawl",
        name: "我的 Firecrawl",
        type: "firecrawl",
        baseUrl: "https://api.firecrawl.dev",
        enabled: false
      }
    ];
    localFixture.searchProviderKeys = { "my-firecrawl": "fc-key" };
    const onInstalled = await importOnInstalledListener();

    await onInstalled();

    const records = syncFixture.searchProviders as Array<Record<string, unknown>>;
    expect(records.filter((record) => record.presetId === "firecrawl")).toEqual([
      {
        id: "my-firecrawl",
        presetId: "firecrawl",
        name: "我的 Firecrawl",
        type: "firecrawl",
        baseUrl: "https://api.firecrawl.dev",
        enabled: false
      }
    ]);
    expect(records.map((record) => record.id)).toEqual([
      "my-firecrawl",
      "search_tavily",
      "search_anysearch",
      "search_parallel"
    ]);
    expect(localFixture.searchProviderKeys).toEqual({ "my-firecrawl": "fc-key" });
  });

  it("flag 最后写：记录写入失败 → flag 不写；下一次 onInstalled 重试整段", async () => {
    const onInstalled = await importOnInstalledListener();
    failProviderWrite = true;

    await onInstalled();

    expect(syncFixture.searchProviders).toBeUndefined();
    expect(syncFixture.searchPresetsAutoActivated).not.toBe(true);

    failProviderWrite = false;
    await onInstalled();

    expect(syncFixture.searchProviders).toEqual(EXPECTED_KEYLESS_RECORDS);
    expect(syncFixture.searchPresetsAutoActivated).toBe(true);
  });

  it("重跑幂等：第二次 onInstalled 不再写记录（无重复行、链首与 flag 不重写）", async () => {
    const onInstalled = await importOnInstalledListener();
    await onInstalled();
    const recordsAfterFirst = JSON.parse(JSON.stringify(syncFixture.searchProviders)) as unknown;
    syncSetMock.mockClear();
    localSetMock.mockClear();

    await onInstalled();

    expect(syncFixture.searchProviders).toEqual(recordsAfterFirst);
    expect((syncFixture.searchProviders as unknown[]).length).toBe(KEYLESS_PRESETS.length);
    expect(syncWriterPayloads().some((obj) => "searchProviders" in obj)).toBe(false);
    expect(localSetMock).not.toHaveBeenCalled();
  });

  it("flag 置位后（用户删光记录）→ 不再自动激活：不加记录、不动链首", async () => {
    syncFixture.searchPresetsAutoActivated = true;
    syncFixture.activeSearchProviderId = "";
    const onInstalled = await importOnInstalledListener();

    await onInstalled();

    expect(syncFixture.searchProviders).toBeUndefined();
    expect(syncFixture.activeSearchProviderId).toBe("");
  });
});
