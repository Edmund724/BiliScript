// extension/ai/provider-models.ts
// AI 平台模型列表拉取的 content 侧薄壳（设置面板「获取可用模型」弹窗的数据源）。
//
// 协议知识（端点 / 鉴权 / 分页 / 条目过滤）归各协议 adapter 的 listModels
//（ai/protocol-adapter.ts 契约）：openai / anthropic 走 OpenAI 兼容
// `${baseUrl}/v1/models` + Bearer，gemini 走原生 `${baseUrl}/v1beta/models` +
// x-goog-api-key（Google 端点不认 Bearer 形式的 API Key，会把它当 OAuth 2 token
// 解析并回 401）。本壳负责对话框不该知道的四件编排：
//   1. 端点回落：双协议预设在 anthropic 协议且用户未手改地址时，模型列表探测跟随
//      同预设的 openai 端点（Messages 端点无 `/v1/models`），并产出需授权源集合；
//   2. Key 回落：表单重输的 apiKey 优先，为空时按 providerId 代查已存 Key；
//   3. 错误文案塑形：响应体解析失败给「无法解析模型列表」，代发通道抛出的
//      Error（未授权提示 / 15s 超时 / URL 不合法）原样透传；
//   4. 传输换路：fetchImpl 注入 SW 代发（core/provider-http.ts 的
//      providerFetchViaBackground，与 AI 探针 ai/provider-test.ts、ASR 模型列表
//      asr/provider-models.ts 同款拓扑）——content script 的跨域 fetch 服从网页
//      CORS，带鉴权头的 GET 常被网关预检白名单拒，代发只受 host 权限约束；
//      单请求 15s 超时由代发通道承担，分页按程计，本壳不自持定时器。
//
// host 权限判定单源在 SW 侧代发通道（handleProviderHttpRequest，未授权回
// HOST_PERMISSION_HINT）；申请侧由弹窗在点击手势链上先行完成
//（requestProviderOriginsViaBackground），壳与对话框都不做页面侧预检
//（content 语境没有 chrome.permissions，预检是恒放行的假门）。

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
  // 平台协议（multi-protocol-ai）：随 resolveAdapter 分派到对应 adapter 的
  // listModels；缺省/未知值兜底 openai（与词表解析单点同口径）。
  protocol?: string;
  preset?: ModelListPresetLike;
}

export type FetchProviderModelsResult = ListModelsResult;

// 解析 AI 模型列表探测地址与需申请 host 权限的源集合：
// 模型探测走 OpenAI 兼容的 GET `${baseUrl}/v1/models`；双协议预设的 anthropic
// baseUrl 指向 Messages 端点（无 `/v1/models`），当用户保持预设 anthropic 地址未手改
// 时，探测地址跟随到预设的 openai 端点，同时把原地址与探测地址一并纳入权限申请集合。
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
    // 代发通道把 SW 侧回包错误作为 Error 抛出，原样透传；响应体 JSON 解析失败
    // 给专用文案（与 ASR 模型列表壳 asr/provider-models.ts 同形）。
    if (error instanceof SyntaxError) {
      return { ok: false, error: "无法解析模型列表" };
    }
    return { ok: false, error: (error as Error | undefined)?.message || String(error) };
  }
}
