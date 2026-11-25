// BILISCRIPT_DUAL_INSTANCE_STATEFUL
import { getActiveReaderDocument, getOpenerDocument } from "./active-host.js";
import { sendRuntimeMessage } from "./messaging.js";
import type {
  ContentStyleInsertMessage,
  ContentStyleReadMessage,
  ContentStyleRemoveMessage,
  ResponseOf
} from "./messaging-protocol.js";

type StyleIpcMessage =
  | ContentStyleInsertMessage
  | ContentStyleRemoveMessage
  | ContentStyleReadMessage;

type MirroredStyleEntry =
  | { kind: "adopted"; sheet: CSSStyleSheet }
  | { kind: "style"; element: HTMLStyleElement };

interface MirroredDocState {
  entries: Map<string, MirroredStyleEntry>;
  epoch: number;
  queue: Promise<void>;
  pending: number;
}

interface MirrorRuntime {
  cssTexts: Map<string, string>;
  cssTextInflight: Map<string, Promise<void>>;
  mirrored: WeakMap<Document, MirroredDocState>;
  mirror: (targetDoc: Document, paths: readonly string[]) => Promise<void>;
  applyLocal: (targetDoc: Document, paths: readonly string[], styles: Record<string, string>) => void;
  unmount: (targetDoc: Document, paths: readonly string[]) => void;
  has: (targetDoc: Document, path: string) => boolean;
}

interface StyleInjectorSlots {
  mounted: Set<string>;
  localMounted: Set<string>;
  inflight: Map<string, Promise<void>>;
  generation: Map<string, number>;
  mainQueue: Promise<void>;
  mainQueuePending: number;
  mirrorRuntime: MirrorRuntime | null;
  readerSettingsReady: Promise<void> | null;
}

const STYLE_SLOT_KEY = "__BILISCRIPT_STYLE_INJECTOR__";
const STYLE_IPC_TIMEOUT_MS = 4000;

function styleSlots(): StyleInjectorSlots {
  const host = globalThis as unknown as Record<string, StyleInjectorSlots | undefined>;
  return (host[STYLE_SLOT_KEY] ??= {
    mounted: new Set(),
    localMounted: new Set(),
    inflight: new Map(),
    generation: new Map(),
    mainQueue: Promise.resolve(),
    mainQueuePending: 0,
    mirrorRuntime: null,
    readerSettingsReady: null
  });
}

function sendStyleRequest<M extends StyleIpcMessage>(
  message: M
): Promise<ResponseOf<M> | null> {
  if (typeof chrome === "undefined" || typeof chrome.runtime?.sendMessage !== "function") {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: ResponseOf<M> | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), STYLE_IPC_TIMEOUT_MS);
    sendRuntimeMessage(message).then(
      (resp) => finish(resp ?? null),
      () => finish(null)
    );
  });
}

function enqueueMainOp(task: () => Promise<void>): Promise<void> {
  const slots = styleSlots();
  const run = async () => {
    try {
      await task();
    } catch {
    } finally {
      slots.mainQueuePending -= 1;
    }
  };
  const prev = slots.mainQueue;
  const idle = slots.mainQueuePending === 0;
  slots.mainQueuePending += 1;
  const next = idle ? run() : prev.then(run);
  slots.mainQueue = next;
  return next;
}

function isExtensionOriginPage(): boolean {
  try {
    const protocol = getOpenerDocument().location?.protocol ?? "";
    return protocol === "chrome-extension:" || protocol === "moz-extension:";
  } catch {
    return false;
  }
}

function mountMainStyles(paths: readonly string[]): Promise<void> {
  if (isExtensionOriginPage()) {
    return Promise.resolve();
  }
  const slots = styleSlots();
  const toInsert: string[] = [];
  const waits: Promise<void>[] = [];

  for (const path of paths) {
    if (!slots.mounted.has(path)) {
      if (!toInsert.includes(path)) toInsert.push(path);
    } else {
      const pending = slots.inflight.get(path);
      if (pending && !waits.includes(pending)) waits.push(pending);
    }
  }

  if (toInsert.length > 0) {
    const gens = toInsert.map((path) => {
      const nextGen = (slots.generation.get(path) ?? 0) + 1;
      slots.generation.set(path, nextGen);
      slots.mounted.add(path);
      return nextGen;
    });
    const batchPromise = enqueueMainOp(async () => {
      const resp = await sendStyleRequest({ type: "content-style-insert", files: toInsert });
      if (!resp?.ok) {
        for (let i = 0; i < toInsert.length; i += 1) {
          const path = toInsert[i];
          if (slots.generation.get(path) === gens[i]) slots.mounted.delete(path);
        }
      } else if (resp.styles && typeof resp.styles === "object") {
        const activeBatch: string[] = [];
        for (let i = 0; i < toInsert.length; i += 1) {
          const path = toInsert[i];
          if (slots.generation.get(path) === gens[i]) {
            activeBatch.push(path);
            slots.localMounted.add(path);
          }
        }
        if (activeBatch.length > 0) {
          slots.mirrorRuntime?.applyLocal(getOpenerDocument(), activeBatch, resp.styles);
        }
      }
      for (const path of toInsert) {
        if (slots.inflight.get(path) === batchPromise) slots.inflight.delete(path);
      }
    });
    for (const path of toInsert) {
      slots.inflight.set(path, batchPromise);
    }
    waits.push(batchPromise);
  }

  return waits.length === 0
    ? Promise.resolve()
    : waits.length === 1
      ? waits[0]
      : Promise.all(waits).then(() => {});
}

