// 端到端走查（用户报障 2026-09-30，BV1q9He6SEyX）：置顶长评论的目录被 500 字截断
// 拦腰切断（渲染出「语言轴：一个词 ag」这类半截标题）、第二段目录发在楼中楼里整段
// 丢失，概览分章因此断尾且逐章 AI 简介过长。本文件跑全链真实模块，只假 transport
// 与模型两头：
//
//   B 站热评接口（含楼中楼）→ fetchHotCommentsJson → 热评全文通道
//   → resolveChapterSource 目录解析（顶层正文 + 楼中楼续篇）→ runOverviewAnalysis
//   产物 → buildMessages 聊天展示
//
// 拍板口径：评论/简介时间轴目录（outline 来源）章节只留标题、不写 AI 简介，金句照常；
// 视频内官方章节（manuscript）与 AI 自由分章（auto）保留逐章简介。渲染侧（空简介
// 不出简介区块）回归在 tests/reader/overview.test.ts。
// 走查末尾写出可复现工件（.scratch/tickets/outline-titles-only/artifacts/01-e2e-walkthrough.md）。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, makeSubtitleBody } from "../setup.js";

let gateway: typeof import("../../extension/bilibili/gateway.js");
let outline: typeof import("../../extension/shared/chapter-outline.js");
let analysis: typeof import("../../extension/ai/analysis.js");
let context: typeof import("../../extension/ai/context.js");

// 内存 Map 实现的 chrome.storage.local（管线缓存族要用）。
function createMemoryStorage() {
  const map = new Map();
  const local = {
    get: vi.fn(async (keys) => {
      if (keys === null || keys === undefined) return Object.fromEntries(map.entries());
      const want = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of want) {
        if (map.has(k)) out[k] = map.get(k);
      }
      return out;
    }),
    set: vi.fn(async (items) => {
      for (const [key, value] of Object.entries(items)) map.set(key, value);
    }),
    remove: vi.fn(async (keys) => {
      const want = Array.isArray(keys) ? keys : [keys];
      for (const k of want) map.delete(k);
    })
  };
  return { map, local };
}

async function importModules() {
  vi.resetModules();
  resetModuleState();
  const storage = createMemoryStorage();
  vi.stubGlobal("chrome", { storage: { local: storage.local } });
  gateway = await import("../../extension/bilibili/gateway.js");
  outline = await import("../../extension/shared/chapter-outline.js");
  analysis = await import("../../extension/ai/analysis.js");
  context = await import("../../extension/ai/context.js");
}

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// —— 实跑样本形状（BV1q9He6SEyX，2026-09-30）：置顶长目录评论 + 它的楼中楼续篇 ——

// 9 行 × 53 字符 + 行间换行 = 485 字符：第 500 字符落在「25:00 核心原则…」标题中部，
// 旧 slice(0, 500) 在这里拦腰切断，其后的「30:00 尾声」整行位于 500 之外。
const HEAD_LINES = Array.from({ length: 9 }, (_, i) => `0${i}:00 小节${i}：${"甲".repeat(43)}`).join("\n");
const PINNED_MESSAGE = `${HEAD_LINES}\n25:00 核心原则：智能体设计的五个层次`;

// 楼中楼续篇：置顶评论的子评论，承载 25:00 之后的目录（旧实现整段抓不到）
const SUB_REPLY_MESSAGE = "30:00 尾声";

const PINNED_ROOT = {
  rpid: 315310607649,
  member: { uname: "硅谷101" },
  like: 520,
  content: { message: PINNED_MESSAGE }
};

function fakeTransport(routes: [match: string, handler: unknown][]) {
  const calls: string[] = [];
  const transport = vi.fn(async (url: string) => {
    calls.push(url);
    const route = routes.find(([match]) => url.includes(match));
    if (!route) throw new Error(`unexpected url: ${url}`);
    const handler = route[1];
    return typeof handler === "function" ? (handler as (u: string) => unknown)(url) : handler;
  });
  return Object.assign(transport, { calls });
}

// 流式模型替身：quotes-only 契约只回金句 JSON（经 token 事件流式回吐——概览正文
// 只能从事件聚合，替身必须走这条路）。
const QUOTE_TEXT = "工具是人的延伸，agent 是意图的延伸。";

