export const SHORTCUT_ACTION_IDS = [
  "toggleReader",
  "generateOverview",
  "commandPalette",
  "subtitleSearch",
  "openSettings",
  "toggleTheme",
  "toggleDetachedWindow",
  "generateVideoNote",
  "copyNote",
  "downloadNote",
  "exportObsidian"
] as const;

export type ShortcutActionId = (typeof SHORTCUT_ACTION_IDS)[number];

export type ShortcutBindings = Record<ShortcutActionId, string>;

export const DEFAULT_SHORTCUTS: Readonly<ShortcutBindings> = Object.freeze({
  toggleReader: "Alt+B",
  generateOverview: "Alt+G",
  commandPalette: "Mod+K",
  subtitleSearch: "Mod+F",
  openSettings: "",
  toggleTheme: "",
  toggleDetachedWindow: "",
  generateVideoNote: "",
  copyNote: "",
  downloadNote: "",
  exportObsidian: ""
});

const MODIFIER_KEYS = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "OS",
  "AltGraph"
]);

const CODE_TO_KEY: Readonly<Record<string, string>> = Object.freeze({
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Space: "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown"
});

const KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  " ": "Space",
  space: "Space",
  spacebar: "Space",
  arrowup: "Up",
  up: "Up",
  arrowdown: "Down",
  down: "Down",
  arrowleft: "Left",
  left: "Left",
  arrowright: "Right",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  comma: ",",
  period: ".",
  slash: "/",
  semicolon: ";",
  quote: "'",
  bracketleft: "[",
  bracketright: "]",
  backslash: "\\",
  minus: "-",
  equal: "=",
  backquote: "`"
});

const ALLOWED_PUNCTUATION = new Set([",", ".", "/", ";", "'", "[", "]", "\\", "-", "=", "`"]);

const FUNCTION_KEY_RE = /^F([1-9]|1[0-2])$/;

const SHORTCUT_RECORDING_SLOT = "__BILISCRIPT_SHORTCUT_RECORDING__";

export function isShortcutRecordingActive(): boolean {
  return Boolean((globalThis as Record<string, unknown>)[SHORTCUT_RECORDING_SLOT]);
}

export function setShortcutRecordingActive(active: boolean): void {
  (globalThis as Record<string, unknown>)[SHORTCUT_RECORDING_SLOT] = active;
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  const el = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    getAttribute?: (name: string) => string | null;
    closest?: (selector: string) => Element | null;
  } | null;
  if (!el || typeof el !== "object") return false;
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  if (el.isContentEditable === true || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  const ce = el.getAttribute?.("contenteditable");
  if (ce === "" || ce === "true" || ce === "plaintext-only") return true;
  return Boolean(el.closest?.("input,textarea,select,[contenteditable]:not([contenteditable=false])"));
}

export interface ParsedShortcutCombo {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

export type CapturedShortcutResult =
  | { status: "ok"; combo: string }
  | { status: "ignore" }
  | { status: "cancel" }
  | { status: "clear" }
  | { status: "invalid"; reason: string };

export function isMacShortcutPlatform(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
}

export function isFunctionShortcutKey(key: string): boolean {
  return FUNCTION_KEY_RE.test(key);
}

function normalizePrimaryKeyToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length === 1) {
    const upper = trimmed.toUpperCase();
    if (/^[A-Z0-9]$/.test(upper) || ALLOWED_PUNCTUATION.has(trimmed)) {
      return upper;
    }
    return null;
  }
  const upper = trimmed.toUpperCase();
  if (FUNCTION_KEY_RE.test(upper)) {
    return upper;
  }
  const alias = KEY_ALIASES[trimmed.toLowerCase()];
  return alias ?? null;
}

function extractEventPrimaryKey(event: Pick<KeyboardEvent, "code" | "key">): string | null {
  const code = typeof event.code === "string" ? event.code : "";
  if (code) {
    if (/^Key[A-Z]$/.test(code)) {
      return code.slice(3);
    }
    if (/^Digit[0-9]$/.test(code)) {
      return code.slice(5);
    }
    if (/^Numpad[0-9]$/.test(code)) {
      return code.slice(6);
    }
    if (FUNCTION_KEY_RE.test(code)) {
      return code;
    }
    const mapped = CODE_TO_KEY[code];
    if (mapped) {
      return mapped;
    }
  }
  const key = typeof event.key === "string" ? event.key : "";
  if (!key) {
    return null;
  }
  return normalizePrimaryKeyToken(key);
}

