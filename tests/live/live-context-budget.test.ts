import { describe, expect, it } from "vitest";
import {
  LIVE_CONTEXT_COMPACT_MAX_CHARS,
  LIVE_CONTEXT_HARD_MAX_CHARS,
  LIVE_CONTEXT_TIER_C_MAX_ANCHORS,
  assembleLiveContextBudget,
  extractCoreSummaryLead,
  sanitizeLiveSummaryMarkdown
} from "../../extension/live/live-context-budget.js";
import {
  buildMinimalSessionUpdatePayload,
  buildVideoInstructions,
  type MossLiveRoomContext,
  type MossLiveVideoContext
} from "../../extension/live/moss-live-protocol.js";

function makeBaseVideo(overrides: Partial<MossLiveVideoContext> = {}): MossLiveVideoContext {
  return {
    url: "https://www.bilibili.com/video/BV1budget0001/",
    bvid: "BV1budget0001",
    cid: "8888",
    title: "实时语音交互架构精讲",
    pageIndex: 1,
    pageCount: 1,
    pageTitle: "",
    chapters: [],
    ...overrides
  };
}

function makeChapterSeries(count: number, stepSec: number, titleSuffix = "") {
  return Array.from({ length: count }, (_, index) => {
    const from = index * stepSec;
    return {
      from,
      to: from + stepSec,
      time: `00:${String(index).padStart(2, "0")}`,
      title: `第${index + 1}节 模块拆解${titleSuffix}`,
      summary: `详细讲解第${index + 1}节的实现细节、状态机迁移与边缘处理策略，内容较多用于测试正文裁剪。`
    };
  });
}

