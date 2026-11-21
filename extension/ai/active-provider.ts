import { NO_ACTIVE_MODEL_MESSAGE } from "../core/overview-setup-error.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { resolveCatalogModel } from "../shared/selected-provider.js";
import type { AiProvider } from "./types.js";
import type { AiProtocol } from "./protocol-adapter.js";

export async function resolveActiveProvider(): Promise<AiProvider> {
  const resp = await sendRuntimeMessage({ type: "resolve-ai-provider" });
  if (!resp?.ok) {
    throw new Error(String(resp?.error || "解析 AI 平台配置失败"));
  }
  const model = String(resp.model || "").trim() || firstCatalogModel(resp.provider);
  if (!model) {
    throw new Error(NO_ACTIVE_MODEL_MESSAGE);
  }
  return {
    baseUrl: String(resp.provider?.baseUrl || "").trim(),
    apiKey: String(resp.apiKey || "").trim(),
    model,
    presetId: String(resp.provider?.presetId || ""),
    protocol: resp.provider?.protocol as AiProtocol | undefined
  };
}

export function firstCatalogModel(provider: { models?: unknown; model?: unknown } | null | undefined): string {
  return resolveCatalogModel(provider);
}
