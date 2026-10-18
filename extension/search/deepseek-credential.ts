// extension/search/deepseek-credential.ts
// DeepSeek 搜索「凭据引用」的共享 helper（GLOSSARY「凭据引用」「官方端点判定」
// 的代码单点）：搜索侧 DeepSeek 记录没有自有 Key，发请求时实时读 AI 族「第一条
// 启用、presetId 为 deepseek 且通过官方端点判定」的记录的 Key（aiProviderKeys）。
// 设置 UI 的行状态文案与 SW 侧链装配消费本模块同一份判定——两侧不允许各写一份。
//
// 叶纪律：只 import core/presets（零运行时依赖的预设数据）；不碰 chrome.storage /
// DOM / 消息。调用方（SW handler / 设置面板 / 编辑 Modal）各自负责拿数据。
//
// 方向单向：搜索读 AI，绝不回写（三族存储隔离的唯一例外，见
// search/search-provider-store.ts 头注）。

import { PRESETS, effectivePresetBaseUrl, type AiProviderPreset } from "../core/presets.js";

// DeepSeek 官方 API host（凭据引用唯一信任的端点；中转 / 反代 / 克隆站一律不通过）。
export const DEEPSEEK_OFFICIAL_HOST = "api.deepseek.com";

// 官方端点判定：baseUrl 规范化（trim、去尾斜杠、小写）后 host 严格等于
// api.deepseek.com 且协议为 https（明文 http 不配承载 Key，一律不通过）。无
// scheme 的裸域先补 https:// 再解析；解析失败一律不通过。禁止 includes("deepseek")
// 子串匹配（子域 / 路径里带 deepseek 字样的克隆站会漏进来）。
export function isOfficialDeepseekEndpoint(baseUrl: unknown): boolean {
  const raw = String(baseUrl || "").trim().replace(/\/+$/, "").toLowerCase();
  if (!raw) return false;
  let parsed: URL | null = null;
  try {
    parsed = new URL(raw);
  } catch {
    try {
      parsed = new URL(`https://${raw}`);
    } catch {
      return false;
    }
  }
  return parsed.protocol === "https:" && parsed.hostname === DEEPSEEK_OFFICIAL_HOST;
}

// 判定用的 AI 记录最小面：AiProvider 的线格式面 presetId/baseUrl/enabled 都是宽松
// 可选（ai/types.js），判定一律走 String(...) 收口；测试可给字面量。
export interface DeepseekAiRecordLike {
  id?: string;
  presetId?: string;
  name?: string;
  baseUrl?: string;
  enabled?: boolean;
  // 平台协议（multi-protocol-ai）：当前生效协议决定端点查表的键；缺省 openai。
  protocol?: string;
  hasSavedKey?: boolean;
}

function deepseekPreset(presets: readonly AiProviderPreset[]): AiProviderPreset | undefined {
  return presets.find((preset) => preset.id === "deepseek");
}

// 凭据引用状态（设置行三态文案的判据，亦是链装配的跳过判据）：
//   ok        = 找到合格记录且已存 Key（链可装配 / 行显示「已复用 AI 平台 Key」）
//   no-key    = 找到合格记录但没存 Key（链跳过 / 行提示回 AI 平台补 Key）
//   unofficial= 有启用的 DeepSeek 记录但端点判定不通过（链跳过 / 行显示非官方端点）
//   no-record = 没有任何启用的 DeepSeek 预设记录（链跳过 / 行提示先去 AI 平台添加）
export type DeepseekCredentialStatus = "ok" | "no-key" | "unofficial" | "no-record";

export interface DeepseekCredentialResolution {
  status: DeepseekCredentialStatus;
  // 合格记录（status 为 ok / no-key 时给出；链装配按它取 Key）。
  record?: DeepseekAiRecordLike;
}

export function resolveDeepseekCredential(
  aiProviders: ReadonlyArray<DeepseekAiRecordLike> | null | undefined,
  presets: readonly AiProviderPreset[] = PRESETS
): DeepseekCredentialResolution {
  const preset = deepseekPreset(presets);
  const candidates = (aiProviders ?? []).filter(
    (record) => record && record.enabled !== false && String(record.presetId || "").trim() === "deepseek"
  );
  if (candidates.length === 0) return { status: "no-record" };
  // 「第一条（列表序）启用且通过官方端点判定的记录」；端点判定以当前生效协议
  // 对应的 baseUrl 为准（生效端点规则单源在 core/presets.ts 的 effectivePresetBaseUrl：
  // 记录值优先，空值按协议缺省链查预设）。
  for (const record of candidates) {
    if (isOfficialDeepseekEndpoint(effectivePresetBaseUrl(record, preset))) {
      return { status: record.hasSavedKey === false ? "no-key" : "ok", record };
    }
  }
  return { status: "unofficial" };
}

// 链装配入口：取 DeepSeek 搜索候选的 Key（取不到 = 空串，链侧据此跳过，同
// free-quota 无 Key 的既有口径）。aiKeys 按记录 id 索引（aiProviderKeys 形状）。
export function resolveDeepseekSearchKey(
  aiProviders: ReadonlyArray<DeepseekAiRecordLike> | null | undefined,
  aiKeys: Record<string, string> | null | undefined,
  presets: readonly AiProviderPreset[] = PRESETS
): string {
  const { status, record } = resolveDeepseekCredential(aiProviders, presets);
  if (status !== "ok" || !record) return "";
  return String(aiKeys?.[String(record.id || "")] ?? "").trim();
}

// 设置行副行状态文案（三态，硬编码中文——本仓无 i18n 惯例）。no-key 与 no-record
// 同文案： actionable 诉求都是「回 AI 平台把官方 DeepSeek 记录配好」。
export const DEEPSEEK_ROW_STATUS_TEXT: Record<DeepseekCredentialStatus, string> = {
  ok: "已复用 AI 平台 Key",
  "no-key": "请先在 AI 平台添加官方 DeepSeek 记录",
  unofficial: "AI 平台 Key 指向非官方端点",
  "no-record": "请先在 AI 平台添加官方 DeepSeek 记录"
};
