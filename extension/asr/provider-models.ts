import { normalizeBaseUrl } from "../core/presets.js";
import { providerFetchViaBackground } from "../core/provider-http.js";
import { formatProbeHttpError } from "../core/provider-store.js";
import { asrProviderStore } from "./asr-provider-store.js";

export interface ListAsrModelsInput {
  baseUrl?: string;
  apiKey?: string;
  providerId?: string;
}

export interface ListAsrModelsResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

export async function listAsrModels({ baseUrl, apiKey, providerId }: ListAsrModelsInput): Promise<ListAsrModelsResult> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return { ok: false, error: "请先填写 baseUrl" };
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  const resolvedApiKey = await asrProviderStore.resolveDraftApiKey(apiKey, providerId);
  if (resolvedApiKey) {
    headers.Authorization = `Bearer ${resolvedApiKey}`;
  }

  try {
    const resp = await providerFetchViaBackground(`${normalizedBaseUrl}/models?sub_type=speech-to-text`, {
      headers,
      method: "GET"
    });
    if (!resp.ok) {
      return { ok: false, error: await formatProbeHttpError(resp) };
    }
    const data = (await resp.json()) as { data?: Array<{ id?: string }> };
    const models: string[] = [];
    if (Array.isArray(data?.data)) {
      for (const item of data.data) {
        if (item?.id) models.push(String(item.id));
      }
    }
    return { ok: true, models };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, error: "无法解析模型列表" };
    }
    return { ok: false, error: (error as Error | undefined)?.message || String(error) };
  }
}
