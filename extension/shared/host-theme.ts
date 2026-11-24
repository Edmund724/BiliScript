import type { Settings } from "../core/defaults.js";
import type { ReaderThemeMode } from "../core/validators.js";

export type ResolvedReaderTheme = "light" | "dark";

export interface ThemeSnapshot {
  mode: ReaderThemeMode;
  palette: string;
  resolved: ResolvedReaderTheme;
}

export const THEME_SNAPSHOT_STORAGE_KEY = "biliscript_theme_snapshot_v1";

const DARK_CLASS_TOKENS = new Set([
  "dark",
  "bili-dark",
  "bilibili-dark",
  "bewly-dark",
  "night-mode",
  "theme-dark"
]);

const LIGHT_CLASS_TOKENS = new Set([
  "light",
  "bili-light",
  "theme-light"
]);

const HOST_THEME_OBSERVED_ATTRS = [
  "class",
  "dark",
  "data-theme",
  "data-dark",
  "data-bili-theme",
  "data-color-scheme",
  "data-darkreader-scheme",
  "style"
];

export function detectSystemTheme(): ResolvedReaderTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function normalizeSignalValue(raw: string | null | undefined): ResolvedReaderTheme | null {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return null;
  if (value === "dark" || value === "night" || value === "true" || value === "1") {
    return "dark";
  }
  if (value === "light" || value === "day" || value === "false" || value === "0") {
    return "light";
  }
  return null;
}

function detectBooleanDarkAttribute(el: Element): ResolvedReaderTheme | null {
  if (!el.hasAttribute("dark")) return null;
  const raw = String(el.getAttribute("dark") ?? "").trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "light") {
    return "light";
  }
  return "dark";
}

function detectFromElementAttributes(el: Element | null): ResolvedReaderTheme | null {
  if (!el) return null;

  const boolDark = detectBooleanDarkAttribute(el);
  if (boolDark) return boolDark;

  const attrNames = [
    "data-dark",
    "data-theme",
    "data-bili-theme",
    "data-color-scheme",
    "data-darkreader-scheme"
  ];
  for (const attr of attrNames) {
    const signal = normalizeSignalValue(el.getAttribute(attr));
    if (signal) return signal;
  }

  if (el.classList && el.classList.length > 0) {
    let sawLight = false;
    for (const token of el.classList) {
      const lower = token.toLowerCase();
      if (DARK_CLASS_TOKENS.has(lower)) {
        return "dark";
      }
      if (LIGHT_CLASS_TOKENS.has(lower)) {
        sawLight = true;
      }
    }
    if (sawLight) {
      return "light";
    }
  }

  if (el instanceof HTMLElement) {
    const scheme = (el.style?.colorScheme || "").trim().toLowerCase();
    if (scheme === "dark") return "dark";
    if (scheme === "light") return "light";
  }

  return null;
}

function srgbChannelToLinear(channel255: number): number {
  const s = Math.min(1, Math.max(0, channel255 / 255));
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function parseColorLuminance(raw: string | null | undefined): number | null {
  const value = String(raw || "").trim().toLowerCase();
  if (!value || value === "transparent" || value === "none" || value === "inherit" || value === "initial") {
    return null;
  }

  const rgbMatch = value.match(
    /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/
  );
  if (rgbMatch) {
    const alphaRaw = rgbMatch[4];
    if (alphaRaw !== undefined) {
      const alpha = alphaRaw.endsWith("%") ? parseFloat(alphaRaw) / 100 : parseFloat(alphaRaw);
      if (!Number.isFinite(alpha) || alpha < 0.1) return null;
    }
    const r = srgbChannelToLinear(parseFloat(rgbMatch[1]));
    const g = srgbChannelToLinear(parseFloat(rgbMatch[2]));
    const b = srgbChannelToLinear(parseFloat(rgbMatch[3]));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const hexMatch = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hexMatch) {
    const hex = hexMatch[1];
    let r255 = 0;
    let g255 = 0;
    let b255 = 0;
    if (hex.length === 3) {
      r255 = parseInt(hex[0] + hex[0], 16);
      g255 = parseInt(hex[1] + hex[1], 16);
      b255 = parseInt(hex[2] + hex[2], 16);
    } else {
      r255 = parseInt(hex.slice(0, 2), 16);
      g255 = parseInt(hex.slice(2, 4), 16);
      b255 = parseInt(hex.slice(4, 6), 16);
      if (hex.length === 8) {
        const a = parseInt(hex.slice(6, 8), 16) / 255;
        if (a < 0.1) return null;
      }
    }
    const r = srgbChannelToLinear(r255);
    const g = srgbChannelToLinear(g255);
    const b = srgbChannelToLinear(b255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const oklchMatch = value.match(
    /^oklch\(\s*([\d.]+%?)\s+[\d.]+\s+[\d.a-z]+(?:\s*\/\s*([\d.]+%?))?\s*\)$/
  );
  if (oklchMatch) {
    const alphaRaw = oklchMatch[2];
    if (alphaRaw !== undefined) {
      const alpha = alphaRaw.endsWith("%") ? parseFloat(alphaRaw) / 100 : parseFloat(alphaRaw);
      if (!Number.isFinite(alpha) || alpha < 0.1) return null;
    }
    const lRaw = oklchMatch[1];
    const l = lRaw.endsWith("%") ? parseFloat(lRaw) / 100 : parseFloat(lRaw);
    if (!Number.isFinite(l)) return null;
    return Math.pow(Math.min(1, Math.max(0, l)), 3);
  }

  return null;
}

function detectFromComputedSurface(doc: Document): ResolvedReaderTheme | null {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") {
    return null;
  }
  const html = doc.documentElement;
  const body = doc.body;
  const candidates: Array<string | null> = [];
  try {
    if (html) {
      const htmlStyle = window.getComputedStyle(html);
      candidates.push(
        htmlStyle.getPropertyValue("--bew-bg"),
        htmlStyle.getPropertyValue("--bg1"),
        htmlStyle.backgroundColor
      );
    }
    if (body) {
      const bodyStyle = window.getComputedStyle(body);
      candidates.push(bodyStyle.backgroundColor);
    }
  } catch {
    return null;
  }

  for (const raw of candidates) {
    const lum = parseColorLuminance(raw);
    if (lum === null) continue;
    if (lum < 0.25) return "dark";
    if (lum > 0.75) return "light";
  }
  return null;
}

export function detectBilibiliHostTheme(doc: Document = document): ResolvedReaderTheme | null {
  if (!doc || !doc.documentElement) {
    return null;
  }
  if (doc.documentElement.getAttribute("data-biliscript-onboarding") === "1") {
    return null;
  }

  const fromHtml = detectFromElementAttributes(doc.documentElement);
  if (fromHtml) return fromHtml;

  const fromBody = detectFromElementAttributes(doc.body);
  if (fromBody) return fromBody;

  return detectFromComputedSurface(doc);
}

export const detectHostTheme = detectBilibiliHostTheme;

export function resolveReaderThemeMode(
  settings?: Pick<Partial<Settings>, "readerTheme" | "readerThemeUserSet"> | null
): ReaderThemeMode {
  const raw = settings?.readerTheme;
  if (raw === "bilibili" || raw === "system") {
    return raw;
  }
  if ((raw === "light" || raw === "dark") && settings?.readerThemeUserSet === true) {
    return raw;
  }
  return "bilibili";
}

export function resolveEffectiveTheme(
  mode: ReaderThemeMode,
  doc: Document = document
): ResolvedReaderTheme {
  if (mode === "light" || mode === "dark") {
    return mode;
  }
  if (mode === "system") {
    return detectSystemTheme();
  }
  return detectBilibiliHostTheme(doc) ?? detectSystemTheme();
}

export function readThemeSnapshot(): ThemeSnapshot | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    const raw = window.localStorage.getItem(THEME_SNAPSHOT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ThemeSnapshot> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const mode: ReaderThemeMode =
      parsed.mode === "bilibili" ||
      parsed.mode === "system" ||
      parsed.mode === "light" ||
      parsed.mode === "dark"
        ? parsed.mode
        : "bilibili";
    const palette = parsed.palette === "editorial" ? "editorial" : "flyme";
    const resolved: ResolvedReaderTheme = parsed.resolved === "dark" ? "dark" : "light";
    return { mode, palette, resolved };
  } catch {
    return null;
  }
}

export function writeThemeSnapshot(snapshot: ThemeSnapshot): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    window.localStorage.setItem(THEME_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
  }
}

