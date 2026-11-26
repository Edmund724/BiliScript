import {
  DEFAULT_AI_SYSTEM_PROMPT,
  DEFAULT_PLAYER_AI_QUICK_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V5,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V6,
  LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT,
  LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2,
  LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V3,
  LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V4,
  MAX_INITIAL_QUICK_PROMPTS
} from "./default-prompts.js";
import {
  DEFAULT_SETTINGS,
  type DetachedWindowMode,
  type NoteExportTarget,
  type NotePromptPreset,
  type PlayerAiActionMode,
  type Settings,
  type SubtitleSegmentationStrategy
} from "./defaults.js";
import {
  DEFAULT_NOTE_TEMPLATE,
  MAX_NOTE_EXPORT_TEMPLATE_BYTES,
  MAX_OBSIDIAN_FIELD_LENGTH
} from "../notes/template-defaults.js";
import {
  BILINGUAL_DISPLAY_ORDER_OPTIONS,
  INTERPRET_SUBTITLE_SCALE_MAX,
  INTERPRET_SUBTITLE_SCALE_MIN,
  LIVE_INTERPRET_DISPLAY_MODE_OPTIONS,
  LIVE_INTERPRET_TARGET_LANG_OPTIONS,
  type BilingualDisplayOrder,
  type InterpretSubtitleDisplayMode,
  type LiveInterpretTargetLang
} from "../live/interpret-subtitle-preferences.js";

export function toString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function booleanField(defaultValue = false): (value: unknown) => boolean {
  return defaultValue
    ? function (value: unknown): boolean { return value !== false; }
    : function (value: unknown): boolean { return value === true; };
}

export function clampedIntField(min: number, max: number, fallback: number): (value: unknown) => number {
  return function (value: unknown): number {
    if (value === null || value === undefined || value === "") {
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(parsed)));
  };
}

export type ReaderThemeMode = "bilibili" | "system" | "light" | "dark";

export function normalizeReaderTheme(value: unknown): ReaderThemeMode {
  if (value === "dark" || value === "light" || value === "system" || value === "bilibili") {
    return value;
  }
  return "bilibili";
}

export function normalizeReaderPalette(value: unknown): string {
  return value === "editorial" ? value : "flyme";
}

export const normalizeChatInputGlow = booleanField(true);

export const normalizeReduceTransparency = booleanField(false);

export function normalizeDownloadFormat(value: unknown): string {
  if (value === "txt") return "txt";
  if (value === "vtt") return "vtt";
  if (value === "vtt-secondary") return "vtt-secondary";
  return "srt";
}

function truncateUtf8ByBytes(text: string, maxBytes: number): string {
  if (!text) return "";
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) {
    return text;
  }
  let result = "";
  let used = 0;
  for (const ch of text) {
    const size = encoder.encode(ch).length;
    if (used + size > maxBytes) {
      break;
    }
    result += ch;
    used += size;
  }
  return result.trimEnd();
}

export function normalizeNoteExportTemplate(value: unknown): string {
  const normalized = toString(value).replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return DEFAULT_NOTE_TEMPLATE;
  }
  return truncateUtf8ByBytes(normalized, MAX_NOTE_EXPORT_TEMPLATE_BYTES) || DEFAULT_NOTE_TEMPLATE;
}

export function normalizeObsidianVaultName(value: unknown): string {
  return toString(value).trim().slice(0, MAX_OBSIDIAN_FIELD_LENGTH);
}

export function normalizeObsidianFolder(value: unknown): string {
  return toString(value)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .slice(0, MAX_OBSIDIAN_FIELD_LENGTH);
}

export const MAX_NOTE_CUSTOM_PROMPT_BYTES = 4096;
export const MAX_NOTE_DOWNLOAD_SUBDIR_LENGTH = 120;

const NOTE_PROMPT_PRESETS: ReadonlySet<NotePromptPreset> = new Set([
  "general",
  "tutorial",
  "course",
  "opinion",
  "custom"
]);

const WINDOWS_RESERVED_PATH_SEGMENT_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function normalizePlayerAiActionMode(value: unknown): PlayerAiActionMode {
  return value === "note" ? "note" : "summary";
}

export const normalizePlayerAiAutoExportNote = booleanField(false);

export function normalizeNotePromptPreset(value: unknown): NotePromptPreset {
  const normalized = toString(value).trim() as NotePromptPreset;
  return NOTE_PROMPT_PRESETS.has(normalized) ? normalized : DEFAULT_SETTINGS.notePromptPreset;
}

