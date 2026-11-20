// Reader 排版/设置呈现层：启动路径必需的常驻微模块。
//
// 收拢启动路径必需的轻呈现函数：阅读视图的排版应用（applyReadingViewPresentation）、
// 设置水合（hydrateReaderStateFromSettings）与外部主题同步（syncReaderExternalTheme）。
import { state } from "../core/state.js";
import { type Settings } from "../core/defaults.js";
import { getReaderElement } from "../shared/dom-utils.js";
import {
  normalizeReaderPalette,
  normalizeReaderFontSizeScale,
  normalizeChatLineHeight,
  normalizeChatParagraphSpacing,
  normalizeChatInputGlow,
  normalizeReduceTransparency,
  type ReaderThemeMode
} from "../core/validators.js";
import {
  applyPrePaintReaderTheme,
  resolveEffectiveTheme,
  resolveReaderThemeMode,
  writeThemeSnapshot
} from "../shared/host-theme.js";
export { applyPrePaintReaderTheme };
import { ids } from "./state.js";
import { refreshThemeButton } from "../ui/theme-button.js";
import { hydrateMermaid } from "../ui/lazy-mermaid.js";
import { READER_APPLY_FIELDS } from "./presentation-fields.js";

export function hydrateReaderStateFromSettings(settings: Partial<Settings> = state.settings) {
  const palette = normalizeReaderPalette(settings?.readerPalette);
  const mode = resolveReaderThemeMode(settings);
  const resolved = resolveEffectiveTheme(mode);
  state.reader.setPalette(palette);
  state.reader.setThemeMode(mode);
  state.reader.setTheme(resolved);
  writeThemeSnapshot({ mode, palette, resolved });
}

export function syncReaderExternalTheme(): boolean {
  const mode = (state.reader.readingThemeMode || "bilibili") as ReaderThemeMode;
  if (mode !== "bilibili" && mode !== "system") {
    return false;
  }
  const next = resolveEffectiveTheme(mode);
  if (next === state.reader.readingTheme) {
    return false;
  }
  state.reader.setTheme(next);
  writeThemeSnapshot({
    mode,
    palette: state.reader.readingPalette || "flyme",
    resolved: next
  });
  applyReadingViewPresentation();
  return true;
}

export function applyChatInputGlow(view?: HTMLElement | null): void {
  const readingView = view ?? getReaderElement(ids.readingView);
  if (!readingView) {
    return;
  }
  const enabled = normalizeChatInputGlow(state.settings?.chatInputGlow);
  if (enabled) {
    delete readingView.dataset.chatInputGlow;
  } else {
    readingView.dataset.chatInputGlow = "0";
  }
}

export function applyReduceTransparency(view?: HTMLElement | null): void {
  const readingView = view ?? getReaderElement(ids.readingView);
  if (!readingView) {
    return;
  }
  if (normalizeReduceTransparency(state.settings?.reduceTransparency)) {
    readingView.dataset.biliscriptReduceTransparency = "1";
  } else {
    delete readingView.dataset.biliscriptReduceTransparency;
  }
}

export function applyReadingViewTypography(view?: HTMLElement | null): void {
  const readingView = view ?? getReaderElement(ids.readingView);
  if (!readingView) {
    return;
  }
  const fontScale = normalizeReaderFontSizeScale(state.settings?.readerFontSizeScale);
  const lineHeight = normalizeChatLineHeight(state.settings?.chatLineHeight);
  const paraSpacing = normalizeChatParagraphSpacing(state.settings?.chatParagraphSpacing);

  readingView.style.setProperty("--biliscript-reader-font-scale", String(fontScale / 100));
  readingView.style.setProperty("--biliscript-chat-line-height", String(lineHeight / 100));
  readingView.style.setProperty("--biliscript-chat-paragraph-spacing", `${paraSpacing}px`);
}

export function applyReadingViewPresentation() {
  const readingView = getReaderElement(ids.readingView);
  const values: Record<string, string> = {};
  for (const field of READER_APPLY_FIELDS) {
    values[field.id] = field.readValue!(state.reader);
  }
  for (const field of READER_APPLY_FIELDS) {
    if (field.targets.readingView && field.datasetKeys.readingView) {
      readingView.dataset[field.datasetKeys.readingView] = values[field.id];
    }
  }
  for (const field of READER_APPLY_FIELDS) {
    if (field.targets.html && field.datasetKeys.html) {
      document.documentElement.dataset[field.datasetKeys.html] = values[field.id];
    }
  }
  for (const field of READER_APPLY_FIELDS) {
    if (field.targets.body && field.datasetKeys.body) {
      document.body.dataset[field.datasetKeys.body] = values[field.id];
    }
  }
  applyReadingViewTypography(readingView);
  applyChatInputGlow(readingView);
  applyReduceTransparency(readingView);
  refreshThemeButton();
  hydrateMermaid(readingView, { force: true });
}
