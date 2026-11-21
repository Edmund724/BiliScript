export const SELECTED_PROVIDER_KEY = "biliscript_ai_selected_provider";

export const MODEL_OPTION_SEPARATOR = String.fromCharCode(1);

export function buildModelOptionValue(providerId: string, model: string): string {
  return `${String(providerId || "").trim()}${MODEL_OPTION_SEPARATOR}${String(model || "").trim()}`;
}

export function parseModelOptionValue(value: unknown): { providerId: string; model: string } {
  const raw = String(value || "");
  const idx = raw.indexOf(MODEL_OPTION_SEPARATOR);
  if (idx === -1) {
    return { providerId: raw.trim(), model: "" };
  }
  return {
    providerId: raw.slice(0, idx).trim(),
    model: raw.slice(idx + MODEL_OPTION_SEPARATOR.length).trim()
  };
}

export function normalizeProviderModels(
  provider: { models?: unknown; model?: unknown } | null | undefined
): string[] {
  if (Array.isArray(provider?.models)) {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entry of provider.models) {
      const id = String(entry ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    return result;
  }
  const legacy = String(provider?.model || "").trim();
  return legacy ? [legacy] : [];
}

export function resolveCatalogModel(
  provider: { models?: unknown; model?: unknown } | null | undefined,
  preferredModel?: unknown
): string {
  const models = normalizeProviderModels(provider);
  if (!models.length) {
    return "";
  }
  const preferred = String(preferredModel || "").trim();
  if (preferred && models.includes(preferred)) {
    return preferred;
  }
  return models[0];
}
