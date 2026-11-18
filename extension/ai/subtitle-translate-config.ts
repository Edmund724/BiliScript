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
  const enabled = (providers || []).filter(
    (item) =>
      Boolean(item) &&
      typeof item === "object" &&
      item.enabled !== false &&
      String(item.id || "").trim() !== ""
  );

  if (enabled.length === 0) {
    throw new Error(NO_ACTIVE_PROVIDER_MESSAGE);
  }

  const preferredProviderId = String(settings?.subtitleTranslateProviderId || "").trim();
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

  const preferredModel = !isFallback ? String(settings?.subtitleTranslateModel || "").trim() : "";
  const model = preferredModel || resolveCatalogModel(chosen);

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
