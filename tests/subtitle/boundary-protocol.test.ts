// 字幕双通道协议与四重容错闭环单测（subtitle/boundary-protocol.ts & ai/subtitle-translate.ts）。
//
// 系统可能的失败方式：
//   1. 批次切分失控：未到 80%（800 字）软边界提前切碎，或满 800 字遇到句号 / >1000ms 停顿未提前封块，
//      或无标点长流超出 1000 字硬上限、产生滑动窗口重叠导致重复翻译；
//   2. 时间戳泄漏：formatBoundaryEvents 向模型暴露 start/end 字段诱发时间戳幻觉，或零/负间隔误带 pauseMs；
//   3. 截断响应全军覆没：模型输出 ```json 围栏、尾逗号或因 max_tokens 半截截断（含字符串内嵌 `}`）时丢失已译前缀；
//   4. 跳号串行错位与原文篡改：某组 ids 跳号或越界后未立即截断脏后缀，或直接使用模型篡改后的 text 而非前端切片拼接；
//   5. 尾部漏译与整块解析失败中断：首轮仅覆盖前缀时未触发最多 1 次 Tail Retry（或偏移还原错误），
//      重试后仍缺尾部事件时未走 mergeSubtitlesByRule 局部降级，或整块损坏时抛错中断整集字幕；
//   6. 时间轴浮点漂移：输出 cues 的 from/to 与原始 events 首尾 startMs/endMs 换算值存在非零误差。

import { describe, expect, it, vi } from "vitest";
import {
  finalizeAiCues,
  formatBoundaryEvents,
  mapBoundaryGroupsToCues,
  salvageTruncatedSubtitleJson,
  splitEventsIntoAiChunks,
  takeContinuousCuePrefix
} from "../../extension/subtitle/boundary-protocol.js";
import {
  buildBoundaryTranslateMessages,
  translateSubtitleItems,
  translateSubtitleTrack
} from "../../extension/ai/subtitle-translate.js";
import type { SubtitleTranslateProviderResolution } from "../../extension/ai/subtitle-translate-config.js";
import type { AtomicSubtitleEvent } from "../../extension/subtitle/segmentation.js";

const TEST_PROVIDER_RESOLUTION: SubtitleTranslateProviderResolution = {
  provider: {
    id: "test-provider",
    name: "Test Provider",
    baseUrl: "https://api.example.com/v1",
    models: ["fast-mini"],
    enabled: true,
    hasSavedKey: true
  },
  apiKey: "sk-test",
  baseUrl: "https://api.example.com/v1",
  model: "fast-mini",
  presetId: "custom",
  protocol: "openai",
  isFallback: false
};

const EIGHT_EVENTS: AtomicSubtitleEvent[] = [
  { text: "When we", startMs: 125, endMs: 980 },
  { text: "design a", startMs: 1020, endMs: 1850 },
  { text: "subtitle protocol,", startMs: 1900, endMs: 3105 },
  { text: "every index", startMs: 3300, endMs: 4120 },
  { text: "must stay", startMs: 4150, endMs: 4890 },
  { text: "strictly aligned.", startMs: 4920, endMs: 6235 },
  { text: "Even tail", startMs: 6800, endMs: 7540 },
  { text: "fragments matter.", startMs: 7600, endMs: 8915 }
];

