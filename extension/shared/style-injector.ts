// BILISCRIPT_DUAL_INSTANCE_STATEFUL
interface StyleInjectorSlots {
  mounted: Map<string, HTMLLinkElement>;
  readerSettingsReady: Promise<void> | null;
}

const STYLE_SLOT_KEY = "__BILISCRIPT_STYLE_INJECTOR__";

function styleSlots(): StyleInjectorSlots {
  const host = globalThis as unknown as Record<string, StyleInjectorSlots | undefined>;
  return (host[STYLE_SLOT_KEY] ??= { mounted: new Map(), readerSettingsReady: null });
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
  const isFirstMount = READER_SETTINGS_STYLE_PATHS.some((path) => !slots.mounted.has(path));
  const links = READER_SETTINGS_STYLE_PATHS.map((path) => mountStyleLink(path));
  if (!isFirstMount) {
    return;
  }
  slots.readerSettingsReady = Promise.all(links.map(waitForStyleLinkLoad)).then(() => {});
}

function waitForStyleLinkLoad(link: HTMLLinkElement): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => resolve();
    if (link.sheet) {
      done();
      return;
    }
    link.addEventListener("load", done, { once: true });
    link.addEventListener("error", done, { once: true });
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

function mountStyleLink(path: string): HTMLLinkElement {
  const { mounted } = styleSlots();
  let link = mounted.get(path);
  if (link) {
    return link;
  }
  link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL(path);
  link.dataset.biliscriptStyle = "1";
  (document.head || document.documentElement).appendChild(link);
  mounted.set(path, link);
  return link;
}

function unmountStyleLink(path: string): void {
  const { mounted } = styleSlots();
  const link = mounted.get(path);
  if (!link) {
    return;
  }
  link.remove();
  mounted.delete(path);
}
