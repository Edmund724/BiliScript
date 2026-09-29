// ai-usage-telemetry T2b 单测：成本护栏数字两链同源。
// 断言方式是端到端的两条真实链路——ladder（阶梯分派）与 runOverviewAnalysis（概览分段），
// 各自经真实的 buildCostGuardNotice 生成用户可见文案，再从「约 X token」里取数字比对：
// 同一 scope + 同一 totalChars 下两条链的数字必须逐字相同（有样本用实测比、无样本回落
// CHAR_PER_TOKEN 都如此），且换 scope 后两条链一起回落。
// 同时锁「数字纯展示」：学到的比把 token 数字拉小也不影响 shouldPrompt（只看调用数），
// 阶梯判定仍比字符数 vs MATERIAL_BUDGET_CHARS（100k 字符不进分段、不弹护栏）。
// 失败方式先行：两条链各自直算（一处传字符、一处传 token 或另写换算），scope 一侧漏传
// generator/provider 导致回落不同，实测比把 shouldPrompt 也带偏。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSubtitleBody } from "../setup.js";
import { runLadderChat } from "../../extension/ai/ladder.js";
import { runOverviewAnalysis } from "../../extension/ai/analysis.js";
import { noteUsageSample, resetUsageStatsForTests } from "../../extension/ai/usage-stats.js";

const PROVIDER = { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };
const OTHER_MODEL = { baseUrl: PROVIDER.baseUrl, model: "other-model", apiKey: "sk-test" };

// 两条链共用的 provider 形状（同时满足 ladder 的 ChatProvider 窄面与概览的 ProviderRequest）。
type ChainProvider = typeof PROVIDER;

// 250k 字符 = 5 段 × 50k → 两链都进分段路径，护栏必弹（≥ COST_GUARD_MIN_CALLS）。
const MATERIAL_CHARS = 250000;

function tokenNumberOf(message: string): number {
  const matched = /约 ([\d,]+) token/.exec(message);
  if (!matched) {
    throw new Error(`护栏文案里没有 token 数字：${message}`);
  }
  return Number(matched[1].replace(/,/g, ""));
}

// ladder 链：真实 buildBudgetPlan + 真实 buildCostGuardNotice（都不注入），
// 只注入会读缓存/网络的 followup 与确认钩子；取消即停，护栏文案就是最终产物。
async function runLadderGuard(subtitleChars: number, provider: ChainProvider) {
  const guardMessages: string[] = [];
  const streamChat = vi.fn(async () => "ok");
  await runLadderChat(
    {
      msg: { context: { subtitleBody: makeSubtitleBody(subtitleChars), chapters: [] }, prompt: "总结" },
      provider,
      port: { postMessage: () => {} },
      signal: null
    },
    {
      streamChat,
      resolveFollowupContext: vi.fn(async () => null),
      askCostGuard: vi.fn(async (_port, message: string) => {
        guardMessages.push(message);
        return false;
      })
    }
  );
  return { guardMessages, streamChat };
}

// 概览链：同样真实 buildBudgetPlan + 真实 buildCostGuardNotice；拒绝确认 → cancelled。
async function runOverviewGuard(subtitleChars: number, provider: ChainProvider): Promise<string> {
  let message = "";
  await expect(
    runOverviewAnalysis(
      {
        provider,
        context: { title: "测试视频", author: "UP", subtitleBody: makeSubtitleBody(subtitleChars) },
        // 跳过整份缓存读与进行中 promise 复用：每条用例都要真跑一次护栏判定。
        forceRefresh: true
      },
      {
        askCostGuard: vi.fn(async (m: string) => {
          message = m;
          return false;
        })
      }
    )
  ).rejects.toMatchObject({ cancelled: true });
  return message;
}

beforeEach(() => {
  resetUsageStatsForTests();
});

describe("成本护栏数字两链同源", () => {
  it("无样本：两链都回落 CHAR_PER_TOKEN，数字相同（= 总字符数）", async () => {
    const ladder = await runLadderGuard(MATERIAL_CHARS, PROVIDER);
    const overview = await runOverviewGuard(MATERIAL_CHARS, PROVIDER);

    expect(ladder.guardMessages).toEqual(["预计约 6 次调用 / 约 250,000 token，可取消"]);
    expect(tokenNumberOf(ladder.guardMessages[0])).toBe(250000);
    expect(tokenNumberOf(overview)).toBe(250000);
    expect(tokenNumberOf(ladder.guardMessages[0])).toBe(tokenNumberOf(overview));
  });

  it("有样本：两链都用同一实测比（2.5）算出同一个数字", async () => {
    noteUsageSample(PROVIDER, { payloadChars: 1000, inputTokens: 400 });

    const ladder = await runLadderGuard(MATERIAL_CHARS, PROVIDER);
    const overview = await runOverviewGuard(MATERIAL_CHARS, PROVIDER);

    expect(tokenNumberOf(ladder.guardMessages[0])).toBe(100000);
    expect(tokenNumberOf(overview)).toBe(100000);
  });

  it("scope 隔离：别的模型无样本时两链一起回落（不是全局混样）", async () => {
    noteUsageSample(PROVIDER, { payloadChars: 1000, inputTokens: 400 });

    const ladder = await runLadderGuard(MATERIAL_CHARS, OTHER_MODEL);
    const overview = await runOverviewGuard(MATERIAL_CHARS, OTHER_MODEL);

    expect(tokenNumberOf(ladder.guardMessages[0])).toBe(250000);
    expect(tokenNumberOf(overview)).toBe(250000);
  });

  it("token 数字纯展示：实测比把数字拉小，shouldPrompt 仍只由调用数决定", async () => {
    // 比 20 → 数字 12,500（远小于字符数），调用数仍是 6/5 ≥ 5。
    noteUsageSample(PROVIDER, { payloadChars: 2000, inputTokens: 100 });

    const ladder = await runLadderGuard(MATERIAL_CHARS, PROVIDER);
    const overview = await runOverviewGuard(MATERIAL_CHARS, PROVIDER);

    expect(ladder.guardMessages).toHaveLength(1);
    expect(tokenNumberOf(ladder.guardMessages[0])).toBe(12500);
    expect(tokenNumberOf(overview)).toBe(12500);
  });

  it("阶梯判定路径未改：100k 字符仍走单次（不弹护栏、不进分段）", async () => {
    noteUsageSample(PROVIDER, { payloadChars: 2000, inputTokens: 100 });

    const ladder = await runLadderGuard(100000, PROVIDER);

    expect(ladder.guardMessages).toEqual([]);
    expect(ladder.streamChat).toHaveBeenCalledTimes(1);
  });
});
