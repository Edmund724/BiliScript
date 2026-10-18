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
//「无法连接：Failed to fetch」失败——故探针经 core/provider-http.js 的
// providerFetchViaBackground 走 SW 代发（请求构造与错误文案仍在本模块与
// completion 链单源，只有传输换路；模型列表 asr/provider-models.ts /
// ai/provider-models.ts 同走这条代发通道）。
//
// 职责边界：本模块只负责探针的输入预检、Key 代查与错误形状包装；Provider
// 列表 CRUD/归一化仍归 core/ai-provider-store.js（SW 出于消息路由仍要加载它，
// 但不再经它拖入 completion 链）。

import { chatCompletion } from "./completion.js";
import type { AiProtocol } from "./protocol-adapter.js";
import { providerFetchViaBackground } from "../core/provider-http.js";
import { formatProbeConnectionError } from "../core/provider-store.js";
import { aiProviderStore } from "../core/ai-provider-store.js";

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
  // 平台协议（multi-protocol-ai）：随 provider 记录透传 chatCompletion，端点 /
  // 鉴权头 / 请求体由 adapter 自然切换（probe 只调度，无协议分支）。缺省/未知值
  // 由 completion 内 resolveAdapter 兜底 openai。
  protocol?: string;
}

export interface TestAiConnectionResult {
  ok: boolean;
  error?: string;
}

export async function testAiConnection({ baseUrl, apiKey, model, presetId, protocol }: TestAiConnectionInput): Promise<TestAiConnectionResult> {
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
    protocol,
    headers: { Accept: "application/json" }
  });
}

interface ProbeAiChatCompletionInput {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  presetId?: string;
  protocol?: string;
  headers?: Record<string, string>;
}

export async function probeAiChatCompletion({ baseUrl, apiKey, model, presetId, protocol, headers }: ProbeAiChatCompletionInput): Promise<TestAiConnectionResult> {
  // 鉴权头由 adapter.authHeaders 全权负责（各协议不同：Bearer / x-api-key 等），
  // 本模块不再注入 Authorization——multi-protocol-ai 探针收进 adapter 后的调度化。
  const requestHeaders: Record<string, string> = { ...(headers || { Accept: "application/json" }) };

  try {
    await chatCompletion({
      provider: { baseUrl, apiKey, model, presetId, protocol: protocol as AiProtocol | undefined },
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

// 设置面板「测试」按钮的入口（跑在 content script 语境，manifest 无 options_page）：
// 平铺字段 + providerId，替代原 ai-providers-test 消息在 SW 侧的输入装配
//（provider-handlers.js pickFlatTestProvider 的契约）——Key 解析优先用户重输的
// apiKey，否则按 providerId 从已存 Key 代查，都没有为空串。
// protocol / presetId 同穿线：直输（表单当前值）优先，否则按 providerId 从已存
// 记录代查（multi-protocol-ai：探针端点/鉴权随 adapter 切换；平台身份则决定平台
// 要求的额外请求头，见 ai/preset-headers.ts）。直传优先是新增平台的必要路径：
// 新增时没有 providerId，身份只可能来自表单，只按记录代查会发出「无预设」的探针
// （Opencode Go 这类要求平台头的站点因此测不通，而对话走 resolve-ai-provider
// 拿得到 presetId，于是出现「对话能通、测试不通」）。
// 探针语义 = 校验**当前表单配置**（不是已保存的激活配置）：baseUrl / Key / 模型 /
// 协议 / 平台身份一律以调用方直传的表单值为准，不做「先保存再测」的前置——新增平台
// 没有已存记录可测。真跑（对话 / 概览）由 resolve-ai-provider 解析已保存的激活平台，
// 两者本就可以不同，属已知取舍：未保存的草稿测通不代表下次对话可用，故行级测试
//（ui/provider-editor-catalog.ts 的 runModelTest）在草稿有未保存改动时给「未保存」短标。
// 返回 { ok, error? }，UX 语义与原消息往返完全一致。
export async function testAiProviderConnection({ providerId, baseUrl, apiKey, model, protocol, presetId }: { providerId?: string; baseUrl?: string; apiKey?: string; model?: string; protocol?: string; presetId?: string }): Promise<TestAiConnectionResult> {
  // 页面侧（content script）**不做** host 权限预检（2026-10-05 删门）：content 没有
  // chrome.permissions（Chromium 只给扩展自有页面 / SW），hasHostPermission 取不到
  // contains 实现即按已授权放行——那道门是恒放行的假门，只会让维护者以为未授权已被
  // 拦住。未授权由下游 SW 代发通道那道**真门**拦下（core/provider-http.ts 的
  // handleProviderHttpRequest 在 SW 里跑、回 HOST_PERMISSION_HINT），用户看到的是经
  // 「无法连接：…」包装的同句提示；唯一的用户手势入口（行级测试 runModelTest）另在
  // 点击手势链上先申请权限。content / offscreen 语境要查权限得走代查入口
  //（hasHostPermissionViaBackground / hasHostPermissionFromOffscreen），不许原样调用——
  // 这条不变式由 tests/core/host-permissions.test.ts 的语境守卫按源码锁死。
  let resolvedApiKey = String(apiKey || "").trim();
  // presetId / protocol 穿线（02 号票 / multi-protocol-ai）：直传值优先，缺省按
  // providerId 从已存列表读记录字段随探针请求下发——host 反代无 host 规则时
  // presetId 是思考字段查表、平台头的唯一识别线索，protocol 决定端点/鉴权/请求体
  // 走哪个 adapter；读取失败按缺省继续（不阻塞探针）。
  let resolvedPresetId = String(presetId || "").trim();
  let resolvedProtocol = String(protocol || "").trim();
  if (providerId) {
    try {
      const record = (await aiProviderStore.loadProviders()).find((item) => item.id === providerId);
      if (!resolvedPresetId) {
        resolvedPresetId = String(record?.presetId || "");
      }
      if (!resolvedProtocol) {
        resolvedProtocol = String(record?.protocol || "");
      }
    } catch (error) {
      console.warn("读取已存平台 presetId/protocol 失败，按无 presetId 继续", error);
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
  return testAiConnection({ baseUrl, apiKey: resolvedApiKey, model, presetId: resolvedPresetId, protocol: resolvedProtocol });
}
