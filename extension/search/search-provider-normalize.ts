import { normalizeBaseUrl, SEARCH_PROVIDER_PRESETS, type SearchProviderType } from "../core/presets.js";

const SEARCH_PROVIDER_TYPES = new Set<string>(SEARCH_PROVIDER_PRESETS.map((p) => p.type));

export interface SearchProvider {
  id: string;
  presetId: string;
  name: string;
  type: SearchProviderType;
  baseUrl: string;
  enabled: boolean;
}

export function normalizeSearchProvider(item: unknown): SearchProvider | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Partial<SearchProvider>;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const type = String(raw.type || "").trim();
  if (!SEARCH_PROVIDER_TYPES.has(type)) return null;
  return {
    id,
    presetId: String(raw.presetId || "custom").trim(),
    name: String(raw.name || "自定义").trim() || "自定义",
    type: type as SearchProviderType,
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    enabled: raw.enabled !== false
  };
}
