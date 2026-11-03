// extension/live/live-provider-normalize.ts
// MOSS-LIVE 平台配置归一化与选用 id 解析。
// 与 asr-provider-normalize.ts 保持一致模式。

import { normalizeBaseUrl } from "../core/presets.js";

const LIVE_PROVIDER_TYPES = new Set(["moss-live"]);

export interface LiveProvider {
  id: string;
  presetId: string;
  name: string;
  type: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  // apiKey 单独存放在 chrome.storage.local，不进同步列表
  apiKey?: string;
}

export function normalizeLiveProvider(item: unknown): LiveProvider | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as Partial<LiveProvider>;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const type = String(raw.type || "").trim() || "moss-live";
  if (!LIVE_PROVIDER_TYPES.has(type)) return null;
  return {
    id,
    presetId: String(raw.presetId || "moss-live").trim() || "moss-live",
    name: String(raw.name || "MOSS-LIVE").trim() || "MOSS-LIVE",
    type,
    baseUrl: normalizeBaseUrl(raw.baseUrl) || "https://api.mosi.cn",
    model: String(raw.model || "").trim() || "moss-live-1.0",
    enabled: raw.enabled !== false
  };
}

export function resolveActiveLiveProviderId(
  providers: ReadonlyArray<{ id?: string | null }> | null | undefined,
  activeId?: string | null
): string {
  const list = Array.isArray(providers) ? providers : [];
  const trimmed = String(activeId || "").trim();
  if (trimmed && list.some((p) => String(p?.id || "").trim() === trimmed)) {
    return trimmed;
  }
  return String(list[0]?.id || "").trim();
}
