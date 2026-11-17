import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { state, clipState } from "../../extension/core/state.js";
import { normalizeSubtitleSegmentationStrategy } from "../../extension/core/validators.js";
import { acceptSubtitle, configureCommitUi } from "../../extension/subtitle/commit.js";
import {
  toAtomicSubtitleEvents,
  fromAtomicSubtitleEvents,
  expandCoarseEvents,
  mergeSubtitlesByRule,
  breakSubtitlesByStats,
  hasNormalPunctuationDensity,
  shouldSegmentTrack
} from "../../extension/subtitle/segmentation.js";

vi.mock("../../extension/subtitle/core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/subtitle/core.js")>();
  return {
    ...actual,
    refreshHotComments: vi.fn(async () => {}),
    refreshDerivedContent: vi.fn(async () => {})
  };
});

vi.mock("../../extension/reader/reader-bus.js", () => ({
  notifyReaderPresenter: vi.fn(),
  subscribeSubtitleRefresh: vi.fn(() => () => {}),
  subscribeReaderPresenter: vi.fn(() => () => {})
}));

function expectSmoothNonOverlappingSec(items: ReadonlyArray<{ from: number; to: number }>) {
  expect(items.length).toBeGreaterThan(0);
  for (let i = 0; i < items.length; i += 1) {
    expect(items[i].to).toBeGreaterThanOrEqual(items[i].from);
    if (i > 0) {
      expect(items[i].from).toBeGreaterThanOrEqual(items[i - 1].to);
    }
  }
}

function expectSmoothNonOverlappingMs(events: ReadonlyArray<{ startMs: number; endMs: number }>) {
  expect(events.length).toBeGreaterThan(0);
  for (let i = 0; i < events.length; i += 1) {
    expect(events[i].endMs).toBeGreaterThanOrEqual(events[i].startMs);
    if (i > 0) {
      expect(events[i].startMs).toBeGreaterThanOrEqual(events[i - 1].endMs);
    }
  }
}

describe("toAtomicSubtitleEvents / fromAtomicSubtitleEvents：双向无损转换与时间钳制", () => {
  it("秒级浮点与毫秒级原子事件双向无损转换", () => {
    const raw = [
      { from: 0.125, to: 1.5, content: "Hello world" },
      { from: 1.5, to: 3.75, content: "[Music]" }
    ];
    const events = toAtomicSubtitleEvents(raw);
    expect(events).toEqual([
      { text: "Hello world", startMs: 125, endMs: 1500 },
      { text: "[Music]", startMs: 1500, endMs: 3750, isNonSpeech: true }
    ]);
    expect(fromAtomicSubtitleEvents(events)).toEqual(raw);
  });

  it("有效结束时间钳制：endMs > nextItem.startMs 且 nextItem.startMs > startMs 时钳制为 nextItem.startMs", () => {
    const events = toAtomicSubtitleEvents([
      { from: 1.0, to: 5.0, content: "First cue" },
      { from: 3.2, to: 6.0, content: "Second cue" },
      { from: 3.2, to: 7.0, content: "Same start cue" }
    ]);
    expect(events).toEqual([
      { text: "First cue", startMs: 1000, endMs: 3200 },
      { text: "Second cue", startMs: 3200, endMs: 6000 },
      { text: "Same start cue", startMs: 3200, endMs: 7000 }
    ]);
  });
});