export function normalizeNoteCustomPrompt(value: unknown): string {
  const normalized = toString(value).replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return "";
  }
  return truncateUtf8ByBytes(normalized, MAX_NOTE_CUSTOM_PROMPT_BYTES);
}

export function normalizeNoteExportTarget(value: unknown): NoteExportTarget {
  return value === "obsidian" ? "obsidian" : "download";
}

export function normalizeNoteDownloadSubdir(value: unknown): string {
  const raw = toString(value)
    .replace(/\\/g, "/")
    .replace(/[\u0000-\u001f\u007f]/g, "");
  const segments: string[] = [];
  for (const part of raw.split("/")) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === "." || trimmed === "..") {
      continue;
    }
    const withoutDrive = trimmed.replace(/^[a-zA-Z]:/, "");
    const cleaned = withoutDrive
      .replace(/[<>:"|?*]/g, "")
      .replace(/\.{2,}/g, ".")
      .trim()
      .replace(/[. ]+$/g, "");
    if (!cleaned || cleaned === "." || cleaned === ".." || WINDOWS_RESERVED_PATH_SEGMENT_RE.test(cleaned)) {
      continue;
    }
    segments.push(cleaned);
  }
  let joined = segments.join("/");
  if (joined.length > MAX_NOTE_DOWNLOAD_SUBDIR_LENGTH) {
    joined = joined
      .slice(0, MAX_NOTE_DOWNLOAD_SUBDIR_LENGTH)
      .replace(/[/. ]+$/g, "")
      .split("/")
      .map((seg) => seg.trim().replace(/[. ]+$/g, ""))
      .filter((seg) => seg && seg !== "." && seg !== ".." && !WINDOWS_RESERVED_PATH_SEGMENT_RE.test(seg))
      .join("/");
  }
  return joined;
}

export const normalizeNoteIncludeKeyframes = booleanField(false);