function unmountMainStyles(paths: readonly string[]): void {
  if (isExtensionOriginPage()) {
    return;
  }
  const slots = styleSlots();
  const toRemove: string[] = [];
  const localRemove: string[] = [];
  const scriptingRemove: string[] = [];
  for (const path of paths) {
    if (slots.mounted.has(path) && !toRemove.includes(path)) {
      toRemove.push(path);
      if (slots.localMounted.has(path)) localRemove.push(path);
      else scriptingRemove.push(path);
    }
  }
  if (toRemove.length === 0) return;
  for (const path of toRemove) {
    slots.mounted.delete(path);
    slots.localMounted.delete(path);
    slots.inflight.delete(path);
    slots.generation.set(path, (slots.generation.get(path) ?? 0) + 1);
  }
  if (localRemove.length > 0) {
    slots.mirrorRuntime?.unmount(getOpenerDocument(), localRemove);
  }
  if (scriptingRemove.length > 0) {
    void enqueueMainOp(async () => {
      await sendStyleRequest({ type: "content-style-remove", files: scriptingRemove });
    });
  }
}

function mountStyles(paths: readonly string[]): Promise<void> {
  const mainReady = mountMainStyles(paths);
  const activeDoc = getActiveReaderDocument();
  const runtime = styleSlots().mirrorRuntime;
  if (activeDoc === getOpenerDocument() || !runtime) {
    return mainReady;
  }
  return Promise.all([mainReady, runtime.mirror(activeDoc, paths)]).then(() => {});
}

function unmountStyles(paths: readonly string[]): void {
  unmountMainStyles(paths);
  const activeDoc = getActiveReaderDocument();
  if (activeDoc !== getOpenerDocument()) {
    styleSlots().mirrorRuntime?.unmount(activeDoc, paths);
  }
}

function isMirroredEntryActive(entry: MirroredStyleEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.kind === "adopted") return true;
  try {
    return Boolean(entry.element.isConnected);
  } catch {
    return false;
  }
}

function applyMirroredStyle(
  targetDoc: Document,
  entries: Map<string, MirroredStyleEntry>,
  path: string,
  cssText: string
): boolean {
  try {
    const existing = entries.get(path);
    if (isMirroredEntryActive(existing)) return true;
    if (existing) entries.delete(path);
    try {
      const targetWin = targetDoc.defaultView as
        | (Window & { CSSStyleSheet?: typeof CSSStyleSheet })
        | null;
      const adopted = targetDoc.adoptedStyleSheets;
      if (targetWin && typeof targetWin.CSSStyleSheet === "function" && Array.isArray(adopted)) {
        const sheet = new targetWin.CSSStyleSheet();
        if (typeof sheet.replaceSync === "function") {
          sheet.replaceSync(cssText);
          targetDoc.adoptedStyleSheets = [...adopted, sheet];
          if (targetDoc.adoptedStyleSheets.includes(sheet)) {
            entries.set(path, { kind: "adopted", sheet });
            return true;
          }
        }
      }
    } catch {
    }
    const container = targetDoc.head || targetDoc.documentElement;
    if (!container) return false;
    const style = targetDoc.createElement("style");
    style.dataset.biliscriptStyle = "1";
    style.dataset.biliscriptStylePath = path;
    style.textContent = cssText;
    container.appendChild(style);
    entries.set(path, { kind: "style", element: style });
    return true;
  } catch {
    return false;
  }
}

function removeMirroredEntries(
  targetDoc: Document,
  entries: Map<string, MirroredStyleEntry>,
  paths: readonly string[]
): void {
  const adoptedToRemove = new Set<CSSStyleSheet>();
  for (const path of paths) {
    const entry = entries.get(path);
    if (!entry) continue;
    entries.delete(path);
    if (entry.kind === "adopted") {
      adoptedToRemove.add(entry.sheet);
    } else {
      try {
        entry.element.remove();
      } catch {
      }
    }
  }
  if (adoptedToRemove.size > 0) {
    try {
      const current = targetDoc.adoptedStyleSheets;
      if (Array.isArray(current)) {
        targetDoc.adoptedStyleSheets = current.filter((sheet) => !adoptedToRemove.has(sheet));
      }
    } catch {
    }
  }
}