describe("expandCoarseEvents：粗粒度块加权线性展平", () => {
  it("优先消费词级 words 时间戳并受父块有效结束时间钳制", () => {
    const events = expandCoarseEvents(
      [
        {
          from: 0,
          to: 10,
          content: "Hello world today",
          words: [
            { word: "Hello", start: 0.1, end: 0.6 },
            { word: "world", start: 0.7, end: 1.4 },
            { word: "today", start: 1.5, end: 5.0 }
          ]
        },
        { from: 2.5, to: 4.0, content: "Next" }
      ],
      "en"
    );
    expect(events).toEqual([
      { text: "Hello", startMs: 100, endMs: 600 },
      { text: "world", startMs: 700, endMs: 1400 },
      { text: "today", startMs: 1500, endMs: 2500 },
      { text: "Next", startMs: 2500, endMs: 4000 }
    ]);
  });

  it("粗粒度英文块（词数 > 3）按字符长度权重线性拆分为连续词级事件", () => {
    // 词长权重：we(2) + build(5) + fast(4) + apps(4) = 15，总时长 3000ms（每位 200ms）
    const events = expandCoarseEvents(
      [{ from: 1, to: 4, content: "we build fast apps" }],
      "en"
    );
    expect(events).toEqual([
      { text: "we", startMs: 1000, endMs: 1400 },
      { text: "build", startMs: 1400, endMs: 2400 },
      { text: "fast", startMs: 2400, endMs: 3200 },
      { text: "apps", startMs: 3200, endMs: 4000 }
    ]);
  });

  it("粗粒度中文块按内部逗号与连词边界切为小粒度事件，并平滑线性分配区间", () => {
    const events = expandCoarseEvents(
      [{ from: 0, to: 6, content: "今天天气不错，但是我还是想在家写代码" }],
      "ai-zh"
    );
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.some((ev) => ev.text.startsWith("但是"))).toBe(true);
    for (const ev of events) {
      expect(ev.text.length).toBeLessThanOrEqual(8);
    }
    expect(events[0].startMs).toBe(0);
    expect(events[events.length - 1].endMs).toBe(6000);
    expectSmoothNonOverlappingMs(events);
  });
});

describe("验收 1：B 站 ai-en 碎句经 mergeSubtitlesByRule 合并为自然句且首尾时间精确包络", () => {
  it("2~3 词无标点碎句按句末标点、停顿间隔与音效边界合并为自然句", () => {
    const aiEnFragments = [
      { from: 0.5, to: 1.1, content: "Hey everyone" },
      { from: 1.2, to: 1.8, content: "welcome back" },
      { from: 1.9, to: 2.6, content: "to the channel." },
      { from: 2.8, to: 4.0, content: "[Music]" },
      { from: 4.1, to: 4.8, content: "Today we will" },
      { from: 5.0, to: 5.9, content: "talk about caching" },
      { from: 7.5, to: 8.2, content: "Next topic" },
      { from: 8.3, to: 9.1, content: "is streaming" }
    ];

    const atomic = expandCoarseEvents(aiEnFragments, "ai-en");
    const merged = fromAtomicSubtitleEvents(mergeSubtitlesByRule(atomic, { lang: "ai-en" }));

    expect(merged).toEqual([
      { from: 0.5, to: 2.6, content: "Hey everyone welcome back to the channel." },
      { from: 2.8, to: 4.0, content: "[Music]" },
      { from: 4.1, to: 5.9, content: "Today we will talk about caching" },
      { from: 7.5, to: 9.1, content: "Next topic is streaming" }
    ]);
  });
});

describe("验收 2：150 词无标点英文 ASR 巨型段与 80 字无标点中文段二次重切", () => {
  it("150 词无标点英文 ASR 巨型段经 expandCoarseEvents + 停顿词二次重切后受控在上限内", () => {
    const baseClause =
      "today we examine how modern browsers schedule rendering tasks however many developers overlook layout thrashing because they read geometric properties right after mutating styles and therefore cause expensive frame drops so profiling remains essential";
    const words150 = Array.from({ length: 5 }, () => baseClause.split(/\s+/)).flat().slice(0, 150);
    expect(words150).toHaveLength(150);

    const atomic = expandCoarseEvents(
      [{ from: 0, to: 45, content: words150.join(" ") }],
      "en"
    );
    const merged = fromAtomicSubtitleEvents(mergeSubtitlesByRule(atomic, { lang: "en" }));

    expect(merged.length).toBeGreaterThanOrEqual(10);
    expect(merged[0].from).toBe(0);
    expect(merged[merged.length - 1].to).toBe(45);
    expectSmoothNonOverlappingSec(merged);

    for (const item of merged) {
      const wordCount = item.content.split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeLessThanOrEqual(15);
      expect(item.content.length).toBeLessThanOrEqual(100);
    }
  });

  it("80 字无标点中文段经 expandCoarseEvents + 停顿词二次重切后受控在上限内且无重叠", () => {
    const zh80 =
      "今天我们来梳理前端构建工具演进路线其实早期项目打包配置相当繁琐而且构建速度非常缓慢但是随着原生模块化和编译器普及因此开发体验提升明显所以团队迁移成本大幅降低另外热更新也更稳定";
    expect(zh80.length).toBeGreaterThanOrEqual(80);

    const atomic = expandCoarseEvents(
      [{ from: 2, to: 10, content: zh80 }],
      "zh"
    );
    const merged = fromAtomicSubtitleEvents(mergeSubtitlesByRule(atomic, { lang: "zh" }));

    expect(merged.length).toBeGreaterThanOrEqual(3);
    expect(merged[0].from).toBe(2);
    expect(merged[merged.length - 1].to).toBe(10);
    expectSmoothNonOverlappingSec(merged);

    for (const item of merged) {
      expect(item.content.length).toBeLessThanOrEqual(30);
    }
    expect(merged.map((item) => item.content).join("")).toBe(zh80);
  });
});

