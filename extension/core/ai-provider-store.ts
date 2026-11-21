import { createProviderStore } from "./provider-store.js";
import { normalizeBaseUrl } from "./presets.js";
import { AI_PROTOCOLS, type AiProtocol } from "../ai/protocol-vocab.js";
import type { AiProvider as AiProviderWire } from "../ai/types.js";

export interface AiProvider extends AiProviderWire {
  id: string;
  presetId: string;
  name: string;
  baseUrl: string;
  models: string[];
  requiresKey: boolean;
  enabled: boolean;
  protocol?: AiProtocol;
  hasSavedKey?: boolean;
  apiKey?: string;
}

export const AI_PROVIDER_KEYS_STORAGE = "aiProviderKeys";
export const AI_PROVIDERS_STORAGE = "aiProviders";

function normalizeModelsField(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of list) {
    const id = String(entry ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function normalizeAiProvider(item: unknown): AiProvider | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Partial<AiProvider>;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const legacyModel = String(raw.model ?? "").trim();
  const models = normalizeModelsField(raw.models);
  const normalized: AiProvider = {
    id,
    presetId: String(raw.presetId || "custom").trim(),
    name: String(raw.name || "自定义").trim() || "自定义",
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    models: models.length ? models : legacyModel ? [legacyModel] : [],
    requiresKey: raw.requiresKey !== false,
    enabled: raw.enabled !== false
  };
  if (typeof raw.protocol === "string" && (AI_PROTOCOLS as readonly string[]).includes(raw.protocol)) {
    normalized.protocol = raw.protocol as AiProtocol;
  }
  return normalized;
}

export const aiProviderStore = createProviderStore<AiProvider>({
  listStorageKey: AI_PROVIDERS_STORAGE,
  keysStorageKey: AI_PROVIDER_KEYS_STORAGE,
  normalizeProvider: normalizeAiProvider
});
