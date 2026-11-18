// extension/subtitle/word-hover.ts
// 轨道级语种分词包裹（区分原生外语轨 vs 纯中文轨防 CPU/GPU/AI 误触）+
// 悬停查词防抖/防闪烁状态机（对标 kiss-translator Issue #1292）+ 发音/收藏/追问 AI。

import { state } from "../core/state.js";
import { normalizeSpeechVoiceVolume } from "../core/validators.js";
import { escapeHtml } from "../shared/string-utils.js";
import { ensureWordHoverStyles } from "../shared/style-injector.js";
import { getFullscreenHost } from "../bilibili/fullscreen.js";
import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { classifySubtitleTrack, findTrackByRef, getLangFamily } from "./selection.js";
import {
  isFavoriteWord,
  removeFavoriteWord,
  saveFavoriteWord
} from "./favorite-words.js";
import {
  closestSubtitleItem,
  getMainLineText,
  getSubtextNode,
  isSubtextReady
} from "../reader/subtitle-item-dom.js";

export const SUBTITLE_WORD_CLASS = "biliscript-subtitle-word";
export const WORD_HOVER_CARD_CLASS = "biliscript-word-hover-card";
export const WORD_HOVER_ENTER_DELAY_MS = 300;
export const WORD_HOVER_CLOSE_DELAY_MS = 1600;

const WORD_TOKEN_REGEX = /\b([a-zA-Z]+(?:'[a-zA-Z]+)?)\b/g;
const LATIN_LANG_FAMILIES = new Set(["en", "de", "fr", "es", "it", "pt", "tr", "id", "ms"]);
const WORD_CACHE_STORAGE_KEY = "biliscript_word_lookup_cache_v1";
const MAX_WORD_CACHE_ENTRIES = 500;

export interface WordWrapOptions {
  enabled?: boolean;
  trackLang?: unknown;
  zhEmbeddedEnabled?: boolean;
}

export type WordWrapPolicy = "none" | "all" | "embedded-only";

function inferLangFamilyFromLabel(rawLang: unknown): string {
  const direct = getLangFamily(rawLang);
  if (direct) {
    return direct;
  }
  const text = String(rawLang ?? "").trim().toLowerCase();
  if (!text) {
    return "";
  }
  if (/中文|汉语|国语|普通话|粤语|繁体|简体/.test(text)) {
    return "zh";
  }
  if (/英语|英文|english/.test(text)) {
    return "en";
  }
  if (/日语|日文|japanese/.test(text)) {
    return "ja";
  }
  if (/韩语|韩文|korean/.test(text)) {
    return "ko";
  }
  return "";
}

export function shouldSkipZhEmbeddedWord(word: string): boolean {
  return /^[A-Z]{1,3}$/.test(word);
}

export function resolveWordWrapPolicy(options: WordWrapOptions = {}): WordWrapPolicy {
  if (options.enabled === false) {
    return "none";
  }
  const family = inferLangFamilyFromLabel(options.trackLang);
  if (LATIN_LANG_FAMILIES.has(family)) {
    return "all";
  }
  if (family === "zh") {
    return options.zhEmbeddedEnabled ? "embedded-only" : "none";
  }
  return "none";
}

export function shouldWrapWordsForTrack(
  trackLang: unknown,
  options: Omit<WordWrapOptions, "trackLang"> = {}
): boolean {
  return resolveWordWrapPolicy({ ...options, trackLang }) !== "none";
}

function shouldWrapMatchedWord(word: string, policy: WordWrapPolicy): boolean {
  if (policy === "none") {
    return false;
  }
  if (policy === "embedded-only") {
    return !shouldSkipZhEmbeddedWord(word);
  }
  return true;
}

export function buildWordWrappedHtml(text: string, options: WordWrapOptions = {}): string {
  const source = String(text ?? "");
  if (!source) {
    return "";
  }
  const policy = resolveWordWrapPolicy(options);
  if (policy === "none") {
    return escapeHtml(source);
  }

  let out = "";
  let cursor = 0;
  WORD_TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_TOKEN_REGEX.exec(source)) !== null) {
    const word = match[1];
    const start = match.index;
    const end = start + word.length;
    if (!shouldWrapMatchedWord(word, policy)) {
      continue;
    }
    if (start > cursor) {
      out += escapeHtml(source.slice(cursor, start));
    }
    const escapedWord = escapeHtml(word);
    out += `<span class="${SUBTITLE_WORD_CLASS}" data-word="${escapedWord}">${escapedWord}</span>`;
    cursor = end;
  }
  if (cursor < source.length) {
    out += escapeHtml(source.slice(cursor));
  }
  return out;
}

