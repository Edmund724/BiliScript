// extension/core/validators.ts
// Pure normalizers / validators for stored settings: reader preferences,
// download format, AI prompts, AI providers and web search. No Chrome APIs, no
// DOM. Default constants live in defaults.ts; prompt default texts in
// default-prompts.ts; provider presets in presets.ts.
import {
  DEFAULT_AI_SYSTEM_PROMPT,
  DEFAULT_INITIAL_QUICK_PROMPTS,
  DEFAULT_PLAYER_AI_QUICK_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4,
  LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT,
  LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2
} from "./default-prompts.js";
import {
  DEFAULT_SETTINGS,
  type Settings
} from "./defaults.js";

// ===== Shared string helper =====
export function toString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ===== Reader normalizers =====
// 三开关退役后只剩主题一项（字幕/章节可见性归一化已随其存储键一并删除）；
// 留守本模块的原因不变：core/settings-store.ts（后台设置归一化）静态依赖它，
// 迁移会破坏后台 bundle 与其测试。
export function normalizeReaderTheme(value: unknown): string {
  return value === "dark" ? value : "light";
}

// ===== Download / AI normalizers =====
export function normalizeDownloadFormat(value: unknown): string {
  return value === "txt" ? "txt" : "srt";
}

export function normalizeEnablePlayerAiQuickAction(value: unknown): boolean {
  return value === true;
}

export function normalizePlayerAiQuickPrompt(value: unknown): string {
  const normalized = toString(value).trim();
  // 两代旧默认快捷提示词一次性升到当前默认（与 aiSystemPrompt 的 LEGACY 映射同机制）。
  if (normalized === LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT || normalized === LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2) {
    return DEFAULT_PLAYER_AI_QUICK_PROMPT;
  }
  // 空串（DEFAULT_SETTINGS 空占位 / 用户清空保存）回落当前默认：清空即恢复默认。
  if (!normalized) {
    return DEFAULT_PLAYER_AI_QUICK_PROMPT;
  }
  return normalized;
}

export function normalizeAiSystemPrompt(value: unknown): string {
  const normalized = toString(value).trim();
  // 四代历史默认一次性升到当前默认（机制相同）；用户自定义文本不动。
  if (
    normalized === LEGACY_DEFAULT_AI_SYSTEM_PROMPT ||
    normalized === LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2 ||
    normalized === LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3 ||
    normalized === LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4
  ) {
    return DEFAULT_AI_SYSTEM_PROMPT;
  }
  // 空串（DEFAULT_SETTINGS 空占位 / 用户清空保存）回落当前默认：清空即恢复默认。
  if (!normalized) {
    return DEFAULT_AI_SYSTEM_PROMPT;
  }
  return normalized;
}

export function normalizeAiPresetPrompts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(function (item: unknown) { return toString(item).trim(); })
    .filter(Boolean)
    .slice(0, 12);
}

export function normalizeAiInitialQuickPrompts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return DEFAULT_INITIAL_QUICK_PROMPTS.slice();
  }
  const prompts = value
    .map(function (item: unknown) { return toString(item).trim(); })
    .slice(0, 4);
  // 空数组（DEFAULT_SETTINGS 空占位）回落当前默认，与 !Array.isArray 分支同语义。
  return prompts.length ? prompts : DEFAULT_INITIAL_QUICK_PROMPTS.slice();
}

export function normalizeDefaultModel(value: unknown): string {
  return toString(value).trim();
}

// 思考档位（off / low / high），off 为默认且不发任何思考参数
export function normalizeAiThinkingLevel(value: unknown): "off" | "low" | "high" {
  return value === "low" || value === "high" ? value : "off";
}

// ===== 联网搜索 normalizers =====
export function normalizeWebSearchEnabled(value: unknown): boolean {
  return value === true;
}

// 单轮搜索次数上限：整数，区间 1–10，越界夹取，非法值回落默认 5（spec §3.2）
export function normalizeWebSearchMaxToolCalls(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_SETTINGS.webSearchMaxToolCalls;
  }
  return Math.min(10, Math.max(1, Math.round(parsed)));
}

interface ValidationResult {
  ok: boolean;
  row?: unknown;
  message?: string;
}

interface AiProviderValidationInput {
  baseUrl?: unknown;
  requiresKey?: unknown;
  apiKey?: unknown;
  hasSavedKey?: unknown;
  models?: unknown;
  id?: unknown;
  name?: unknown;
}

// ===== AI provider validation =====
export function validateAiProviders(items: unknown[]): ValidationResult {
  const seenIds = new Set<string>();
  for (let i = 0; i < (items as unknown[]).length; i++) {
    const item = (items as unknown[])[i] as AiProviderValidationInput;
    if (!item.baseUrl) {
      return { ok: false, message: "每个平台都需要填写 baseUrl" };
    }
    try {
      const u = new URL(String(item.baseUrl));
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return { ok: false, message: "baseUrl 必须以 http(s):// 开头（" + item.baseUrl + "）" };
      }
    } catch {
      return { ok: false, message: "baseUrl 格式不正确：" + item.baseUrl };
    }
    if (item.requiresKey && !item.apiKey && !item.hasSavedKey) {
      return { ok: false, message: "平台「" + item.name + "」需要填写 API Key" };
    }
    // 模型目录允许为空（multi-model-catalog 拍板 Q13）：空目录平台只是不出现在
    // 聊天模型选择器，目录外 ID 仍可直接发送；不再强制至少一个模型。
    if (seenIds.has(String(item.id))) {
      return { ok: false, message: "平台 id 重复，请刷新页面后重试" };
    }
    seenIds.add(String(item.id));
  }
  return { ok: true };
}

export type { Settings };
