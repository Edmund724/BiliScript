// extension/ai/provider-models.ts
// AI 平台模型列表拉取的 content 侧薄壳（设置面板「获取可用模型」弹窗的数据源）。
//
// 协议知识（端点 / 鉴权 / 分页 / 条目过滤）归各协议 adapter 的 listModels
//（ai/protocol-adapter.ts 契约）：openai / anthropic 走 OpenAI 兼容
// `${baseUrl}/v1/models` + Bearer，gemini 走原生 `${baseUrl}/v1beta/models` +
// x-goog-api-key（Google 端点不认 Bearer 形式的 API Key，会把它当 OAuth 2 token
// 解析并回 401）。本壳只做对话框不该知道的三件编排：
//   1. Key 回落：表单重输的 apiKey 优先，为空时按 providerId 代查已存 Key；
//   2. 错误文案塑形：响应体解析失败给「无法解析模型列表」，代发通道抛出的
//      Error（未授权提示 / 15s 超时 / URL 不合法）原样透传；
//   3. 传输换路：fetchImpl 注入 SW 代发（core/provider-http.ts 的
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
import { providerFetchViaBackground } from "../core/provider-http.js";
import { resolveAdapter, type ListModelsResult } from "./protocol-adapter.js";

export interface FetchProviderModelsInput {
  baseUrl?: string;
  apiKey?: string;
  providerId?: string;
  // 平台协议（multi-protocol-ai）：随 resolveAdapter 分派到对应 adapter 的
  // listModels；缺省/未知值兜底 openai（与词表解析单点同口径）。
  protocol?: string;
}

export type FetchProviderModelsResult = ListModelsResult;

export async function fetchProviderModels({ baseUrl, apiKey, providerId, protocol }: FetchProviderModelsInput): Promise<FetchProviderModelsResult> {
  const normalizedBaseUrl = String(baseUrl || "").trim();
  if (!normalizedBaseUrl) {
    return { ok: false, error: "请填写 baseUrl" };
  }
  // Key 回落：表单重输优先；为空且带 providerId（编辑已存平台）时代查已存 Key。
  let resolvedApiKey = String(apiKey || "").trim();
  if (!resolvedApiKey && providerId) {
    const keys = await aiProviderStore.loadKeys();
    resolvedApiKey = String(keys[String(providerId)] || "").trim();
  }
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
