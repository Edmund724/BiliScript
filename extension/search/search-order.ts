import { DEFAULT_SEARCH_PROVIDER_ORDER } from "../core/presets.js";

export function normalizeSearchProviderOrder(raw: unknown, knownRecordIds: Iterable<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(knownRecordIds);
  const seen = new Set<string>();
  const order: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || value.trim() === "") return [];
    if (!known.has(value) || seen.has(value)) return [];
    seen.add(value);
    order.push(value);
  }
  return order;
}

export function providerOrderRank(
  id: string,
  presetId: string,
  order: readonly string[]
): readonly [number, number] {
  const orderIndex = order.indexOf(id);
  const defaultIndex = DEFAULT_SEARCH_PROVIDER_ORDER.indexOf(presetId);
  return [
    orderIndex === -1 ? Number.POSITIVE_INFINITY : orderIndex,
    defaultIndex === -1 ? DEFAULT_SEARCH_PROVIDER_ORDER.length : defaultIndex
  ];
}
