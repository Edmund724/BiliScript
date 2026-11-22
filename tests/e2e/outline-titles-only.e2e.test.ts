import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, makeSubtitleBody } from "../setup.js";
import { installChromeHost } from "../helpers/chrome-host.js";
import type { ChatCompletionInput } from "../../extension/ai/completion.js";
import type { HotComment as AiHotComment } from "../../extension/ai/types.js";

let gateway: typeof import("../../extension/bilibili/gateway.js");
let outline: typeof import("../../extension/shared/chapter-outline.js");
let analysis: typeof import("../../extension/ai/analysis.js");
let context: typeof import("../../extension/ai/context.js");

async function importModules() {
  vi.resetModules();
  resetModuleState();
  installChromeHost();
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
const PINNED = MAIN_FIXTURE.data.top_replies[0];
const PINNED_MESSAGE = String(PINNED.content.message);
const SUB_REPLY_MESSAGE = String(SUB_FIXTURE.data.replies[0].content.message);
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

const QUOTE_TEXT = "工具是人的延伸，agent 是意图的延伸。";

function makeQuotesOnlyModel() {
  const calls: { system: string; user: string }[] = [];
  const chatCompletion = vi.fn(async (input: ChatCompletionInput) => {
    calls.push({ system: String(input.messages[0]?.content || ""), user: String(input.messages.at(-1)?.content || "") });
    const text = JSON.stringify({
      summary: "视频围绕 agent 工程实践展开，讨论工具、语言轴与确定性边界，并给出可复用的协作原则。",
      keyQuotes: [{ quote: QUOTE_TEXT, timestamp: "3:00", timestampSeconds: 180 }]
    });
    for (let i = 0; i < text.length; i += 7) {
      input.onEvent?.({ type: "token", data: text.slice(i, i + 7) });
    }
    return { done: true, finishReason: "stop" } as const;
  });
  return { chatCompletion, calls };
}

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
    const transport = fakeTransport([
      ["x/v2/reply/main", MAIN_FIXTURE],
      ["x/v2/reply/reply", SUB_FIXTURE]
    ]);
    const comments = await gateway.fetchHotCommentsJson(transport, VIDEO.aid, 20);
    const subCalls = transport.calls.filter((url) => url.includes("x/v2/reply/reply"));

    expect(comments[0].uname).toBe("ChHsich");
    expect(comments[0].message).toBe(PINNED_MESSAGE);
    expect(PINNED_MESSAGE.length).toBe(906);
    expect(comments[0].subMessages).toEqual([SUB_REPLY_MESSAGE]);
    expect(SUB_REPLY_MESSAGE.length).toBe(876);
    expect(subCalls).toHaveLength(1);
    expect(subCalls[0]).toContain(`root=${PINNED.rpid}`);
    expect(subCalls[0]).toContain(`oid=${VIDEO.aid}`);

    const legacyCut = PINNED_MESSAGE.slice(0, 500);
    expect(legacyCut.endsWith("语言轴：一个词 ag")).toBe(true);
    expect(legacyCut).not.toContain("TDD 该不该用");
    expect(PINNED_MESSAGE).toContain(FULL_0933_TITLE);

    const source = outline.resolveChapterSource(VIDEO.desc, comments, []);
    expect(source.kind).toBe("outline");
    expect(source.chapters).toHaveLength(27);
    expect(source.chapters[0].seconds).toBe(0);
    expect(source.chapters.find((item) => item.seconds === 573)?.title).toBe(FULL_0933_TITLE);
    expect(PINNED_MESSAGE).not.toContain("00:25:00");
    expect(source.chapters.find((item) => item.seconds === 1500)?.title).toBe(
      "核心原则：确定性归脚本、判断归 agent，迁移就该 codemod 爬 AST 硬转"
    );
    expect(source.chapters.at(-1)).toEqual({ seconds: 3977, title: "道别：约定 Part 2，周一碰时间" });

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
    expect(result.summary).toContain("agent 工程实践");
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
    expect(systemText).not.toContain("以下是按热度排序的前");
    expect(systemText).not.toContain(PINNED_MESSAGE.slice(0, 100));

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
        "## ④ 概览产物（密集 outline 只留章节标题，总体简介与金句照常）",
        `- 总体简介：${result.summary}`,
        ...result.chapters.map((item) => `- [${item.from}..${item.to}] ${item.title} | summary=${JSON.stringify(item.summary)}`),
        ...result.quotes.map((item) => `- 金句 @${item.from}s：${item.content}`),
        "",
        "## ⑤ 聊天展示（buildMessages）",
        "- 评论数据已从聊天展示解耦，buildMessages 不再向提示词注入热门评论",
        "",
        "## ⑥ 走查结论",
        "- 旧 500 字符截断点落在 09:33 行内，正是用户报的「语言轴：一个词 ag」；真数据下由 slice(0, 500) 复现",
        "- 目录解析拿全文，09:33 整行与楼中楼续篇（25:00 起）都不丢",
        "- 楼中楼续篇与热评正文均不进聊天提示词，热评仅供目录解析",
        "- 27 章的密集 outline 只留章节标题（summary 恒空），总体简介与金句照常生成",
        ""
      ].join("\n")
    );

    const artifact = readFileSync(join(artifactDir, "01-e2e-walkthrough.md"), "utf8");
    expect(artifact).toContain("语言轴：一个词 ag");
    expect(artifact).toContain("1:06:17 道别：约定 Part 2，周一碰时间");
    expect(artifact).toContain(`[3977..${VIDEO.duration}] 道别：约定 Part 2，周一碰时间 | summary=""`);
  });
});
