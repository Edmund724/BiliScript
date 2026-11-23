// BILISCRIPT_DUAL_INSTANCE_STATEFUL
import { getActiveReaderDocument, getOpenerDocument } from "./active-host.js";

interface StyleInjectorSlots {
  mounted: Map<string, HTMLLinkElement>;
  mirrored: WeakMap<Document, Map<string, HTMLLinkElement>>;
  readerSettingsReady: Promise<void> | null;
}

const STYLE_SLOT_KEY = "__BILISCRIPT_STYLE_INJECTOR__";

function styleSlots(): StyleInjectorSlots {
  const host = globalThis as unknown as Record<string, StyleInjectorSlots | undefined>;
  return (host[STYLE_SLOT_KEY] ??= {
    mounted: new Map(),
    mirrored: new WeakMap(),
    readerSettingsReady: null
  });
}

function getReaderStylePaths(): string[] {
  return [
    "entry/styles/tokens-primitive.css",
    "entry/styles/reader.css",
    "entry/styles/reader-gate.css"
  ];
}

export async function ensureReaderStyles(): Promise<void> {
  await Promise.all(getReaderStylePaths().map((path) => waitForStyleLinkLoad(mountStyleLink(path))));
}

export function removeReaderStyles(): void {
  getReaderStylePaths().forEach((path) => unmountStyleLink(path));
}

export function ensurePlayerAiStyles(): void {
  mountStyleLink("entry/styles/player-ai.css");
}

export function ensureInterpretSubtitleStyles(): void {
  mountStyleLink("entry/styles/interpret-subtitles.css");
}

export function removePlayerAiStyles(): void {
  unmountStyleLink("entry/styles/player-ai.css");
}

const READER_SETTINGS_STYLE_PATHS = [
  "entry/styles/reader-settings-shell.css",
  "entry/styles/reader-settings-rows.css",
  "entry/styles/reader-settings-providers.css"
];

export function ensureReaderSettingsStyles(): void {
  const slots = styleSlots();
  const openerDoc = getOpenerDocument();
  const activeDoc = getActiveReaderDocument();
  const detached = activeDoc !== openerDoc;
  const isFirstMount = READER_SETTINGS_STYLE_PATHS.some((path) => !slots.mounted.get(path)?.isConnected);
  const needsDetachedMount =
    detached && READER_SETTINGS_STYLE_PATHS.some((path) => !hasReadyMirroredLink(activeDoc, path));
  const targetLinks = READER_SETTINGS_STYLE_PATHS.map((path) => mountStyleLink(path));
  if (!isFirstMount && !needsDetachedMount) {
    return;
  }
  slots.readerSettingsReady = Promise.all(targetLinks.map(waitForStyleLinkLoad)).then(() => {});
}

function waitForStyleLinkLoad(link: HTMLLinkElement | null): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => resolve();
    try {
      if (!link || link.sheet) {
        done();
        return;
      }
      link.addEventListener("load", done, { once: true });
      link.addEventListener("error", done, { once: true });
    } catch {
      done();
      return;
    }
    window.setTimeout(done, 50);
  });
}

export function whenReaderSettingsStylesReady(): Promise<void> {
  return styleSlots().readerSettingsReady ?? Promise.resolve();
}

export async function ensureLiveRoomSettingsStyles(): Promise<void> {
  const readerReady = ensureReaderStyles();
  ensureReaderSettingsStyles();
  await Promise.all([readerReady, whenReaderSettingsStylesReady()]);
}

const CUSTOM_SELECT_STYLE_PATH = "entry/styles/custom-select.css";

export function ensureCustomSelectStyles(): void {
  mountStyleLink(CUSTOM_SELECT_STYLE_PATH);
}

const TOGGLE_SWITCH_STYLE_PATH = "entry/styles/toggle-switch.css";

export function ensureToggleSwitchStyles(): void {
  mountStyleLink(TOGGLE_SWITCH_STYLE_PATH);
}

const BILINGUAL_SUBTITLE_STYLE_PATH = "entry/styles/bilingual-subtitles.css";

export function ensureBilingualSubtitleStyles(): void {
  mountStyleLink(BILINGUAL_SUBTITLE_STYLE_PATH);
}

const READER_CHAT_STYLE_PATHS = [
  "entry/styles/github-markdown.css",
  "entry/styles/github-markdown-theme.css",
  "entry/styles/reader-chat.css"
];

export function ensureReaderChatStyles(): void {
  READER_CHAT_STYLE_PATHS.forEach((path) => mountStyleLink(path));
}

function getMirroredDocMap(targetDoc: Document): Map<string, HTMLLinkElement> {
  const { mirrored } = styleSlots();
  let docMap = mirrored.get(targetDoc);
  if (!docMap) {
    docMap = new Map();
    mirrored.set(targetDoc, docMap);
  }
  return docMap;
}

function hasReadyMirroredLink(targetDoc: Document, path: string): boolean {
  try {
    const link = styleSlots().mirrored.get(targetDoc)?.get(path);
    return Boolean(link?.isConnected && link.sheet);
  } catch {
    return false;
  }
}

function appendStyleLink(
  targetDoc: Document,
  map: Map<string, HTMLLinkElement>,
  path: string
): HTMLLinkElement | null {
  try {
    const existing = map.get(path);
    if (existing?.isConnected) {
      return existing;
    }
    const container = targetDoc.head || targetDoc.documentElement;
    if (!container) {
      return null;
    }
    const link = targetDoc.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL(path);
    link.dataset.biliscriptStyle = "1";
    container.appendChild(link);
    map.set(path, link);
    return link;
  } catch (error) {
    if (targetDoc === getOpenerDocument()) {
      throw error;
    }
    return null;
  }
}

function removeFromMap(map: Map<string, HTMLLinkElement> | undefined, path: string): void {
  const link = map?.get(path);
  if (!link) {
    return;
  }
  map!.delete(path);
  try {
    link.remove();
  } catch {
  }
}

function mountStyleLink(path: string): HTMLLinkElement | null {
  const openerDoc = getOpenerDocument();
  const link = appendStyleLink(openerDoc, styleSlots().mounted, path);
  const activeDoc = getActiveReaderDocument();
  return activeDoc !== openerDoc
    ? appendStyleLink(activeDoc, getMirroredDocMap(activeDoc), path)
    : link;
}

function unmountStyleLink(path: string): void {
  const slots = styleSlots();
  removeFromMap(slots.mounted, path);
  removeFromMap(slots.mirrored.get(getActiveReaderDocument()), path);
}

export function syncStylesToDocument(targetDoc: Document): void {
  if (!targetDoc || targetDoc === getOpenerDocument()) {
    return;
  }
  const docMap = getMirroredDocMap(targetDoc);
  for (const path of styleSlots().mounted.keys()) {
    appendStyleLink(targetDoc, docMap, path);
  }
}

export function clearMirroredStyles(targetDoc: Document): void {
  if (!targetDoc || targetDoc === getOpenerDocument()) {
    return;
  }
  const slots = styleSlots();
  const docMap = slots.mirrored.get(targetDoc);
  if (docMap) {
    for (const link of docMap.values()) {
      try {
        link.remove();
      } catch {
      }
    }
    slots.mirrored.delete(targetDoc);
  }
  try {
    targetDoc.querySelectorAll('link[data-biliscript-style="1"]').forEach((node) => {
      node.remove();
    });
  } catch {
  }
}
