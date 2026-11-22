import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSubtitleBody } from "../setup.js";
import { runLadderChat } from "../../extension/ai/ladder.js";
import { runOverviewAnalysis } from "../../extension/ai/analysis.js";
import { noteUsageSample, resetUsageStatsForTests } from "../../extension/ai/usage-stats.js";

const PROVIDER = { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };
const OTHER_MODEL = { baseUrl: PROVIDER.baseUrl, model: "other-model", apiKey: "sk-test" };

type ChainProvider = typeof PROVIDER;

const MATERIAL_CHARS = 250000;

function tokenNumberOf(message: string): number {
  const matched = /约 ([\d,]+) token/.exec(message);
  if (!matched) {
    throw new Error(`护栏文案里没有 token 数字：${message}`);
  }
  return Number(matched[1].replace(/,/g, ""));
}

async function runLadderGuard(subtitleChars: number, provider: ChainProvider) {
  const guardMessages: string[] = [];
  const streamChat = vi.fn(async () => ({ done: true as const }));
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

async function runOverviewGuard(subtitleChars: number, provider: ChainProvider): Promise<string> {
  let message = "";
  await expect(
    runOverviewAnalysis(
      {
        provider,
        context: { title: "测试视频", author: "UP", subtitleBody: makeSubtitleBody(subtitleChars) },
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