describe("模式 B：breakSubtitlesByStats（MAD + Z-Score 统计分布断句）", () => {
  it("结合停顿 Z-Score、标点与大写/转折加分断句，并遵守最短门限与 7000ms 硬上限", () => {
    const events = [
      // 句 1：4 词 + >= 500ms + 显著停顿 (800ms vs median 50ms) -> 断句
      { text: "We", startMs: 0, endMs: 180 },
      { text: "start", startMs: 220, endMs: 420 },
      { text: "right", startMs: 470, endMs: 650 },
      { text: "now", startMs: 700, endMs: 900 },
      // 句 2：逗号(+1.0) + 大写(+0.5) = 1.5 >= 1.2，且满足 >= 4 词 & >= 500ms -> 断句
      { text: "after", startMs: 1700, endMs: 1880 },
      { text: "checking", startMs: 1930, endMs: 2150 },
      { text: "the", startMs: 2200, endMs: 2350 },
      { text: "logs,", startMs: 2400, endMs: 2650 },
      // 句 3：后半段无标点无长停顿但跨度超过 7000ms -> 触发硬上限断句
      { text: "Finally", startMs: 2700, endMs: 4000 },
      { text: "things", startMs: 4050, endMs: 6500 },
      { text: "stabilized", startMs: 6550, endMs: 9000 },
      { text: "completely", startMs: 9050, endMs: 10500 }
    ];

    const broken = breakSubtitlesByStats(events, { lang: "en" });
    expect(broken).toEqual([
      { text: "We start right now", startMs: 0, endMs: 900 },
      { text: "after checking the logs,", startMs: 1700, endMs: 2650 },
      { text: "Finally things stabilized", startMs: 2700, endMs: 9000 },
      { text: "completely", startMs: 9050, endMs: 10500 }
    ]);
  });

  it("中文句子结合句末标点、停顿及中文转折词加分在满足最短门限后切分", () => {
    const events = [
      { text: "今天", startMs: 0, endMs: 250 },
      { text: "天气", startMs: 290, endMs: 520 },
      { text: "不错，", startMs: 560, endMs: 850 },
      { text: "但是", startMs: 900, endMs: 1150 },
      { text: "我们", startMs: 1190, endMs: 1450 },
      { text: "依然", startMs: 1490, endMs: 1750 },
      { text: "需要", startMs: 1790, endMs: 2050 },
      { text: "继续", startMs: 2090, endMs: 2350 },
      { text: "测试", startMs: 2390, endMs: 2650 }
    ];

    const broken = breakSubtitlesByStats(events, { lang: "zh" });
    expect(broken).toEqual([
      { text: "今天天气不错，", startMs: 0, endMs: 850 },
      { text: "但是我们依然需要继续测试", startMs: 900, endMs: 2650 }
    ]);
  });
});

