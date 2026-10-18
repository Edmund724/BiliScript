// 付费平台（GLOSSARY「付费平台」，SearchProviderAccess 的 "paid"）链行为测试：
//   ① 链装配过滤：智能链开关关 → paid 跳过；开 → 入链（默认序末位）；无 Key（凭据
//      引用解析产物为空）→ 跳过；单选不受开关限制；
//   ② 执行器付费可见性：付费平台成功 → outcome.paid；付费平台失败（402/429/超时）
//      后回退成功 → outcome.paidFallback（reason 映射）+ formatPaidFallbackNotice 文案；
//      全部失败仍走既有整链无果错误（含额度类终态文案）。
// 不写真付费请求：执行器全部走注入桩。
import { describe, expect, it } from "vitest";
import { SEARCH_PROVIDER_PRESETS } from "../../extension/core/presets.js";
import type { SearchProvider } from "../../extension/search/search-provider-normalize.js";
import {
  executeSearchChain,
  formatPaidFallbackNotice,
  resolveSearchChain,
  SEARCH_QUOTA_MESSAGE,
  type SearchChainCandidate
} from "../../extension/search/search-chain.js";

const DEEPSEEK_RECORD: SearchProvider = {
  id: "search_deepseek",
  presetId: "deepseek",
  name: "DeepSeek Search",
  type: "deepseek",
  baseUrl: "https://api.deepseek.com",
  enabled: true
};
const TAVILY_RECORD: SearchProvider = {
  id: "search_tavily",
  presetId: "tavily",
  name: "Tavily",
  type: "tavily",
  baseUrl: "https://api.tavily.com",
  enabled: true
};

function paidCandidate(): SearchChainCandidate {
  return {
    provider: {
      id: DEEPSEEK_RECORD.id,
      presetId: "deepseek",
      name: "DeepSeek Search",
      type: "deepseek",
      baseUrl: "https://api.deepseek.com",
      access: "paid"
    },
    apiKey: "sk-deepseek"
  };
}

function smartOptions(overrides: Record<string, unknown> = {}) {
  return { mode: "smart" as const, order: [], cooldownUntil: {}, now: 0, ...overrides };
}

describe("链装配：付费候选过滤（GLOSSARY「付费平台」）", () => {
  it("智能链：开关关 → paid 候选跳过（即便有 Key）", () => {
    const resolved = resolveSearchChain(
      [DEEPSEEK_RECORD, TAVILY_RECORD],
      {},
      "__smart__",
      SEARCH_PROVIDER_PRESETS,
      smartOptions({ allowPaid: false, paidKeys: { deepseek: "sk-deepseek" } })
    );
    expect(resolved.chain.map((c) => c.provider.presetId)).toEqual(["tavily"]);
  });

  it("智能链：开关开 + 有 Key → paid 入链，且默认序排末位", () => {
    const resolved = resolveSearchChain(
      [DEEPSEEK_RECORD, TAVILY_RECORD],
      {},
      "__smart__",
      SEARCH_PROVIDER_PRESETS,
      smartOptions({ allowPaid: true, paidKeys: { deepseek: "sk-deepseek" } })
    );
    expect(resolved.chain.map((c) => c.provider.presetId)).toEqual(["tavily", "deepseek"]);
    // 候选带出 access 与凭据引用解析的 Key（执行器付费标注 / 适配器鉴权用）
    const deepseek = resolved.chain[1];
    expect(deepseek.provider.access).toBe("paid");
    expect(deepseek.apiKey).toBe("sk-deepseek");
  });

  it("智能链：开关开但无 Key（凭据引用解析产物为空）→ 跳过（同 free-quota 无 Key 口径）", () => {
    const resolved = resolveSearchChain(
      [DEEPSEEK_RECORD],
      {},
      "__smart__",
      SEARCH_PROVIDER_PRESETS,
      smartOptions({ allowPaid: true, paidKeys: { deepseek: "" } })
    );
    expect(resolved.chain).toEqual([]);
  });

  it("单选：付费平台不受开关限制（单选本身是显式付费意图），有 Key 即独苗链", () => {
    const resolved = resolveSearchChain(
      [DEEPSEEK_RECORD, TAVILY_RECORD],
      {},
      "search_deepseek",
      SEARCH_PROVIDER_PRESETS,
      { mode: "single", order: [], cooldownUntil: {}, now: 0, allowPaid: false, paidKeys: { deepseek: "sk-deepseek" } }
    );
    expect(resolved.chain).toHaveLength(1);
    expect(resolved.chain[0].provider.presetId).toBe("deepseek");
  });

  it("单选：无 Key 仍是空链（走既有「未配置」路径）", () => {
    const resolved = resolveSearchChain(
      [DEEPSEEK_RECORD],
      {},
      "search_deepseek",
      SEARCH_PROVIDER_PRESETS,
      { mode: "single", order: [], cooldownUntil: {}, now: 0, allowPaid: true, paidKeys: { deepseek: "" } }
    );
    expect(resolved.chain).toEqual([]);
  });
});

