import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SEGMENT_CACHE_KEY_FIELDS,
  projectSegmentCacheContext,
  segmentCacheKeyFields,
  segmentCacheKeyStringFields
} from "../../extension/ai/segment-cache-key-fields.js";

function probe(field: { key: string }): string {
  return `kf-${field.key}`;
}

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
    const { buildSegmentSummaryCacheKey } = await import("../../extension/ai/segment-cache.js");
    const base = emptyContext();
    const summaryBase = buildSegmentSummaryCacheKey(base, 1);
    for (const field of SEGMENT_CACHE_KEY_FIELDS) {
      const changed = { ...base, [field.context]: probe(field) };
      expect(
        buildSegmentSummaryCacheKey(changed, 1),
        `键位维度 ${field.key} 未参与分段小结键（表与族键算法脱节）`
      ).not.toBe(summaryBase);
    }
  });

  it("出站点投影 → SW 键位装配 = 直连键位（过线不失真，漏投影一个维度即红）", async () => {
    const { buildSegmentSummaryCacheKey } = await import("../../extension/ai/segment-cache.js");
    const context = probeContext();
    const overTheWire = JSON.parse(JSON.stringify(projectSegmentCacheContext(context)));
    expect(buildSegmentSummaryCacheKey(overTheWire, 7)).toBe(buildSegmentSummaryCacheKey(context, 7));

    const fromWire = segmentCacheKeyFields(overTheWire);
    for (const field of SEGMENT_CACHE_KEY_FIELDS) {
      expect(fromWire[field.key]).toBe(context[field.context]);
    }
  });

  describe("字符串化命名投影 segmentCacheKeyStringFields", () => {
    it("字段集与表全等，缺失上下文时全量字段恒为空串", () => {
      const context = probeContext();
      const stringFields = segmentCacheKeyStringFields(context);

      expect(Object.keys(stringFields)).toEqual(SEGMENT_CACHE_KEY_FIELDS.map((field) => field.key));
      for (const field of SEGMENT_CACHE_KEY_FIELDS) {
        expect(stringFields[field.key]).toBe(probe(field));
      }

      for (const empty of [undefined, null, {}]) {
        const emptyFields = segmentCacheKeyStringFields(empty);
        expect(Object.keys(emptyFields)).toEqual(SEGMENT_CACHE_KEY_FIELDS.map((field) => field.key));
        for (const field of SEGMENT_CACHE_KEY_FIELDS) {
          expect(emptyFields[field.key]).toBe("");
        }
      }
    });

    it("真值表：含 0 / false / null / undefined / 非字符串值", () => {
      const cases: Array<{ input: unknown; expected: string; label: string }> = [
        { input: "hello", expected: "hello", label: "普通非空字符串" },
        { input: "", expected: "", label: "空字符串" },
        { input: null, expected: "", label: "null 归一为空串" },
        { input: undefined, expected: "", label: "undefined 归一为空串" },
        { input: 0, expected: "0", label: "数字 0 保留字面量（?? 口径与 || 口径在域外分流）" },
        { input: false, expected: "false", label: "布尔 false 保留字面量" },
        { input: true, expected: "true", label: "布尔 true" },
        { input: 12345, expected: "12345", label: "数值 12345" },
        { input: NaN, expected: "NaN", label: "NaN 保留字面量" }
      ];

      for (const testCase of cases) {
        for (const field of SEGMENT_CACHE_KEY_FIELDS) {
          const result = segmentCacheKeyStringFields({ [field.context]: testCase.input });
          expect(result[field.key], `${field.key} on ${testCase.label}`).toBe(testCase.expected);
        }
      }
    });

    it("现键值域等价性判据验证：域内合法取值下，String(v ?? '') 与 String(v || '') 严格等价", () => {
      const inDomainValues: unknown[] = [
        "BV1test",
        "123456",
        123456,
        "sub-1",
        "https://example.com/sub.json",
        "zh-CN",
        "",
        null,
        undefined
      ];

      for (const val of inDomainValues) {
        const nullishCoalesced = String(val ?? "");
        const logicalOrCoalesced = String(val || "");
        expect(nullishCoalesced).toBe(logicalOrCoalesced);

        for (const field of SEGMENT_CACHE_KEY_FIELDS) {
          const projected = segmentCacheKeyStringFields({ [field.context]: val });
          expect(projected[field.key]).toBe(nullishCoalesced);
        }
      }
    });
  });
});
