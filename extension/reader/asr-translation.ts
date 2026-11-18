// extension/reader/asr-translation.ts
// 译文副轨（ASR 伪轨 / 单语种原生轨 / 多轨手动精翻覆盖）：面板侧的启动、中止、目标语言
// 同族过滤与列投影模型。
//
// 分工：真正的分片调度、缓存覆盖判定、逐片翻译与写槽在链层
//（subtitle/asr-translation.ts，经 subtitle/lazy 的 chain 暴露）；本模块是
// 轻叶子，只持有「在飞、进度、是否开启手动 AI 精翻覆盖」面板要同步读取的事实，
// 并负责偏好写入与用户动作编排。

import { state, clipState } from "../core/state.js";
import {
  LIVE_INTERPRET_TARGET_LANG_OPTIONS,
  type LiveInterpretTargetLang
} from "../live/interpret-subtitle-preferences.js";
import {
  classifySubtitleTrack,
  findManualForeignTrackForAiRefine,
  findTrackByRef,
  getAvailableTargetLangOptions,
  isLoadableNativeTrack,
  isMonolingualNativeTracks,
  resolveTargetLang,
  resolveTargetLangBcp47,
  resolveTrackTarget
} from "../subtitle/selection.js";
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";
import { notifyReaderPresenter, persistReaderSettingsThroughSeam } from "./reader-bus.js";

export function hasAsrPseudoTrack(
  tracks: ReadonlyArray<{ id?: string; lan?: string; subtitleUrl?: string } | null | undefined> | null | undefined
): boolean {
  return (tracks || []).some(
    (track) => classifySubtitleTrack(track) === "asr" && !String(track?.subtitleUrl || "").trim()
  );
}

export function resolveCurrentMainTrackLan(
  tracks: ReadonlyArray<{ id?: string; lan?: string; subtitleUrl?: string }> = state.clip.subtitles
): string {
  const selectedId = String(state.clip.selectedSubtitleId || "").trim();
  const selectedUrl = String(state.clip.selectedSubtitleUrl || "").trim();
  const current =
    findTrackByRef(tracks, { id: selectedId, url: selectedUrl }) ??
    tracks[0] ??
    null;
  if (!current) {
    return "";
  }
  if (classifySubtitleTrack(current) === "asr") {
    const asrLang = String(state.settings?.asrLanguage || "auto").trim().toLowerCase();
    return asrLang === "zh" || asrLang === "en" ? `asr-${asrLang}` : "auto";
  }
  return String(current.lan || "");
}

export function resolveAsrTranslationLang(
  sourceLan: unknown = resolveCurrentMainTrackLan()
): LiveInterpretTargetLang {
  return resolveTargetLang(sourceLan, state.settings.liveInterpretTargetLang);
}

export function resolveAsrTranslationTargetBcp47(
  sourceLan: unknown = resolveCurrentMainTrackLan()
): string {
  return resolveTargetLangBcp47(sourceLan, state.settings.liveInterpretTargetLang);
}

export function normalizeAsrTranslationLang(
  value: unknown,
  sourceLan: unknown = resolveCurrentMainTrackLan()
): LiveInterpretTargetLang {
  return resolveTargetLang(sourceLan, value);
}

// ===== 在飞、进度与手动精翻覆盖（本模块持有）=====
let activeAbort: AbortController | null = null;
let progress: { total: number; done: number; failed: number } = { total: 0, done: 0, failed: 0 };
let startRequested = false;
let contextKey = "";
let aiRefineVideoKey = "";

function currentVideoKey(): string {
  return `${state.clip.bvid}|${state.clip.cid}`;
}

function currentContextKey(): string {
  return `${state.clip.bvid}|${state.clip.cid}|${clipState.fetchRunId}|${state.clip.selectedSubtitleId}`;
}

function syncContext(): void {
  const videoKey = currentVideoKey();
  if (aiRefineVideoKey && aiRefineVideoKey !== videoKey) {
    aiRefineVideoKey = "";
  }
  const next = currentContextKey();
  if (next === contextKey) {
    return;
  }
  contextKey = next;
  activeAbort?.abort();
  activeAbort = null;
  progress = { total: 0, done: 0, failed: 0 };
  startRequested = false;
}

