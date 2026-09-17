// extension/ai/active-provider.ts
// 「当前选中的 AI 平台 + 其 API Key」的 content 侧解析（概览生成 / 选区解释共用）。
//
// arch-slim-3/09 收口：解析单趟化——原先手抄三趟消息链（get-settings →
// ai-providers-list → get-ai-provider-key），现统一走 resolve-ai-provider
// 合成消息，解析策略（defaultModel → 首个启用回落）与密钥校验单源在
// core/provider-handlers.ts 的处理器；offscreen 聊天链同走此消息（
// entry/offscreen.ts 的 resolveProviderWithKey），此前「回吐协议不同不合并」
// 的第三份复制就此退役。
//
// 为什么单独成文件：概览（reader/overview.ts）与选区解释（reader/explain-card.ts）
// 都要「拿一个能直接发请求的 provider」，本模块是 content 侧对该接缝的唯一
// 消费壳——没有 port 可回吐，失败一律以异常上翻，由调用方的状态机落 error 态。

import { sendRuntimeMessage } from "../shared/messaging.js";
import type { AiProvider } from "./types.js";
import type { AiProtocol } from "./protocol-adapter.js";

/**
 * 解析当前应使用的 AI 平台（含 apiKey/baseUrl/model）。
 * 解析在 SW 侧一次往返完成（策略见 createAiResolvedProviderHandler）；无平台、
 * 读 Key 失败或需要 Key 但未配置都以可读错误抛出。
 */
export async function resolveActiveProvider(): Promise<AiProvider> {
  const resp = await sendRuntimeMessage({ type: "resolve-ai-provider" });
  if (!resp?.ok) {
    throw new Error(String(resp?.error || "解析 AI 平台配置失败"));
  }
  const models = Array.isArray(resp.provider?.models) ? resp.provider.models : [];
  const legacyModel = String(resp.provider?.model || "").trim();
  return {
    baseUrl: String(resp.provider?.baseUrl || "").trim(),
    apiKey: String(resp.apiKey || "").trim(),
    // 模型目录取首项（概览/选区解释无模型选择器）；旧单模型记录回落 model
    // 字段（multi-model-catalog 无感迁移的消费端镜像）。
    model: String(models[0] ?? "").trim() || legacyModel,
    // presetId 穿线（provider 记录随带）：解释链下游 thinking-profiles 查表的
    // 主识别路径，反代 baseUrl 无 host 规则时是唯一线索。缺失归一为空串
    //（resolver 端回落 host/模型名识别，不臆造平台）。
    presetId: String(resp.provider?.presetId || ""),
    // 协议穿线（multi-protocol-ai）：completion 经 resolveAdapter 收敛到协议
    // 适配器；非法/缺失值由 resolveAdapter 兜底 openai，此处原样透传。
    protocol: resp.provider?.protocol as AiProtocol | undefined
  };
}