describe("验收 3：设置项归一与按轨道类型智能挂载（commit.ts）", () => {
  beforeEach(() => {
    resetModuleState();
    configureCommitUi({ setStatus: vi.fn() });
  });

  it("normalizeSubtitleSegmentationStrategy 归一四种合法值并将非法值回落到 auto", () => {
    expect(normalizeSubtitleSegmentationStrategy("auto")).toBe("auto");
    expect(normalizeSubtitleSegmentationStrategy("RULE")).toBe("rule");
    expect(normalizeSubtitleSegmentationStrategy("stats")).toBe("stats");
    expect(normalizeSubtitleSegmentationStrategy("off")).toBe("off");
    expect(normalizeSubtitleSegmentationStrategy("invalid")).toBe("auto");
    expect(normalizeSubtitleSegmentationStrategy(null)).toBe("auto");
  });

  it("auto 模式下人工精校 en-US / zh-CN CC 轨不被误拆，原样保留时间轴与文本", async () => {
    const humanEnCc = Array.from({ length: 10 }, (_, idx) => ({
      from: idx * 1.2,
      to: idx * 1.2 + 0.9,
      content: idx % 2 === 0 ? `Line ${idx + 1}, short` : `part ${idx + 1}.`
    }));
    expect(hasNormalPunctuationDensity(humanEnCc)).toBe(true);

    clipState.setSubtitles([
      { id: "cc-en", lan: "en-US", lanDoc: "English (US)", subtitleUrl: "https://example.com/en-us.json" }
    ]);
    state.settings.subtitleSegmentationStrategy = "auto";

    await acceptSubtitle({
      body: humanEnCc,
      selectedSubtitleId: "cc-en",
      selectedSubtitleUrl: "https://example.com/en-us.json",
      selectedSubtitleLang: "English (US)"
    });
    expect(state.clip.subtitleBody).toEqual(humanEnCc);

    const humanZhCc = Array.from({ length: 10 }, (_, idx) => ({
      from: idx * 1.1,
      to: idx * 1.1 + 0.8,
      content: `第${idx + 1}行，人工精校字幕。`
    }));
    clipState.setSubtitles([
      { id: "cc-zh", lan: "zh-CN", lanDoc: "中文（中国）", subtitleUrl: "https://example.com/zh-cn.json" }
    ]);

    await acceptSubtitle({
      body: humanZhCc,
      selectedSubtitleId: "cc-zh",
      selectedSubtitleUrl: "https://example.com/zh-cn.json",
      selectedSubtitleLang: "中文（中国）"
    });
    expect(state.clip.subtitleBody).toEqual(humanZhCc);
  });

  it("auto 模式下 ai-en / ai-zh 轨与 asr 伪轨自动执行粗块展平与智能重断句", async () => {
    clipState.setSubtitles([
      { id: "ai-track-1", lan: "ai-en", lanDoc: "English", subtitleUrl: "https://example.com/ai-en.json" }
    ]);
    state.settings.subtitleSegmentationStrategy = "auto";

    await acceptSubtitle({
      body: [
        { from: 0.2, to: 0.8, content: "Hello everyone" },
        { from: 0.9, to: 1.5, content: "welcome back." },
        { from: 1.6, to: 2.2, content: "Next line" }
      ],
      selectedSubtitleId: "ai-track-1",
      selectedSubtitleUrl: "https://example.com/ai-en.json",
      selectedSubtitleLang: "English"
    });

    expect(state.clip.subtitleBody).toEqual([
      { from: 0.2, to: 1.5, content: "Hello everyone welcome back." },
      { from: 1.6, to: 2.2, content: "Next line" }
    ]);

    // 切换为 off 模式时不做本地重断句
    state.settings.subtitleSegmentationStrategy = "off";
    const rawAsr = [
      { from: 0, to: 1, content: "Part one" },
      { from: 1.1, to: 2, content: "part two" }
    ];
    await acceptSubtitle({
      body: rawAsr,
      selectedSubtitleId: "asr",
      selectedSubtitleUrl: "",
      selectedSubtitleLang: "自配平台转写"
    });
    expect(state.clip.subtitleBody).toEqual(rawAsr);
  });

  it("shouldSegmentTrack 在 rule / stats 下强制开启，在 off 下强制关闭", () => {
    const sample = [{ from: 0, to: 1, content: "Hello world." }];
    expect(
      shouldSegmentTrack({
        strategy: "rule",
        selectedSubtitleId: "cc-en",
        trackLan: "en-US",
        items: sample
      })
    ).toBe(true);
    expect(
      shouldSegmentTrack({
        strategy: "stats",
        selectedSubtitleId: "cc-en",
        trackLan: "en-US",
        items: sample
      })
    ).toBe(true);
    expect(
      shouldSegmentTrack({
        strategy: "off",
        selectedSubtitleId: "asr",
        trackLan: "asr-zh",
        items: sample
      })
    ).toBe(false);
  });
});