function formatCanonicalCombo(parsed: ParsedShortcutCombo): string {
  const parts: string[] = [];
  if (parsed.mod) parts.push("Mod");
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  if (parsed.meta) parts.push("Meta");
  parts.push(parsed.key);
  return parts.join("+");
}

function hasRequiredModifierOrFunctionKey(parsed: ParsedShortcutCombo): boolean {
  return parsed.mod || parsed.ctrl || parsed.alt || parsed.meta || isFunctionShortcutKey(parsed.key);
}

export function parseShortcutCombo(raw: unknown): ParsedShortcutCombo | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  const parsed: ParsedShortcutCombo = {
    mod: false,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    key: ""
  };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "mod" || lower === "cmdorctrl" || lower === "commandorcontrol" || lower === "primary") {
      parsed.mod = true;
      continue;
    }
    if (lower === "ctrl" || lower === "control" || lower === "macctrl") {
      parsed.ctrl = true;
      continue;
    }
    if (lower === "alt" || lower === "option" || lower === "opt") {
      parsed.alt = true;
      continue;
    }
    if (lower === "shift") {
      parsed.shift = true;
      continue;
    }
    if (lower === "meta" || lower === "cmd" || lower === "command" || lower === "win" || lower === "super") {
      parsed.meta = true;
      continue;
    }
    if (parsed.key) {
      return null;
    }
    const key = normalizePrimaryKeyToken(part);
    if (!key) {
      return null;
    }
    parsed.key = key;
  }
  if (!parsed.key || !hasRequiredModifierOrFunctionKey(parsed)) {
    return null;
  }
  return parsed;
}

export function normalizeShortcutCombo(raw: unknown): string | null {
  if (raw === "") {
    return "";
  }
  if (typeof raw !== "string") {
    return null;
  }
  if (!raw.trim()) {
    return "";
  }
  const parsed = parseShortcutCombo(raw);
  if (!parsed) {
    return null;
  }
  return formatCanonicalCombo(parsed);
}

export function normalizeShortcuts(raw: unknown): ShortcutBindings {
  const result: ShortcutBindings = { ...DEFAULT_SHORTCUTS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return result;
  }
  const source = raw as Record<string, unknown>;
  for (const id of SHORTCUT_ACTION_IDS) {
    if (!(id in source)) {
      continue;
    }
    const normalized = normalizeShortcutCombo(source[id]);
    if (normalized !== null) {
      result[id] = normalized;
    }
  }
  return result;
}

export function resolveShortcuts(settings?: { shortcuts?: unknown } | null): ShortcutBindings {
  return normalizeShortcuts(settings?.shortcuts);
}

export function getShortcutBinding(
  settings: { shortcuts?: unknown } | null | undefined,
  actionId: ShortcutActionId
): string {
  const rawMap = settings?.shortcuts;
  if (rawMap && typeof rawMap === "object" && !Array.isArray(rawMap) && actionId in rawMap) {
    const normalized = normalizeShortcutCombo((rawMap as Record<string, unknown>)[actionId]);
    if (normalized !== null) {
      return normalized;
    }
  }
  return DEFAULT_SHORTCUTS[actionId];
}

export function matchShortcutEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "isComposing" | "keyCode">,
  combo: string
): boolean {
  if (!combo || event.isComposing || event.key === "Process" || event.keyCode === 229) {
    return false;
  }
  const parsed = parseShortcutCombo(combo);
  if (!parsed) {
    return false;
  }
  if (Boolean(event.altKey) !== parsed.alt || Boolean(event.shiftKey) !== parsed.shift) {
    return false;
  }
  const ctrl = Boolean(event.ctrlKey);
  const meta = Boolean(event.metaKey);
  if (parsed.mod) {
    if (parsed.ctrl) {
      if (!ctrl || !meta) {
        return false;
      }
    } else if (parsed.meta) {
      if (!meta || ctrl) {
        return false;
      }
    } else if (ctrl === meta) {
      return false;
    }
  } else {
    if (ctrl !== parsed.ctrl || meta !== parsed.meta) {
      return false;
    }
  }
  const eventKey = extractEventPrimaryKey(event);
  return eventKey === parsed.key;
}

export function areShortcutCombosEquivalent(
  a: string,
  b: string,
  isMac = isMacShortcutPlatform()
): boolean {
  const pa = parseShortcutCombo(a);
  const pb = parseShortcutCombo(b);
  if (!pa || !pb) {
    return false;
  }
  const aCtrl = pa.ctrl || (!isMac && pa.mod);
  const aMeta = pa.meta || (isMac && pa.mod);
  const bCtrl = pb.ctrl || (!isMac && pb.mod);
  const bMeta = pb.meta || (isMac && pb.mod);
  return (
    aCtrl === bCtrl &&
    aMeta === bMeta &&
    pa.alt === pb.alt &&
    pa.shift === pb.shift &&
    pa.key === pb.key
  );
}