export function isAiRefineOverrideActive(): boolean {
  const key = currentVideoKey();
  return Boolean(aiRefineVideoKey && key !== "|" && aiRefineVideoKey === key) ||
    Boolean(aiRefineVideoKey && aiRefineVideoKey === key);
}

export function setAiRefineOverride(enabled: boolean): void {
  aiRefineVideoKey = enabled ? currentVideoKey() : "";
}

/**
 * 判定当前视频是否走 AI 译文副轨模式：
 * 1) 存在跨语种多轨但用户显式开启了「AI 精翻」覆盖；
 * 2) 存在 ASR 伪轨且原生可配对跨语种轨不足；
 * 3) 原生轨全属同一语种族（单条 `en-US`、单条 `zh-CN`、或 `zh-Hans` + `zh-Hant` 同族多轨）。
 */
export function isTranslationSecondaryScenario(
  tracks: ReadonlyArray<{ id?: string; lan?: string; subtitleUrl?: string }> | null | undefined = state.clip.subtitles
): boolean {
  const list = tracks || [];
  const loadableNative = list.filter(isLoadableNativeTrack);
  if (isAiRefineOverrideActive() && (loadableNative.length > 0 || hasAsrPseudoTrack(list))) {
    return true;
  }
  if (hasAsrPseudoTrack(list) && (loadableNative.length === 0 || isMonolingualNativeTracks(list))) {
    return true;
  }
  return isMonolingualNativeTracks(list);
}

export interface AsrTranslationView {
  lang: LiveInterpretTargetLang;
  inFlight: boolean;
  note: string;
  action: { label: string; kind: "start" | "retry" | "fill" } | null;
}

export function resolveAsrTranslationOptions(
  sourceLan: unknown = resolveCurrentMainTrackLan()
): ReadonlyArray<(typeof LIVE_INTERPRET_TARGET_LANG_OPTIONS)[number]> {
  return getAvailableTargetLangOptions(sourceLan);
}

export function resolveAsrTranslationView(): AsrTranslationView {
  syncContext();
  const sourceLan = resolveCurrentMainTrackLan();
  const lang = resolveAsrTranslationLang(sourceLan);
  const inFlight = activeAbort !== null;
  const slotState = state.clip.secondarySubtitle.state;
  const hasBody = (state.clip.subtitleBody || []).length > 0;
  if (inFlight) {
    const note =
      progress.total > 0 ? `正在生成译文 ${progress.done}/${progress.total} 片` : "";
    return { lang, inFlight, note, action: null };
  }
  if (slotState === "error") {
    return { lang, inFlight, note: "", action: { label: "重试", kind: "retry" } };
  }
  if (slotState === "ready") {
    if (progress.failed > 0) {
      return {
        lang,
        inFlight,
        note: "译文已生成，部分分片失败",
        action: { label: `补齐失败的 ${progress.failed} 片`, kind: "fill" }
      };
    }
    return { lang, inFlight, note: "", action: null };
  }
  if (!hasBody) {
    return { lang, inFlight, note: "", action: null };
  }
  return { lang, inFlight, note: "", action: { label: "开始生成译文", kind: "start" } };
}

export type AsrTranslationEnsureMode = "cache-only" | "translate";

export interface AsrTranslationEnsureResult {
  kind: "done" | "pending" | "skipped";
}