export function parseAgentBridgeUrl(value: unknown): string | null {
  const input = toString(value).trim();
  if (!input) return null;
  try {
    const url = new URL(input);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    const port = Number(url.port);
    if (url.protocol !== "ws:" || !loopback || !url.port || !Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }
    if (url.username || url.password || (url.pathname && url.pathname !== "/") || url.search || url.hash) return null;
    return `ws://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

export function normalizeAgentBridgeUrl(value: unknown): string {
  return parseAgentBridgeUrl(value) ?? DEFAULT_SETTINGS.agentBridgeUrl;
}

export const normalizeEnablePlayerAiQuickAction = booleanField(false);

export function normalizePlayerAiQuickPrompt(value: unknown): string {
  const normalized = toString(value).trim();
  if (
    normalized === LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT ||
    normalized === LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V2 ||
    normalized === LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V3 ||
    normalized === LEGACY_DEFAULT_PLAYER_AI_QUICK_PROMPT_V4
  ) {
    return DEFAULT_PLAYER_AI_QUICK_PROMPT;
  }
  if (!normalized) {
    return DEFAULT_PLAYER_AI_QUICK_PROMPT;
  }
  return normalized;
}

export function normalizeAiSystemPrompt(value: unknown): string {
  const normalized = toString(value).trim();
  if (
    normalized === LEGACY_DEFAULT_AI_SYSTEM_PROMPT ||
    normalized === LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2 ||
    normalized === LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3 ||
    normalized === LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4 ||
    normalized === LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V5 ||
    normalized === LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V6
  ) {
    return DEFAULT_AI_SYSTEM_PROMPT;
  }
  if (!normalized) {
    return DEFAULT_AI_SYSTEM_PROMPT;
  }
  return normalized;
}

export function normalizeAiInitialQuickPrompts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(function (item: unknown) { return toString(item).trim(); })
    .filter(function (prompt: string) { return Boolean(prompt); })
    .slice(0, MAX_INITIAL_QUICK_PROMPTS);
}

export function normalizeDefaultModel(value: unknown): string {
  return toString(value).trim();
}

export function normalizeDefaultAiModel(value: unknown): string {
  return toString(value).trim();
}

export { normalizeThinkingLevel as normalizeAiThinkingLevel } from "../ai/thinking-levels.js";

export { normalizeLiveVoiceSpeed } from "../live/live-voice-speed.js";
export const normalizeLiveVoiceVolume = clampedIntField(
  0,
  200,
  DEFAULT_SETTINGS.liveVoiceVolume
);
export const normalizeSpeechVoiceVolume = clampedIntField(
  0,
  100,
  DEFAULT_SETTINGS.speechVoiceVolume
);
export const normalizeLiveVoicePriority = booleanField(true);
export const normalizeLiveShareVideoAudio = booleanField(false);
export const normalizeLiveGeminiNativeSearch = booleanField(false);
export const normalizeLiveLowBandwidth = booleanField(false);

export function normalizeSubtitleTranslateProviderId(value: unknown): string {
  return toString(value).trim() || DEFAULT_SETTINGS.subtitleTranslateProviderId;
}

export function normalizeSubtitleTranslateModel(value: unknown): string {
  return toString(value).trim();
}

export function normalizeSubtitleTranslateGlossary(value: unknown): string {
  return toString(value).replace(/\r\n?/g, "\n").trim();
}

export function normalizeLiveInterpretTargetLang(value: unknown): LiveInterpretTargetLang {
  const normalized = toString(value).trim();
  return LIVE_INTERPRET_TARGET_LANG_OPTIONS.find((option) => option.value === normalized)?.value
    ?? DEFAULT_SETTINGS.liveInterpretTargetLang;
}

export function normalizeLiveInterpretDisplayMode(value: unknown): InterpretSubtitleDisplayMode {
  const normalized = toString(value).trim();
  return LIVE_INTERPRET_DISPLAY_MODE_OPTIONS.find((option) => option.value === normalized)?.value
    ?? DEFAULT_SETTINGS.liveInterpretDisplayMode;
}

export const normalizeLiveInterpretFontScale = clampedIntField(
  INTERPRET_SUBTITLE_SCALE_MIN,
  INTERPRET_SUBTITLE_SCALE_MAX,
  DEFAULT_SETTINGS.liveInterpretFontScale
);

export const normalizeLiveInterpretBlurSecondary = booleanField(false);

export const normalizeWebSearchEnabled = booleanField(false);

export const normalizeSearchPresetsAutoActivated = booleanField(false);

export const normalizeSearchOptInNoticeAcknowledged = booleanField(false);

export const normalizeWebSearchMaxToolCalls = clampedIntField(
  1,
  20,
  DEFAULT_SETTINGS.webSearchMaxToolCalls
);

export const normalizeAllowPaidSearchProviders = booleanField(false);

export const normalizeBilingualSubtitles = booleanField(false);

export const normalizeReaderFontSizeScale = clampedIntField(
  70,
  130,
  DEFAULT_SETTINGS.readerFontSizeScale
);

export const normalizeChatLineHeight = clampedIntField(
  120,
  200,
  DEFAULT_SETTINGS.chatLineHeight
);

export const normalizeChatParagraphSpacing = clampedIntField(
  4,
  20,
  DEFAULT_SETTINGS.chatParagraphSpacing
);

export const CUSTOM_PANEL_WIDTH_MIN = 400;
export const CUSTOM_PANEL_WIDTH_MAX = 960;

export const normalizeCustomPanelWidthEnabled = booleanField(false);

export const normalizeCustomPanelWidth = clampedIntField(
  CUSTOM_PANEL_WIDTH_MIN,
  CUSTOM_PANEL_WIDTH_MAX,
  DEFAULT_SETTINGS.customPanelWidth
);

export function normalizeDetachedWindowMode(value: unknown): DetachedWindowMode {
  return value === "popup" ? "popup" : "pip";
}

export const normalizeAutoOpenReader = booleanField(false);

export function normalizeSecondarySubtitleLang(value: unknown): string {
  const normalized = toString(value).trim();
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(normalized)) {
    return DEFAULT_SETTINGS.secondarySubtitleLang;
  }
  return normalized;
}

export function normalizeBilingualDisplayOrder(value: unknown): BilingualDisplayOrder {
  const normalized = toString(value).trim();
  return BILINGUAL_DISPLAY_ORDER_OPTIONS.find((option) => option.value === normalized)?.value
    ?? DEFAULT_SETTINGS.bilingualDisplayOrder;
}

const SUBTITLE_SEGMENTATION_STRATEGIES: ReadonlySet<SubtitleSegmentationStrategy> = new Set([
  "auto",
  "rule",
  "stats",
  "off"
]);

export function normalizeSubtitleSegmentationStrategy(value: unknown): SubtitleSegmentationStrategy {
  const normalized = toString(value).trim().toLowerCase() as SubtitleSegmentationStrategy;
  return SUBTITLE_SEGMENTATION_STRATEGIES.has(normalized)
    ? normalized
    : DEFAULT_SETTINGS.subtitleSegmentationStrategy;
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
    if (seenIds.has(String(item.id))) {
      return { ok: false, message: "平台 id 重复，请刷新页面后重试" };
    }
    seenIds.add(String(item.id));
  }
  return { ok: true };
}

export type { Settings };
