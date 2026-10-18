// extension/search/adapters/rows.ts 测试：七家 adapter 共享的行映射不变量单源
// （spec §8）：坏行（非对象）落到 {} 不抛、title/url String 归一、snippet 解析期
// 截断 500（SEARCH_SNIPPET_MAX_LENGTH）。各 adapter 自己的测试只钉 envelope 路径
// 与 pickRow 字段接线，不复测这些不变量。

import { describe, expect, it } from "vitest";
import { mapSearchResultRows } from "../../extension/search/adapters/rows.js";
import { SEARCH_SNIPPET_MAX_LENGTH } from "../../extension/search/adapters/types.js";

const pickContent = (row: Record<string, unknown>) => ({
  title: row.title,
  url: row.url,
  snippet: row.content
});

describe("mapSearchResultRows", () => {
  it("坏行（null / 字符串 / 数字）不抛，按空行归一出空字符串", () => {
    const rows = mapSearchResultRows([null, "nope", 42, { title: "T", url: "https://a", content: "摘要" }], pickContent);
    expect(rows).toEqual([
      { title: "", url: "", snippet: "" },
      { title: "", url: "", snippet: "" },
      { title: "", url: "", snippet: "" },
      { title: "T", url: "https://a", snippet: "摘要" }
    ]);
  });

  it("缺字段 / 非字符串值按 String(row.x || \"\") 归一", () => {
    const rows = mapSearchResultRows(
      [{ title: 0, url: "https://a", content: null }, { content: "只有 snippet" }],
      pickContent
    );
    expect(rows).toEqual([
      { title: "", url: "https://a", snippet: "" },
      { title: "", url: "", snippet: "只有 snippet" }
    ]);
  });

  it("snippet 解析期截断 500 字符（SEARCH_SNIPPET_MAX_LENGTH）", () => {
    const rows = mapSearchResultRows([{ title: "T", url: "https://a", content: "x".repeat(600) }], pickContent);
    expect(rows[0].snippet).toHaveLength(SEARCH_SNIPPET_MAX_LENGTH);
  });
});
