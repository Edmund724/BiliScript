import { normalizeBaseUrl } from "../core/presets.js";

const ASR_PROVIDER_TYPES = new Set([
  "openai-transcriptions"
]);

export interface AsrProvider {
  id: string;
  presetId: string;
  name: string;
  type: string;
  baseUrl: string;
  model: string;
  supportsTimestamps: boolean;
  enabled: boolean;
  apiKey?: string;
  language?: string;
}

export function normalizeAsrProvider(item: unknown): AsrProvider | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Partial<AsrProvider>;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const type = String(raw.type || "").trim();
  if (!ASR_PROVIDER_TYPES.has(type)) return null;
  return {
    id,
    presetId: String(raw.presetId || "custom").trim(),
    name: String(raw.name || "自定义").trim() || "自定义",
    type,
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    model: String(raw.model || "").trim(),
    supportsTimestamps: raw.supportsTimestamps !== false,
    enabled: raw.enabled !== false
  };
}

export function resolveActiveAsrProviderId(
  providers: ReadonlyArray<{ id?: string | null }> | null | undefined,
  activeId?: string | null
): string {
  const list = Array.isArray(providers) ? providers : [];
  const trimmed = String(activeId || "").trim();
  if (trimmed && list.some((p) => String(p?.id || "").trim() === trimmed)) {
    return trimmed;
  }
  return String(list[0]?.id || "").trim();
}
