// extension/core/ai-provider-store.ts
// AI 平台 Provider/Key 的存储（列表 CRUD + 归一化）。
// 从 extension/entry/background.js 提取的深模块：只与 chrome.storage 交互，
// 不涉及消息路由。所有函数返回 Promise，由 background.js 的消息处理函数调用。
// 全局设置（reader/AI/ASR/下载域）的归一化与读写已拆到 settings-store.js，
// 本模块只负责 AI 平台列表 CRUD。连通性测试/探针已移至 ai/provider-test.js
// （候选 04 拆链：探针依赖 ai/completion.js，留在本文件会把整条 completion 链
// 拖进 SW 静态图；options 页直调 provider-test，本模块回归纯存储）；
// 模型列表探测（handleAiProvidersModels，fetch 原语）也已移至 ai/provider-models.js
//（arch-slim-2/09：探针是 ai 域知识，core/ 回归纯共享底座）。

import { createProviderStore } from "./provider-store.js";
import { PROTOCOL_ADAPTERS, type AiProtocol } from "../ai/protocol-adapter.js";

export interface AiProvider {
  id: string;
  presetId: string;
  name: string;
  baseUrl: string;
  // 模型目录（multi-model-catalog 拍板 Q7：纯 ID 数组，删除即移除，无启停
  // 开关；允许空数组——空目录平台在聊天选择器中不显示任何模型）。
  models: string[];
  requiresKey: boolean;
  enabled: boolean;
  // 平台协议（multi-protocol-ai）：设置 UI 写入显式值；缺省/未知值不落盘，
  // 读侧经 resolveAdapter 兜底 openai（存量记录零变化）。
  protocol?: AiProtocol;
  hasSavedKey?: boolean;
  apiKey?: string;
}

// ===== AI 模型平台存储 =====
// 列表 CRUD（load/save/delete/Key 读写）委托给通用工厂 createProviderStore，
// 本模块只提供 storage key 与 AI 专属的 normalizeProvider。不变式
// “apiKey 永不进同步列表”由工厂统一保证。直接导出绑定好的 store 实例，
// 消费方（background 消息路由）调用实例方法。

const AI_PROVIDER_KEYS_STORAGE = "aiProviderKeys";

function normalizeModelsField(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of list) {
    const id = String(entry ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function normalizeAiProvider(item: unknown): AiProvider | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Partial<AiProvider> & { model?: unknown };
  const id = String(raw.id || "").trim();
  if (!id) return null;
  // 无感迁移（拍板 Q2）：旧单模型记录读时包成单元素目录。trim/去空/去重由
  // normalizeModelsField 收口（拍板 Q7 校验口径）。
  const legacyModel = String(raw.model ?? "").trim();
  const models = normalizeModelsField(raw.models);
  const normalized: AiProvider = {
    id,
    presetId: String(raw.presetId || "custom"),
    name: String(raw.name || "自定义").trim() || "自定义",
    baseUrl: String(raw.baseUrl || "").trim().replace(/\/+$/, ""),
    models: models.length ? models : legacyModel ? [legacyModel] : [],
    requiresKey: raw.requiresKey !== false,
    enabled: raw.enabled !== false
  };
  // 协议字段：仅注册表词表内的值落盘（缺省/未知值省略，读侧经 resolveAdapter
  // 兜底 openai——存量记录读写出形状不变，multi-protocol-ai 设置 UI 章）。
  if (typeof raw.protocol === "string" && raw.protocol in PROTOCOL_ADAPTERS) {
    normalized.protocol = raw.protocol as AiProtocol;
  }
  return normalized;
}

export const aiProviderStore = createProviderStore<AiProvider>({
  listStorageKey: "aiProviders",
  keysStorageKey: AI_PROVIDER_KEYS_STORAGE,
  normalizeProvider: normalizeAiProvider
});
