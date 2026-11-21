import { chatCompletion } from "./completion.js";
import type { AiProtocol } from "./protocol-adapter.js";
import { providerFetchViaBackground } from "../core/provider-http.js";
import { formatProbeConnectionError } from "../core/provider-store.js";
import { aiProviderStore } from "../core/ai-provider-store.js";

function formatProbeSeamError(error: unknown): string {
  const err = error as { status?: unknown; overflow?: boolean; cause?: unknown; message?: string };
  if (err?.status != null || err?.overflow) {
    return String(err.message || "");
  }
  if (err?.cause) {
    return formatProbeConnectionError(err.cause);
  }
  return String(err.message || "");
}

export interface TestAiConnectionInput {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  presetId?: string;
  protocol?: string;
}

export interface TestAiConnectionResult {
  ok: boolean;
  error?: string;
}

export async function testAiConnection({ baseUrl, apiKey, model, presetId, protocol }: TestAiConnectionInput): Promise<TestAiConnectionResult> {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  const normalizedModel = String(model || "").trim();
  if (!normalizedBaseUrl) {
    return { ok: false, error: "请填写 baseUrl" };
  }
  if (!normalizedModel) {
    return { ok: false, error: "请填写模型名" };
  }

  return probeAiChatCompletion({
    baseUrl: normalizedBaseUrl,
    apiKey,
    model: normalizedModel,
    presetId,
    protocol,
    headers: { Accept: "application/json" }
  });
}

interface ProbeAiChatCompletionInput {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  presetId?: string;
  protocol?: string;
  headers?: Record<string, string>;
}

export async function probeAiChatCompletion({ baseUrl, apiKey, model, presetId, protocol, headers }: ProbeAiChatCompletionInput): Promise<TestAiConnectionResult> {
  const requestHeaders: Record<string, string> = { ...(headers || { Accept: "application/json" }) };

  try {
    await chatCompletion({
      provider: { baseUrl, apiKey, model, presetId, protocol: protocol as AiProtocol | undefined },
      messages: [{ role: "user", content: "ping" }],
      probe: true,
      headers: requestHeaders,
      retries: 0,
      fetchImpl: providerFetchViaBackground
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatProbeSeamError(error) };
  }
}

export async function testAiProviderConnection({ providerId, baseUrl, apiKey, model, protocol, presetId }: { providerId?: string; baseUrl?: string; apiKey?: string; model?: string; protocol?: string; presetId?: string }): Promise<TestAiConnectionResult> {
  let resolvedPresetId = String(presetId || "").trim();
  let resolvedProtocol = String(protocol || "").trim();
  if (providerId) {
    try {
      const record = (await aiProviderStore.loadProviders()).find((item) => item.id === providerId);
      if (!resolvedPresetId) {
        resolvedPresetId = String(record?.presetId || "");
      }
      if (!resolvedProtocol) {
        resolvedProtocol = String(record?.protocol || "");
      }
    } catch (error) {
      console.warn("读取已存平台 presetId/protocol 失败，按无 presetId 继续", error);
    }
  }
  const resolvedApiKey = await aiProviderStore.resolveDraftApiKey(apiKey, providerId);
  return testAiConnection({ baseUrl, apiKey: resolvedApiKey, model, presetId: resolvedPresetId, protocol: resolvedProtocol });
}
