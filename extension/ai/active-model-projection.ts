// extension/ai/active-model-projection.ts
// AI 默认平台与模型「生效投影」（票 05）：设置面板「AI 模型平台」分区直接展示
// 概览 / 选区解释将实际使用哪个平台与模型，以及对话 tab 的另选是否与之不同。
//
// 投影与真实请求复用同一解析链，不维护第二份回落逻辑：
// - 平台与可用性：经 resolve-ai-provider 合成消息由 SW 解析权威产出——
//   defaultModel → 首个启用平台回落、缺 Key 即不可用都发生在
//   core/provider-handlers.ts 处理器内，回落事实由响应 isFallback 自报；
// - 模型：复用 ai/active-provider.ts 的同一套规则（对话选中模型优先，
//   回落模型目录首项 / 历史 model 字段）。
// 任何失败（消息异常 / ok:false）都收敛为 unavailable 投影——投影是展示增强，
// 绝不让设置面板主链报错。

import { sendRuntimeMessage } from "../shared/messaging.js";
import { SELECTED_PROVIDER_KEY, parseModelOptionValue } from "../shared/selected-provider.js";
import { firstCatalogModel, selectedChatModelFor } from "./active-provider.js";
import type { ProviderListEntry, ResolveSubtitleTranslateProviderResponse } from "../shared/messaging-protocol.js";

export interface AiActiveProjectionOk {
  state: "ok";
  provider: ProviderListEntry;
  /** 概览 / 选区解释将实际使用的模型（对话选中模型优先，回落目录首项）。 */
  model: string;
  /** 解析权威自报：显式默认平台不可用，已回落到别的启用平台。 */
  isFallback: boolean;
}

export interface AiActiveProjectionUnavailable {
  state: "unavailable";
  error: string;
}

export type AiActiveModelProjection = AiActiveProjectionOk | AiActiveProjectionUnavailable;

/**
 * 解析当前生效投影：设置面板摘要、默认行徽标的唯一真相来源。
 */
export async function resolveAiActiveModelProjection(): Promise<AiActiveModelProjection> {
  try {
    const resp = await sendRuntimeMessage({ type: "resolve-ai-provider" });
    if (!resp?.ok || !resp.provider) {
      return { state: "unavailable", error: String(resp?.error || "解析 AI 平台配置失败") };
    }
    const provider = resp.provider;
    const model =
      (await selectedChatModelFor(String(provider.id || ""))) || firstCatalogModel(provider);
    return {
      state: "ok",
      provider,
      model,
      isFallback: resp.isFallback === true
    };
  } catch (error) {
    return { state: "unavailable", error: (error as Error)?.message || String(error) };
  }
}

export interface ChatSelectedModel {
  providerId: string;
  model: string;
}

/**
 * 读取对话 tab 的选中平台 + 模型（chrome.storage.local 复合值；读取失败 /
 * 无选中项返回空）。设置面板用它判断「对话另选」是否偏离生效投影。
 */
export async function readChatSelectedModel(): Promise<ChatSelectedModel> {
  if (typeof chrome === "undefined" || !chrome?.storage?.local) {
    return { providerId: "", model: "" };
  }
  try {
    const stored = await chrome.storage.local.get([SELECTED_PROVIDER_KEY]);
    const selected = parseModelOptionValue(stored?.[SELECTED_PROVIDER_KEY]);
    return { providerId: selected.providerId, model: selected.model };
  } catch {
    return { providerId: "", model: "" };
  }
}

export interface SubtitleFollowProjectionOk {
  state: "ok";
  providerName: string;
  model: string;
  /** 专属配置缺失 / 失效，已回落到全局默认激活平台（解析权威自报）。 */
  isFallback: boolean;
}

export interface SubtitleFollowProjectionUnavailable {
  state: "unavailable";
  error: string;
}

export type SubtitleFollowProjection = SubtitleFollowProjectionOk | SubtitleFollowProjectionUnavailable;

/**
 * 字幕翻译「跟随 AI 默认平台」的当前跟随目标：直调 resolve-subtitle-translate-provider
 * 由解析权威（ai/subtitle-translate.ts 的 resolveSubtitleTranslateProviderConfig）
 * 给出真实回落与不可用状态——展示层不复写回落逻辑，存储键与请求语义不变。
 */
export async function resolveSubtitleFollowProjection(): Promise<SubtitleFollowProjection> {
  try {
    const resp: ResolveSubtitleTranslateProviderResponse = await sendRuntimeMessage({
      type: "resolve-subtitle-translate-provider"
    });
    if (!resp?.ok || !resp.provider) {
      return { state: "unavailable", error: String(resp?.error || "解析字幕翻译平台配置失败") };
    }
    const provider = resp.provider;
    const model = String(resp.model || "").trim();
    return {
      state: "ok",
      providerName: String(provider.name || "").trim(),
      model,
      isFallback: resp.isFallback === true
    };
  } catch (error) {
    return { state: "unavailable", error: (error as Error)?.message || String(error) };
  }
}