export function eventToShortcutCombo(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "isComposing" | "keyCode">,
  isMac = isMacShortcutPlatform()
): CapturedShortcutResult {
  if (event.isComposing || event.key === "Process" || event.keyCode === 229) {
    return { status: "ignore" };
  }
  if (MODIFIER_KEYS.has(event.key)) {
    return { status: "ignore" };
  }
  const hasAnyModifier = Boolean(event.ctrlKey || event.altKey || event.shiftKey || event.metaKey);
  if (!hasAnyModifier) {
    if (event.key === "Escape") {
      return { status: "cancel" };
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      return { status: "clear" };
    }
    if (event.key === "Tab" || event.key === "Enter") {
      return { status: "invalid", reason: "该按键不可设为快捷键" };
    }
  }
  if (event.key === "Escape" || event.key === "Tab" || event.key === "Enter" || event.key === "Backspace" || event.key === "Delete") {
    return { status: "invalid", reason: "该按键不可设为快捷键" };
  }
  const key = extractEventPrimaryKey(event);
  if (!key) {
    return { status: "invalid", reason: "该按键不支持设为快捷键" };
  }
  const parsed: ParsedShortcutCombo = {
    mod: isMac ? Boolean(event.metaKey) : Boolean(event.ctrlKey),
    ctrl: isMac ? Boolean(event.ctrlKey) : false,
    alt: Boolean(event.altKey),
    shift: Boolean(event.shiftKey),
    meta: isMac ? false : Boolean(event.metaKey),
    key
  };
  if (!hasRequiredModifierOrFunctionKey(parsed)) {
    return { status: "invalid", reason: "请搭配 Ctrl / Alt / ⌘，或使用 F1–F12 功能键" };
  }
  return { status: "ok", combo: formatCanonicalCombo(parsed) };
}

export function findShortcutConflict(
  bindings: ShortcutBindings,
  actionId: ShortcutActionId,
  candidateCombo: string,
  isMac = isMacShortcutPlatform()
): ShortcutActionId | null {
  if (!candidateCombo) {
    return null;
  }
  for (const id of SHORTCUT_ACTION_IDS) {
    if (id === actionId) {
      continue;
    }
    const existing = bindings[id];
    if (existing && areShortcutCombosEquivalent(existing, candidateCombo, isMac)) {
      return id;
    }
  }
  return null;
}

const DISPLAY_KEY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  Space: "Space"
});

export function formatShortcutTokens(
  combo: string,
  isMac = isMacShortcutPlatform()
): string[] {
  const parsed = parseShortcutCombo(combo);
  if (!parsed) {
    return [];
  }
  const tokens: string[] = [];
  if (isMac) {
    if (parsed.ctrl) tokens.push("⌃");
    if (parsed.alt) tokens.push("⌥");
    if (parsed.shift) tokens.push("⇧");
    if (parsed.mod || parsed.meta) tokens.push("⌘");
  } else {
    if (parsed.mod || parsed.ctrl) tokens.push("Ctrl");
    if (parsed.alt) tokens.push("Alt");
    if (parsed.shift) tokens.push("Shift");
    if (parsed.meta) tokens.push("Win");
  }
  tokens.push(DISPLAY_KEY_LABELS[parsed.key] ?? parsed.key);
  return tokens;
}

export function formatShortcutLabel(
  combo: string,
  isMac = isMacShortcutPlatform()
): string {
  const tokens = formatShortcutTokens(combo, isMac);
  if (tokens.length === 0) {
    return "未设置";
  }
  return isMac ? tokens.join("") : tokens.join("+");
}

export function countCustomizedShortcuts(bindings: ShortcutBindings): number {
  let count = 0;
  for (const id of SHORTCUT_ACTION_IDS) {
    if (bindings[id] !== DEFAULT_SHORTCUTS[id]) {
      count += 1;
    }
  }
  return count;
}

export function toShortcutOverrides(bindings: ShortcutBindings): Partial<ShortcutBindings> {
  const overrides: Partial<ShortcutBindings> = {};
  for (const id of SHORTCUT_ACTION_IDS) {
    if (bindings[id] !== DEFAULT_SHORTCUTS[id]) {
      overrides[id] = bindings[id];
    }
  }
  return overrides;
}
