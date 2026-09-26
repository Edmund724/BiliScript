// extension/asr/asr-provider-normalize.ts
// ASR provider 归一化（arch-slim-2/09 自 core/presets.ts 搬入 asr/：域类型与
// 域归一化跟域走，core/ 回归纯共享底座；ASR_PROVIDER_PRESETS 预设数据仍是
// 跨 context 契约，留在 core/presets.ts）。
//
// 归一化单个 ASR provider：字段齐全 + type 合法值校验。
// 与 normalizeAiProvider（core/ai-provider-store.ts）平行：持久化层只存
// "明文可回传"字段，apiKey 单独存放在 chrome.storage.local，不进列表，
// 故此处不带 apiKey。

import { normalizeBaseUrl } from "../core/presets.js";

// 合法的 ASR 适配器类型，决定请求构造与响应解析方式
const ASR_PROVIDER_TYPES = new Set([
  "openai-transcriptions"
]);

export interface AsrProvider {
  id: string;
  presetId: string;
  name: string;
  type: string;
  baseUrl: string;
  model: string;
  supportsTimestamps: boolean;
  enabled: boolean;
  // 以下两个字段不落盘（normalize 不产出）：apiKey 单独存放在
  // chrome.storage.local，language 归全局设置 asrLanguage 管（normalizeAsrLanguage
  // 处理），运行时由消费方注入——offscreen 侧 entry/offscreen-asr 在解析激活
  // provider 时补 apiKey 与生效语言。
  apiKey?: string;
  language?: string;
}

export function normalizeAsrProvider(item: unknown): AsrProvider | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Partial<AsrProvider>;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const type = String(raw.type || "").trim();
  if (!ASR_PROVIDER_TYPES.has(type)) return null;
  return {
    id,
    presetId: String(raw.presetId || "custom").trim(),
    name: String(raw.name || "自定义").trim() || "自定义",
    type,
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    model: String(raw.model || "").trim(),
    supportsTimestamps: raw.supportsTimestamps !== false,
    enabled: raw.enabled !== false
  };
}
