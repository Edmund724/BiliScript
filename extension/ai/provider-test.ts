// extension/ai/provider-test.ts
// AI 平台连通性测试探针（候选 04 拆链）。
// 从 core/ai-provider-store.js 移出：探针依赖 ai/completion.js（→ sse-parser.js），
// 留在 ai-provider-store 里会把整条 completion 链拖进 Service Worker 静态图，
// 而 SW 并不需要它（ADR-0003：平台禁止动态 import()，只能拆静态边）。
// 连通性测试需要的上下文是「扩展语境」：本模块在 content script 侧跑请求构造
//（completion 链不进 SW）。
//
// 传输层：content script 的跨域 fetch 服从**网页** CORS，平台网关不支持浏览器
// 预检时（OPTIONS 无 Access-Control-Allow-*）带 Authorization 的请求一律以
//「无法连接：Failed to fetch」失败——而模型列表能跑通只是因为它由 SW 发出。
// 故探针经 core/provider-http.js 的 providerFetchViaBackground 走 SW 代发（请求
// 构造与错误文案仍在本模块与 completion 链单源，只有传输换路）。
//
// 职责边界：本模块只负责探针的输入预检、Key 代查与错误形状包装；Provider
// 列表 CRUD/归一化仍归 core/ai-provider-store.js（SW 出于消息路由仍要加载它，
// 但不再经它拖入 completion 链）。

import { chatCompletion } from "./completion.js";
import { providerFetchViaBackground } from "../core/provider-http.js";
import { formatProbeConnectionError } from "../core/provider-store.js";
import { aiProviderStore } from "../core/ai-provider-store.js";
import { HOST_PERMISSION_HINT, hasHostPermission } from "../core/host-permissions.js";

// 把接缝抛出的类型化错误转成探针错误文案：
// - HTTP 失败（err.status / err.overflow）：接缝 message 与 formatProbeHttpError 同型，直接透传；
// - 连接失败（原始抛出物挂 err.cause）：复用「无法连接：…」文案（AI/ASR 逐字一致）；
// - 其余（接缝 baseUrl/model 守卫等）：message 已是清晰文案，直接透传。
function formatProbeSeamError(error: unknown): string {
  const err = error as { status?: unknown; overflow?: boolean; cause?: unknown; message?: string };
  if (err?.status != null || err?.overflow) {
    return String(err.message || "");
  }
  if (err?.cause) {
    return formatProbeConnectionError(err.cause);
  }
  return String(err.message || "");
}

export interface TestAiConnectionInput {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  presetId?: string;
}

export interface TestAiConnectionResult {
  ok: boolean;
  error?: string;
}

export async function testAiConnection({ baseUrl, apiKey, model, presetId }: TestAiConnectionInput): Promise<TestAiConnectionResult> {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  const normalizedModel = String(model || "").trim();
  if (!normalizedBaseUrl) {
    return { ok: false, error: "请填写 baseUrl" };
  }
  if (!normalizedModel) {
    return { ok: false, error: "请填写模型名" };
  }

  return probeAiChatCompletion({
    baseUrl: normalizedBaseUrl,
    apiKey,
    model: normalizedModel,
    presetId,
    headers: { Accept: "application/json" }
  });
}

interface ProbeAiChatCompletionInput {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  presetId?: string;
  headers?: Record<string, string>;
}

export async function probeAiChatCompletion({ baseUrl, apiKey, model, presetId, headers }: ProbeAiChatCompletionInput): Promise<TestAiConnectionResult> {
  const requestHeaders: Record<string, string> = { ...(headers || { Accept: "application/json" }) };
  if (apiKey && !requestHeaders.Authorization) {
    requestHeaders.Authorization = `Bearer ${apiKey}`;
  }

  try {
    await chatCompletion({
      provider: { baseUrl, apiKey, model, presetId },
      messages: [{ role: "user", content: "ping" }],
      probe: true,
      headers: requestHeaders,
      retries: 0,
      // 传输层换路：经 SW 代发（content script 直连受网页 CORS 约束，见文件头）。
      // 请求构造（思考档位 / token 上限规则）与错误文案仍单源在本模块与
      // completion 链，只有「谁来发这一跳」不同。
      fetchImpl: providerFetchViaBackground
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatProbeSeamError(error) };
  }
}

// options 页「测试」按钮的入口：平铺字段 + providerId，替代原 ai-providers-test
// 消息在 SW 侧的输入装配（provider-handlers.js pickFlatTestProvider 的契约）——
// Key 解析优先用户重输的 apiKey，否则按 providerId 从已存 Key 代查，都没有为空串。
// 返回 { ok, error? }，UX 语义与原消息往返完全一致。
export async function testAiProviderConnection({ providerId, baseUrl, apiKey, model }: { providerId?: string; baseUrl?: string; apiKey?: string; model?: string }): Promise<TestAiConnectionResult> {
  // S2 收紧 host_permissions：域名未授权时跨域 fetch 只会以 CORS 失败，探针原样
  // 抛出是「无法连接：Failed to fetch」这类看不出原因的文案，所以先把权限缺失换成
  // 可操作提示，不再发起注定失败的请求，也不读一次 Key 存储。
  // 判定收口在 core/host-permissions.js（与 ASR 探针共用一份）：取不到
  // chrome.permissions 实现（单测环境）时按已授权处理，不阻塞既有探针行为。
  if (!(await hasHostPermission(baseUrl))) {
    return { ok: false, error: HOST_PERMISSION_HINT };
  }
  let resolvedApiKey = String(apiKey || "").trim();
  // presetId 穿线（02 号票）：按 providerId 从已存列表读记录的 presetId（preset
  // 词表键，loadProviders 已 normalize），随探针请求下发——host 反代无 host 规则
  // 时这是思考字段查表的唯一识别线索；读取失败按无 presetId 继续（不阻塞探针）。
  let resolvedPresetId = "";
  if (providerId) {
    try {
      const record = (await aiProviderStore.loadProviders()).find((item) => item.id === providerId);
      resolvedPresetId = String(record?.presetId || "");
    } catch (error) {
      console.warn("读取已存平台 presetId 失败，按无 presetId 继续", error);
    }
  }
  if (!resolvedApiKey && providerId) {
    try {
      const keys = await aiProviderStore.loadKeys();
      resolvedApiKey = String(keys[providerId] || "").trim();
    } catch (error) {
      // Key 存储读取失败沿用原处理器的容错：按空 Key 继续探针（报错来自探针本身）
      console.warn("读取已存 API Key 失败，按未填写 Key 继续", error);
    }
  }
  return testAiConnection({ baseUrl, apiKey: resolvedApiKey, model, presetId: resolvedPresetId });
}
