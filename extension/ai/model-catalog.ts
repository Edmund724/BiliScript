import { PRESETS, type AiProviderPreset } from "../core/presets.js";
import { hostOf, presetIdForHost } from "../core/preset-host-index.js";
import {
  UPSTREAM_CATALOG,
  lookupUpstreamModelMeta,
  type CatalogModelMeta
} from "./catalog/models-dev-catalog.generated.js";
import { MODEL_ID_ALIASES } from "./catalog/models-dev-thinking.generated.js";

export { UPSTREAM_CATALOG_SOURCE } from "./catalog/models-dev-catalog.generated.js";
export type { CatalogModelMeta };

const IDENTITYLESS_PRESETS = new Set<string>(["custom"]);

function presetById(id: string): AiProviderPreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

export function resolveCatalogProvider(presetId: unknown, baseUrl: unknown): string | null {
  const id = typeof presetId === "string" ? presetId.trim() : "";
  if (id) {
    const preset = presetById(id);
    if (preset) {
      if (preset.catalogProvider) {
        return preset.catalogProvider;
      }
      if (!IDENTITYLESS_PRESETS.has(preset.id)) {
        return null;
      }
    }
  }
  const host = hostOf(baseUrl);
  if (!host) {
    return null;
  }
  const hostPresetId = presetIdForHost(host);
  if (!hostPresetId) {
    return null;
  }
  return presetById(hostPresetId)?.catalogProvider ?? null;
}

function resolveCatalogKey(
  providerId: string,
  modelId: string
): { providerId: string; modelId: string } | null {
  if (lookupUpstreamModelMeta(providerId, modelId)) {
    return { providerId, modelId };
  }
  const folded = modelId.toLowerCase();
  for (const candidate of Object.keys(UPSTREAM_CATALOG[providerId] ?? {})) {
    if (candidate.toLowerCase() === folded) {
      return { providerId, modelId: candidate };
    }
  }
  for (const alias of MODEL_ID_ALIASES) {
    if (alias.provider !== providerId || alias.localId.toLowerCase() !== folded) {
      continue;
    }
    const slash = alias.upstream.indexOf("/");
    if (slash > 0 && slash < alias.upstream.length - 1) {
      return { providerId: alias.upstream.slice(0, slash), modelId: alias.upstream.slice(slash + 1) };
    }
  }
  return null;
}

export function lookupCatalogMeta(
  presetId: unknown,
  baseUrl: unknown,
  modelId: unknown
): CatalogModelMeta | null {
  const providerId = resolveCatalogProvider(presetId, baseUrl);
  if (!providerId) {
    return null;
  }
  const id = typeof modelId === "string" ? modelId.trim() : "";
  if (!id) {
    return null;
  }
  const key = resolveCatalogKey(providerId, id);
  return key ? lookupUpstreamModelMeta(key.providerId, key.modelId) : null;
}
