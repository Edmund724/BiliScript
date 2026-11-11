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
import type { ChatMessage, SubtitleBodyItem } from "./types.js";
import { chatCompletion, type ChatCompletionInput } from "./completion.js";
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

export const TARGET_LANG_NAME_MAP: Record<string, string> = {
  zh: "中文",
  en: "英文",
  ja: "日文",
  ko: "韩文",
  de: "德文",
  fr: "法文",
  es: "西班牙文",
  ru: "俄文",
  it: "意大利文",
  pt: "葡萄牙文",
  tr: "土耳其文",
  el: "希腊文",
  id: "印尼文",
  ms: "马来文"
};

export function resolveTargetLangDisplayName(lang: string): string {
  const code = String(lang || "").trim().toLowerCase();
  return TARGET_LANG_NAME_MAP[code] || lang;
}

/**
 * 序号行协议：将原文字幕条目渲染为序号编号行
 * 格式：`1. 第一句话\n2. 第二句话`
 */
export function formatSubtitleNumberedLines(items: Array<{ content?: unknown }>): string {
  return (items || [])
    .map((item, idx) => `${idx + 1}. ${String(item?.content || "").trim()}`)
    .join("\n");
}

/**
 * 序号行协议解析：从 LLM 返回文本按行解析序号与译文，并严格保持与原文字幕条目 1:1 时间戳对齐。
 * 容错支持 `1. 译文`、`1、译文`、`1: 译文` 等变体；若某行缺失则回退原文，不发生时间戳偏移。
 */
export function parseSubtitleNumberedLines(
  response: string,
  originalItems: SubtitleBodyItem[]
): SubtitleBodyItem[] {
  if (!Array.isArray(originalItems) || originalItems.length === 0) {
    return [];
  }
  const lines = String(response || "").split(/\r?\n/);
  const translationMap = new Map<number, string>();
  const linePattern = /^\s*(\d+)[\.、:：\s]+(.*)$/;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const match = linePattern.exec(trimmed);
    if (match) {
      const lineNum = Number(match[1]);
      const content = match[2].trim();
      if (lineNum > 0 && !translationMap.has(lineNum)) {
        translationMap.set(lineNum, content);
      }
    }
  }

  return originalItems.map((item, idx) => {
    const lineNum = idx + 1;
    const translated = translationMap.get(lineNum);
    return {
      from: Number(item.from) || 0,
      to: Number(item.to) || 0,
      content: translated && translated.length > 0 ? translated : String(item.content || "").trim()
    };
  });
}

export function buildSubtitleTranslateMessages(
  items: SubtitleBodyItem[],
  targetLang: string
): ChatMessage[] {
  const langName = resolveTargetLangDisplayName(targetLang);
  const numberedText = formatSubtitleNumberedLines(items);
  return [
    {
      role: "system",
      content:
        `你是一个专业的音视频字幕翻译专家。请将用户给出的原文字幕逐行翻译为${langName}。\n` +
        `规则：\n` +
        `1. 严格按照原序号逐行输出翻译，格式为「序号. 译文」，每行一条；\n` +
        `2. 保持 1:1 逐行对应，禁止合并、拆分或遗漏序号；\n` +
        `3. 译文通顺自然、符合视频口语语境；\n` +
        `4. 只输出翻译结果行，不要输出任何额外的解释、问候或说明。`
    },
    {
      role: "user",
      content: numberedText
    }
  ];
}

export interface TranslateSubtitleItemsInput {
  items: SubtitleBodyItem[];
  targetLang: string;
  providerResolution?: SubtitleTranslateProviderResolution;
  signal?: AbortSignal | null;
  chatCompletionFn?: typeof chatCompletion;
}

/**
 * 基于序号行协议的 LLM 逐句翻译核心函数：
 * 将一组字幕条目翻译为指定目标语言，返回保持 1:1 时间戳对齐的新字幕条目数组。
 */
export async function translateSubtitleItems({
  items,
  targetLang,
  providerResolution,
  signal,
  chatCompletionFn = chatCompletion
}: TranslateSubtitleItemsInput): Promise<SubtitleBodyItem[]> {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const resolved = providerResolution || (await resolveSubtitleTranslateProvider());
  const messages = buildSubtitleTranslateMessages(items, targetLang);
  const request = buildSubtitleTranslateRequest({
    provider: {
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      model: resolved.model,
      presetId: resolved.presetId,
      protocol: resolved.protocol
    },
    messages,
    signal
  });

  const rawResult = await chatCompletionFn(request);
  const responseText = typeof rawResult === "string" ? rawResult : "";
  return parseSubtitleNumberedLines(responseText, items);
}
