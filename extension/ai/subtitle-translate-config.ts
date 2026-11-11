// extension/ai/subtitle-translate-config.ts
// 字幕翻译平台解析叶：平台列表 + 密钥 + 设置 → 本次翻译使用的平台与模型。
//
// 纯查表、零请求：不引 completion / protocol-adapter / adapters，故可被
// Service Worker 常驻侧（core/provider-handlers 的 resolve-subtitle-translate-provider）
// 静态引用。请求装配（buildSubtitleTranslateRequest / translateSubtitleItems）
// 留在 ai/subtitle-translate.ts，只允许页面/offscreen 侧按需加载。

import { NO_ACTIVE_PROVIDER_MESSAGE } from "../core/overview-setup-error.js";
import type { ProviderListEntry } from "../shared/messaging-protocol.js";
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
  defaultModel?: unknown;
}

/**
 * 纯函数：根据已保存平台列表、密钥字典与设置，解析字幕翻译应使用的 AI 平台与模型。
 * - 专属配置优先：指定了 subtitleTranslateProviderId 且处于启用状态时优先匹配；
 * - 平滑回落：未指定或目标平台不存在/已禁用时，回落至全局默认激活 AI 平台；
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
    const defaultId = String(settings?.defaultModel || "").trim();
    chosen = enabled.find((item) => String(item.id) === defaultId) || enabled[0] || null;
  }

  if (!chosen) {
    throw new Error(NO_ACTIVE_PROVIDER_MESSAGE);
  }

  const chosenId = String(chosen.id);
  const apiKey = String(keys?.[chosenId] || "").trim();
  if (chosen.requiresKey !== false && !apiKey) {
    throw new Error("该平台 API Key 未配置");
  }

  let model = "";
  if (!isFallback && String(settings?.subtitleTranslateModel || "").trim()) {
    model = String(settings?.subtitleTranslateModel).trim();
  } else {
    const models = Array.isArray(chosen.models) ? chosen.models : [];
    const legacyModel = String(chosen.model || "").trim();
    model = String(models[0] ?? "").trim() || legacyModel;
  }

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
