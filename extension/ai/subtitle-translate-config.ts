// extension/ai/subtitle-translate-config.ts
// 字幕翻译平台解析叶：平台列表 + 密钥 + 设置 → 本次翻译使用的平台与模型。
//
// 纯查表、零请求：不引 completion / protocol-adapter / adapters，故可被
// Service Worker 常驻侧（core/provider-handlers 的 resolve-subtitle-translate-provider）
// 静态引用。请求装配（buildSubtitleTranslateRequest / translateSubtitleItems）
// 留在 ai/subtitle-translate.ts，只允许页面/offscreen 侧按需加载。

import { NO_ACTIVE_PROVIDER_MESSAGE } from "../core/overview-setup-error.js";
import type { ProviderListEntry } from "../shared/messaging-protocol.js";
import { normalizeProviderModels, resolveCatalogModel } from "../shared/selected-provider.js";
import type { AiProtocol } from "./protocol-vocab.js";

export interface SubtitleTranslateProviderResolution {
  provider: ProviderListEntry;
  apiKey: string;
  baseUrl: string;
  model: string;
  presetId: string;
  protocol?: AiProtocol;
  isFallback: boolean;
}

export const INDEX_TRANSLATE_PROVIDER_ID = "bilibili-index-translate";
export const INDEX_TRANSLATE_PROVIDER_NAME = "Bilibili Index-Translate";
export const INDEX_TRANSLATE_BASE_URL = "https://index-translate.bilibili.com/v1";
export const INDEX_TRANSLATE_HOST = "index-translate.bilibili.com";
export const INDEX_TRANSLATE_MODELS = [
  "Index-Translate-35B-A3B",
  "Index-Translate-9B",
  "Index-Translate-2B"
] as const;
export type IndexTranslateModelId = (typeof INDEX_TRANSLATE_MODELS)[number];
export const INDEX_TRANSLATE_DEFAULT_MODEL: IndexTranslateModelId = "Index-Translate-35B-A3B";
export const INDEX_TRANSLATE_MODEL: IndexTranslateModelId = INDEX_TRANSLATE_DEFAULT_MODEL;
export const INDEX_TRANSLATE_USER_AGENT = "Index-Translate-Client/1.0";

export interface IndexTranslateModelOption {
  id: IndexTranslateModelId;
  label: string;
  tier: "旗舰" | "均衡" | "轻量";
  isDefault: boolean;
  available: boolean;
}

export const INDEX_TRANSLATE_MODEL_OPTIONS: readonly IndexTranslateModelOption[] = [
  {
    id: "Index-Translate-35B-A3B",
    label: "Index-Translate-35B-A3B（旗舰，默认）",
    tier: "旗舰",
    isDefault: true,
    available: true
  },
  {
    id: "Index-Translate-9B",
    label: "Index-Translate-9B（均衡）",
    tier: "均衡",
    isDefault: false,
    available: true
  },
  {
    id: "Index-Translate-2B",
    label: "Index-Translate-2B（轻量）",
    tier: "轻量",
    isDefault: false,
    available: true
  }
];

export const INDEX_TRANSLATE_BUILTIN_PROVIDER: ProviderListEntry = {
  id: INDEX_TRANSLATE_PROVIDER_ID,
  presetId: INDEX_TRANSLATE_PROVIDER_ID,
  name: INDEX_TRANSLATE_PROVIDER_NAME,
  baseUrl: INDEX_TRANSLATE_BASE_URL,
  models: [...INDEX_TRANSLATE_MODELS],
  model: INDEX_TRANSLATE_DEFAULT_MODEL,
  requiresKey: false,
  hasSavedKey: false,
  enabled: true,
  protocol: "openai"
};

export function isIndexTranslateModelId(value: unknown): value is IndexTranslateModelId {
  return typeof value === "string" && (INDEX_TRANSLATE_MODELS as readonly string[]).includes(value);
}

/**
 * 归一化内置 Index-Translate 模型名：支持 3 个枚举模型（忽略大小写），缺省或未知值回落至旗舰默认模型 `Index-Translate-35B-A3B`。
 */