export function wrapTextToFragment(
  text: string,
  options: WordWrapOptions = {},
  doc: Document = document
): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  const source = String(text ?? "");
  if (!source) {
    return fragment;
  }
  const policy = resolveWordWrapPolicy(options);
  if (policy === "none") {
    fragment.appendChild(doc.createTextNode(source));
    return fragment;
  }

  let cursor = 0;
  WORD_TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_TOKEN_REGEX.exec(source)) !== null) {
    const word = match[1];
    const start = match.index;
    const end = start + word.length;
    if (!shouldWrapMatchedWord(word, policy)) {
      continue;
    }
    if (start > cursor) {
      fragment.appendChild(doc.createTextNode(source.slice(cursor, start)));
    }
    const span = doc.createElement("span");
    span.className = SUBTITLE_WORD_CLASS;
    span.dataset.word = word;
    span.textContent = word;
    fragment.appendChild(span);
    cursor = end;
  }
  if (cursor < source.length) {
    fragment.appendChild(doc.createTextNode(source.slice(cursor)));
  }
  return fragment;
}

export function setElementTextWithWordWrap(
  element: HTMLElement,
  text: string,
  options: WordWrapOptions = {}
): void {
  const source = String(text ?? "");
  const policy = resolveWordWrapPolicy(options);
  const signature = `${policy}|${source}`;
  if (element.dataset.biliscriptWordWrapSig === signature && element.textContent === source) {
    return;
  }
  element.dataset.biliscriptWordWrapSig = signature;
  if (policy === "none") {
    if (element.textContent !== source || element.childElementCount > 0) {
      element.textContent = source;
    }
    return;
  }
  element.replaceChildren(wrapTextToFragment(source, options, element.ownerDocument));
}

export function resolveMainTrackLanguage(): string {
  const tracks = (state.clip.subtitles || []) as Array<{
    id?: string;
    lan?: string;
    subtitleUrl?: string;
  }>;
  const current =
    findTrackByRef(tracks, {
      id: state.clip.selectedSubtitleId,
      url: state.clip.selectedSubtitleUrl
    }) ??
    tracks[0] ??
    null;
  if (current) {
    if (classifySubtitleTrack(current) === "asr") {
      const asrLang = String(state.settings?.asrLanguage || "auto").trim().toLowerCase();
      if (asrLang === "zh" || asrLang === "en") {
        return `asr-${asrLang}`;
      }
      return String(state.clip.selectedSubtitleLang || current.lan || "");
    }
    return String(current.lan || state.clip.selectedSubtitleLang || "");
  }
  return String(state.clip.selectedSubtitleLang || "");
}

export function resolveSecondaryTrackLanguage(): string {
  const sec = state.clip.secondarySubtitle;
  if (!sec || sec.state !== "ready") {
    return "";
  }
  const tracks = (state.clip.subtitles || []) as Array<{
    id?: string;
    lan?: string;
    subtitleUrl?: string;
  }>;
  const matched = findTrackByRef(tracks, {
    id: sec.id,
    url: sec.url
  });
  if (matched?.lan) {
    return String(matched.lan);
  }
  const id = String(sec.id || "").trim();
  const translateIdx = id.lastIndexOf("translate-");
  if (translateIdx !== -1) {
    return id.slice(translateIdx + "translate-".length);
  }
  return String(state.settings?.secondarySubtitleLang || state.settings?.liveInterpretTargetLang || "");
}

export interface WordLookupResult {
  word: string;
  phonetic: string;
  defs: string[];
  contextMeaning: string;
  source?: "ai" | "dictionaryapi";
}

export interface WordLookupInput {
  word: string;
  sentence: string;
  translation?: string;
  signal?: AbortSignal | null;
  useFreeDict?: boolean;
}

export interface WordHoverContext {
  word: string;
  sentence: string;
  translation: string;
  from: number;
  bvid: string;
  videoTitle: string;
}

export interface WordHoverControllerOptions {
  root?: HTMLElement | null;
  getEnabled?: () => boolean;
  getAutoPause?: () => boolean;
  getVideoElement?: () => HTMLVideoElement | null;
  getMountHost?: () => HTMLElement | null;
  getTheme?: () => { theme: string; palette: string };
  lookupWord?: (input: WordLookupInput) => Promise<WordLookupResult>;
  speakWord?: (word: string) => void;
  isFavorite?: (word: string) => Promise<boolean>;
  saveFavorite?: (ctx: WordHoverContext, lookup: WordLookupResult | null) => Promise<unknown>;
  removeFavorite?: (word: string) => Promise<unknown>;
  onAskAi?: (ctx: WordHoverContext, lookup: WordLookupResult | null) => void | Promise<void>;
}

export interface WordHoverController {
  attach(root: HTMLElement): void;
  detach(): void;
  hide(): void;
  syncMountHost(): void;
  isOpen(): boolean;
  isCardInteractionActive(): boolean;
  isPausedByHover(): boolean;
  getCardElement(): HTMLElement | null;
  dispose(): void;
}

const memoryLookupCache = new Map<string, WordLookupResult>();