export async function ensureAsrTranslation(
  mode: AsrTranslationEnsureMode = "cache-only"
): Promise<AsrTranslationEnsureResult> {
  syncContext();
  if (!isTranslationSecondaryScenario(state.clip.subtitles)) {
    return { kind: "skipped" };
  }
  if (mode === "translate") {
    startRequested = true;
  }
  if (activeAbort) {
    return { kind: "skipped" };
  }
  if ((state.clip.subtitleBody || []).length === 0) {
    return { kind: "skipped" };
  }
  const effectiveMode: AsrTranslationEnsureMode = startRequested ? "translate" : mode;
  startRequested = false;
  const lang = resolveAsrTranslationLang();
  const abort = new AbortController();
  activeAbort = abort;
  progress = { total: 0, done: 0, failed: 0 };
  notifyReaderPresenter({ kind: "rerender" });
  try {
    const chain = await ensureSummarizeChain();
    if (abort.signal.aborted) {
      return { kind: "skipped" };
    }
    const result = await chain.ensureAsrTranslation({
      mode: effectiveMode,
      targetLang: lang,
      runId: clipState.fetchRunId,
      signal: abort.signal,
      isStale: () => resolveAsrTranslationLang() !== lang,
      onProgress: (next) => {
        if (activeAbort !== abort) {
          return;
        }
        progress = { total: next.total, done: next.done, failed: next.failed };
        notifyReaderPresenter({ kind: "rerender" });
      }
    });
    return { kind: result.kind === "pending" ? "pending" : "done" };
  } catch (error) {
    logWarn("[BILISCRIPT] subtitle translation failed", error);
    notifyReaderPresenter({ kind: "notice", text: `译文生成失败：${getErrorMessage(error)}` });
    return { kind: "skipped" };
  } finally {
    if (activeAbort === abort) {
      activeAbort = null;
    }
    notifyReaderPresenter({ kind: "rerender" });
  }
}

export function cancelAsrTranslation(): void {
  startRequested = false;
  activeAbort?.abort();
  activeAbort = null;
  progress = { total: 0, done: 0, failed: 0 };
  notifyReaderPresenter({ kind: "rerender" });
}

export function selectAsrTranslationLanguage(value: unknown): void {
  const lang = normalizeAsrTranslationLang(value);
  state.setSettings({ ...state.settings, liveInterpretTargetLang: lang });
  persistReaderSettingsThroughSeam();
  cancelAsrTranslation();
  clipState.clearSecondarySubtitle();
  notifyReaderPresenter({ kind: "rerender" });
  void ensureAsrTranslation("translate");
}

/**
 * 在跨语种多轨视频中激活 AI 精翻覆盖：
 * - `preferManualForeignSource = true`（场景 C：`en-US` + `ai-zh`）：若当前主轨非原版人工外语轨，
 *   先将主轨切到该人工外语轨，并以中文（`zh` / `zh-CN`）作为精翻目标生成独立缓存副轨；
 * - 常规多轨覆盖（场景 A：「改用 AI 重新精翻」）：保持当前主轨，按同族过滤后的目标语言发起精翻。
 */
export async function activateAiTranslationRefine(options?: {
  preferManualForeignSource?: boolean;
}): Promise<AsrTranslationEnsureResult> {
  const tracks = state.clip.subtitles;
  const foreignTrack = options?.preferManualForeignSource
    ? findManualForeignTrackForAiRefine(tracks)
    : null;

  cancelAsrTranslation();
  setAiRefineOverride(true);
  clipState.clearSecondarySubtitle();

  const sourceLan = foreignTrack ? foreignTrack.lan : resolveCurrentMainTrackLan(tracks);
  const nextTargetLang: LiveInterpretTargetLang = foreignTrack
    ? "zh"
    : resolveTargetLang(sourceLan, state.settings.liveInterpretTargetLang);

  state.setSettings({
    ...state.settings,
    bilingualSubtitles: true,
    liveInterpretTargetLang: nextTargetLang
  });
  persistReaderSettingsThroughSeam();

  if (
    foreignTrack &&
    foreignTrack.subtitleUrl &&
    String(state.clip.selectedSubtitleId || "") !== String(foreignTrack.id || "")
  ) {
    const target = resolveTrackTarget(foreignTrack, tracks);
    const chain = await ensureSummarizeChain();
    await chain.loadSubtitle(target.url, target.lang, clipState.fetchRunId, target.id);
    // 换主轨后同步刷新 contextKey，避免 ensureAsrTranslation 把本次覆盖重置
    contextKey = currentContextKey();
  }

  notifyReaderPresenter({ kind: "rerender" });
  return ensureAsrTranslation("translate");
}
