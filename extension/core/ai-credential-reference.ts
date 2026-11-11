// extension/core/ai-credential-reference.ts
// 跨族「凭据引用」与「官方端点判定」唯一真源（GLOSSARY.md 同名词条）。
// 搜索侧 DeepSeek（search/deepseek）与实时伴看侧 Gemini Live（live/gemini-live）
// 不设独立 API Key 输入框，统一实时读取 AI 平台族中「第一条启用、对应 presetId 且
// 通过官方 HTTPS 端点 host 严格判等」的记录及其 Key（aiProviderKeys）。

import {
  PRESETS,
  effectivePresetBaseUrl,
  type AiProviderPreset
} from "./presets.js";
import { sendRuntimeMessage } from "../shared/messaging.js";

export type AiCredentialPresetLike = Pick<
  AiProviderPreset,
  "id" | "baseUrl" | "protocol" | "protocolBaseUrls"
>;

export type AiCredentialReferenceTarget = "deepseek" | "gemini-live";

export type AiCredentialStatus = "ok" | "no-record" | "unofficial" | "no-key";

export interface AiCredentialRecordLike {
  id?: string;
  presetId?: string;
  baseUrl?: string;
  protocol?: string;
  enabled?: boolean;
  hasSavedKey?: boolean;
}

export interface AiCredentialResolution<T extends AiCredentialRecordLike = AiCredentialRecordLike> {
  status: AiCredentialStatus;
  record: T | null;
}

export interface AiCredentialKeyResolution {
  key: string;
  status: AiCredentialStatus;
}

export interface AiCredentialReferenceSpec {
  readonly target: AiCredentialReferenceTarget;
  readonly consumerKind: "search" | "live";
  readonly consumerPresetId: string;
  readonly aiPresetId: string;
  readonly officialHost: string;
  readonly rowStatusText: Readonly<Record<AiCredentialStatus, string>>;
}

export const AI_CREDENTIAL_REFERENCE_SPECS: Readonly<
  Record<AiCredentialReferenceTarget, AiCredentialReferenceSpec>
> = {
  deepseek: {
    target: "deepseek",
    consumerKind: "search",
    consumerPresetId: "deepseek",
    aiPresetId: "deepseek",
    officialHost: "api.deepseek.com",
    rowStatusText: {
      ok: "已复用 AI 平台 Key",
      "no-record": "请先在 AI 平台添加官方 DeepSeek 记录",
      "no-key": "请先在 AI 平台添加官方 DeepSeek 记录",
      unofficial: "AI 平台配置的并非 DeepSeek 官方接口地址"
    }
  },
  "gemini-live": {
    target: "gemini-live",
    consumerKind: "live",
    consumerPresetId: "gemini-live",
    aiPresetId: "gemini",
    officialHost: "generativelanguage.googleapis.com",
    rowStatusText: {
      ok: "已复用 AI 平台 Key",
      "no-record": "尚未配置官方 Gemini AI Key",
      "no-key": "官方 Gemini AI Key 缺失或引用已失效",
      unofficial: "AI 平台配置的并非 Gemini 官方接口地址"
    }
  }
};

const ALL_CREDENTIAL_SPECS: readonly AiCredentialReferenceSpec[] = Object.values(
  AI_CREDENTIAL_REFERENCE_SPECS
);

function extractHttpsHost(baseUrl: unknown): string {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withScheme);
    if (url.protocol !== "https:") return "";
    if (url.port && url.port !== "443") return "";
    return url.hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isOfficialAiCredentialEndpoint(
  target: AiCredentialReferenceTarget,
  baseUrl: unknown
): boolean {
  const spec = AI_CREDENTIAL_REFERENCE_SPECS[target];
  return extractHttpsHost(baseUrl) === spec.officialHost;
}

export function usesAiCredentialReference(
  kind: string,
  presetId: string | null | undefined
): boolean {
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedPresetId) return false;
  return ALL_CREDENTIAL_SPECS.some(
    (spec) => spec.consumerKind === kind && spec.consumerPresetId === normalizedPresetId
  );
}

export function getAiCredentialStatusText(
  target: AiCredentialReferenceTarget,
  status: AiCredentialStatus
): string {
  return AI_CREDENTIAL_REFERENCE_SPECS[target].rowStatusText[status];
}

