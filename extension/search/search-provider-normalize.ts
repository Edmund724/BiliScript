// extension/search/search-provider-normalize.ts
// 搜索平台 provider 归一化。与 normalizeAsrProvider（asr/asr-provider-normalize.ts）
// 平行：持久化层只存"明文可回传"字段，apiKey 单独存放在 chrome.storage.local，
// 不进列表，故此处不带 apiKey。域类型与域归一化跟域走（arch-slim-2/09 先例），
// 预设数据（SEARCH_PROVIDER_PRESETS）仍是跨 context 契约，留在 core/presets.ts。
//
// 不做自定义预设（spec 非目标）：type 只接受三个预设值，未知 type 的存量条目
// 在归一化期被丢弃（列表读取与保存共用同一收口）。

import { normalizeBaseUrl, SEARCH_PROVIDER_PRESETS, type SearchProviderType } from "../core/presets.js";

// 合法的搜索适配器类型，决定请求构造与响应解析方式；派生自预设表，新增预设免手改
const SEARCH_PROVIDER_TYPES = new Set<string>(SEARCH_PROVIDER_PRESETS.map((p) => p.type));

export interface SearchProvider {
  id: string;
  presetId: string;
  name: string;
  type: SearchProviderType;
  baseUrl: string;
  enabled: boolean;
}

export function normalizeSearchProvider(item: unknown): SearchProvider | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Partial<SearchProvider>;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const type = String(raw.type || "").trim();
  if (!SEARCH_PROVIDER_TYPES.has(type)) return null;
  return {
    id,
    presetId: String(raw.presetId || "custom").trim(),
    name: String(raw.name || "自定义").trim() || "自定义",
    type: type as SearchProviderType,
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    enabled: raw.enabled !== false
  };
}
