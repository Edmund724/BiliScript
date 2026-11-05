import { PRESETS, effectivePresetBaseUrl, type AiProviderPreset } from "../core/presets.js";
import { sendRuntimeMessage } from "../shared/messaging.js";

export const GEMINI_OFFICIAL_HOST = "generativelanguage.googleapis.com";
export const GEMINI_LIVE_DEFAULT_MODEL = "gemini-3.8-live";
export const GEMINI_LIVE_FALLBACK_MODELS = [
  GEMINI_LIVE_DEFAULT_MODEL,
  "gemini-3.8-live-extended-thinking"
] as const;

export interface GeminiAiRecordLike {
  id?: string;
  presetId?: string;
  baseUrl?: string;
  enabled?: boolean;
  protocol?: string;
  hasSavedKey?: boolean;
}

export type GeminiCredentialStatus = "ok" | "no-key" | "unofficial" | "no-record";

export interface GeminiCredentialResolution {
  status: GeminiCredentialStatus;
  record?: GeminiAiRecordLike;
}

export function isOfficialGeminiEndpoint(baseUrl: unknown): boolean {
  const raw = String(baseUrl || "").trim().replace(/\/+$/, "").toLowerCase();
  if (!raw) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    try {
      parsed = new URL(`https://${raw}`);
    } catch {
      return false;
    }
  }
  return parsed.protocol === "https:" && parsed.hostname === GEMINI_OFFICIAL_HOST;
}

export function resolveGeminiCredential(
  aiProviders: ReadonlyArray<GeminiAiRecordLike> | null | undefined,
  presets: readonly AiProviderPreset[] = PRESETS
): GeminiCredentialResolution {
  const preset = presets.find((item) => item.id === "gemini");
  const candidates = (aiProviders ?? []).filter(
    (record) => record && record.enabled !== false && String(record.presetId || "").trim() === "gemini"
  );
  if (candidates.length === 0) return { status: "no-record" };
  for (const record of candidates) {
    if (isOfficialGeminiEndpoint(effectivePresetBaseUrl(record, preset))) {
      return { status: record.hasSavedKey === false ? "no-key" : "ok", record };
    }
  }
  return { status: "unofficial" };
}

export const GEMINI_LIVE_ROW_STATUS_TEXT: Record<GeminiCredentialStatus, string> = {
  ok: "已复用 AI 平台 Key",
  "no-key": "请先在 AI 平台添加官方 Gemini 记录",
  unofficial: "AI 平台配置的并非 Gemini 官方接口地址",
  "no-record": "请先在 AI 平台添加官方 Gemini 记录"
};

export type GeminiCredentialMessageSender = (
  message: { type: "ai-providers-list" } | { type: "get-ai-provider-key"; providerId: string }
) => Promise<any>;

export async function queryGeminiCredentialKey(
  sender: GeminiCredentialMessageSender = sendRuntimeMessage,
  presets: readonly AiProviderPreset[] = PRESETS
): Promise<{ key: string; status: GeminiCredentialStatus }> {
  try {
    const resp = await sender({ type: "ai-providers-list" });
    if (!resp?.ok || !Array.isArray(resp.providers)) return { key: "", status: "no-record" };
    const { status, record } = resolveGeminiCredential(resp.providers, presets);
    if (status !== "ok" || !record?.id) return { key: "", status };
    const keyResp = await sender({ type: "get-ai-provider-key", providerId: record.id });
    const key = keyResp?.ok ? String(keyResp.apiKey || "").trim() : "";
    return { key, status: key ? "ok" : "no-key" };
  } catch {
    return { key: "", status: "no-record" };
  }
}