function ensureMirrorRuntime(): MirrorRuntime {
  const slots = styleSlots();
  if (slots.mirrorRuntime) {
    return slots.mirrorRuntime;
  }
  const cssTexts = new Map<string, string>();
  const cssTextInflight = new Map<string, Promise<void>>();
  const mirrored = new WeakMap<Document, MirroredDocState>();

  const getDocState = (targetDoc: Document): MirroredDocState => {
    let docState = mirrored.get(targetDoc);
    if (!docState) {
      docState = { entries: new Map(), epoch: 0, queue: Promise.resolve(), pending: 0 };
      mirrored.set(targetDoc, docState);
    }
    return docState;
  };

  const has = (targetDoc: Document, path: string): boolean => {
    try {
      const docState = mirrored.get(targetDoc);
      if (!docState) return false;
      const entry = docState.entries.get(path);
      if (isMirroredEntryActive(entry)) return true;
      if (entry) docState.entries.delete(path);
      return false;
    } catch {
      return false;
    }
  };

  const ensureCssTexts = (paths: readonly string[]): Promise<void> => {
    const missing: string[] = [];
    const toFetch: string[] = [];
    const waits: Promise<void>[] = [];
    for (const path of paths) {
      if (cssTexts.has(path) || missing.includes(path)) continue;
      missing.push(path);
      const pending = cssTextInflight.get(path);
      if (pending) {
        if (!waits.includes(pending)) waits.push(pending);
      } else {
        toFetch.push(path);
      }
    }
    if (toFetch.length > 0) {
      const batchPromise = sendStyleRequest({ type: "content-style-read", files: toFetch })
        .then((resp) => {
          if (!resp?.ok || !resp.styles || typeof resp.styles !== "object") return;
          for (const path of toFetch) {
            const cssText = resp.styles[path];
            if (typeof cssText === "string") cssTexts.set(path, cssText);
          }
        })
        .finally(() => {
          for (const path of toFetch) {
            if (cssTextInflight.get(path) === batchPromise) cssTextInflight.delete(path);
          }
        });
      for (const path of toFetch) cssTextInflight.set(path, batchPromise);
      waits.push(batchPromise);
    }
    return waits.length === 0
      ? Promise.resolve()
      : waits.length === 1
        ? waits[0]
        : Promise.all(waits).then(() => {});
  };

  const mirror = (targetDoc: Document, paths: readonly string[]): Promise<void> => {
    if (!targetDoc || targetDoc === getOpenerDocument() || paths.length === 0) {
      return Promise.resolve();
    }
    const docState = getDocState(targetDoc);
    const needed: string[] = [];
    for (const path of paths) {
      if (slots.mounted.has(path) && !has(targetDoc, path) && !needed.includes(path)) {
        needed.push(path);
      }
    }
    if (needed.length === 0) {
      return docState.pending > 0 ? docState.queue : Promise.resolve();
    }
    if (docState.pending === 0 && needed.every((path) => cssTexts.has(path))) {
      for (const path of needed) {
        const cssText = cssTexts.get(path);
        if (typeof cssText === "string") applyMirroredStyle(targetDoc, docState.entries, path, cssText);
      }
      return Promise.resolve();
    }
    const myEpoch = docState.epoch;
    const textsReady = ensureCssTexts(needed);
    const run = async () => {
      try {
        await textsReady;
        if (docState.epoch !== myEpoch) return;
        for (const path of paths) {
          if (docState.epoch !== myEpoch) return;
          if (!slots.mounted.has(path) || has(targetDoc, path)) continue;
          const cssText = cssTexts.get(path);
          if (typeof cssText === "string") applyMirroredStyle(targetDoc, docState.entries, path, cssText);
        }
      } catch {
      } finally {
        docState.pending -= 1;
      }
    };
    const prev = docState.queue;
    const idle = docState.pending === 0;
    docState.pending += 1;
    const next = idle ? run() : prev.then(run);
    docState.queue = next;
    return next;
  };

  const applyLocal = (
    targetDoc: Document,
    paths: readonly string[],
    styles: Record<string, string>
  ): void => {
    const docState = getDocState(targetDoc);
    for (const path of paths) {
      const cssText = styles[path];
      if (typeof cssText !== "string") continue;
      cssTexts.set(path, cssText);
      applyMirroredStyle(targetDoc, docState.entries, path, cssText);
    }
  };

  const unmount = (targetDoc: Document, paths: readonly string[]): void => {
    const docState = mirrored.get(targetDoc);
    if (docState) removeMirroredEntries(targetDoc, docState.entries, paths);
  };

  const runtime: MirrorRuntime = { cssTexts, cssTextInflight, mirrored, mirror, applyLocal, unmount, has };
  slots.mirrorRuntime = runtime;
  return runtime;
}

