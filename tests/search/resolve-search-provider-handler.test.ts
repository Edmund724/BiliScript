// tests/search/resolve-search-provider-handler.test.ts
// search/resolve-search-provider-handler.ts（链装配编排的 SW 端 handler 工厂）的
// 行为契约：五个读取 primitive 全部 fake 直驱，原 entry 层 10 个行为分支语义搬入
//（单选 / 智能哨兵与空串 / 用户序 / 脏序回落 / 免 Key 无 Key / 无合格记录 /
// 单选空链 / 免费额度无 Key 排除 / 有 Key 入链 / 未知 presetId 排除）+ 冷却归因支。
// 链的形状锁在回包全等断言里（spec §1 S4 单趟回传形状）。

import { describe, expect, it, vi } from "vitest";
import { createResolveSearchProviderHandler } from "../../extension/search/resolve-search-provider-handler.js";
import { SMART_SEARCH_ACTIVE_ID } from "../../extension/core/search-mode.js";
import type { ResolveSearchProviderResponse } from "../../extension/shared/messaging-protocol.js";
import type { SearchProvider } from "../../extension/search/search-provider-normalize.js";
import type { SearchHealthMap } from "../../extension/search/search-health.js";

const PROVIDER_ENTRY: SearchProvider = {
  id: "tavily",
  presetId: "tavily",
  name: "Tavily",
  type: "tavily",
  baseUrl: "https://api.tavily.com",
  enabled: true
};

const FIRECRAWL_ENTRY: SearchProvider = {
  id: "search_firecrawl",
  presetId: "firecrawl",
  name: "Firecrawl",
  type: "firecrawl",
  baseUrl: "https://api.firecrawl.dev",
  enabled: true
};

// free-quota 家（Exa）：无 Key 不进链、有 Key 才进（spec §2 调用形状表）
const EXA_ENTRY: SearchProvider = {
  id: "exa",
  presetId: "exa",
  name: "Exa",
  type: "exa",
  baseUrl: "https://api.exa.ai",
  enabled: true
};

const TAVILY_CANDIDATE = {
  provider: {
    id: "tavily",
    presetId: "tavily",
    name: "Tavily",
    type: "tavily",
    baseUrl: "https://api.tavily.com",
    access: "keyless"
  },
  apiKey: ""
};

const FIRECRAWL_CANDIDATE = {
  provider: {
    id: "search_firecrawl",
    presetId: "firecrawl",
    name: "Firecrawl",
    type: "firecrawl",
    baseUrl: "https://api.firecrawl.dev",
    access: "keyless"
  },
  apiKey: ""
};

interface Fixture {
  settings?: Record<string, unknown>;
  providers?: SearchProvider[];
  keys?: Record<string, string>;
  aiProviders?: Array<Record<string, unknown>>;
  aiKeys?: Record<string, string>;
  order?: string[];
  health?: SearchHealthMap;
}

function makeHandler(fixture: Fixture) {
  const reads = {
    getSettings: vi.fn(async () => fixture.settings ?? {}),
    getSearchStore: vi.fn(async () => ({ providers: fixture.providers ?? [], keys: fixture.keys ?? null })),
    getAiStore: vi.fn(async () => ({ providers: fixture.aiProviders ?? [], keys: fixture.aiKeys ?? null })),
    getOrder: vi.fn(async () => fixture.order ?? []),
    getHealth: vi.fn(async () => fixture.health ?? {})
  };
  const handler = createResolveSearchProviderHandler({ ...reads, now: () => 1000 });
  return { handler, reads };
}

function call(handler: (message: unknown, sender: unknown, sendResponse: (response: ResolveSearchProviderResponse) => void) => void) {
  return new Promise<ResolveSearchProviderResponse>((resolve) => {
    handler({ type: "resolve-search-provider" }, {}, (response) => resolve(response));
  });
}