export function applyPrePaintReaderTheme(
  settings?: Partial<Settings> | null,
  doc: Document = document,
  readingViewId = "biliscript-reading-view"
): { mode: ReaderThemeMode; theme: ResolvedReaderTheme; palette: string } {
  const snapshot = readThemeSnapshot();
  const hasSettings = Boolean(
    settings && (settings.readerTheme !== undefined || settings.readerThemeUserSet !== undefined)
  );
  const mode = hasSettings ? resolveReaderThemeMode(settings) : (snapshot?.mode ?? "bilibili");
  const palette =
    settings?.readerPalette === "editorial"
      ? "editorial"
      : settings?.readerPalette === "flyme"
        ? "flyme"
        : (snapshot?.palette ?? "flyme");
  const theme = resolveEffectiveTheme(mode, doc);

  if (doc.documentElement) {
    doc.documentElement.dataset.biliscriptReaderTheme = theme;
    doc.documentElement.dataset.biliscriptReaderPalette = palette;
  }
  if (doc.body) {
    doc.body.dataset.biliscriptReaderTheme = theme;
    doc.body.dataset.biliscriptReaderPalette = palette;
  }
  const readingView = doc.getElementById(readingViewId);
  if (readingView) {
    readingView.dataset.theme = theme;
    readingView.dataset.palette = palette;
  }

  return { mode, theme, palette };
}

export function watchExternalThemeChanges(
  onChange: () => void,
  options: { doc?: Document; signal?: AbortSignal } = {}
): () => void {
  const doc = options.doc ?? document;
  const signal = options.signal;
  if (signal?.aborted) {
    return () => {};
  }

  let disposed = false;
  let scheduled = false;
  const notify = () => {
    if (disposed) return;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!disposed) {
        onChange();
      }
    });
  };

  let media: MediaQueryList | null = null;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    try {
      media = window.matchMedia("(prefers-color-scheme: dark)");
      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", notify);
      } else if (typeof media.addListener === "function") {
        media.addListener(notify);
      }
    } catch {
      media = null;
    }
  }

  let observer: MutationObserver | null = null;
  const isStandaloneExtensionPage =
    doc?.documentElement?.getAttribute("data-biliscript-onboarding") === "1";
  if (!isStandaloneExtensionPage && typeof MutationObserver === "function" && doc?.documentElement) {
    observer = new MutationObserver(notify);
    const observeOpts: MutationObserverInit = {
      attributes: true,
      attributeFilter: HOST_THEME_OBSERVED_ATTRS
    };
    observer.observe(doc.documentElement, observeOpts);
    if (doc.body) {
      observer.observe(doc.body, observeOpts);
    }
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (media) {
      if (typeof media.removeEventListener === "function") {
        media.removeEventListener("change", notify);
      } else if (typeof media.removeListener === "function") {
        media.removeListener(notify);
      }
      media = null;
    }
    signal?.removeEventListener("abort", dispose);
  };

  signal?.addEventListener("abort", dispose, { once: true });
  return dispose;
}