export function normalizeIndexTranslateModel(model?: unknown): IndexTranslateModelId {
  const trimmed = String(model ?? "").trim();
  if (!trimmed) {
    return INDEX_TRANSLATE_DEFAULT_MODEL;
  }
  const matched = INDEX_TRANSLATE_MODELS.find(
    (candidate) => candidate.toLowerCase() === trimmed.toLowerCase()
  );
  return matched ?? INDEX_TRANSLATE_DEFAULT_MODEL;
}

/**
 * 判断平台/解析结果是否为内置 Bilibili Index-Translate 通道（按 id / presetId / baseUrl 域名识别）。
 */
export function isIndexTranslateProvider(
  provider?: { id?: unknown; presetId?: unknown; baseUrl?: unknown } | null
): boolean {
  if (!provider) {
    return false;
  }
  const id = String(provider.id || "").trim();
  const presetId = String(provider.presetId || "").trim();
  if (id === INDEX_TRANSLATE_PROVIDER_ID || presetId === INDEX_TRANSLATE_PROVIDER_ID) {
    return true;
  }
  const rawBaseUrl = String(provider.baseUrl || "").trim();
  if (!rawBaseUrl) {
    return false;
  }
  try {
    return new URL(rawBaseUrl).hostname.toLowerCase() === INDEX_TRANSLATE_HOST;
  } catch {
    return false;
  }
}

/**
 * 构造内置 Bilibili Index-Translate 通道的运行时解析结果（免 Key、支持三档模型枚举，默认 Index-Translate-35B-A3B）。
 */
export function createIndexTranslateResolution(model?: string): SubtitleTranslateProviderResolution {
  const effectiveModel = normalizeIndexTranslateModel(model);
  return {
    provider: INDEX_TRANSLATE_BUILTIN_PROVIDER,
    apiKey: "",
    baseUrl: INDEX_TRANSLATE_BASE_URL,
    model: effectiveModel,
    presetId: INDEX_TRANSLATE_PROVIDER_ID,
    protocol: "openai",
    isFallback: false
  };
}

export interface SubtitleTranslateSettingsInput {
  subtitleTranslateProviderId?: unknown;
  subtitleTranslateModel?: unknown;
  subtitleTranslateGlossary?: unknown;
}

export interface SubtitleGlossaryEntry {
  source: string;
  target: string;
  note?: string;
}

export type SubtitleGlossaryInput =
  | string
  | readonly SubtitleGlossaryEntry[]
  | Readonly<Record<string, string>>;

function upsertGlossaryEntry(
  deduped: Map<string, SubtitleGlossaryEntry>,
  rawSource: unknown,
  rawTarget: unknown,
  rawNote?: unknown
): void {
  const source = String(rawSource ?? "").replace(/\s+/g, " ").trim();
  if (!source || /^[=\-_*~`]+$/.test(source)) {
    return;
  }
  const target = String(rawTarget ?? "").replace(/\s+/g, " ").trim();
  const note = String(rawNote ?? "").replace(/\s+/g, " ").trim();
  const key = source.toLowerCase();
  const entry: SubtitleGlossaryEntry = note ? { source, target, note } : { source, target };
  if (deduped.has(key)) {
    deduped.delete(key);
  }
  deduped.set(key, entry);
}

/**
 * 解析字幕翻译术语表配置：
 * - 支持多行文本：`原文 = 译文`（指定译文）、`原文 =` 或仅写 `原文`（译文留空，强制保留原词不翻译）；
 * - 自动忽略空行、`#` / `//` 注释行及缺原文的异常行（如 `= 译文`、`===`）；
 * - 同时兼容数组与键值对象输入，按小写原文去重（后者覆盖前者）。
 */
export function parseSubtitleGlossary(
  input: SubtitleGlossaryInput | null | undefined
): SubtitleGlossaryEntry[] {
  if (!input) {
    return [];
  }

  const deduped = new Map<string, SubtitleGlossaryEntry>();

  if (typeof input === "string") {
    const lines = input.split(/\r?\n/);
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
        continue;
      }
      let eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) {
        eqIdx = trimmed.indexOf("＝");
      }
      if (eqIdx === -1) {
        upsertGlossaryEntry(deduped, trimmed, "");
        continue;
      }
      const source = trimmed.slice(0, eqIdx).trim();
      const target = trimmed.slice(eqIdx + 1).trim();
      if (!source) {
        continue;
      }
      upsertGlossaryEntry(deduped, source, target);
    }
    return [...deduped.values()];
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      upsertGlossaryEntry(deduped, item.source, item.target, item.note);
    }
    return [...deduped.values()];
  }

  if (typeof input === "object") {
    for (const [source, target] of Object.entries(input as Record<string, unknown>)) {
      upsertGlossaryEntry(deduped, source, target);
    }
  }

  return [...deduped.values()];
}