export function computeContextHash(text: string): string {
  const normalized = String(text ?? "").trim().toLowerCase();
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function makeLookupCacheKey(word: string, sentence: string): string {
  return `${word.trim().toLowerCase()}|${computeContextHash(sentence)}`;
}

async function readPersistentLookupCache(cacheKey: string): Promise<WordLookupResult | null> {
  const mem = memoryLookupCache.get(cacheKey);
  if (mem) {
    return mem;
  }
  if (typeof chrome === "undefined" || !chrome.storage?.local?.get) {
    return null;
  }
  try {
    const raw = await chrome.storage.local.get(WORD_CACHE_STORAGE_KEY);
    const map = raw?.[WORD_CACHE_STORAGE_KEY] as Record<string, WordLookupResult> | undefined;
    const hit = map?.[cacheKey];
    if (hit && typeof hit === "object" && Array.isArray(hit.defs)) {
      memoryLookupCache.set(cacheKey, hit);
      return hit;
    }
  } catch {
    // 缓存读取失败不阻断查词
  }
  return null;
}

async function writePersistentLookupCache(cacheKey: string, result: WordLookupResult): Promise<void> {
  memoryLookupCache.set(cacheKey, result);
  if (typeof chrome === "undefined" || !chrome.storage?.local?.get || !chrome.storage?.local?.set) {
    return;
  }
  try {
    const raw = await chrome.storage.local.get(WORD_CACHE_STORAGE_KEY);
    const prev = (raw?.[WORD_CACHE_STORAGE_KEY] as Record<string, WordLookupResult> | undefined) || {};
    const entries = Object.entries(prev).filter(([key]) => key !== cacheKey);
    entries.unshift([cacheKey, result]);
    const trimmed = Object.fromEntries(entries.slice(0, MAX_WORD_CACHE_ENTRIES));
    await chrome.storage.local.set({ [WORD_CACHE_STORAGE_KEY]: trimmed });
  } catch {
    // 缓存写入失败静默降级
  }
}

export function parseWordLookupJson(rawText: string, word: string): WordLookupResult | null {
  const cleaned = String(rawText ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  const jsonSlice = match ? match[0] : cleaned;
  try {
    const parsed = JSON.parse(jsonSlice) as {
      phonetic?: unknown;
      defs?: unknown;
      contextMeaning?: unknown;
    };
    const phonetic = String(parsed?.phonetic ?? "").trim();
    const defs = Array.isArray(parsed?.defs)
      ? parsed.defs.map((d) => String(d ?? "").trim()).filter(Boolean).slice(0, 4)
      : typeof parsed?.defs === "string" && parsed.defs.trim()
        ? [parsed.defs.trim()]
        : [];
    const contextMeaning = String(parsed?.contextMeaning ?? "").trim();
    if (!defs.length && !contextMeaning) {
      return null;
    }
    return { word, phonetic, defs, contextMeaning, source: "ai" };
  } catch {
    return null;
  }
}

async function fetchFreeDictionaryFallback(
  word: string,
  signal?: AbortSignal | null
): Promise<WordLookupResult | null> {
  const targetUrl = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`;
  try {
    const [{ hasHostPermissionViaBackground }, { providerFetchViaBackground }] = await Promise.all([
      import("../core/host-permissions.js"),
      import("../core/provider-http.js")
    ]);
    const permitted = await hasHostPermissionViaBackground("https://api.dictionaryapi.dev");
    if (!permitted) {
      return null;
    }
    const resp = await providerFetchViaBackground(targetUrl, { method: "GET", signal: signal ?? undefined });
    if (!resp.ok) {
      return null;
    }
    const payload = (await resp.json()) as Array<{
      phonetic?: string;
      phonetics?: Array<{ text?: string }>;
      meanings?: Array<{
        partOfSpeech?: string;
        definitions?: Array<{ definition?: string }>;
      }>;
    }>;
    const first = Array.isArray(payload) ? payload[0] : null;
    if (!first) {
      return null;
    }
    const phonetic =
      String(first.phonetic || "").trim() ||
      String(first.phonetics?.find((p) => p?.text)?.text || "").trim();
    const defs: string[] = [];
    for (const meaning of first.meanings || []) {
      const pos = String(meaning.partOfSpeech || "").trim();
      const def = String(meaning.definitions?.[0]?.definition || "").trim();
      if (def) {
        defs.push(pos ? `${pos}. ${def}` : def);
      }
      if (defs.length >= 3) break;
    }
    if (!defs.length) {
      return null;
    }
    return {
      word,
      phonetic,
      defs,
      contextMeaning: "",
      source: "dictionaryapi"
    };
  } catch {
    return null;
  }
}

async function resolveWordLookupProvider() {
  try {
    const { resolveActiveProvider } = await import("../ai/active-provider.js");
    return await resolveActiveProvider();
  } catch {
    const { sendRuntimeMessage } = await import("../shared/messaging.js");
    const resp = await sendRuntimeMessage({ type: "resolve-subtitle-translate-provider" });
    if (!resp?.ok || !resp.provider) {
      throw new Error(String(resp?.error || "暂无可用的 AI 查词平台"));
    }
    return {
      baseUrl: String(resp.provider.baseUrl || "").trim(),
      apiKey: String(resp.apiKey || "").trim(),
      model: String(resp.model || resp.provider.model || "").trim(),
      presetId: String(resp.provider.presetId || ""),
      protocol: resp.provider.protocol
    };
  }
}

export async function lookupWordDefault(input: WordLookupInput): Promise<WordLookupResult> {
  const word = String(input.word ?? "").trim();
  const sentence = String(input.sentence ?? "").trim();
  const cacheKey = makeLookupCacheKey(word, sentence);
  const cached = await readPersistentLookupCache(cacheKey);
  if (cached) {
    return cached;
  }

  if (input.useFreeDict) {
    const dictResult = await fetchFreeDictionaryFallback(word, input.signal);
    if (dictResult) {
      await writePersistentLookupCache(cacheKey, dictResult);
      return dictResult;
    }
  }

  const [provider, { chatCompletion }, { providerFetchViaBackground }] = await Promise.all([
    resolveWordLookupProvider(),
    import("../ai/completion.js"),
    import("../core/provider-http.js")
  ]);

  const userPrompt = [
    `单词：${word}`,
    sentence ? `所在字幕句：${sentence}` : "",
    input.translation ? `对照译文：${input.translation}` : "",
    '请仅返回严格 JSON：{"phonetic":"音标(如 /.../)","defs":["词性. 简明中文释义"],"contextMeaning":"结合本句语境的贴切译义（15字以内）"}'
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await chatCompletion({
    provider,
    messages: [
      {
        role: "system",
        content: "你是英汉字幕词典助手。只输出合法紧凑 JSON，不要 Markdown 代码块、不要多余说明。"
      },
      { role: "user", content: userPrompt }
    ],
    stream: false,
    thinkingLevel: "off",
    signal: input.signal,
    maxTokens: 200,
    retries: 1,
    fetchImpl: providerFetchViaBackground
  });

  const parsed = parseWordLookupJson(String(raw || ""), word);
  if (!parsed) {
    throw new Error("词典解析失败");
  }
  await writePersistentLookupCache(cacheKey, parsed);
  return parsed;
}

export function speakWordNative(word: string): void {
  const text = String(word ?? "").trim();
  if (!text || typeof window === "undefined" || !("speechSynthesis" in window)) {
    return;
  }
  try {
    const synth = window.speechSynthesis;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    const voices = typeof synth.getVoices === "function" ? synth.getVoices() : [];
    const preferredVoice =
      voices.find(
        (v) => v.lang?.toLowerCase().startsWith("en-us") && /natural/i.test(v.name || "")
      ) ??
      voices.find((v) => v.lang?.toLowerCase().startsWith("en-us")) ??
      voices.find((v) => v.lang?.toLowerCase().startsWith("en"));
    if (preferredVoice) {
      utterance.voice = preferredVoice;
    }
    const vol = normalizeSpeechVoiceVolume(state.settings?.speechVoiceVolume) / 100;
    utterance.volume = Math.min(1, Math.max(0, vol));
    synth.speak(utterance);
  } catch {
    // 部分测试或无声卡环境容错
  }
}

function hasActiveTextSelection(): boolean {
  try {
    return Boolean(window.getSelection?.()?.toString().trim());
  } catch {
    return false;
  }
}

function defaultExtractWordContext(wordEl: HTMLElement): WordHoverContext {
  const word = String(wordEl.dataset.word || wordEl.textContent || "").trim();
  const bvid = String(state.clip.bvid || "").trim();
  const videoTitle = String(state.clip.title || "").trim();

  const readingItem = closestSubtitleItem(wordEl);
  if (readingItem) {
    const inSubtext = Boolean(wordEl.closest(".biliscript-reading-subtext"));
    const mainText = getMainLineText(readingItem).trim();
    const subText = isSubtextReady(readingItem)
      ? String(getSubtextNode(readingItem)?.textContent || "").trim()
      : "";
    return {
      word,
      sentence: inSubtext ? subText : mainText,
      translation: inSubtext ? mainText : subText,
      from: Number(readingItem.dataset.seconds || 0) || 0,
      bvid,
      videoTitle
    };
  }

  const overlay = wordEl.closest<HTMLElement>(".biliscript-interpret-subtitle-overlay");
  if (overlay) {
    const inTranslation = Boolean(wordEl.closest(".biliscript-interpret-subtitle-translation"));
    const originalText =
      overlay.querySelector<HTMLElement>(".biliscript-interpret-subtitle-original")?.textContent?.trim() || "";
    const translationText =
      overlay.querySelector<HTMLElement>(".biliscript-interpret-subtitle-translation")?.textContent?.trim() || "";
    const video = getRuntimeVideoElement();
    return {
      word,
      sentence: inTranslation ? translationText : originalText,
      translation: inTranslation ? originalText : translationText,
      from: Math.max(0, Number(video?.currentTime || 0) || 0),
      bvid,
      videoTitle
    };
  }

  return {
    word,
    sentence: wordEl.parentElement?.textContent?.trim() || word,
    translation: "",
    from: 0,
    bvid,
    videoTitle
  };
}

const SPEAKER_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path></svg>`;
const STAR_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;
const STAR_FILLED_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;
const CLOSE_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;

export function createWordHoverController(
  options: WordHoverControllerOptions = {}
): WordHoverController {
  if (typeof chrome !== "undefined" && typeof chrome.runtime?.getURL === "function") {
    ensureWordHoverStyles();
  }

  const getEnabled = options.getEnabled ?? (() => state.settings?.wordHoverEnabled === true);
  const getAutoPause = options.getAutoPause ?? (() => state.settings?.wordHoverAutoPause === true);
  const getVideoElement = options.getVideoElement ?? getRuntimeVideoElement;
  const getMountHost =
    options.getMountHost ?? (() => getFullscreenHost() || document.body);
  const getTheme =
    options.getTheme ??
    (() => ({
      theme: state.reader?.readingTheme || state.settings?.readerTheme || "light",
      palette: state.reader?.readingPalette || state.settings?.readerPalette || "flyme"
    }));
  const lookupWord =
    options.lookupWord ??
    ((input: WordLookupInput) =>
      lookupWordDefault({
        ...input,
        useFreeDict: state.settings?.wordHoverUseFreeDict === true
      }));
  const speakWord = options.speakWord ?? speakWordNative;
  const checkFavorite = options.isFavorite ?? isFavoriteWord;
  const saveFavorite =
    options.saveFavorite ??
    ((ctx: WordHoverContext, lookup: WordLookupResult | null) =>
      saveFavoriteWord({
        word: ctx.word,
        phonetic: lookup?.phonetic || "",
        defs: lookup?.defs || [],
        contextMeaning: lookup?.contextMeaning || "",
        bvid: ctx.bvid,
        videoTitle: ctx.videoTitle,
        sentence: ctx.sentence,
        translation: ctx.translation,
        from: ctx.from
      }));
  const removeFavorite = options.removeFavorite ?? removeFavoriteWord;

  let attachedRoot: HTMLElement | null = null;
  let cardEl: HTMLElement | null = null;
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let cardInteractionActive = false;
  let pausedByWordHover = false;
  let activeVideoEl: HTMLVideoElement | null = null;
  let activeWordEl: HTMLElement | null = null;
  let activeContext: WordHoverContext | null = null;
  let activeLookup: WordLookupResult | null = null;
  let activeFavorited = false;
  let lookupSeq = 0;
  let lookupAbort: AbortController | null = null;
  let phase: "loading" | "ready" | "error" = "loading";
  let errorText = "";
  let docListenersBound = false;

  function clearOpenTimer(): void {
    if (openTimer !== null) {
      clearTimeout(openTimer);
      openTimer = null;
    }
  }

  function clearCloseTimer(): void {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function detachVideoListeners(): void {
    if (!activeVideoEl) {
      return;
    }
    activeVideoEl.removeEventListener("play", onVideoExternalInteraction);
    activeVideoEl.removeEventListener("seeking", onVideoExternalInteraction);
    activeVideoEl = null;
  }

  function onVideoExternalInteraction(): void {
    pausedByWordHover = false;
    detachVideoListeners();
  }

  function maybeAutoPauseVideo(): void {
    if (!getAutoPause() || pausedByWordHover) {
      return;
    }
    const video = getVideoElement();
    if (!video || video.paused) {
      return;
    }
    pausedByWordHover = true;
    activeVideoEl = video;
    video.pause();
    video.addEventListener("play", onVideoExternalInteraction, { once: true });
    video.addEventListener("seeking", onVideoExternalInteraction, { once: true });
  }

  function maybeResumeVideo(): void {
    if (!pausedByWordHover) {
      detachVideoListeners();
      return;
    }
    const video = activeVideoEl || getVideoElement();
    pausedByWordHover = false;
    detachVideoListeners();
    if (video && video.paused) {
      void Promise.resolve(video.play()).catch(() => {});
    }
  }

  function ensureCardMounted(): HTMLElement {
    const host = getMountHost() || document.body;
    if (!cardEl) {
      cardEl = document.createElement("div");
      cardEl.className = WORD_HOVER_CARD_CLASS;
      cardEl.setAttribute("role", "dialog");
      cardEl.setAttribute("aria-label", "单词释义");
      cardEl.hidden = true;

      const onCardEnter = () => {
        cardInteractionActive = true;
        clearCloseTimer();
      };
      const onCardLeave = () => {
        cardInteractionActive = false;
        scheduleClose();
      };
      cardEl.addEventListener("mouseenter", onCardEnter);
      cardEl.addEventListener("pointerenter", onCardEnter);
      cardEl.addEventListener("focusin", onCardEnter);
      cardEl.addEventListener("mouseleave", onCardLeave);
      cardEl.addEventListener("pointerleave", onCardLeave);
      cardEl.addEventListener("pointerdown", (e) => e.stopPropagation());
      cardEl.addEventListener("mousedown", (e) => e.stopPropagation());
      cardEl.addEventListener("click", handleCardClick);
    }
    if (cardEl.parentElement !== host) {
      host.appendChild(cardEl);
    }
    const { theme, palette } = getTheme();
    cardEl.dataset.theme = theme === "dark" ? "dark" : "light";
    cardEl.dataset.palette = palette === "editorial" ? "editorial" : "flyme";
    return cardEl;
  }

  function positionCard(anchor: HTMLElement): void {
    const card = cardEl;
    if (!card || card.hidden) {
      return;
    }
    const wordRect = anchor.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const cardWidth = cardRect.width > 0 ? cardRect.width : 288;
    const cardHeight = cardRect.height > 0 ? cardRect.height : 170;
    const viewportW = typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : 1280;
    const viewportH = typeof window !== "undefined" && window.innerHeight > 0 ? window.innerHeight : 720;

    let bottomLimit = viewportH - 12;
    const playerContainer = anchor.closest(".bpx-player-container");
    if (playerContainer) {
      const playerRect = playerContainer.getBoundingClientRect();
      if (playerRect.bottom > 0) {
        bottomLimit = Math.min(bottomLimit, playerRect.bottom - 56);
      }
    }

    const belowTop = wordRect.bottom + 8;
    const aboveTop = wordRect.top - cardHeight - 8;
    let placement: "bottom" | "top" = "bottom";
    let top = belowTop;
    if (belowTop + cardHeight > bottomLimit && aboveTop >= 8) {
      placement = "top";
      top = aboveTop;
    } else if (belowTop + cardHeight > bottomLimit) {
      top = Math.max(8, bottomLimit - cardHeight);
    } else {
      top = Math.max(8, belowTop);
    }

    const maxLeft = Math.max(8, viewportW - cardWidth - 8);
    const left = Math.min(Math.max(8, Math.round(wordRect.left)), maxLeft);

    card.dataset.placement = placement;
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }

  function renderCard(): void {
    if (!activeContext) {
      return;
    }
    const card = ensureCardMounted();
    const phonetic = activeLookup?.phonetic || "";
    const defs = activeLookup?.defs || [];
    const contextMeaning = activeLookup?.contextMeaning || "";

    let bodyHtml = "";
    if (phase === "loading") {
      bodyHtml = `<div class="biliscript-word-hover-status">正在查词…</div>`;
    } else if (phase === "error") {
      bodyHtml = `
        <div class="biliscript-word-hover-status is-error">${escapeHtml(errorText || "查词失败")}</div>
        <div><button type="button" class="biliscript-word-hover-retry-btn" data-word-hover-action="retry">重试</button></div>
      `;
    } else {
      const defsHtml = defs.length
        ? `<ul class="biliscript-word-hover-defs">${defs.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`
        : "";
      const ctxHtml = contextMeaning
        ? `<div class="biliscript-word-hover-context"><strong>本句释义：</strong>${escapeHtml(contextMeaning)}</div>`
        : "";
      bodyHtml = `${defsHtml}${ctxHtml}`;
    }

    card.innerHTML = `
      <div class="biliscript-word-hover-head">
        <div class="biliscript-word-hover-title-wrap">
          <span class="biliscript-word-hover-word">${escapeHtml(activeContext.word)}</span>
          ${phonetic ? `<span class="biliscript-word-hover-phonetic">${escapeHtml(phonetic)}</span>` : ""}
        </div>
        <div class="biliscript-word-hover-head-actions">
          <button type="button" class="biliscript-word-hover-icon-btn" data-word-hover-action="speak" title="发音" aria-label="发音">${SPEAKER_ICON_SVG}</button>
          <button type="button" class="biliscript-word-hover-icon-btn ${activeFavorited ? "is-favorited" : ""}" data-word-hover-action="favorite" title="${activeFavorited ? "取消收藏" : "收藏生词"}" aria-label="${activeFavorited ? "取消收藏" : "收藏生词"}" aria-pressed="${activeFavorited ? "true" : "false"}">${activeFavorited ? STAR_FILLED_SVG : STAR_ICON_SVG}</button>
          <button type="button" class="biliscript-word-hover-icon-btn" data-word-hover-action="close" title="关闭" aria-label="关闭">${CLOSE_ICON_SVG}</button>
        </div>
      </div>
      <div class="biliscript-word-hover-body">${bodyHtml}</div>
      <div class="biliscript-word-hover-foot">
        <button type="button" class="biliscript-word-hover-ask-btn" data-word-hover-action="ask-ai">结合当前句追问 AI</button>
      </div>
    `;

    card.hidden = false;
    if (activeWordEl?.isConnected) {
      positionCard(activeWordEl);
    }
  }

  function startLookup(ctx: WordHoverContext): void {
    lookupAbort?.abort();
    lookupAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
    const seq = ++lookupSeq;
    phase = "loading";
    errorText = "";
    activeLookup = null;
    renderCard();

    void checkFavorite(ctx.word)
      .then((fav) => {
        if (seq === lookupSeq && activeContext) {
          activeFavorited = fav;
          renderCard();
        }
      })
      .catch(() => {});

    void lookupWord({
      word: ctx.word,
      sentence: ctx.sentence,
      translation: ctx.translation,
      signal: lookupAbort?.signal
    })
      .then((result) => {
        if (seq !== lookupSeq || !activeContext) {
          return;
        }
        activeLookup = result;
        phase = "ready";
        renderCard();
      })
      .catch((error) => {
        if (seq !== lookupSeq || !activeContext) {
          return;
        }
        if ((error as Error)?.name === "AbortError") {
          return;
        }
        phase = "error";
        errorText = (error as Error)?.message || "查词失败";
        renderCard();
      });
  }

  function openForWord(wordEl: HTMLElement): void {
    if (!getEnabled() || hasActiveTextSelection() || !wordEl.isConnected) {
      return;
    }
    const ctx = defaultExtractWordContext(wordEl);
    if (!ctx.word) {
      return;
    }
    if (activeWordEl && activeWordEl !== wordEl) {
      activeWordEl.classList.remove("is-hover-active");
    }
    activeWordEl = wordEl;
    activeWordEl.classList.add("is-hover-active");
    activeContext = ctx;
    activeFavorited = false;
    maybeAutoPauseVideo();
    startLookup(ctx);
  }

  function hide(): void {
    clearOpenTimer();
    clearCloseTimer();
    cardInteractionActive = false;
    lookupAbort?.abort();
    lookupAbort = null;
    lookupSeq += 1;
    if (activeWordEl) {
      activeWordEl.classList.remove("is-hover-active");
      activeWordEl = null;
    }
    activeContext = null;
    activeLookup = null;
    activeFavorited = false;
    if (cardEl) {
      cardEl.hidden = true;
    }
    maybeResumeVideo();
  }

  function scheduleClose(): void {
    clearCloseTimer();
    if (cardInteractionActive) {
      return;
    }
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (cardInteractionActive) {
        return;
      }
      hide();
    }, WORD_HOVER_CLOSE_DELAY_MS);
  }

  async function triggerAskAi(ctx: WordHoverContext, lookup: WordLookupResult | null): Promise<void> {
    if (options.onAskAi) {
      await options.onAskAi(ctx, lookup);
      return;
    }
    const { setPendingExplainIntent } = await import("../reader/explain-intent.js");
    const { activateScriptTab } = await import("../reader/script-tab-activation.js");
    const { ensureReaderDomain } = await import("../reader/lazy-reader.js");

    const parts: string[] = [];
    if (lookup?.phonetic) parts.push(lookup.phonetic);
    if (lookup?.defs?.length) parts.push(lookup.defs.join("；"));
    if (lookup?.contextMeaning) parts.push(`语境含义：${lookup.contextMeaning}`);
    const explanation = parts.join("\n");
    const line = ctx.translation ? `${ctx.sentence}（${ctx.translation}）` : ctx.sentence;

    setPendingExplainIntent({
      from: ctx.from,
      content: line || ctx.word,
      selection: ctx.word,
      ...(explanation ? { explanation } : {}),
      createdAt: Date.now()
    });
    if (!state.reader.readingViewOpen) {
      const reader = await ensureReaderDomain();
      await reader.enterReaderMode("open");
    }
    await activateScriptTab("chat");
  }

  function handleCardClick(event: MouseEvent): void {
    event.stopPropagation();
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-word-hover-action]");
    if (!target || !activeContext) {
      return;
    }
    const action = target.dataset.wordHoverAction;
    if (action === "close") {
      hide();
      return;
    }
    if (action === "speak") {
      speakWord(activeContext.word);
      return;
    }
    if (action === "retry") {
      startLookup(activeContext);
      return;
    }
    if (action === "favorite") {
      const ctx = activeContext;
      const lookup = activeLookup;
      const wasFav = activeFavorited;
      activeFavorited = !wasFav;
      renderCard();
      void (wasFav ? removeFavorite(ctx.word) : saveFavorite(ctx, lookup)).catch(() => {
        activeFavorited = wasFav;
        renderCard();
      });
      return;
    }
    if (action === "ask-ai") {
      const ctx = activeContext;
      const lookup = activeLookup;
      hide();
      void triggerAskAi(ctx, lookup);
    }
  }

  function onRootMouseOver(event: MouseEvent): void {
    if (!getEnabled()) {
      return;
    }
    const target = (event.target as Element | null)?.closest<HTMLElement>(`.${SUBTITLE_WORD_CLASS}`);
    if (!target || !attachedRoot?.contains(target)) {
      return;
    }
    if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) {
      return;
    }
    if (hasActiveTextSelection()) {
      hide();
      return;
    }
    clearCloseTimer();
    if (activeWordEl === target && cardEl && !cardEl.hidden) {
      return;
    }
    clearOpenTimer();
    openTimer = setTimeout(() => {
      openTimer = null;
      openForWord(target);
    }, WORD_HOVER_ENTER_DELAY_MS);
  }

  function onRootMouseOut(event: MouseEvent): void {
    const target = (event.target as Element | null)?.closest<HTMLElement>(`.${SUBTITLE_WORD_CLASS}`);
    if (!target || !attachedRoot?.contains(target)) {
      return;
    }
    if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) {
      return;
    }
    clearOpenTimer();
    if (event.relatedTarget instanceof Node && cardEl?.contains(event.relatedTarget)) {
      return;
    }
    if (cardEl && !cardEl.hidden) {
      scheduleClose();
    }
  }

  function onDocumentSelectionChange(): void {
    if (hasActiveTextSelection()) {
      hide();
    }
  }

  function onDocumentFullscreenChange(): void {
    syncMountHost();
  }

  function onDocumentKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && cardEl && !cardEl.hidden) {
      hide();
    }
  }

  function onDocumentPointerDown(event: Event): void {
    if (!cardEl || cardEl.hidden) {
      return;
    }
    const target = event.target as Node | null;
    if (target && cardEl.contains(target)) {
      return;
    }
    if (target instanceof Element && target.closest(`.${SUBTITLE_WORD_CLASS}`)) {
      return;
    }
    hide();
  }

  function onRootScroll(): void {
    if (!cardEl || cardEl.hidden || cardInteractionActive) {
      return;
    }
    hide();
  }

  function bindDocumentListeners(): void {
    if (docListenersBound || typeof document === "undefined") {
      return;
    }
    docListenersBound = true;
    document.addEventListener("selectionchange", onDocumentSelectionChange);
    document.addEventListener("fullscreenchange", onDocumentFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onDocumentFullscreenChange);
    document.addEventListener("keydown", onDocumentKeyDown, true);
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
  }

  function unbindDocumentListeners(): void {
    if (!docListenersBound || typeof document === "undefined") {
      return;
    }
    docListenersBound = false;
    document.removeEventListener("selectionchange", onDocumentSelectionChange);
    document.removeEventListener("fullscreenchange", onDocumentFullscreenChange);
    document.removeEventListener("webkitfullscreenchange", onDocumentFullscreenChange);
    document.removeEventListener("keydown", onDocumentKeyDown, true);
    document.removeEventListener("pointerdown", onDocumentPointerDown, true);
  }

  function attach(root: HTMLElement): void {
    if (attachedRoot === root) {
      bindDocumentListeners();
      return;
    }
    detach();
    attachedRoot = root;
    attachedRoot.addEventListener("mouseover", onRootMouseOver);
    attachedRoot.addEventListener("mouseout", onRootMouseOut);
    attachedRoot.addEventListener("scroll", onRootScroll, { passive: true });
    bindDocumentListeners();
  }

  function detach(): void {
    if (attachedRoot) {
      attachedRoot.removeEventListener("mouseover", onRootMouseOver);
      attachedRoot.removeEventListener("mouseout", onRootMouseOut);
      attachedRoot.removeEventListener("scroll", onRootScroll);
      attachedRoot = null;
    }
    hide();
  }

  function syncMountHost(): void {
    if (!cardEl) {
      return;
    }
    const host = getMountHost() || document.body;
    if (cardEl.parentElement !== host) {
      host.appendChild(cardEl);
    }
    if (!cardEl.hidden && activeWordEl?.isConnected) {
      positionCard(activeWordEl);
    }
  }

  function dispose(): void {
    detach();
    unbindDocumentListeners();
    cardEl?.remove();
    cardEl = null;
  }

  if (options.root) {
    attach(options.root);
  }

  return {
    attach,
    detach,
    hide,
    syncMountHost,
    isOpen: () => Boolean(cardEl && !cardEl.hidden),
    isCardInteractionActive: () => cardInteractionActive,
    isPausedByHover: () => pausedByWordHover,
    getCardElement: () => cardEl,
    dispose
  };
}
