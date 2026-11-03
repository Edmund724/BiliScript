import { READING_SPEAKER_ICON, READING_STOP_ICON } from "../ui/reading-icons.js";

const DEFAULT_MAX_CHUNK_CHARS = 16000;
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT",
  "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6",
  "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "TR", "UL"
]);

export interface ChatSpeechVoice {
  voiceName?: string;
  lang?: string;
  remote?: boolean;
}

export interface ChatSpeechEvent {
  type: string;
}

export interface ChatSpeechSpeakOptions {
  voiceName?: string;
  lang?: string;
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
  onError?: (message: string) => void;
}

export interface ChatSpeechController {
  toggle(button: HTMLButtonElement, text: string, options?: { maxChunkChars?: number }): Promise<void>;
  stop(): void;
}

const chromeSpeechEngine: ChatSpeechEngine = {
  getVoices: () => chrome.tts.getVoices(),
  speak: (text, options) => chrome.tts.speak(text, options),
  stop: () => chrome.tts.stop()
};

export function speechTextFromElement(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("pre").forEach((block) => {
    block.replaceWith(document.createTextNode("代码块，已跳过。"));
  });
  clone.querySelectorAll("img").forEach((image) => {
    image.replaceWith(document.createTextNode(image.getAttribute("alt") || ""));
  });
  clone.querySelectorAll("script, style, svg, .katex-mathml").forEach((element) => element.remove());

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

  return readNode(clone)
    .replace(/[\u00a0\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

function matchVoice(voices: ChatSpeechVoice[], lang: string): ChatSpeechVoice | undefined {
  const target = normalizeLanguage(lang);
  if (!target) {
    return undefined;
  }
  return voices.find((voice) => normalizeLanguage(voice.lang) === target)
    || voices.find((voice) => normalizeLanguage(voice.lang).split("-")[0] === target.split("-")[0]);
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
  const engine = deps.engine || chromeSpeechEngine;
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

  function speakChunk(token: number, chunks: string[], index: number, voice: ChatSpeechVoice, lang: string): void {
    if (!isActive(token)) {
      return;
    }
    try {
      const result = engine.speak(chunks[index], {
        voiceName: voice.voiceName,
        lang: voice.lang || lang,
        onEvent: (event) => {
          if (!isActive(token)) {
            return;
          }
          if (event.type === "error") {
            fail(token);
          } else if (event.type === "interrupted" || event.type === "cancelled") {
            stop();
          } else if (event.type === "end") {
            if (index + 1 < chunks.length) {
              speakChunk(token, chunks, index + 1, voice, lang);
            } else {
              finish(token);
            }
          }
        }
      });
      if (result && typeof result.then === "function") {
        void result.catch(() => fail(token));
      }
    } catch {
      fail(token);
    }
  }

  async function toggle(button: HTMLButtonElement, text: string, options: { maxChunkChars?: number } = {}): Promise<void> {
    if (active?.button === button) {
      stop();
      return;
    }
    stop();
    const cleanText = text.trim();
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
      const localVoices = voices.filter((voice) => voice.remote === false);
      const voice = matchVoice(localVoices, requestedLanguage)
        || matchVoice(localVoices, browserLanguage)
        || matchVoice(voices, requestedLanguage)
        || matchVoice(voices, browserLanguage);
      if (!voice) {
        fail(token);
        return;
      }
      const chunks = splitSpeechText(cleanText, options.maxChunkChars);
      if (!chunks.length) {
        finish(token);
        return;
      }
      speakChunk(token, chunks, 0, voice, requestedLanguage);
    } catch {
      fail(token);
    }
  }

  return { toggle, stop };
}
