// extension/ai/subtitle-translate.ts
// 字幕翻译模型配置解析与请求装配。
//
// 服务播放器无 CC 字幕 LLM 逐句翻译管线（工单 02 / 03）：
// 1. 允许用户为字幕翻译单独指定专属轻量 AI 平台与模型（subtitleTranslateProviderId + subtitleTranslateModel）；
// 2. 专属平台未指定或已删除/禁用时，平滑回退到全局默认激活 AI 平台（defaultModel / 首个启用平台）；
// 3. 平台缺失或密钥未配置时抛出可读错误；
// 4. 请求装配固定将思考档位设为关闭（thinkingLevel: "off"），不继承对话面板的高思考强度档位，
//    以降低字幕逐句翻译的首字延迟与 token 成本。

import { NO_ACTIVE_PROVIDER_MESSAGE } from "../core/provider-handlers.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import type { AiProtocol } from "./protocol-vocab.js";
import type { ChatMessage } from "./types.js";
import type { ChatCompletionInput } from "./completion.js";
import type { ProviderListEntry } from "../shared/messaging-protocol.js";
import type { Settings } from "../core/defaults.js";

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

export interface ResolveSubtitleTranslateProviderDeps {
  getSettings?: () => Promise<Partial<Settings>>;
  loadProviders?: () => Promise<ProviderListEntry[]>;
  loadKeys?: () => Promise<Record<string, string>>;
}

/**
 * 异步解析字幕翻译运行时配置（依赖注入或经 runtime 消息向 SW 请求）。
 */
export async function resolveSubtitleTranslateProvider(
  deps?: ResolveSubtitleTranslateProviderDeps
): Promise<SubtitleTranslateProviderResolution> {
  if (deps?.getSettings && deps?.loadProviders && deps?.loadKeys) {
    const [settings, providers, keys] = await Promise.all([
      deps.getSettings(),
      deps.loadProviders(),
      deps.loadKeys()
    ]);
    return resolveSubtitleTranslateProviderConfig(providers, keys, settings);
  }

  const resp = await sendRuntimeMessage({ type: "resolve-subtitle-translate-provider" });
  if (!resp?.ok) {
    throw new Error(String(resp?.error || "解析字幕翻译平台配置失败"));
  }
  const provider = resp.provider!;
  return {
    provider,
    apiKey: String(resp.apiKey || "").trim(),
    baseUrl: String(provider.baseUrl || "").trim(),
    model: String(resp.model || provider.model || "").trim(),
    presetId: String(provider.presetId || ""),
    protocol: provider.protocol as AiProtocol | undefined,
    isFallback: resp.isFallback === true
  };
}

export interface SubtitleTranslateRequestInput {
  provider: {
    baseUrl: string;
    apiKey: string;
    model: string;
    presetId?: string;
    protocol?: AiProtocol;
  };
  messages: ChatMessage[];
  stream?: boolean;
  signal?: AbortSignal | null;
  maxTokens?: number | null;
  /** 外部传入的任何思考档位将被显式忽略，强制收敛为 "off"。 */
  thinkingLevel?: unknown;
}

/**
 * 装配字幕翻译模型请求：
 * 固定将思考档位设为关闭（`off`），不继承对话面板的高思考强度档位，
 * 降低首字延迟与 token 消耗。
 */
export function buildSubtitleTranslateRequest(
  input: SubtitleTranslateRequestInput
): ChatCompletionInput {
  return {
    provider: {
      baseUrl: String(input.provider.baseUrl || "").trim(),
      apiKey: String(input.provider.apiKey || "").trim(),
      model: String(input.provider.model || "").trim(),
      presetId: String(input.provider.presetId || "custom").trim() || "custom",
      protocol: input.provider.protocol || "openai"
    },
    messages: input.messages,
    stream: input.stream ?? false,
    signal: input.signal ?? null,
    maxTokens: input.maxTokens ?? null,
    // 固定将思考档位设为关闭（off），不继承对话面板的高思考强度档位
    thinkingLevel: "off"
  };
}