describe("splitEventsIntoAiChunks：80% 软边界无重叠批次切分", () => {
  it("达到 820 字符遇到句号时立即提前封块，低于 800 字符遇句号不提前封块且无重叠", () => {
    const ev0: AtomicSubtitleEvent = { text: "a".repeat(400), startMs: 0, endMs: 1000 };
    const ev1: AtomicSubtitleEvent = { text: `${"b".repeat(389)}.`, startMs: 1100, endMs: 2000 }; // 累计 790 < 800
    const ev2: AtomicSubtitleEvent = { text: `${"c".repeat(29)}.`, startMs: 2100, endMs: 3000 }; // 累计 820 >= 800 且句号结尾
    const ev3: AtomicSubtitleEvent = { text: "d".repeat(120), startMs: 3100, endMs: 4000 };

    const chunks = splitEventsIntoAiChunks([ev0, ev1, ev2, ev3], 1000);

    expect(chunks).toEqual([[ev0, ev1, ev2], [ev3]]);
  });

  it("达到 820 字符无句末标点但与下一事件停顿 1200ms（>1000ms）时立即提前封块", () => {
    const ev0: AtomicSubtitleEvent = { text: "a".repeat(500), startMs: 0, endMs: 1000 };
    const ev1: AtomicSubtitleEvent = { text: "b".repeat(320), startMs: 1100, endMs: 2000 }; // 累计 820
    const ev2: AtomicSubtitleEvent = { text: "c".repeat(150), startMs: 3200, endMs: 4000 }; // 停顿 1200ms

    const chunks = splitEventsIntoAiChunks([ev0, ev1, ev2], 1000);

    expect(chunks).toEqual([[ev0, ev1], [ev2]]);
  });

  it("全程无句末标点且停顿 <=1000ms 时，在超出 1000 字符硬上限前封块", () => {
    const ev0: AtomicSubtitleEvent = { text: "a".repeat(500), startMs: 0, endMs: 1000 };
    const ev1: AtomicSubtitleEvent = { text: "b".repeat(320), startMs: 1500, endMs: 2200 }; // 累计 820，停顿 300ms
    const ev2: AtomicSubtitleEvent = { text: "c".repeat(150), startMs: 2500, endMs: 3200 }; // 累计 970 <= 1000
    const ev3: AtomicSubtitleEvent = { text: "d".repeat(60), startMs: 3500, endMs: 4200 }; // 970 + 60 = 1030 > 1000

    const chunks = splitEventsIntoAiChunks([ev0, ev1, ev2, ev3], 1000);

    expect(chunks).toEqual([[ev0, ev1, ev2], [ev3]]);
  });
});

describe("formatBoundaryEvents：零时间戳编码", () => {
  it("仅输出字符串 id、text 与正整数 pauseMs，绝不包含任何 start/end 字段", () => {
    const encoded = formatBoundaryEvents([
      { text: "Hello", startMs: 100, endMs: 500 },
      { text: "world", startMs: 500, endMs: 1000 }, // 间隔 0ms，不带 pauseMs
      { text: "again", startMs: 1350, endMs: 2000 } // 末项前一项间隔 350ms
    ]);

    expect(encoded).toEqual([
      { id: "0", text: "Hello" },
      { id: "1", text: "world", pauseMs: 350 },
      { id: "2", text: "again" }
    ]);
    expect(Object.keys(encoded[0])).toEqual(["id", "text"]);
    expect(Object.keys(encoded[1])).toEqual(["id", "text", "pauseMs"]);
  });
});

describe("salvageTruncatedSubtitleJson：围栏剥离、尾逗号修复与半截 JSON 前缀抢救", () => {
  it("剥离未闭合 ```json 围栏、修复尾逗号，并抢救半截字符串（含内嵌花括号）前的完整 groups 前缀", () => {
    const truncated =
      '```json\n{"groups":[' +
      '{"ids":["0","1"],"text":"When we design","translation":"当我们设计",},' +
      '{"ids":["2"],"text":"subtitle protocol,","translation":"字幕协议时，"},' +
      '{"ids":["3","5"],"text":"unfinished } string with \\"quote';

    const salvaged = salvageTruncatedSubtitleJson(truncated);

    expect(salvaged).toEqual({
      groups: [
        { ids: ["0", "1"], text: "When we design", translation: "当我们设计" },
        { ids: ["2"], text: "subtitle protocol,", translation: "字幕协议时，" }
      ]
    });
  });

  it("支持人工 CC 批量协议顶层 JSON 数组截断前缀抢救", () => {
    const truncatedArray =
      '```json\n[{"id":"0","translation":"第一句译文"},{"id":"1","translation":"第二句译文"}, {"id":"2","transl';

    const salvaged = salvageTruncatedSubtitleJson(truncatedArray);

    expect(salvaged).toEqual([
      { id: "0", translation: "第一句译文" },
      { id: "1", translation: "第二句译文" }
    ]);
  });

  it("完全无有效 JSON 结构时返回 null 而不抛异常", () => {
    expect(salvageTruncatedSubtitleJson("Sorry, I cannot process this request.")).toBeNull();
    expect(salvageTruncatedSubtitleJson('{"groups":[{"ids":["0"],"text":"cut before first close')).toBeNull();
  });
});

