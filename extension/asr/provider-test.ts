import { normalizeAsrProvider } from "./asr-provider-normalize.js";
import { getMergedSettings } from "../core/settings-store.js";
import { asrProviderStore } from "./asr-provider-store.js";
import { probeAsrProviderViaOffscreen } from "./offscreen-bridge.page.js";

export interface AsrProbeResult {
  ok: boolean;
  error?: string;
}

export async function testAsrConnection(provider: unknown): Promise<AsrProbeResult> {
  let normalized = normalizeAsrProvider(provider);
  if (!normalized) {
    const raw = provider as { id?: string; apiKey?: string };
    if (!String(raw?.id || "").trim() && String(raw?.apiKey || "").trim()) {
      normalized = normalizeAsrProvider({ ...raw, id: "__probe-draft__" });
    }
  }
  if (!normalized) {
    return { ok: false, error: "平台配置不完整或 type 非法" };
  }
  if (!normalized.baseUrl) {
    return { ok: false, error: "请填写 baseUrl" };
  }
  if (!normalized.model) {
    return { ok: false, error: "请填写模型名" };
  }

  const apiKey = await asrProviderStore.resolveDraftApiKey(
    (provider as { apiKey?: string })?.apiKey,
    normalized.id
  );

  let language = "";
  try {
    const settings = await getMergedSettings();
    language = (settings?.asrLanguage as string) || "";
  } catch {
  }

  return probeAsrProviderViaOffscreen({
    type: normalized.type,
    baseUrl: normalized.baseUrl,
    model: normalized.model,
    apiKey,
    language
  });
}
