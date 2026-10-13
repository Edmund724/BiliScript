// 段缓存键入口的新旧两路径逐字节对拍：SW handler 的键位装配走
// ai/segment-cache.js 的便捷形 buildSegmentSummaryCacheKey / buildRawSegmentCacheKey
// （吃 AI 上下文 + 段号 + 预算档，内部经键位叶 ai/segment-cache-key-fields.ts 投影），
// 旧路径是「键位叶投影展开 + getSegmentSummaryKey / getRawSegmentKey 手拼」。两条路径
// 必须逐字节同键——段边界靠段序号 + 预算代后缀区分，键漂移的表现是缓存互相命中
// （内容串段）而不报错。
//
// 覆盖键形差异面：常态化档（无后缀）/ 非常态档（_b50 / _b200）/ 非法与缺省预算档
// （回落常态档）/ 缺上下文与 null 上下文（键位字段恒在、值全 undefined）。

import { describe, expect, it } from "vitest";
import {
  buildRawSegmentCacheKey,
  buildSegmentSummaryCacheKey,
  getRawSegmentKey,
  getSegmentSummaryKey,
  segmentCacheKeyFields
} from "../../extension/ai/segment-cache.js";

const CONTEXT = {
  bvid: "BV1keyentry",
  cid: "77",
  selectedSubtitleId: "sub-9",
  selectedSubtitleUrl: "",
  subtitleLang: "",
  // 键位之外的字段不得混入
  title: "测试视频",
  subtitleBody: [{ from: 0, to: 5, content: "x" }]
};

// 旧路径：键位叶投影展开后手拼（handler 收成入口前的写法）。
function legacySummaryKey(context: Record<string, unknown> | undefined | null, segmentIndex: unknown, budgetScale?: unknown): string {
  return getSegmentSummaryKey({ ...segmentCacheKeyFields(context), segmentIndex, budgetScale });
}

function legacyRawKey(context: Record<string, unknown> | undefined | null, segmentIndex: unknown, budgetScale?: unknown): string {
  return getRawSegmentKey({ ...segmentCacheKeyFields(context), segmentIndex, budgetScale });
}

describe("段缓存键入口：便捷形与手拼键逐字节相同", () => {
  it.each([
    ["常态化档 1", 3, 1],
    ["缺省预算档", 3, undefined],
    ["非常态档 0.5", 3, 0.5],
    ["非常态档 2", 3, 2],
    ["非法预算档", 3, "x"],
    ["字符串段号", "12", 0.5]
  ])("%s：新旧两路径同键", (_label, segmentIndex, budgetScale) => {
    expect(buildSegmentSummaryCacheKey(CONTEXT, segmentIndex, budgetScale)).toBe(
      legacySummaryKey(CONTEXT, segmentIndex, budgetScale)
    );
    expect(buildRawSegmentCacheKey(CONTEXT, segmentIndex, budgetScale)).toBe(
      legacyRawKey(CONTEXT, segmentIndex, budgetScale)
    );
  });

  it("键字节锚点：常态化档键形与历史逐字节一致（两路径同漂会被这里钉住）", () => {
    expect(buildSegmentSummaryCacheKey(CONTEXT, 3, 1)).toBe("biliscript_lvs_summary_BV1keyentry_77_id_sub-9_3");
    expect(buildRawSegmentCacheKey(CONTEXT, 3, 1)).toBe("biliscript_lvs_raw_BV1keyentry_77_id_sub-9_3");
    expect(buildSegmentSummaryCacheKey(CONTEXT, 3, 0.5)).toBe("biliscript_lvs_summary_BV1keyentry_77_id_sub-9_3_b50");
  });

  it("缺上下文 / null 上下文：键位字段恒在、值全 undefined，两路径同键", () => {
    for (const context of [undefined, null]) {
      // 运行时 null：类型面按 undefined 传（键位叶自身容错 null），对拍的是运行时行为
      expect(buildSegmentSummaryCacheKey(context as unknown as Record<string, unknown>, 3)).toBe(
        legacySummaryKey(context, 3)
      );
      expect(buildRawSegmentCacheKey(context as unknown as Record<string, unknown>, 3)).toBe(
        legacyRawKey(context, 3)
      );
    }
    expect(buildSegmentSummaryCacheKey(undefined, 3)).toBe(legacySummaryKey({}, 3));
  });
});
