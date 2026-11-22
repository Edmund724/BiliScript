import { normalizeAsrProviderFields } from "./asr-provider-normalize.js";
import { getMergedSettings } from "../core/settings-store.js";
import { asrProviderStore } from "./asr-provider-store.js";
import { probeAsrProviderViaOffscreen } from "./offscreen-bridge.page.js";

export interface AsrProbeResult {
  ok: boolean;
  error?: string;
}

export async function testAsrConnection(provider: unknown): Promise<AsrProbeResult> {
  const normalized = normalizeAsrProviderFields(provider);
  if (!normalized) {
    return { ok: false, error: "平台配置不完整或 type 非法" };
  }
  if (!normalized.baseUrl) {
    return { ok: false, error: "请填写 baseUrl" };
  }
  if (!normalized.model) {
    return { ok: false, error: "请填写模型名" };
  }

  const raw = provider as { id?: string; apiKey?: string };
  const apiKey = await asrProviderStore.resolveDraftApiKey(
    raw?.apiKey,
    String(raw?.id || "").trim()
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
