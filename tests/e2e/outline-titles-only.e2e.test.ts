// 端到端走查（用户报障 2026-09-30，BV1q9He6SEyX）：置顶长评论的目录被 500 字截断
// 拦腰切断（渲染出「语言轴：一个词 ag」这类半截标题）、第二段目录发在楼中楼里整段
// 丢失，概览分章因此断尾且逐章 AI 简介过长。本文件跑全链真实模块，只假 transport
// 与模型两头；transport 喂的是**真接口响应**（tests/fixtures/bilibili/
// bv1q9he6seyx-reply-*.json：2026-10-06 用带 cookie 的真实浏览器抓的同一支视频的
// x/v2/reply/main 与 x/v2/reply/reply），不是手写样本：
//
//   B 站热评接口真响应（含楼中楼）→ fetchHotCommentsJson → 热评全文通道
//   → resolveChapterSource 目录解析（顶层正文 + 楼中楼续篇）→ runOverviewAnalysis
//   产物 → buildMessages 聊天展示
//
// 拍板口径：评论/简介时间轴目录（outline 来源）章节只留标题、不写 AI 简介，金句照常；
// 视频内官方章节（manuscript）与 AI 自由分章（auto）保留逐章简介。渲染侧（空简介
// 不出简介区块）回归在 tests/reader/overview.test.ts。
// 走查末尾写出可复现工件（.scratch/tickets/outline-titles-only/artifacts/01-e2e-walkthrough.md）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, makeSubtitleBody } from "../setup.js";
import type { ChatCompletionInput } from "../../extension/ai/completion.js";
import type { HotComment as AiHotComment } from "../../extension/ai/types.js";

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

// —— 真接口响应样本（BV1q9He6SEyX，2026-10-06 抓，出处写在 fixture 的 _provenance）——

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "bilibili");
const MAIN_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "bv1q9he6seyx-reply-main.json"), "utf8")
);
const SUB_FIXTURE = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "bv1q9he6seyx-reply-reply.json"), "utf8")
);

const VIDEO = MAIN_FIXTURE._provenance.video as {
  bvid: string;
  aid: number;
  title: string;
  owner: string;
  duration: number;
  desc: string;
};
// 置顶目录评论（UP ChHsich 自己置顶）：正文 906 字符，第二段目录在它的楼中楼里
const PINNED = MAIN_FIXTURE.data.top_replies[0];
const PINNED_MESSAGE = String(PINNED.content.message);
const SUB_REPLY_MESSAGE = String(SUB_FIXTURE.data.replies[0].content.message);
// 09:33 那一行：旧 slice(0, 500) 恰好切在这行中部（用户报障原文「语言轴：一个词 ag」）
const FULL_0933_TITLE =
  "语言轴：一个词 agent 会咬住并在思考里强化；TDD 该不该用无所谓，让 agent 换一种方式排优先级才是真目的";

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
// 只能从事件聚合，替身必须走这条路）。入参形状单源引用 ai/completion.js 的
// ChatCompletionInput（同 tests/ai/analysis.test.ts）：手抄形状会随 StreamChatEvent
// 词表漂移，正是本文件此前的类型错来源。
const QUOTE_TEXT = "工具是人的延伸，agent 是意图的延伸。";