describe("执行器：付费可见性标注", () => {
  const tavilyCandidate: SearchChainCandidate = {
    provider: { id: "search_tavily", presetId: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com" },
    apiKey: ""
  };

  it("付费平台成功 → outcome.paid = true（来源列表「付费」徽标的输入）", async () => {
    const outcome = await executeSearchChain([paidCandidate()], "query", {
      execute: async () => ({ results: [{ title: "t", url: "https://x", snippet: "s" }], platform: "DeepSeek Search" }),
      recordAttempt: () => {}
    });
    expect(outcome.paid).toBe(true);
    expect(outcome.paidFallback).toBeUndefined();
    expect(outcome.platform).toBe("DeepSeek Search");
  });

  it("402 余额不足 → 回退成功带 paidFallback（reason balance）", async () => {
    const outcome = await executeSearchChain([paidCandidate(), tavilyCandidate], "query", {
      execute: async (candidate) => {
        if (candidate.provider.presetId === "deepseek") {
          throw Object.assign(new Error("HTTP 402"), { status: 402 });
        }
        return { results: [{ title: "t", url: "https://x", snippet: "s" }], platform: "Tavily" };
      },
      recordAttempt: () => {}
    });
    expect(outcome.platform).toBe("Tavily");
    expect(outcome.paid).toBeUndefined();
    expect(outcome.paidFallback).toEqual({ platform: "DeepSeek Search", reason: "balance", fallbackTo: "Tavily" });
  });

  it("429 限速 → reason rate-limit；超时 / 网络错误 → reason timeout", async () => {
    const run = async (error: unknown) => {
      const calls: string[] = [];
      const outcome = await executeSearchChain([paidCandidate(), tavilyCandidate], "query", {
        execute: async (candidate) => {
          calls.push(candidate.provider.presetId);
          if (candidate.provider.presetId === "deepseek") throw error;
          return { results: [], platform: "Tavily" };
        },
        recordAttempt: () => {}
      });
      return outcome.paidFallback;
    };
    expect(await run(Object.assign(new Error("HTTP 429"), { status: 429 }))).toMatchObject({ reason: "rate-limit" });
    expect(await run(new Error("请求超时，请检查 baseUrl 或稍后重试"))).toMatchObject({ reason: "timeout" });
  });

  it("非付费候选失败维持既有静默纪律：回退成功不带 paidFallback", async () => {
    const outcome = await executeSearchChain([tavilyCandidate, paidCandidate()], "query", {
      execute: async (candidate) => {
        if (candidate.provider.presetId === "tavily") throw Object.assign(new Error("HTTP 429"), { status: 429 });
        return { results: [], platform: "DeepSeek Search" };
      },
      recordAttempt: () => {}
    });
    expect(outcome.paid).toBe(true);
    expect(outcome.paidFallback).toBeUndefined();
  });

  it("整链全挂仍走既有终态：402 在列 → 额度类文案（付费失败不特殊化整链错误）", async () => {
    await expect(
      executeSearchChain([paidCandidate()], "query", {
        execute: async () => {
          throw Object.assign(new Error("HTTP 402"), { status: 402 });
        },
        recordAttempt: () => {}
      })
    ).rejects.toMatchObject({ searchFailureClass: "quota", message: SEARCH_QUOTA_MESSAGE });
  });
});

describe("formatPaidFallbackNotice：额度类与超时/网络类分文案", () => {
  it("余额不足 / 已达限速 / 请求超时三档措辞", () => {
    expect(
      formatPaidFallbackNotice({ platform: "DeepSeek Search", reason: "balance", fallbackTo: "Tavily" })
    ).toBe("DeepSeek Search 搜索不可用（余额不足），已回退至 Tavily");
    expect(
      formatPaidFallbackNotice({ platform: "DeepSeek Search", reason: "rate-limit", fallbackTo: "Tavily" })
    ).toBe("DeepSeek Search 搜索不可用（已达限速），已回退至 Tavily");
    expect(
      formatPaidFallbackNotice({ platform: "DeepSeek Search", reason: "timeout", fallbackTo: "豆包" })
    ).toBe("DeepSeek Search 搜索不可用（请求超时），已回退至 豆包");
  });
});
