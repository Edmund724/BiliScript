import { truncateSnippet, type NormalizedSearchResult } from "./types.js";

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