describe("resolve-search-provider handler 工厂（链装配编排）", () => {
  it("单选（activeId = 记录 id）：只回那一条候选 + webSearchMaxToolCalls（无回退）", async () => {
    const { handler } = makeHandler({
      settings: { activeSearchProviderId: "tavily", webSearchMaxToolCalls: 5 },
      providers: [PROVIDER_ENTRY, FIRECRAWL_ENTRY],
      keys: { tavily: "tvly-key" }
    });

    const response = await call(handler);

    expect(response).toEqual({
      ok: true,
      chain: [{ ...TAVILY_CANDIDATE, apiKey: "tvly-key" }],
      maxToolCalls: 5
    });
  });

  it("智能（哨兵 / 空串）：chain 顺序 = 内置默认序（非预设表序）", async () => {
    for (const activeId of [SMART_SEARCH_ACTIVE_ID, ""]) {
      const { handler } = makeHandler({
        settings: { activeSearchProviderId: activeId },
        providers: [FIRECRAWL_ENTRY, PROVIDER_ENTRY]
      });

      const response = await call(handler);

      // 内置默认序 tavily(2) < firecrawl(3)；预设表序是 firecrawl 起头，故本断言能分辨两者
      expect(response.chain).toEqual([TAVILY_CANDIDATE, FIRECRAWL_CANDIDATE]);
    }
  });

  it("智能：searchProviderOrder 归一序优先于内置默认序（§10 第 60 行）", async () => {
    const { handler } = makeHandler({
      settings: { activeSearchProviderId: "" },
      order: ["search_firecrawl", "tavily"],
      providers: [FIRECRAWL_ENTRY, PROVIDER_ENTRY]
    });

    const response = await call(handler);

    expect(response.chain).toEqual([FIRECRAWL_CANDIDATE, TAVILY_CANDIDATE]);
  });

  it("智能：脏 order（含未知 id）整体作废 → 回落内置默认序", async () => {
    const { handler } = makeHandler({
      settings: { activeSearchProviderId: "" },
      order: ["search_ghost", "search_firecrawl"],
      providers: [FIRECRAWL_ENTRY, PROVIDER_ENTRY]
    });

    const response = await call(handler);

    expect(response.chain).toEqual([TAVILY_CANDIDATE, FIRECRAWL_CANDIDATE]);
  });

  it("keyless 无 Key 也产出 chain 候选（apiKey:''），必填性按预设 access 判", async () => {
    const { handler } = makeHandler({
      settings: { activeSearchProviderId: "tavily" },
      providers: [PROVIDER_ENTRY]
    });

    const response = await call(handler);

    expect(response.chain).toEqual([TAVILY_CANDIDATE]);
  });

  it("无任何在组记录：ok:true 且 chain 缺省（不算错误，也不带空链归因）", async () => {
    const { handler } = makeHandler({ settings: {} });

    const response = await call(handler);

    expect(response).toEqual({ ok: true });
    expect(response.chain).toBeUndefined();
    // 真的没有合格记录 = 未配置路径：不带 chainEmptyReason（spec §12.7 第 6 条翻案）
    expect(response.chainEmptyReason).toBeUndefined();
  });

  it("单选空链（选了未配 Key 的 free-quota）→ 不带空链归因（仍走「未配置」路径）", async () => {
    const { handler } = makeHandler({
      settings: { activeSearchProviderId: "exa" },
      providers: [EXA_ENTRY, PROVIDER_ENTRY]
    });

    const response = await call(handler);

    expect(response.chain).toBeUndefined();
    expect(response.chainEmptyReason).toBeUndefined();
  });

  it("free-quota 无 Key 不进链（同批 keyless 记录仍在链）", async () => {
    const { handler } = makeHandler({
      settings: { activeSearchProviderId: "" },
      providers: [EXA_ENTRY, PROVIDER_ENTRY]
    });

    const response = await call(handler);

    expect(response.chain).toEqual([TAVILY_CANDIDATE]);
  });

  it("free-quota 有 Key 进链，顺序按内置默认序（Exa 位次 1）", async () => {
    const { handler } = makeHandler({
      settings: { activeSearchProviderId: "" },
      providers: [PROVIDER_ENTRY, EXA_ENTRY],
      keys: { exa: "exa-key" }
    });

    const response = await call(handler);

    expect(response.chain).toEqual([
      {
        provider: { id: "exa", presetId: "exa", name: "Exa", type: "exa", baseUrl: "https://api.exa.ai", access: "free-quota" },
        apiKey: "exa-key"
      },
      TAVILY_CANDIDATE
    ]);
  });

  it("presetId 查不到预设表的记录不进链（脏值按最保守处理）", async () => {
    const { handler } = makeHandler({
      settings: { activeSearchProviderId: "" },
      providers: [
        { id: "search_brave", presetId: "brave", name: "Brave", type: "tavily", baseUrl: "https://api.search.brave.com", enabled: true },
        PROVIDER_ENTRY
      ]
    });

    const response = await call(handler);

    expect(response.chain).toEqual([TAVILY_CANDIDATE]);
  });

  it("智能链合格记录全在冷却中 → 空链归因 cooldown（§12.7 第 6 条）", async () => {
    const { handler } = makeHandler({
      settings: { activeSearchProviderId: "" },
      providers: [PROVIDER_ENTRY],
      health: { tavily: { attempts: [], consecutiveFailures: 3, cooldownLevel: 1, cooldownUntil: 2000 } }
    });

    const response = await call(handler);

    expect(response).toEqual({ ok: true, chainEmptyReason: "cooldown" });
  });
});