function makeQuotesOnlyModel() {
  const calls: { system: string; user: string }[] = [];
  const chatCompletion = vi.fn(async (input: ChatCompletionInput) => {
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

// 秒 → 与阅读面板同款时钟（小时级带 h，如 1:06:17）。
function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

describe("端到端：置顶评论目录全量识别 → 章节只留标题 + 金句照常", () => {
  it("截断/楼中楼/只留标题三处回归走查（真接口响应回放，产出可复现工件）", async () => {
    // ① B 站热评接口（真实 gateway + 真响应 fixture）：main 给置顶目录评论，reply 给楼中楼续篇
    const transport = fakeTransport([
      ["x/v2/reply/main", MAIN_FIXTURE],
      ["x/v2/reply/reply", SUB_FIXTURE]
    ]);
    const comments = await gateway.fetchHotCommentsJson(transport, VIDEO.aid, 20);
    const subCalls = transport.calls.filter((url) => url.includes("x/v2/reply/reply"));

    // ② 热评全文通道：置顶正文完整（906 字符，>500 不截断），续篇挂在 subMessages
    expect(comments[0].uname).toBe("ChHsich");
    expect(comments[0].message).toBe(PINNED_MESSAGE);
    expect(PINNED_MESSAGE.length).toBe(906);
    expect(comments[0].subMessages).toEqual([SUB_REPLY_MESSAGE]);
    expect(SUB_REPLY_MESSAGE.length).toBe(876);
    expect(subCalls).toHaveLength(1);
    expect(subCalls[0]).toContain(`root=${PINNED.rpid}`);
    expect(subCalls[0]).toContain(`oid=${VIDEO.aid}`);

    // 旧实现口径（slice(0, 500)）在真数据上的样子：正好断在 09:33 那行中部——
    // 这就是用户报障的「语言轴：一个词 ag」。锁住它，防截断回归。
    const legacyCut = PINNED_MESSAGE.slice(0, 500);
    expect(legacyCut.endsWith("语言轴：一个词 ag")).toBe(true);
    expect(legacyCut).not.toContain("TDD 该不该用");
    expect(PINNED_MESSAGE).toContain(FULL_0933_TITLE);

    // ③ 目录解析：500 字符之后的章节行（09:33 整行）与楼中楼续篇（25:00 起）都识别
    const source = outline.resolveChapterSource(VIDEO.desc, comments, []);
    expect(source.kind).toBe("outline");
    expect(source.chapters).toHaveLength(27);
    expect(source.chapters[0].seconds).toBe(0);
    expect(source.chapters.find((item) => item.seconds === 573)?.title).toBe(FULL_0933_TITLE);
    // 25:00 之后整段目录只存在于楼中楼续篇里（顶层正文里搜不到 00:25:00）
    expect(PINNED_MESSAGE).not.toContain("00:25:00");
    expect(source.chapters.find((item) => item.seconds === 1500)?.title).toBe(
      "核心原则：确定性归脚本、判断归 agent，迁移就该 codemod 爬 AST 硬转"
    );
    expect(source.chapters.at(-1)).toEqual({ seconds: 3977, title: "道别：约定 Part 2，周一碰时间" });

    // ④ 概览产物（真实管线 + 假模型）：章节只留标题（不写 AI 简介），金句照常
    const { chatCompletion, calls } = makeQuotesOnlyModel();
    const result = await analysis.runOverviewAnalysis(
      {
        provider: { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" },
        context: {
          title: VIDEO.title,
          author: VIDEO.owner,
          bvid: VIDEO.bvid,
          cid: "1",
          selectedSubtitleId: "sub-1",
          subtitleLang: "zh-CN",
          videoDescription: VIDEO.desc,
          videoDuration: VIDEO.duration,
          subtitleBody: makeSubtitleBody(50000),
          hotComments: comments
        }
      },
      { chatCompletion }
    );

    expect(calls[0].system).toContain("为给定的章节目录挑选金句");
    expect(result.chapters).toHaveLength(27);
    expect(result.chapters.every((item) => item.summary === "")).toBe(true);
    expect(result.chapters.find((item) => item.from === 573)?.title).toBe(FULL_0933_TITLE);
    expect(result.chapters.at(-1)).toMatchObject({
      from: 3977,
      to: VIDEO.duration,
      title: "道别：约定 Part 2，周一碰时间",
      summary: ""
    });
    expect(result.quotes.map((q) => q.content)).toEqual([QUOTE_TEXT]);

    // ⑤ 聊天展示（真实 buildMessages）：每条 500 字截断、楼中楼续篇不外泄
    // 展示契约是 ai/types 的宽松形状（字段全可选 + 索引签名），目录数据是
    // bilibili 侧的具体形状：过界处显式投影，不用 as 断言绕过检查。
    const displayComments: AiHotComment[] = comments.map(({ uname, like, message, subMessages }) => ({
      uname,
      like,
      message,
      subMessages
    }));
    const messages = context.buildMessages({
      context: { title: VIDEO.title, author: VIDEO.owner, hotComments: displayComments },
      userPrompt: "这个视频讲了什么？"
    });
    const systemText = String(messages[0].content);
    const commentBlock = systemText.split("以下是按热度排序的前")[1]?.split("\n\n").slice(1).join("\n\n") || "";
    expect(systemText).toContain(PINNED_MESSAGE.slice(0, 500));
    expect(systemText).not.toContain("TDD 该不该用");
    expect(systemText).not.toContain("核心原则：确定性归脚本");

    // ⑦ 工件：可复现走查记录（同一测试重跑逐字节一致）
    const artifactDir = join(process.cwd(), ".scratch", "tickets", "outline-titles-only", "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "01-e2e-walkthrough.md"),
      [
        "# 置顶评论目录走查工件（由 tests/e2e/outline-titles-only.e2e.test.ts 生成）",
        "",
        "## ① 热评接口真响应（tests/fixtures/bilibili/bv1q9he6seyx-reply-*.json）",
        `- 视频：${VIDEO.bvid}「${VIDEO.title}」UP ${VIDEO.owner}，时长 ${VIDEO.duration}s`,
        `- 置顶评论：${PINNED.member.uname} / rpid ${PINNED.rpid} / 正文 ${PINNED_MESSAGE.length} 字符`,
        `- 旧 500 字符截断点两侧：「${PINNED_MESSAGE.slice(480, 500)}」|「${PINNED_MESSAGE.slice(500, 520)}」`,
        `- 旧 slice(0, 500) 末尾 = 「${legacyCut.slice(-25)}」← 用户报障原文「语言轴：一个词 ag」`,
        `- 楼中楼请求：${subCalls.join(", ")}`,
        `- 楼中楼续篇：${SUB_REPLY_MESSAGE.length} 字符，起于「${SUB_REPLY_MESSAGE.slice(0, 12)}…」`,
        "",
        "## ② 热评全文通道（fetchHotCommentsJson）",
        `- message 全文保留（等于 fixture）：${comments[0].message === PINNED_MESSAGE}`,
        `- subMessages 续篇：${JSON.stringify(comments[0].subMessages?.map((text) => `${text.length} 字符`))}`,
        `- 评论条数：${comments.length}（置顶 1 + 普通 ${comments.length - 1}）`,
        "",
        "## ③ 目录解析（resolveChapterSource）",
        `- kind: ${source.kind}；章节 ${source.chapters.length} 条`,
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
        "- 旧 500 字符截断点落在 09:33 行内，正是用户报的「语言轴：一个词 ag」；真数据下由 slice(0, 500) 复现",
        "- 500 字符截断只发生在聊天展示；目录解析拿全文，09:33 整行与楼中楼续篇（25:00 起）都不丢",
        "- 楼中楼续篇只进目录解析，不进聊天展示",
        "- outline 来源章节只留标题（summary 恒空），金句照常生成",
        ""
      ].join("\n")
    );

    // 工件与真实产物对账（防工件说谎）
    const artifact = readFileSync(join(artifactDir, "01-e2e-walkthrough.md"), "utf8");
    expect(artifact).toContain("语言轴：一个词 ag");
    expect(artifact).toContain("1:06:17 道别：约定 Part 2，周一碰时间");
    expect(artifact).toContain(`[3977..${VIDEO.duration}] 道别：约定 Part 2，周一碰时间 | summary=""`);
  });
});
