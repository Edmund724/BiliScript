import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { EXPECTED_DETACH_BTN_ID } from "./detached-contracts.js";
import type { DetachedE2EHarness } from "./detached-e2e-harness.js";
import type { FakeDetachedWindow } from "./detached-window-fake.js";

export const HEADER_BUTTON_IDS = [
  EXPECTED_DETACH_BTN_ID,
  "biliscript-reading-theme-select",
  "biliscript-reading-settings-btn",
  "biliscript-reading-close-btn"
] as const;

export function assertHeaderButtonOrder(doc: Document): HTMLButtonElement[] {
  const actions = doc.querySelector(".biliscript-reading-actions");
  expect(actions).not.toBeNull();
  const buttons = Array.from(actions?.querySelectorAll<HTMLButtonElement>(":scope > button") ?? []);
  expect(buttons).toHaveLength(4);
  expect(buttons.map((btn) => btn.id)).toEqual([...HEADER_BUTTON_IDS]);
  return buttons;
}

export function getMirroredStyleHrefs(doc: Document): string[] {
  return Array.from(doc.head.querySelectorAll<HTMLStyleElement>('style[data-biliscript-style="1"]')).map(
    (style) => style.dataset.biliscriptStylePath ?? ""
  );
}

export function assertStyleLinksPresent(doc: Document, suffixes: string[]): void {
  expect(doc.querySelectorAll('link[data-biliscript-style="1"]')).toHaveLength(0);
  const paths = getMirroredStyleHrefs(doc);
  for (const suffix of suffixes) {
    expect(paths.some((path) => path.endsWith(suffix)), `missing stylesheet ${suffix}`).toBe(true);
  }
}

export function findUnwrappedScrollbarRules(cssRelativePath: string): string[] {
  const raw = readFileSync(join(process.cwd(), cssRelativePath), "utf8");
  const lines = raw.split(/\r?\n/);
  const violations: string[] = [];
  let braceDepth = 0;
  let supportsDepth: number | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/@supports\s*\([^)]*-moz-appearance\s*:\s*none[^)]*\)/.test(line)) {
      supportsDepth = braceDepth + 1;
    }
    if (/scrollbar-(?:width|color)\s*:/.test(line) && supportsDepth === null) {
      violations.push(`${cssRelativePath}:${i + 1}:${line.trim()}`);
    }
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    braceDepth += opens - closes;
    if (supportsDepth !== null && braceDepth < supportsDepth) {
      supportsDepth = null;
    }
  }
  return violations;
}

export async function openCommandPaletteInDoc(
  harness: DetachedE2EHarness,
  doc: Document
): Promise<HTMLDialogElement | null> {
  doc.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })
  );
  await harness.flushTimersAndMicrotasks(60);
  const palette = doc.getElementById("biliscript-command-palette") as HTMLDialogElement | null;
  if (!palette) {
    return null;
  }
  const isOpen = Boolean(palette.open || palette.hasAttribute("open"));
  return isOpen ? palette : null;
}

export async function dispatchEscapeInDoc(harness: DetachedE2EHarness, doc: Document): Promise<void> {
  doc.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true
    })
  );
  await harness.flushTimersAndMicrotasks(60);
}

export async function setSettingsSelectValue(
  harness: DetachedE2EHarness,
  doc: Document,
  id: string,
  value: string
): Promise<HTMLSelectElement> {
  const select = doc.getElementById(id) as HTMLSelectElement | null;
  expect(select).not.toBeNull();
  if (!select) {
    throw new Error(`Missing select #${id}`);
  }
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await harness.flushStyles([doc]);
  await harness.flushTimersAndMicrotasks(80);
  return select;
}

export async function setSettingsCheckboxValue(
  harness: DetachedE2EHarness,
  doc: Document,
  id: string,
  checked: boolean
): Promise<HTMLInputElement> {
  const input = doc.getElementById(id) as HTMLInputElement | null;
  expect(input).not.toBeNull();
  if (!input) {
    throw new Error(`Missing checkbox #${id}`);
  }
  input.checked = checked;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await harness.flushTimersAndMicrotasks(80);
  return input;
}