function getReaderStylePaths(): string[] {
  return [
    "entry/styles/tokens-primitive.css",
    "entry/styles/reader.css",
    "entry/styles/reader-gate.css"
  ];
}

export async function ensureReaderStyles(): Promise<void> {
  await mountStyles(getReaderStylePaths());
}

export function removeReaderStyles(): void {
  unmountStyles(getReaderStylePaths());
}

export function ensurePlayerAiStyles(): void {
  ensureMirrorRuntime();
  void mountStyles(["entry/styles/player-ai.css"]);
}

export function ensureInterpretSubtitleStyles(): void {
  ensureMirrorRuntime();
  void mountStyles(["entry/styles/interpret-subtitles.css"]);
}

export function removePlayerAiStyles(): void {
  unmountStyles(["entry/styles/player-ai.css"]);
}

const READER_SETTINGS_STYLE_PATHS = [
  "entry/styles/reader-settings-shell.css",
  "entry/styles/reader-settings-rows.css",
  "entry/styles/reader-settings-providers.css"
];

export function ensureReaderSettingsStyles(): void {
  const slots = styleSlots();
  const activeDoc = getActiveReaderDocument();
  const detached = activeDoc !== getOpenerDocument();
  const runtime = ensureMirrorRuntime();
  const needsMainMount = READER_SETTINGS_STYLE_PATHS.some(
    (path) => !slots.mounted.has(path) || slots.inflight.has(path)
  );
  const needsDetachedMount =
    detached && READER_SETTINGS_STYLE_PATHS.some((path) => !runtime.has(activeDoc, path));
  const ready = mountStyles(READER_SETTINGS_STYLE_PATHS);
  if (!needsMainMount && !needsDetachedMount) {
    return;
  }
  slots.readerSettingsReady = ready;
}

export function whenReaderSettingsStylesReady(): Promise<void> {
  return styleSlots().readerSettingsReady ?? Promise.resolve();
}

export async function ensureLiveRoomSettingsStyles(): Promise<void> {
  ensureMirrorRuntime();
  const readerReady = ensureReaderStyles();
  ensureReaderSettingsStyles();
  await Promise.all([readerReady, whenReaderSettingsStylesReady()]);
}

const CUSTOM_SELECT_STYLE_PATH = "entry/styles/custom-select.css";

export function ensureCustomSelectStyles(): void {
  ensureMirrorRuntime();
  void mountStyles([CUSTOM_SELECT_STYLE_PATH]);
}

const TOGGLE_SWITCH_STYLE_PATH = "entry/styles/toggle-switch.css";

export function ensureToggleSwitchStyles(): void {
  ensureMirrorRuntime();
  void mountStyles([TOGGLE_SWITCH_STYLE_PATH]);
}

const BILINGUAL_SUBTITLE_STYLE_PATH = "entry/styles/bilingual-subtitles.css";

export function ensureBilingualSubtitleStyles(): void {
  ensureMirrorRuntime();
  void mountStyles([BILINGUAL_SUBTITLE_STYLE_PATH]);
}

const READER_CHAT_STYLE_PATHS = [
  "entry/styles/github-markdown.css",
  "entry/styles/github-markdown-theme.css",
  "entry/styles/reader-chat.css"
];

export function ensureReaderChatStyles(): void {
  ensureMirrorRuntime();
  void mountStyles(READER_CHAT_STYLE_PATHS);
}

export function syncStylesToDocument(targetDoc: Document): Promise<void> {
  if (!targetDoc || targetDoc === getOpenerDocument()) {
    return Promise.resolve();
  }
  return ensureMirrorRuntime().mirror(targetDoc, [...styleSlots().mounted]);
}

export function clearMirroredStyles(targetDoc: Document): void {
  if (!targetDoc || targetDoc === getOpenerDocument()) {
    return;
  }
  const runtime = styleSlots().mirrorRuntime;
  const docState = runtime?.mirrored.get(targetDoc);
  if (runtime && docState) {
    docState.epoch += 1;
    removeMirroredEntries(targetDoc, docState.entries, [...docState.entries.keys()]);
    runtime.mirrored.delete(targetDoc);
  }
  try {
    targetDoc.querySelectorAll('style[data-biliscript-style="1"]').forEach((node) => {
      node.remove();
    });
  } catch {
  }
}
