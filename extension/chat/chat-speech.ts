import { READING_SPEAKER_ICON, READING_STOP_ICON } from "../ui/reading-icons.js";
import {
  CHAT_SPEECH_PORT_NAME,
  type ChatSpeechEvent,
  type ChatSpeechPortMessage,
  type ChatSpeechRequest,
  type ChatSpeechVoice
} from "./protocol.js";

export type { ChatSpeechEvent, ChatSpeechVoice };

const DEFAULT_MAX_CHUNK_CHARS = 16000;
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT",
  "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TR", "UL"
]);

export interface ChatSpeechSpeakOptions {
  voiceName?: string;
  lang?: string;
  volume?: number;
  onEvent?: (event: ChatSpeechEvent) => void;
}

export interface ChatSpeechEngine {
  getVoices(): Promise<ChatSpeechVoice[]>;
  speak(text: string, options: ChatSpeechSpeakOptions): void | Promise<void>;
  stop(): void;
}

export interface CreateChatSpeechControllerDeps {
  engine?: ChatSpeechEngine;
  getBrowserLanguage?: () => string;
  getVolume?: () => number | undefined;
  onError?: (message: string) => void;
}

export interface ChatSpeechController {
  toggle(button: HTMLButtonElement, source: HTMLElement | string, options?: { maxChunkChars?: number; volume?: number }): Promise<void>;
  stop(): void;
}