describe("takeContinuousCuePrefix & mapBoundaryGroupsToCues：连续无跳号校验与零误差时间轴回填", () => {
  it("兼容首尾二元区间与完整连续数组 ids，跳号或越界处立即截断并用前端原文覆盖模型篡改文本", () => {
    const groups = {
      groups: [
        { ids: ["0", "1", "2"], text: "LLM altered text!", translation: "当我们设计字幕协议时，" },
        { ids: ["3", "4"], text: "every index must stay", translation: "每个索引都必须保持" },
        // 跳过了 "5"，直接跳到 "6" -> 此项及后续项必须全部丢弃
        { ids: ["6", "7"], text: "Even tail fragments matter.", translation: "脏数据不应保留" }
      ]
    };

    const cues = mapBoundaryGroupsToCues(groups, EIGHT_EVENTS, "en");

    expect(cues).toEqual([
      {
        startIndex: 0,
        endIndex: 2,
        from: 0.125,
        to: 3.105,
        text: "When we design a subtitle protocol,",
        translation: "当我们设计字幕协议时，"
      },
      {
        startIndex: 3,
        endIndex: 4,
        from: 3.3,
        to: 4.89,
        text: "every index must stay",
        translation: "每个索引都必须保持"
      }
    ]);
    expect(cues[0].from - EIGHT_EVENTS[0].startMs / 1000).toBe(0);
    expect(cues[0].to - EIGHT_EVENTS[2].endMs / 1000).toBe(0);
    expect(cues[1].from - EIGHT_EVENTS[3].startMs / 1000).toBe(0);
    expect(cues[1].to - EIGHT_EVENTS[4].endMs / 1000).toBe(0);
  });

  it("takeContinuousCuePrefix 对越界区间立即截断", () => {
    const prefix = takeContinuousCuePrefix(
      [
        { startIndex: 0, endIndex: 1 },
        { startIndex: 2, endIndex: 8 } // totalEvents=8，最大合法下标为 7
      ],
      8
    );
    expect(prefix).toEqual([{ startIndex: 0, endIndex: 1 }]);
  });
});

