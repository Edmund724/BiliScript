import { aiProviderStore } from "../core/ai-provider-store.js";
import { presetBaseUrlForProtocol } from "../core/presets.js";
import { providerFetchViaBackground } from "../core/provider-http.js";
import { resolveAdapter, type ListModelsResult } from "./protocol-adapter.js";

export type ModelListPresetLike = Parameters<typeof presetBaseUrlForProtocol>[0];

export interface ResolveAiModelListTargetInput {
  baseUrl?: string | null;
  protocol?: string | null;
  preset?: ModelListPresetLike;
}

export interface AiModelListTarget {
  baseUrl: string;
  permissionBaseUrls: string[];
}

export interface FetchProviderModelsInput {
  baseUrl?: string;
  apiKey?: string;
  providerId?: string;
  protocol?: string;
  preset?: ModelListPresetLike;
}

export type FetchProviderModelsResult = ListModelsResult;

export function resolveAiModelListTarget({
  baseUrl,
  protocol,
  preset
}: ResolveAiModelListTargetInput = {}): AiModelListTarget {
  const trimmedBaseUrl = String(baseUrl || "").trim();
  const normalizedProtocol = resolveAdapter(protocol ?? undefined).protocol;
  const presetAnthropicBaseUrl = presetBaseUrlForProtocol(preset, "anthropic");
  const presetOpenaiBaseUrl = presetBaseUrlForProtocol(preset, "openai");
  const probeBaseUrl =
    normalizedProtocol === "anthropic" &&
    Boolean(preset) &&
    trimmedBaseUrl === presetAnthropicBaseUrl &&
    Boolean(presetOpenaiBaseUrl)
      ? presetOpenaiBaseUrl
      : trimmedBaseUrl;
  const permissionBaseUrls = [...new Set([trimmedBaseUrl, probeBaseUrl].filter(Boolean))];
  return {
    baseUrl: probeBaseUrl,
    permissionBaseUrls
  };
}

export async function fetchProviderModels({
  baseUrl,
  apiKey,
  providerId,
  protocol,
  preset
}: FetchProviderModelsInput): Promise<FetchProviderModelsResult> {
  const { baseUrl: normalizedBaseUrl } = resolveAiModelListTarget({ baseUrl, protocol, preset });
  if (!normalizedBaseUrl) {
    return { ok: false, error: "请填写 baseUrl" };
  }
  const resolvedApiKey = await aiProviderStore.resolveDraftApiKey(apiKey, providerId);
  try {
    return await resolveAdapter(protocol).listModels({
      baseUrl: normalizedBaseUrl,
      apiKey: resolvedApiKey,
      fetchImpl: providerFetchViaBackground
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, error: "无法解析模型列表" };
    }
    return { ok: false, error: (error as Error | undefined)?.message || String(error) };
  }
}