describe("live-context-budget 三档容量预算装配器", () => {
  it("短片命中档位 A（<= 1500 字符），保留完整章节、逐章概览与金句", () => {
    const context = makeBaseVideo({
      chapters: [
        { from: 0, to: 90, title: "导言" },
        { from: 90, to: 240, title: "核心链路" }
      ],
      overview: {
        phase: "ready",
        coverage: "complete",
        summary: "全片紧凑介绍双工语音伴看的握手、混音与工具调用链路。",
        chapters: [
          { from: 0, to: 90, time: "0:00", title: "导言", summary: "说明全双工低延迟目标" },
          { from: 90, to: 240, time: "1:30", title: "核心链路", summary: "拆解端到端媒体帧时序" }
        ],
        quotes: [{ from: 125, time: "2:05", content: "首包发声延迟决定交互质感。" }],
        statusText: ""
      },
      compressedSummaryMarkdown: "## 成稿笔记\n\n短片成稿补充：前端采集 16kHz PCM 后经端口转推。"
    });

    const result = assembleLiveContextBudget(context, { clientDelegation: true });

    expect(result.tier).toBe("A");
    expect(result.charCount).toBe(result.text.length);
    expect(result.charCount).toBeLessThanOrEqual(LIVE_CONTEXT_COMPACT_MAX_CHARS);
    expect(result.totalChapters).toBe(2);
    expect(result.includedChapters).toBe(2);
    expect(result.text).toContain("0:00 导言：说明全双工低延迟目标");
    expect(result.text).toContain("1:30 核心链路：拆解端到端媒体帧时序");
    expect(result.text).toContain("2:05 首包发声延迟决定交互质感。");
    expect(result.text).toContain("前端采集 16kHz PCM 后经端口转推。");
  });

  it("长课程命中档位 B（> 1500 且章节 <= 40），剥离逐章正文/金句/分段小结并保留全部章节骨架", () => {
    const chapters = makeChapterSeries(18, 120);
    const longNote = "成稿笔记核心导读：本课程系统讲授分布式一致性、状态机复制、快照压缩与客户端重连机制。".repeat(12);
    const segmentSummaries = Array.from(
      { length: 6 },
      (_, idx) => `### 片段 ${idx + 1}\n分段小结冗余文本 ${idx + 1}：${"逐段复述细节内容。".repeat(20)}`
    ).join("\n\n");

    const context = makeBaseVideo({
      chapters: chapters.map(({ from, to, title }) => ({ from, to, title })),
      overview: {
        phase: "ready",
        coverage: "complete",
        summary: "长课程全片简介：深入讲解分布式共识工程落地。".repeat(14),
        chapters,
        quotes: [
          { from: 150, time: "2:30", content: "这条金句在档位 B 应当被剥离以节省常驻 Token。" }
        ],
        statusText: ""
      },
      compressedSummaryMarkdown: `## 分段小结\n\n${segmentSummaries}\n\n## 成稿笔记\n\n${longNote}`
    });

    const result = assembleLiveContextBudget(context, { clientDelegation: true });

    expect(result.tier).toBe("B");
    expect(result.totalChapters).toBe(18);
    expect(result.includedChapters).toBe(18);
    expect(result.charCount).toBeLessThanOrEqual(LIVE_CONTEXT_HARD_MAX_CHARS);
    expect(result.text).toContain("章节骨架（共18章");
    expect(result.text).toContain("- 0:00 第1节 模块拆解");
    expect(result.text).toContain("- 34:00 第18节 模块拆解");
    expect(result.text).not.toContain("详细讲解第1节的实现细节");
    expect(result.text).not.toContain("分段小结冗余文本");
    expect(result.text).not.toContain("## 分段小结");
    expect(result.text).not.toContain("金句");
    expect(result.text).not.toContain("这条金句在档位 B 应当被剥离");
  });

  it("超长多章节视频命中档位 C（150 章跨 4 小时），合并顶层区间并严守 3000 字符硬上限", () => {
    const chapters = makeChapterSeries(150, 96);
    const context = makeBaseVideo({
      title: "四小时大型开源项目源码走读直播录播全集",
      chapters: chapters.map(({ from, to, title }) => ({ from, to, title })),
      overview: {
        phase: "ready",
        coverage: "complete",
        summary: "超长录播导读：从引导流程到存储引擎的完整架构梳理。".repeat(20),
        chapters,
        quotes: [{ from: 7200, time: "2:00:00", content: "不应进入 C 档的金句。" }],
        statusText: ""
      }
    });

    const result = assembleLiveContextBudget(context, { clientDelegation: true });

    expect(result.tier).toBe("C");
    expect(result.totalChapters).toBe(150);
    expect(result.includedChapters).toBeLessThanOrEqual(LIVE_CONTEXT_TIER_C_MAX_ANCHORS);
    expect(result.charCount).toBeLessThanOrEqual(LIVE_CONTEXT_HARD_MAX_CHARS);
    expect(result.text).toContain("已合并为");
    expect(result.text).toContain("- 0:00 第1节 模块拆解");
    expect(result.text).toContain("- 3:58:24 第150节 模块拆解");
    expect(result.text).not.toContain("不应进入 C 档的金句");
  });

  it("章节数 <= 40 但超长标题含 emoji 溢出档位 B 时自动降级至 C 档且不劈开 UTF-16 代理对", () => {
    const chapters = makeChapterSeries(38, 120, "🚀✨".repeat(30));
    const context = makeBaseVideo({
      chapters: chapters.map(({ from, to, title }) => ({ from, to, title })),
      overview: {
        phase: "ready",
        coverage: "complete",
        summary: "导读正文🚀".repeat(80),
        chapters,
        quotes: [],
        statusText: ""
      }
    });

    const result = assembleLiveContextBudget(context, { clientDelegation: true });

    expect(result.tier).toBe("C");
    expect(result.charCount).toBeLessThanOrEqual(LIVE_CONTEXT_HARD_MAX_CHARS);
    expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("绝不将原始字幕行或原始字幕分节塞入任何档位与 systemInstruction", () => {
    const dirtySummary = [
      "## 成稿笔记",
      "",
      "精炼结论：视频核心比较了两种传输协议。",
      "",
      "## 相关原始字幕段",
      "",
      "[0:10-0:14] 原始字幕台词片段不应泄漏A",
      "[1:02:05-1:02:10] 原始字幕台词片段不应泄漏B",
      "",
      "## 字幕",
      "",
      "### 第一章 0:00",
      "`0:10` 逐字字幕行不应泄漏C",
      "- `0:15` 列表形式字幕行不应泄漏D"
    ].join("\n");

    const sanitized = sanitizeLiveSummaryMarkdown(dirtySummary);
    expect(sanitized).toContain("精炼结论：视频核心比较了两种传输协议。");
    expect(sanitized).not.toContain("不应泄漏");

    const lead = extractCoreSummaryLead(dirtySummary, 120);
    expect(lead).toBe("精炼结论：视频核心比较了两种传输协议。");

    const tierAContext = makeBaseVideo({ compressedSummaryMarkdown: dirtySummary });
    const tierAResult = assembleLiveContextBudget(tierAContext, { clientDelegation: true });
    expect(tierAResult.tier).toBe("A");
    expect(tierAResult.text).not.toContain("不应泄漏");

    const tierCContext = makeBaseVideo({
      chapters: makeChapterSeries(100, 60).map(({ from, to, title }) => ({ from, to, title })),
      compressedSummaryMarkdown: dirtySummary
    });
    const tierCResult = assembleLiveContextBudget(tierCContext, { clientDelegation: true });
    expect(tierCResult.tier).toBe("C");
    expect(tierCResult.charCount).toBeLessThanOrEqual(LIVE_CONTEXT_HARD_MAX_CHARS);
    expect(tierCResult.text).not.toContain("不应泄漏");

    const instructions = buildVideoInstructions(tierCContext, true);
    expect(instructions).not.toContain("不应泄漏");
    expect(instructions).toContain("常规脉络与章节大意直接根据上下文中的概览或章节骨架秒答");
    expect(instructions).toContain("追问具体某段原话细节需跨片查证时");
  });

  it("严格遵守时刻文本单源不补零规范并按时间升序去重", () => {
    const context = makeBaseVideo({
      chapters: [
        { from: 3725, to: 4000, title: "小时级章节" },
        { from: 5, to: 150, title: "五秒章节" },
        { from: 150, to: 3725, title: "两分半章节" }
      ],
      overview: {
        phase: "ready",
        coverage: "complete",
        summary: "测试时刻文本单源输出。",
        chapters: [
          { from: 3725, to: 4000, time: "01:02:05", title: "小时级章节", summary: "忽略外部补零字段" },
          { from: 5, to: 150, time: "00:05", title: "五秒章节", summary: "" },
          { from: 150, to: 3725, time: "02:30", title: "两分半章节", summary: "" }
        ],
        quotes: [{ from: 5, time: "00:05", content: "五秒金句" }],
        statusText: ""
      }
    });

    const result = assembleLiveContextBudget(context, { clientDelegation: true });
    expect(result.tier).toBe("A");
    expect(result.text).toContain("0:05 五秒章节");
    expect(result.text).toContain("2:30 两分半章节");
    expect(result.text).toContain("1:02:05 小时级章节");
    expect(result.text).toContain("- 0:05 五秒金句");
    expect(result.text).not.toMatch(/(?:^|[^:\d])0\d:\d{2}/);
    expect(result.text).not.toMatch(/\b\d+s\s/);
    expect(result.text.indexOf("0:05 五秒章节")).toBeLessThan(result.text.indexOf("2:30 两分半章节"));
    expect(result.text.indexOf("2:30 两分半章节")).toBeLessThan(result.text.indexOf("1:02:05 小时级章节"));
  });

  it("无字幕、部分覆盖、空上下文与直播间伴看边界保持诚实与极简", () => {
    expect(assembleLiveContextBudget(null)).toEqual({
      tier: "none",
      text: "",
      charCount: 0,
      estimatedTokens: 0,
      totalChapters: 0,
      includedChapters: 0
    });

    const noSubtitle = assembleLiveContextBudget(
      makeBaseVideo({
        overview: {
          phase: "empty",
          coverage: "none",
          summary: "",
          chapters: [],
          quotes: [],
          statusText: "当前视频没有可用字幕，暂时无法生成全片概览。"
        }
      }),
      { clientDelegation: true }
    );
    expect(noSubtitle.tier).toBe("A");
    expect(noSubtitle.text).toContain("章节：无章节信息");
    expect(noSubtitle.text).toContain("当前视频没有可用字幕");

    const partialLarge = assembleLiveContextBudget(
      makeBaseVideo({
        chapters: makeChapterSeries(80, 90).map(({ from, to, title }) => ({ from, to, title })),
        overview: {
          phase: "partial",
          coverage: "partial",
          summary: "部分完成简介。".repeat(30),
          chapters: makeChapterSeries(80, 90),
          quotes: [],
          failedRanges: [{ from: 120, to: 300 }],
          statusText: "覆盖不完整：1 段字幕生成失败；不得当作完整全片总结。"
        }
      }),
      { clientDelegation: true }
    );
    expect(partialLarge.tier).toBe("C");
    expect(partialLarge.text).toContain("全片概览状态：partial（覆盖：partial）");
    expect(partialLarge.text).toContain("不得当作完整全片总结");
    expect(partialLarge.text).toContain("未覆盖区间：2:00–5:00");

    const room: MossLiveRoomContext = {
      kind: "live-room",
      url: "https://live.bilibili.com/21452505",
      roomId: "21452505",
      title: "直播编程夜话",
      anchorName: "某主播"
    };
    const roomBudget = assembleLiveContextBudget(room);
    expect(roomBudget).toEqual({
      tier: "live-room",
      text: "当前直播间：直播编程夜话\n主播：某主播",
      charCount: 19,
      estimatedTokens: 19,
      totalChapters: 0,
      includedChapters: 0
    });
    const roomPayload = buildMinimalSessionUpdatePayload(room);
    expect(roomPayload.session.instructions).toContain("当前直播间：直播编程夜话");
    expect(roomPayload.session.instructions).toContain("主播：某主播");
    expect(roomPayload.session.instructions).not.toContain("BV：");
    expect(roomPayload.session.instructions).not.toContain("章节：");
    expect(roomPayload.session.instructions).not.toContain("章节骨架");
    expect(roomPayload.session.instructions).not.toContain("后台委派");
    expect(roomPayload.session.tools).toEqual([]);
  });
});
