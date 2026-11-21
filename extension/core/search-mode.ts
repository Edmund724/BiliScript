export const SMART_SEARCH_ACTIVE_ID = "__smart__";

export type SearchMode = "single" | "smart";

export function isSmartSearchActive(activeId: string | null | undefined): boolean {
  const id = String(activeId ?? "").trim();
  return id === "" || id === SMART_SEARCH_ACTIVE_ID;
}

export function resolveSearchMode(activeId: string | null | undefined): SearchMode {
  return isSmartSearchActive(activeId) ? "smart" : "single";
}