/**
 * 从设置对象中读取并解析字幕翻译术语表。
 */
export function resolveSubtitleTranslateGlossary(
  settings?: SubtitleTranslateSettingsInput | null
): SubtitleGlossaryEntry[] {
  const raw = typeof settings?.subtitleTranslateGlossary === "string"
    ? settings.subtitleTranslateGlossary
    : "";
  return parseSubtitleGlossary(raw);
}

/**
 * 纯函数：根据已保存平台列表、密钥字典与设置，解析字幕翻译应使用的 AI 平台与模型。
 * - 专属配置优先：指定了 subtitleTranslateProviderId 且处于启用状态时优先匹配；
 * - 平滑回落：未指定或目标平台不存在/已禁用时，回落至首个含可用模型的启用 AI 平台；
 * - 错误判定：平台完全缺失抛出 NO_ACTIVE_PROVIDER_MESSAGE，需要 Key 却缺失抛出可读错误。
 */
export function resolveSubtitleTranslateProviderConfig(
  providers: ProviderListEntry[],
  keys: Record<string, string>,
  settings?: SubtitleTranslateSettingsInput
): SubtitleTranslateProviderResolution {
  const providerList = Array.isArray(providers) ? providers : [];
  const enabled = providerList.filter(
    (item) =>
      Boolean(item) &&
      typeof item === "object" &&
      item.enabled !== false &&
      String(item.id || "").trim() !== ""
  );

  const preferredProviderId = String(settings?.subtitleTranslateProviderId || "").trim();
  const preferredModel = String(settings?.subtitleTranslateModel || "").trim();

  if (preferredProviderId === INDEX_TRANSLATE_PROVIDER_ID) {
    const explicitEntry = providerList.find(
      (item) => Boolean(item) && typeof item === "object" && String(item.id || "").trim() === INDEX_TRANSLATE_PROVIDER_ID
    );
    if (!explicitEntry) {
      return createIndexTranslateResolution(preferredModel);
    }
    if (explicitEntry.enabled !== false) {
      const apiKey = String(keys?.[INDEX_TRANSLATE_PROVIDER_ID] || "").trim();
      return {
        provider: explicitEntry,
        apiKey,
        baseUrl: String(explicitEntry.baseUrl || "").trim() || INDEX_TRANSLATE_BASE_URL,
        model: normalizeIndexTranslateModel(preferredModel || resolveCatalogModel(explicitEntry)),
        presetId: String(explicitEntry.presetId || INDEX_TRANSLATE_PROVIDER_ID),
        protocol: (explicitEntry.protocol as AiProtocol | undefined) ?? "openai",
        isFallback: false
      };
    }
  }

  if (enabled.length === 0) {
    throw new Error(NO_ACTIVE_PROVIDER_MESSAGE);
  }

  let chosen: ProviderListEntry | null = null;
  let isFallback = false;

  if (preferredProviderId) {
    chosen = enabled.find((item) => String(item.id) === preferredProviderId) || null;
  }

  if (!chosen) {
    isFallback = true;
    chosen = enabled.find((item) => normalizeProviderModels(item).length > 0) || enabled[0] || null;
  }

  if (!chosen) {
    throw new Error(NO_ACTIVE_PROVIDER_MESSAGE);
  }

  const chosenId = String(chosen.id);
  const apiKey = String(keys?.[chosenId] || "").trim();
  if (chosen.requiresKey !== false && !apiKey) {
    throw new Error("该平台 API Key 未配置");
  }

  const model = (!isFallback ? preferredModel : "") || resolveCatalogModel(chosen);

  return {
    provider: chosen,
    apiKey,
    baseUrl: String(chosen.baseUrl || "").trim(),
    model,
    presetId: String(chosen.presetId || ""),
    protocol: chosen.protocol as AiProtocol | undefined,
    isFallback
  };
}