function makeQuotesOnlyModel() {
  const calls: { system: string; user: string }[] = [];
  const chatCompletion = vi.fn(async (input: { messages: { role: string; content: string }[]; onEvent?: (e: { type: string; data: string }) => void }) => {
    calls.push({ system: String(input.messages[0]?.content || ""), user: String(input.messages.at(-1)?.content || "") });
    const text = JSON.stringify({
      keyQuotes: [{ quote: QUOTE_TEXT, timestamp: "3:00", timestampSeconds: 180 }]
    });
    for (let i = 0; i < text.length; i += 7) {
      input.onEvent?.({ type: "token", data: text.slice(i, i + 7) });
    }
    return { done: true } as const;
  });
  return { chatCompletion, calls };
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

describe("端到端：置顶评论目录全量识别 → 章节只留标题 + 金句照常", () => {
  it("截断/楼中楼/只留标题三处回归走查（产出可复现工件）", async () => {
    // ① B 站热评接口（真实 gateway + 假 transport）：main 给置顶长目录，reply/reply 给续篇
    const transport = fakeTransport([
      [
        "x/v2/reply/main",
        { code: 0, data: { replies: [], top: null, top_replies: [PINNED_ROOT], upper: { top: PINNED_ROOT } } }
      ],
      [
        "x/v2/reply/reply",
        {
          code: 0,
          data: {
            replies: [{ rpid: 9001, member: { uname: "硅谷101" }, like: 10, content: { message: SUB_REPLY_MESSAGE } }]
          }
        }
      ]
    ]);
    const comments = await gateway.fetchHotCommentsJson(transport, 123, 20);
    const subCalls = transport.calls.filter((url) => url.includes("x/v2/reply/reply"));

    // ② 热评全文通道：置顶正文完整（>500 字符不截断），续篇挂在 subMessages
    expect(comments[0].message).toBe(PINNED_MESSAGE);
    expect(PINNED_MESSAGE.length).toBeGreaterThan(500);
    expect(comments[0].subMessages).toEqual([SUB_REPLY_MESSAGE]);
    expect(subCalls).toHaveLength(1);
    expect(subCalls[0]).toContain("root=315310607649");

    // ③ 目录解析：500 字符之后的章节行（25:00）与楼中楼续篇（30:00）都识别
    const source = outline.resolveChapterSource("普通简介，无时间轴", comments, []);
    expect(source.kind).toBe("outline");
    expect(source.chapters.map((item) => item.title)).toEqual([
      ...Array.from({ length: 9 }, (_, i) => `小节${i}：${"甲".repeat(43)}`),
      "核心原则：智能体设计的五个层次",
      "尾声"
    ]);
    expect(source.chapters.at(-1)).toEqual({ seconds: 30 * 60, title: "尾声" });

    // ④ 概览产物（真实管线 + 假模型）：章节只留标题（不写 AI 简介），金句照常
    const { chatCompletion, calls } = makeQuotesOnlyModel();
    const result = await analysis.runOverviewAnalysis(
      {
        provider: { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" },
        context: {
          title: "智能体设计的五个层次",
          author: "硅谷101",
          bvid: "BV1q9He6SEyX",
          cid: "1",
          selectedSubtitleId: "sub-1",
          subtitleLang: "zh-CN",
          videoDuration: 1860,
          subtitleBody: makeSubtitleBody(50000),
          hotComments: comments
        }
      },
      { chatCompletion }
    );

    expect(calls[0].system).toContain("为给定的章节目录挑选金句");
    expect(result.chapters).toHaveLength(11);
    expect(result.chapters.every((item) => item.summary === "")).toBe(true);
    expect(result.chapters.at(-1)).toMatchObject({ from: 1800, to: 1860, title: "尾声", summary: "" });
    expect(result.quotes.map((q) => q.content)).toEqual([QUOTE_TEXT]);

    // ⑤ 聊天展示（真实 buildMessages）：每条 500 字截断、楼中楼续篇不外泄
    const messages = context.buildMessages({
      context: { title: "智能体设计的五个层次", author: "硅谷101", hotComments: comments },
      userPrompt: "这个视频讲了什么？"
    });
    const systemText = String(messages[0].content);
    const commentBlock = systemText.split("以下是按热度排序的前")[1]?.split("\n\n").slice(1).join("\n\n") || "";
    expect(systemText).toContain(PINNED_MESSAGE.slice(0, 500));
    expect(systemText).not.toContain("核心原则：智能体设计的五个层次");
    expect(systemText).not.toContain(SUB_REPLY_MESSAGE);

    // ⑦ 工件：可复现走查记录（同一测试重跑逐字节一致）
    const artifactDir = join(process.cwd(), ".scratch", "tickets", "outline-titles-only", "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "01-e2e-walkthrough.md"),
      [
        "# 置顶评论目录走查工件（由 tests/e2e/outline-titles-only.e2e.test.ts 生成）",
        "",
        "## ① 热评接口样本（x/v2/reply/main 置顶 + x/v2/reply/reply 楼中楼续篇）",
        `- 置顶评论正文 ${PINNED_MESSAGE.length} 字符；旧 500 字符截断点两侧：「${PINNED_MESSAGE.slice(480, 500)}」|「${PINNED_MESSAGE.slice(500, 520)}」`,
        `- 楼中楼请求：${subCalls.join(", ")}`,
        `- 楼中楼续篇：「${SUB_REPLY_MESSAGE}」`,
        "",
        "## ② 热评全文通道（fetchHotCommentsJson）",
        `- message 全文保留（等于样本）：${comments[0].message === PINNED_MESSAGE}`,
        `- subMessages 续篇：${JSON.stringify(comments[0].subMessages)}`,
        "",
        "## ③ 目录解析（resolveChapterSource）",
        `- kind: ${source.kind}`,
        ...source.chapters.map((item) => `- ${clock(item.seconds)} ${item.title}`),
        "",
        "## ④ 概览产物（outline 来源只留标题 + 金句照常）",
        ...result.chapters.map((item) => `- [${item.from}..${item.to}] ${item.title} | summary=${JSON.stringify(item.summary)}`),
        ...result.quotes.map((item) => `- 金句 @${item.from}s：${item.content}`),
        "",
        "## ⑤ 聊天展示（buildMessages 评论块，逐字截取）",
        "```text",
        commentBlock,
        "```",
        "",
        "## ⑥ 走查结论",
        "- 500 字符截断只发生在聊天展示；目录解析拿全文，25:00/30:00 章节不丢",
        "- 楼中楼续篇只进目录解析，不进聊天展示",
        "- outline 来源章节只留标题（summary 恒空），金句照常生成",
        ""
      ].join("\n")
    );

    // 工件与真实产物对账（防工件说谎）
    const artifact = (await import("node:fs")).readFileSync(join(artifactDir, "01-e2e-walkthrough.md"), "utf8");
    expect(artifact).toContain("30:00 尾声");
    expect(artifact).toContain(`[1800..1860] 尾声 | summary=""`);
  });
});