export function resolveAiCredentialReference<T extends AiCredentialRecordLike>(
  target: AiCredentialReferenceTarget,
  aiProviders: readonly T[] | null | undefined,
  presets: readonly AiCredentialPresetLike[] = PRESETS
): AiCredentialResolution<T> {
  const spec = AI_CREDENTIAL_REFERENCE_SPECS[target];
  const list = Array.isArray(aiProviders) ? aiProviders : [];
  const preset = presets.find((item) => item?.id === spec.aiPresetId) || null;
  let sawUnofficial = false;

  for (const record of list) {
    if (!record || record.enabled === false) continue;
    if (String(record.presetId || "") !== spec.aiPresetId) continue;
    if (isOfficialAiCredentialEndpoint(target, effectivePresetBaseUrl(record, preset))) {
      if (record.hasSavedKey === false) {
        return { status: "no-key", record };
      }
      return { status: "ok", record };
    }
    sawUnofficial = true;
  }

  return { status: sawUnofficial ? "unofficial" : "no-record", record: null };
}

export function resolveAiCredentialKey(
  target: AiCredentialReferenceTarget,
  aiProviders: readonly AiCredentialRecordLike[] | null | undefined,
  aiKeys: Record<string, string> | null | undefined,
  presets: readonly AiCredentialPresetLike[] = PRESETS
): AiCredentialKeyResolution {
  const { status, record } = resolveAiCredentialReference(target, aiProviders, presets);
  if (status !== "ok" || !record) {
    return { key: "", status };
  }
  const id = String(record.id || "").trim();
  if (!id) {
    return { key: "", status: "no-key" };
  }
  const key = String(aiKeys?.[id] || "").trim();
  if (!key) {
    return { key: "", status: "no-key" };
  }
  return { key, status: "ok" };
}

export function annotateAiCredentialRows<T extends { presetId?: string; statusNote?: string }>(
  kind: string,
  items: T[],
  aiProviders: readonly AiCredentialRecordLike[] | null | undefined,
  presets: readonly AiCredentialPresetLike[] = PRESETS,
  statusOverrides: Partial<Record<AiCredentialReferenceTarget, AiCredentialStatus>> = {}
): T[] {
  const matchingSpecs = ALL_CREDENTIAL_SPECS.filter((spec) => spec.consumerKind === kind);
  if (matchingSpecs.length === 0 || items.length === 0) {
    return items;
  }

  let result = items;
  for (const spec of matchingSpecs) {
    if (!result.some((item) => String(item.presetId || "") === spec.consumerPresetId)) {
      continue;
    }
    const status = statusOverrides[spec.target]
      ?? resolveAiCredentialReference(spec.target, aiProviders, presets).status;
    const text = spec.rowStatusText[status];
    result = result.map((item) =>
      String(item.presetId || "") === spec.consumerPresetId ? { ...item, statusNote: text } : item
    );
  }
  return result;
}

export type AiCredentialMessageSender = (message: {
  type: "ai-providers-list" | "get-ai-provider-key";
  providerId?: string;
}) => Promise<{
  ok?: boolean;
  providers?: AiCredentialRecordLike[];
  apiKey?: string;
}>;

export async function queryAiCredentialKey(
  target: AiCredentialReferenceTarget,
  send: AiCredentialMessageSender = sendRuntimeMessage as unknown as AiCredentialMessageSender,
  presets: readonly AiCredentialPresetLike[] = PRESETS
): Promise<AiCredentialKeyResolution> {
  try {
    const resp = await send({ type: "ai-providers-list" });
    if (!resp?.ok || !Array.isArray(resp.providers)) {
      return { key: "", status: "no-record" };
    }
    const { status, record } = resolveAiCredentialReference(target, resp.providers, presets);
    if (status !== "ok" || !record?.id) {
      return { key: "", status };
    }
    const keyResp = await send({ type: "get-ai-provider-key", providerId: record.id });
    const key = keyResp?.ok ? String(keyResp.apiKey || "").trim() : "";
    if (!key) {
      return { key: "", status: "no-key" };
    }
    return { key, status: "ok" };
  } catch {
    return { key: "", status: "no-record" };
  }
}
