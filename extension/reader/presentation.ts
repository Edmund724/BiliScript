import { state } from "../core/state.js";
import { type Settings } from "../core/defaults.js";
import {
  activeById,
  getActiveReaderDocument,
  getOpenerDocument,
  isReaderDetached
} from "../shared/active-host.js";
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
import { refreshThemeButton, themeButtonView } from "../ui/theme-button.js";
import { hydrateMermaid } from "../ui/lazy-mermaid.js";
import { READER_APPLY_FIELDS } from "./presentation-fields.js";

export function hydrateReaderStateFromSettings(settings: Partial<Settings> = state.settings) {
  const palette = normalizeReaderPalette(settings?.readerPalette);
  const mode = resolveReaderThemeMode(settings);
  const resolved = resolveEffectiveTheme(mode, getOpenerDocument());
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
  const next = resolveEffectiveTheme(mode, getOpenerDocument());
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

function setGlowDataset(el: HTMLElement | null | undefined, enabled: boolean): void {
  if (!el) return;
  if (enabled) {
    delete el.dataset.chatInputGlow;
  } else {
    el.dataset.chatInputGlow = "0";
  }
}

function setReduceTransparencyDataset(el: HTMLElement | null | undefined, enabled: boolean): void {
  if (!el) return;
  if (enabled) {
    el.dataset.biliscriptReduceTransparency = "1";
  } else {
    delete el.dataset.biliscriptReduceTransparency;
  }
}

function setTypographyVars(
  el: HTMLElement | null | undefined,
  fontScale: number,
  lineHeight: number,
  paraSpacing: number
): void {
  if (!el) return;
  el.style.setProperty("--biliscript-reader-font-scale", String(fontScale / 100));
  el.style.setProperty("--biliscript-chat-line-height", String(lineHeight / 100));
  el.style.setProperty("--biliscript-chat-paragraph-spacing", `${paraSpacing}px`);
}

export function applyChatInputGlow(view?: HTMLElement | null): void {
  const readingView = view ?? activeById(ids.readingView);
  if (!readingView) {
    return;
  }
  const enabled = normalizeChatInputGlow(state.settings?.chatInputGlow);
  setGlowDataset(readingView, enabled);
  if (isReaderDetached()) {
    setGlowDataset(getActiveReaderDocument().documentElement, enabled);
  }
}

export function applyReduceTransparency(view?: HTMLElement | null): void {
  const readingView = view ?? activeById(ids.readingView);
  if (!readingView) {
    return;
  }
  const enabled = normalizeReduceTransparency(state.settings?.reduceTransparency);
  setReduceTransparencyDataset(readingView, enabled);
  if (isReaderDetached()) {
    setReduceTransparencyDataset(getActiveReaderDocument().documentElement, enabled);
  }
}

export function applyReadingViewTypography(view?: HTMLElement | null): void {
  const readingView = view ?? activeById(ids.readingView);
  if (!readingView) {
    return;
  }
  const fontScale = normalizeReaderFontSizeScale(state.settings?.readerFontSizeScale);
  const lineHeight = normalizeChatLineHeight(state.settings?.chatLineHeight);
  const paraSpacing = normalizeChatParagraphSpacing(state.settings?.chatParagraphSpacing);

  setTypographyVars(readingView, fontScale, lineHeight, paraSpacing);
  if (isReaderDetached()) {
    setTypographyVars(getActiveReaderDocument().documentElement, fontScale, lineHeight, paraSpacing);
  }
}

export function mirrorPresentationToDocument(targetDoc: Document): void {
  const values: Record<string, string> = {};
  for (const field of READER_APPLY_FIELDS) {
    values[field.id] = field.readValue!(state.reader);
  }
  for (const field of READER_APPLY_FIELDS) {
    if (field.targets.html && field.datasetKeys.html && targetDoc.documentElement) {
      targetDoc.documentElement.dataset[field.datasetKeys.html] = values[field.id];
    }
    if (field.targets.body && field.datasetKeys.body && targetDoc.body) {
      targetDoc.body.dataset[field.datasetKeys.body] = values[field.id];
    }
  }
  if (targetDoc !== getOpenerDocument()) {
    targetDoc.documentElement?.setAttribute("data-biliscript-reader-mode", "1");
    targetDoc.documentElement?.setAttribute("data-biliscript-detached", "1");
    targetDoc.body?.setAttribute("data-biliscript-reader-mode", "1");
    targetDoc.body?.setAttribute("data-biliscript-reading-active", "1");
    targetDoc.body?.setAttribute("data-biliscript-detached", "1");
    setGlowDataset(
      targetDoc.documentElement,
      normalizeChatInputGlow(state.settings?.chatInputGlow)
    );
    setReduceTransparencyDataset(
      targetDoc.documentElement,
      normalizeReduceTransparency(state.settings?.reduceTransparency)
    );
    setTypographyVars(
      targetDoc.documentElement,
      normalizeReaderFontSizeScale(state.settings?.readerFontSizeScale),
      normalizeChatLineHeight(state.settings?.chatLineHeight),
      normalizeChatParagraphSpacing(state.settings?.chatParagraphSpacing)
    );
  }
}

function syncDetachedThemeButton(): void {
  const button = activeById(ids.readingThemeSelect);
  if (!button) {
    return;
  }
  const view = themeButtonView(state.reader.readingTheme, state.reader.readingThemeMode);
  button.innerHTML = view.icon;
  button.title = `主题：${view.title}`;
  button.setAttribute("aria-label", `主题：${view.title}`);
}

export function applyReadingViewPresentation() {
  const openerDoc = getOpenerDocument();
  const activeDoc = getActiveReaderDocument();
  const readingView = activeById(ids.readingView);
  const values: Record<string, string> = {};
  for (const field of READER_APPLY_FIELDS) {
    values[field.id] = field.readValue!(state.reader);
  }
  if (readingView) {
    for (const field of READER_APPLY_FIELDS) {
      if (field.targets.readingView && field.datasetKeys.readingView) {
        readingView.dataset[field.datasetKeys.readingView] = values[field.id];
      }
    }
  }
  for (const field of READER_APPLY_FIELDS) {
    if (field.targets.html && field.datasetKeys.html && openerDoc.documentElement) {
      openerDoc.documentElement.dataset[field.datasetKeys.html] = values[field.id];
    }
  }
  for (const field of READER_APPLY_FIELDS) {
    if (field.targets.body && field.datasetKeys.body && openerDoc.body) {
      openerDoc.body.dataset[field.datasetKeys.body] = values[field.id];
    }
  }
  if (activeDoc !== openerDoc) {
    mirrorPresentationToDocument(activeDoc);
  }
  applyReadingViewTypography(readingView);
  applyChatInputGlow(readingView);
  applyReduceTransparency(readingView);
  refreshThemeButton();
  if (activeDoc !== openerDoc) {
    syncDetachedThemeButton();
  }
  if (readingView) {
    hydrateMermaid(readingView, { force: true });
  }
}