describe("Tail Retry 与 finalizeAiCues 四重容错闭环端到端验证", () => {
  it("初次只返回 0..5（共 8 个事件）时自动触发 1 次 Tail Retry 补齐 6..7，且首尾时间轴误差严格为 0", async () => {
    const mockChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          groups: [
            { ids: ["0", "2"], text: "When we design a subtitle protocol,", translation: "当我们设计字幕协议时，" },
            { ids: ["3", "5"], text: "every index must stay strictly aligned.", translation: "每个索引都必须保持严格对齐。" }
          ]
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          groups: [
            { ids: ["0", "1"], text: "Even tail fragments matter.", translation: "哪怕尾部碎片也至关重要。" }
          ]
        })
      );

    const result = await translateSubtitleTrack({
      items: [],
      events: EIGHT_EVENTS,
      sourceLang: "en",
      targetLang: "zh",
      mode: "boundary-v3",
      providerResolution: TEST_PROVIDER_RESOLUTION,
      chatCompletionFn: mockChatCompletion as any
    });

    expect(mockChatCompletion).toHaveBeenCalledTimes(2);
    // 验证第 2 次请求（Tail Retry）仅发送原 6..7 切片且重编码为局部索引 "0".."1"
    const retryUserContent = mockChatCompletion.mock.calls[1][0].messages[1].content;
    expect(JSON.parse(retryUserContent)).toEqual([
      { id: "0", text: "Even tail", pauseMs: 60 },
      { id: "1", text: "fragments matter." }
    ]);

    expect(result.mode).toBe("boundary-v3");
    expect(result.items).toEqual([
      { from: 0.125, to: 3.105, content: "When we design a subtitle protocol," },
      { from: 3.3, to: 6.235, content: "every index must stay strictly aligned." },
      { from: 6.8, to: 8.915, content: "Even tail fragments matter." }
    ]);
    expect(result.translations).toEqual([
      { from: 0.125, to: 3.105, content: "当我们设计字幕协议时，" },
      { from: 3.3, to: 6.235, content: "每个索引都必须保持严格对齐。" },
      { from: 6.8, to: 8.915, content: "哪怕尾部碎片也至关重要。" }
    ]);

    // 严格校验生成时间轴与原始 events 首尾时间戳误差为 0
    expect(result.items[0].from - EIGHT_EVENTS[0].startMs / 1000).toBe(0);
    expect(result.items[0].to - EIGHT_EVENTS[2].endMs / 1000).toBe(0);
    expect(result.items[1].from - EIGHT_EVENTS[3].startMs / 1000).toBe(0);
    expect(result.items[1].to - EIGHT_EVENTS[5].endMs / 1000).toBe(0);
    expect(result.items[2].from - EIGHT_EVENTS[6].startMs / 1000).toBe(0);
    expect(result.items[2].to - EIGHT_EVENTS[7].endMs / 1000).toBe(0);
  });

  it("初次覆盖 0..5、Tail Retry 仍缺 7 时，不再无限重试 boundary-v3，仅对残余 7 局部降级规则合并并补译", async () => {
    const mockChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          groups: [
            { ids: ["0", "2"], text: "When we design a subtitle protocol,", translation: "当我们设计字幕协议时，" },
            { ids: ["3", "5"], text: "every index must stay strictly aligned.", translation: "每个索引都必须保持严格对齐。" }
          ]
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          groups: [{ ids: ["0"], text: "Even tail", translation: "哪怕是尾部" }]
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify([{ id: "0", translation: "碎片也很重要。" }])
      );

    const result = await translateSubtitleItems({
      items: [],
      events: EIGHT_EVENTS,
      sourceLang: "en",
      targetLang: "zh",
      mode: "boundary-v3",
      providerResolution: TEST_PROVIDER_RESOLUTION,
      chatCompletionFn: mockChatCompletion as any
    });

    // 1 次主请求 + 1 次 Tail Retry + 1 次残余规则合并后的轻量补译
    expect(mockChatCompletion).toHaveBeenCalledTimes(3);
    const fallbackUserContent = mockChatCompletion.mock.calls[2][0].messages[1].content;
    expect(JSON.parse(fallbackUserContent)).toEqual([{ id: "0", text: "fragments matter." }]);

    expect(result.items).toEqual([
      { from: 0.125, to: 3.105, content: "When we design a subtitle protocol," },
      { from: 3.3, to: 6.235, content: "every index must stay strictly aligned." },
      { from: 6.8, to: 7.54, content: "Even tail" },
      { from: 7.6, to: 8.915, content: "fragments matter." }
    ]);
    expect([...result]).toEqual([
      { from: 0.125, to: 3.105, content: "当我们设计字幕协议时，" },
      { from: 3.3, to: 6.235, content: "每个索引都必须保持严格对齐。" },
      { from: 6.8, to: 7.54, content: "哪怕是尾部" },
      { from: 7.6, to: 8.915, content: "碎片也很重要。" }
    ]);
    expect(result.translations).toEqual([...result]);
    expect(result.items[3].from - EIGHT_EVENTS[7].startMs / 1000).toBe(0);
    expect(result.items[3].to - EIGHT_EVENTS[7].endMs / 1000).toBe(0);
  });

  it("Tail Retry 返回无法解析内容时，尾部多事件残余切片 6..7 经 mergeSubtitlesByRule 合并为单句并补译", async () => {
    const mockChatCompletion = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          groups: [
            { ids: ["0", "2"], text: "When we design a subtitle protocol,", translation: "当我们设计字幕协议时，" },
            { ids: ["3", "5"], text: "every index must stay strictly aligned.", translation: "每个索引都必须保持严格对齐。" }
          ]
        })
      )
      .mockResolvedValueOnce("unparseable retry output")
      .mockResolvedValueOnce(
        JSON.stringify([{ id: "0", translation: "哪怕尾部碎片也很重要。" }])
      );

    const result = await translateSubtitleTrack({
      items: [],
      events: EIGHT_EVENTS,
      sourceLang: "en",
      targetLang: "zh",
      mode: "boundary-v3",
      providerResolution: TEST_PROVIDER_RESOLUTION,
      chatCompletionFn: mockChatCompletion as any
    });

    expect(mockChatCompletion).toHaveBeenCalledTimes(3);
    expect(JSON.parse(mockChatCompletion.mock.calls[2][0].messages[1].content)).toEqual([
      { id: "0", text: "Even tail fragments matter." }
    ]);
    expect(result.items[2]).toEqual({
      from: 6.8,
      to: 8.915,
      content: "Even tail fragments matter."
    });
    expect(result.translations[2]).toEqual({
      from: 6.8,
      to: 8.915,
      content: "哪怕尾部碎片也很重要。"
    });
    expect(result.items[2].from - EIGHT_EVENTS[6].startMs / 1000).toBe(0);
    expect(result.items[2].to - EIGHT_EVENTS[7].endMs / 1000).toBe(0);
  });

  it("整块彻底解析失败且补译亦异常时，finalizeAiCues 整块降级为 mergeSubtitlesByRule，绝不抛错中断", async () => {
    const finalized = await finalizeAiCues([], EIGHT_EVENTS, {
      sourceLang: "en",
      fallbackToOriginal: false,
      translateFallbackLines: async () => {
        throw new Error("fallback llm failed");
      }
    });

    // EIGHT_EVENTS 按句末标点 `.` 在下标 5 与 7 处合并为 2 条完整主句
    expect(finalized.items).toEqual([
      {
        from: 0.125,
        to: 6.235,
        content: "When we design a subtitle protocol, every index must stay strictly aligned."
      },
      {
        from: 6.8,
        to: 8.915,
        content: "Even tail fragments matter."
      }
    ]);
    expect(finalized.translations).toEqual([
      { from: 0.125, to: 6.235, content: "" },
      { from: 6.8, to: 8.915, content: "" }
    ]);
  });

  it("buildBoundaryTranslateMessages 支持注入可选 title / description / summary / glossary 上下文", () => {
    const messages = buildBoundaryTranslateMessages(EIGHT_EVENTS.slice(0, 2), "zh", {
      title: "Compiler Optimization Talk",
      description: "Deep dive into SSA",
      summary: "Explains loop invariant code motion",
      glossary: { SSA: "静态单赋值", LICM: "循环不变代码外提" }
    });

    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("<= 15 词");
    expect(messages[0].content).toContain("<= 30 字");
    expect(messages[0].content).toContain("视频标题：Compiler Optimization Talk");
    expect(messages[0].content).toContain("视频简介：Deep dive into SSA");
    expect(messages[0].content).toContain("内容摘要：Explains loop invariant code motion");
    expect(messages[0].content).toContain("SSA -> 静态单赋值");
    expect(messages[0].content).toContain("LICM -> 循环不变代码外提");
  });
});
