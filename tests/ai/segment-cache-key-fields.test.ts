// ai/segment-cache-key-fields.js 键位字段叶单测（架构评审候选 5）：
// 叶是「段缓存键位字段清单 + 上下文投影」的唯一来源，四个消费者（SW 侧键位装配 /
// offscreen 出站点投影 / 协议载荷类型 / 概览键位装配）都从它派生。本文件钉住派生关系，
// 让「加一个键位维度 = 只改表一行」成立，且漏接一处就红：
//   1. 叶子零 import（把 storage / cache-lru 拖到 offscreen 侧即违约）；
//   2. 表 ↔ 两个投影：键位入参名 / 上下文字段名各就各位，字段集与表全等（无关字段不过线）；
//   3. 表里每个维度都真实改变段缓存族键——族键算法（core/cache-lru 的 key()）不读表，
//      漏接一个维度会静默串键（表现是缓存互相命中、不报错），这里必须红；
//   4. 出站点投影后过线的窄对象与原始上下文产出逐字节相同的键（过线不失真）。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SEGMENT_CACHE_KEY_FIELDS,
  projectSegmentCacheContext,
  segmentCacheKeyFields
} from "../../extension/ai/segment-cache-key-fields.js";

// 每个维度的探针值由字段名派生：新增维度不必改本文件（值恒为非空字符串）。
function probe(field: { key: string }): string {
  return `kf-${field.key}`;
}

// 上下文/期望形状一律从表派生，本文件不手抄一份字段清单。
// 全空上下文：source key 的 id > url > lang 优先级下，只有高优先维留空，低优先维的
// 差异才落到键上——逐维探针因此互不遮蔽。
function emptyContext(): Record<string, unknown> {
  return Object.fromEntries(SEGMENT_CACHE_KEY_FIELDS.map((field) => [field.context, ""] as const));
}

function probeContext(): Record<string, unknown> {
  return Object.fromEntries(SEGMENT_CACHE_KEY_FIELDS.map((field) => [field.context, probe(field)] as const));
}

describe("段缓存键位字段叶", () => {
  it("纯叶：模块源码无 import（offscreen 侧不会拖入 storage 层）", () => {
    const source = readFileSync("extension/ai/segment-cache-key-fields.ts", "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
  });

  it("表 ↔ 投影：键位名 / 上下文字段名各就各位，字段集与表全等", () => {
    const context = probeContext();
    const keyFields = segmentCacheKeyFields(context);
    const projected = projectSegmentCacheContext(context);

    expect(Object.keys(keyFields)).toEqual(SEGMENT_CACHE_KEY_FIELDS.map((field) => field.key));
    expect(Object.keys(projected)).toEqual(SEGMENT_CACHE_KEY_FIELDS.map((field) => field.context));
    for (const field of SEGMENT_CACHE_KEY_FIELDS) {
      expect(keyFields[field.key]).toBe(probe(field));
      expect(projected[field.context]).toBe(probe(field));
    }
  });

  it("投影只带键位字段：整份 AiContext 的无关字段不过线，缺上下文时键位字段恒在", () => {
    const full = {
      ...probeContext(),
      title: "长视频",
      subtitleBody: [{ from: 0, to: 5, content: "x" }],
      chapters: [{ from: 0, to: 10, title: "开场" }]
    };
    expect(Object.keys(projectSegmentCacheContext(full))).toEqual(
      SEGMENT_CACHE_KEY_FIELDS.map((field) => field.context)
    );

    for (const empty of [undefined, null]) {
      const keyFields = segmentCacheKeyFields(empty);
      expect(Object.keys(keyFields)).toEqual(SEGMENT_CACHE_KEY_FIELDS.map((field) => field.key));
      for (const field of SEGMENT_CACHE_KEY_FIELDS) {
        expect(keyFields[field.key]).toBeUndefined();
      }
    }
  });

  it("每个维度都真实参与族键：改一维即键变（漏接 = 静默串键，这里红）", async () => {
    const { buildSegmentSummaryCacheKey, buildRawSegmentCacheKey } = await import("../../extension/ai/segment-cache.js");
    const base = emptyContext();
    const summaryBase = buildSegmentSummaryCacheKey(base, 1);
    const rawBase = buildRawSegmentCacheKey(base, 1);
    for (const field of SEGMENT_CACHE_KEY_FIELDS) {
      const changed = { ...base, [field.context]: probe(field) };
      expect(
        buildSegmentSummaryCacheKey(changed, 1),
        `键位维度 ${field.key} 未参与分段小结键（表与族键算法脱节）`
      ).not.toBe(summaryBase);
      expect(buildRawSegmentCacheKey(changed, 1), `键位维度 ${field.key} 未参与原始段键`).not.toBe(rawBase);
    }
  });

  it("出站点投影 → SW 键位装配 = 直连键位（过线不失真，漏投影一个维度即红）", async () => {
    const { buildSegmentSummaryCacheKey } = await import("../../extension/ai/segment-cache.js");
    const context = probeContext();
    // 出站点只把投影后的窄对象发过线；JSON 往返即线上的可序列化形状
    const overTheWire = JSON.parse(JSON.stringify(projectSegmentCacheContext(context)));
    expect(buildSegmentSummaryCacheKey(overTheWire, 7)).toBe(buildSegmentSummaryCacheKey(context, 7));

    const fromWire = segmentCacheKeyFields(overTheWire);
    for (const field of SEGMENT_CACHE_KEY_FIELDS) {
      expect(fromWire[field.key]).toBe(context[field.context]);
    }
  });
});
