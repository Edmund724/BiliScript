// extension/search/adapters/rows.ts
// 行映射帮手：七家 adapter 的 parse 在信封提取之后只剩「哪三个字段构成一行」
// 这一个差异（snippet 提取式各家不同：content / summary / snippet / excerpts[0] /
// 回退链；豆包是 PascalCase 键）。pickRow 是行策略，只做字段选择；对象守卫
// （坏行落到 {}，不抛）、String 归一、snippet 截断统一收在这里，口径单源。
// 纯函数，零 Chrome API / 零 DOM。

import { truncateSnippet, type NormalizedSearchResult } from "./types.js";

// pickRow 的返回约定：三个字段都是原始值（未归一），归一由 mapSearchResultRows 收口。
export type PickedSearchRow = {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
};

export function mapSearchResultRows(
  rows: unknown[],
  pickRow: (row: Record<string, unknown>) => PickedSearchRow
): NormalizedSearchResult[] {
  return rows.map((item) => {
    const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const picked = pickRow(row);
    return {
      title: String(picked.title || ""),
      url: String(picked.url || ""),
      snippet: truncateSnippet(picked.snippet)
    };
  });
}