export async function setSettingsRangeValue(
  harness: DetachedE2EHarness,
  doc: Document,
  id: string,
  value: number
): Promise<HTMLInputElement> {
  const input = doc.getElementById(id) as HTMLInputElement | null;
  expect(input).not.toBeNull();
  if (!input) {
    throw new Error(`Missing range #${id}`);
  }
  input.value = String(value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await harness.flushTimersAndMicrotasks(80);
  return input;
}

export async function clickResetAndSettle(
  harness: DetachedE2EHarness,
  doc: Document,
  confirm: boolean
): Promise<void> {
  const resetBtn = doc.getElementById("biliscriptSettingsResetBtn") as HTMLButtonElement | null;
  expect(resetBtn).not.toBeNull();
  resetBtn?.click();
  await harness.flushTimersAndMicrotasks(40);
  const selector = confirm ? ".confirm-dialog-confirm" : ".confirm-dialog-cancel";
  const dialogBtn = doc.querySelector<HTMLButtonElement>(selector);
  expect(dialogBtn).not.toBeNull();
  dialogBtn?.click();
  await harness.flushTimersAndMicrotasks(120);
}

export async function triggerSubtitleSelection(
  harness: DetachedE2EHarness,
  doc: Document,
  win: Window | FakeDetachedWindow
): Promise<void> {
  const itemText = doc.querySelector<HTMLElement>("#biliscript-reading-subtitle [data-seconds] .biliscript-reading-text");
  expect(itemText).not.toBeNull();
  if (!itemText) {
    return;
  }
  const range = doc.createRange();
  range.selectNodeContents(itemText);
  const sel = win.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  doc.dispatchEvent(new Event("selectionchange"));
  await harness.flushTimersAndMicrotasks(60);
}

export function clearWinSelection(win: Window | FakeDetachedWindow): void {
  win.getSelection()?.removeAllRanges();
}

export function getFirstSubtitleItem(doc: Document, index = 1): HTMLElement | null {
  const items = Array.from(doc.querySelectorAll<HTMLElement>("#biliscript-reading-subtitle [data-seconds]"));
  return items[index] ?? items[0] ?? null;
}

export function getFirstOverviewChapter(doc: Document, index = 1): HTMLElement | null {
  const items = Array.from(doc.querySelectorAll<HTMLElement>("#biliscript-reading-overview-body [data-seconds]"));
  return items[index] ?? items[0] ?? null;
}

export function assertZeroUnwrappedScrollbars(paths: string[]): void {
  const violations = paths.flatMap((p) => findUnwrappedScrollbarRules(p));
  expect(violations).toEqual([]);
}

export function assertMirroredStylesWithoutExtensionLinks(doc: Document): void {
  expect(doc.querySelectorAll('link[data-biliscript-style="1"]')).toHaveLength(0);
  expect(doc.querySelectorAll('link[href^="chrome-extension://"], link[href^="moz-extension://"]')).toHaveLength(0);
  const styles = Array.from(doc.head.querySelectorAll<HTMLStyleElement>('style[data-biliscript-style="1"]'));
  expect(styles.length).toBeGreaterThan(0);
  expect(styles.every((style) => (style.dataset.biliscriptStylePath ?? "").startsWith("entry/styles/"))).toBe(true);
}

export async function openExplainCardFromSelection(
  harness: DetachedE2EHarness,
  doc: Document,
  win: Window | FakeDetachedWindow
): Promise<HTMLElement | null> {
  await triggerSubtitleSelection(harness, doc, win);
  const btn = doc.querySelector<HTMLButtonElement>('#biliscript-reading-explain-pop [data-selection-action="explain"]');
  expect(btn).not.toBeNull();
  btn?.click();
  await harness.flushTimersAndMicrotasks(80);
  return doc.getElementById("biliscript-reading-explain-card");
}

export async function openQuoteShareModalInDoc(harness: DetachedE2EHarness, doc: Document): Promise<HTMLElement | null> {
  const { openQuoteShareModal } = await import("../../../extension/reader/quote-share-modal.js");
  openQuoteShareModal({ content: "测试金句卡片内容" });
  await harness.flushTimersAndMicrotasks(60);
  return doc.querySelector<HTMLElement>(".biliscript-quote-share-dialog");
}

export async function triggerPlayerAiQuickAction(
  harness: DetachedE2EHarness,
  prompt: string
): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve) => {
    chrome.runtime.sendMessage({ type: "player-ai-quick-action", prompt }, (resp) => {
      resolve((resp ?? { ok: true }) as Record<string, unknown>);
    });
  }).then(async (resp) => {
    await harness.flushStyles();
    await harness.flushTimersAndMicrotasks(100);
    return resp;
  });
}

export function getWindowPrototypeDescriptorSnapshot(): {
  hasDocumentGetter: boolean;
  docBodyOwnDesc: PropertyDescriptor | undefined;
} {
  return {
    hasDocumentGetter: typeof Object.getOwnPropertyDescriptor(Window.prototype, "document")?.get === "function"
      || Object.prototype.hasOwnProperty.call(window, "document"),
    docBodyOwnDesc: Object.getOwnPropertyDescriptor(document, "body")
  };
}

export function getReadingViewAnchorVars(readingView: HTMLElement): string[] {
  return ["--biliscript-script-left", "--biliscript-script-top", "--biliscript-script-width", "--biliscript-script-height"]
    .map((prop) => readingView.style.getPropertyValue(prop))
    .filter((v) => v !== "");
}