function createChromeSpeechEngine(): ChatSpeechEngine {
  let port: chrome.runtime.Port | null = null;
  let nextRequestId = 1;
  const voiceRequests = new Map<number, {
    resolve: (voices: ChatSpeechVoice[]) => void;
    reject: (error: Error) => void;
  }>();
  const eventListeners = new Map<number, ((event: ChatSpeechEvent) => void) | undefined>();

  function ensurePort(): chrome.runtime.Port {
    if (port) {
      return port;
    }
    const connected = chrome.runtime.connect({ name: CHAT_SPEECH_PORT_NAME });
    port = connected;
    connected.onMessage.addListener((value: unknown) => {
      const message = value as ChatSpeechPortMessage;
      if (message.type === "voices") {
        const pending = voiceRequests.get(message.requestId);
        voiceRequests.delete(message.requestId);
        pending?.resolve(message.voices);
        return;
      }
      if (message.type === "error") {
        const pending = voiceRequests.get(message.requestId);
        if (pending) {
          voiceRequests.delete(message.requestId);
          pending.reject(new Error(message.message));
          return;
        }
        const listener = eventListeners.get(message.requestId);
        eventListeners.delete(message.requestId);
        listener?.({ type: "error", errorMessage: message.message });
        return;
      }
      const listener = eventListeners.get(message.requestId);
      if (["end", "error", "interrupted", "cancelled"].includes(message.event.type)) {
        eventListeners.delete(message.requestId);
      }
      listener?.(message.event);
    });
    connected.onDisconnect.addListener(() => {
      if (port === connected) {
        port = null;
      }
      const error = new Error(chrome.runtime.lastError?.message || "Speech port disconnected");
      voiceRequests.forEach((pending) => pending.reject(error));
      voiceRequests.clear();
      const listeners = Array.from(eventListeners.values());
      eventListeners.clear();
      listeners.forEach((listener) => listener?.({ type: "error", errorMessage: error.message }));
    });
    return connected;
  }

  function send(request: ChatSpeechRequest): void {
    ensurePort().postMessage(request);
  }

  return {
    getVoices: () => new Promise<ChatSpeechVoice[]>((resolve, reject) => {
      const requestId = nextRequestId++;
      voiceRequests.set(requestId, { resolve, reject });
      try {
        send({ type: "get-voices", requestId });
      } catch (error) {
        voiceRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }),
    speak: (text, options) => {
      const requestId = nextRequestId++;
      eventListeners.set(requestId, options.onEvent);
      try {
        send({ type: "speak", requestId, text, voiceName: options.voiceName, lang: options.lang, volume: options.volume });
      } catch (error) {
        eventListeners.delete(requestId);
        throw error;
      }
    },
    stop: () => {
      eventListeners.clear();
      if (!port) {
        return;
      }
      try {
        port.postMessage({ type: "stop" } satisfies ChatSpeechRequest);
      } catch {}
    }
  };
}

let chromeSpeechEngine: ChatSpeechEngine | null = null;

const TIMESTAMP_TOKEN = "\\b\\d{1,3}[:：]\\d{2}(?:[:：]\\d{2})?\\b";
const RANGE_CONNECTOR = "\\s*(?:[-–—~～至到]|\\.{2,3}|…)\\s*";
const TIME_ITEM = `(?:${TIMESTAMP_TOKEN}(?:${RANGE_CONNECTOR}${TIMESTAMP_TOKEN})?)`;
const PREFIX = "(?:(?:详见|参见|参考|见|时间戳[:：]?|at|see)\\s*)?";

const BRACKETED_TIMESTAMP_PATTERN = new RegExp(
  `(?:[\\[【(（])\\s*${PREFIX}${TIME_ITEM}\\s*(?:[\\]】)）])(?:\\s*[:：\\-–—~～]\\s*|\\s+)?`,
  "giu"
);

const BARE_TIMESTAMP_PATTERN = new RegExp(
  `(?:^|(?<=[\\s\\p{P}\\p{S}]))${TIME_ITEM}(?:\\s*[:：\\-–—~～]\\s*|\\s+)?`,
  "gu"
);

export function stripSpeechTimestamps(text: string): string {
  return String(text || "")
    .replace(BRACKETED_TIMESTAMP_PATTERN, "")
    .replace(BARE_TIMESTAMP_PATTERN, "")
    .replace(/ +([，。！？；：,.!?;:])/g, "$1")
    .replace(/[\u00a0\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function speechTextFromElement(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("pre").forEach((block) => {
    block.replaceWith(document.createTextNode("代码块，已跳过。"));
  });
  clone.querySelectorAll("img").forEach((image) => {
    image.replaceWith(document.createTextNode(image.getAttribute("alt") || ""));
  });
  clone.querySelectorAll("script, style, svg, .katex-mathml, annotation, .biliscript-md-mermaid-fallback, .biliscript-md-table-cell-label, .biliscript-md-table-tools").forEach((element) => element.remove());

  function readNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || "";
    }
    if (!(node instanceof HTMLElement)) {
      return Array.from(node.childNodes).map(readNode).join("");
    }
    if (node.tagName === "BR") {
      return "\n";
    }
    const body = Array.from(node.childNodes).map(readNode).join("");
    const suffix = node.tagName === "TD" || node.tagName === "TH" ? " " : "";
    return BLOCK_TAGS.has(node.tagName) ? `\n${body}\n` : `${body}${suffix}`;
  }

  return stripSpeechTimestamps(readNode(clone));
}

export function splitSpeechText(text: string, maxChunkChars = DEFAULT_MAX_CHUNK_CHARS): string[] {
  const limit = Math.max(1, Math.floor(maxChunkChars));
  let remaining = text.trim();
  const chunks: string[] = [];
  while (remaining.length > limit) {
    let cut = -1;
    for (const separator of ["\n\n", "\n", "。", "！", "？", "! ", "? ", "；", "; ", ". "]) {
      const index = remaining.lastIndexOf(separator, limit - 1);
      if (index >= 0) {
        cut = Math.max(cut, index + separator.length);
      }
    }
    if (cut < Math.floor(limit / 2)) {
      cut = limit;
    }
    const chunk = remaining.slice(0, cut).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function normalizeLanguage(lang: string | undefined): string {
  return String(lang || "").replace(/_/g, "-").toLowerCase();
}

function detectLanguage(text: string): "zh-CN" | "en-US" | "" {
  const hanCount = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length || 0;
  const latinCount = text.match(/[a-z]/gi)?.length || 0;
  if (!hanCount && !latinCount) {
    return "";
  }
  return hanCount > latinCount ? "zh-CN" : "en-US";
}

function isNaturalVoice(voice: ChatSpeechVoice): boolean {
  return /natural/i.test(voice.voiceName || "");
}

function matchLanguageVoices(voices: ChatSpeechVoice[], lang: string): ChatSpeechVoice[] {
  const target = normalizeLanguage(lang);
  if (!target) {
    return [];
  }
  const exact = voices.filter((voice) => normalizeLanguage(voice.lang) === target);
  if (exact.length) {
    return exact;
  }
  const prefix = target.split("-")[0];
  return voices.filter((voice) => normalizeLanguage(voice.lang).split("-")[0] === prefix);
}

function matchVoice(voices: ChatSpeechVoice[], lang: string): ChatSpeechVoice | undefined {
  const matched = matchLanguageVoices(voices, lang);
  if (!matched.length) {
    return undefined;
  }
  return matched.find(isNaturalVoice)
    || matched.find((voice) => voice.remote === true)
    || matched.find((voice) => voice.remote === false)
    || matched[0];
}

function setButtonSpeaking(button: HTMLButtonElement, speaking: boolean): void {
  const label = speaking ? "停止朗读" : "朗读回答";
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.setAttribute("aria-pressed", String(speaking));
  button.classList.toggle("is-speaking", speaking);
  button.innerHTML = speaking ? READING_STOP_ICON : READING_SPEAKER_ICON;
}

export function createChatSpeechController(deps: CreateChatSpeechControllerDeps = {}): ChatSpeechController {
  const engine = deps.engine || (chromeSpeechEngine ??= createChromeSpeechEngine());
  const getBrowserLanguage = deps.getBrowserLanguage || (() => navigator.language || "zh-CN");
  const onError = deps.onError || (() => {});
  let generation = 0;
  let active: { generation: number; button: HTMLButtonElement } | null = null;

  function isActive(token: number): boolean {
    return active?.generation === token;
  }

  function stop(): void {
    generation += 1;
    const current = active;
    active = null;
    if (current) {
      setButtonSpeaking(current.button, false);
      try {
        engine.stop();
      } catch {}
    }
  }

  function finish(token: number): void {
    if (!isActive(token)) {
      return;
    }
    const current = active;
    active = null;
    generation += 1;
    if (current) {
      setButtonSpeaking(current.button, false);
    }
  }

  function fail(token: number): void {
    if (!isActive(token)) {
      return;
    }
    stop();
    onError("当前设备无法朗读");
  }

  function speakChunk(
    token: number,
    chunks: string[],
    index: number,
    voice: ChatSpeechVoice,
    lang: string,
    fallbackVoice?: ChatSpeechVoice,
    options: { maxChunkChars?: number; volume?: number } = {}
  ): void {
    if (!isActive(token)) {
      return;
    }
    const handleChunkError = () => {
      if (!isActive(token)) {
        return;
      }
      if (fallbackVoice && fallbackVoice !== voice) {
        speakChunk(token, chunks, index, fallbackVoice, lang, undefined, options);
        return;
      }
      fail(token);
    };
    try {
      const rawVolume = typeof options.volume === "number" && Number.isFinite(options.volume)
        ? options.volume
        : deps.getVolume?.();
      const volume = typeof rawVolume === "number" && Number.isFinite(rawVolume)
        ? Math.max(0, Math.min(1, rawVolume))
        : undefined;
      const result = engine.speak(chunks[index], {
        voiceName: voice.voiceName,
        lang: voice.lang || lang,
        volume,
        onEvent: (event) => {
          if (!isActive(token)) {
            return;
          }
          if (event.type === "error") {
            handleChunkError();
          } else if (event.type === "interrupted" || event.type === "cancelled") {
            stop();
          } else if (event.type === "end") {
            if (index + 1 < chunks.length) {
              speakChunk(token, chunks, index + 1, voice, lang, fallbackVoice, options);
            } else {
              finish(token);
            }
          }
        }
      });
      if (result && typeof result.then === "function") {
        void result.catch(handleChunkError);
      }
    } catch {
      handleChunkError();
    }
  }

  async function toggle(button: HTMLButtonElement, source: HTMLElement | string, options: { maxChunkChars?: number; volume?: number } = {}): Promise<void> {
    if (active?.button === button) {
      stop();
      return;
    }
    stop();
    const cleanText = (typeof source === "string" ? stripSpeechTimestamps(source) : speechTextFromElement(source)).trim();
    if (!cleanText) {
      return;
    }
    const token = generation;
    active = { generation: token, button };
    setButtonSpeaking(button, true);
    try {
      const voices = await engine.getVoices();
      if (!isActive(token)) {
        return;
      }
      const browserLanguage = getBrowserLanguage();
      const detectedLanguage = detectLanguage(cleanText);
      const requestedLanguage = detectedLanguage || browserLanguage;
      const localVoices = voices.filter((item) => item.remote === false);
      const voice = matchVoice(voices, requestedLanguage)
        || matchVoice(voices, browserLanguage);
      if (!voice) {
        fail(token);
        return;
      }
      const fallbackVoice = voice.remote === true
        ? (matchVoice(localVoices, requestedLanguage) || matchVoice(localVoices, browserLanguage))
        : undefined;
      const chunks = splitSpeechText(cleanText, options.maxChunkChars);
      if (!chunks.length) {
        finish(token);
        return;
      }
      speakChunk(token, chunks, 0, voice, requestedLanguage, fallbackVoice, options);
    } catch {
      fail(token);
    }
  }

  return { toggle, stop };
}
