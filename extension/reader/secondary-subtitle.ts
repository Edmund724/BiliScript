import { DEFAULT_SETTINGS, type Settings } from "../core/defaults.js";
import {
  clipState,
  registerSubtitleSessionBoundaryHooks,
  state,
  triggerSubtitleSessionBoundary,
  type SecondarySubtitleState
} from "../core/state.js";
import {
  normalizeBilingualDisplayOrder,
  normalizeLiveInterpretTargetLang
} from "../core/validators.js";
import type { SubtitleTrack } from "../bilibili/gateway.js";
import {
  LIVE_INTERPRET_TARGET_LANG_OPTIONS,
  type LiveInterpretTargetLang
} from "../live/interpret-subtitle-preferences.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";
import { resolveSubtitleLangLabel } from "../subtitle/labels.js";
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import {
  canUseNativeBilingualPair,
  classifySubtitleTrack,
  findManualForeignTrackForAiRefine,
  findSecondaryTrackByPreferredLang,
  findTrackByPreferredLang,
  findTrackByRef,
  getAvailableTargetLangOptions,
  getLangFamily,
  isAsrSubtitleTrack,
  isLoadableNativeTrack,
  isMainSubtitleTrack,
  isSameLangFamily,
  resolveTargetLang,
  resolveTrackTarget,
  type SubtitleTrackOriginLike,
  type SubtitleTrackRef,
  type SubtitleTrackTarget
} from "../subtitle/selection.js";
import { clearSecondary } from "../subtitle/slot.js";
import { notifyReaderPresenter, persistReaderSettingsThroughSeam } from "./reader-bus.js";

export type BilingualSecondaryMode = "native" | "translation";

export interface BilingualAiRefineAction {
  kind: "foreign-refine" | "manual-refine" | "exit-refine";
  label: string;
}

export interface BilingualSecondaryAction {
  kind: "retry" | "start" | "fill";
  label: string;
  disabled: boolean;
}

export type BilingualTranslationOption = (typeof LIVE_INTERPRET_TARGET_LANG_OPTIONS)[number];

export interface BilingualPickerView {
  mode: BilingualSecondaryMode;
  bilingual: boolean;
  switchDisabled: boolean;
  heading: string;
  note: string;
  footerNote: string;
  selectedValue: string;
  selectDisabled: boolean;
  busy: boolean;
  action: BilingualSecondaryAction | null;
  aiRefineAction: BilingualAiRefineAction | null;
  translationOptions: ReadonlyArray<BilingualTranslationOption>;
}

export type SecondaryTarget = SubtitleTrackTarget;

export type SecondaryTargetMissReason = "no-preference" | "no-track" | "main-track";

export type SecondaryEnsureSkipReason = SecondaryTargetMissReason | "bilingual-off" | "slot-busy";

export interface SecondaryLoadSettlement {
  error: unknown | null;
}

export interface TranslationEnsureResult {
  kind: "done" | "pending" | "skipped";
}

export type SecondaryEnsureOutcome =
  | { kind: "started"; target: SecondaryTarget; settled: Promise<SecondaryLoadSettlement> }
  | { kind: "translation"; settled: Promise<TranslationEnsureResult> }
  | { kind: "skipped"; reason: SecondaryEnsureSkipReason };

export interface SecondaryOptionSelection extends SubtitleTrackRef {
  value?: string;
}

export type SecondarySelectionOutcome =
  | { kind: "started"; target: SecondaryTarget; settled: Promise<SecondaryLoadSettlement> }
  | { kind: "translation"; settled: Promise<TranslationEnsureResult> }
  | { kind: "main-track" }
  | { kind: "skipped"; reason: "in-flight" | "no-track" };

export interface BilingualStorageSyncResult {
  changed: boolean;
  loadOutcome: SecondaryEnsureOutcome;
}

const SUB_HEAD_TEXT_TRACK = "副字幕";
const SUB_HEAD_TEXT_TRANSLATION = "译文";
const SECONDARY_EMPTY_PICK_TEXT = "选择副字幕语言";
const SECONDARY_COLLISION_TEXT = "主副字幕相同";
const SECONDARY_MISSING_PREFIX = "本视频没有";
const SECONDARY_MISSING_SUFFIX = "轨";
const SECONDARY_RETRY_TEXT = "加载失败 · 重试";

type SecondaryTargetResolution =
  | { kind: "target"; target: SecondaryTarget }
  | { kind: "none"; reason: SecondaryTargetMissReason };

type TranslationEnsureMode = "cache-only" | "translate";

function currentTracks(): SubtitleTrack[] {
  return state.clip.subtitles || [];
}

function hasAsrPseudoTrack(
  tracks: ReadonlyArray<SubtitleTrackOriginLike | null | undefined> | null | undefined
): boolean {
  return (tracks || []).some((track) => isAsrSubtitleTrack(track));
}

function isCurrentMainTrackAsr(
  tracks: ReadonlyArray<{ id?: string; lan?: string; subtitleUrl?: string; source?: string; origin?: string }> | null | undefined = state.clip.subtitles
): boolean {
  const selectedId = String(state.clip.selectedSubtitleId || "").trim();
  const selectedUrl = String(state.clip.selectedSubtitleUrl || "").trim();
  if (!selectedId && !selectedUrl) {
    return false;
  }
  const current = findTrackByRef(tracks, { id: selectedId, url: selectedUrl });
  return current
    ? isAsrSubtitleTrack(current)
    : isAsrSubtitleTrack({ id: selectedId, subtitleUrl: selectedUrl });
}

function resolveCurrentMainTrackLan(
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

function isBilingualSwitchDisabled(tracks: SubtitleTrack[]): boolean {
  return tracks.filter(isLoadableNativeTrack).length === 0 && !hasAsrPseudoTrack(tracks);
}

let loadToken = 0;
const inFlightLoads = new Set<number>();

function isSecondarySubtitleLoadInFlight(): boolean {
  return inFlightLoads.size > 0;
}

function resolveSecondaryTarget(ref?: SubtitleTrackRef): SecondaryTargetResolution {
  const tracks = currentTracks();
  const mainId = state.clip.selectedSubtitleId;
  const mainTrack = mainId
    ? tracks.find((item) => String(item?.id || "") === String(mainId)) ?? null
    : null;
  if (ref) {
    const track = findTrackByRef(tracks, ref);
    if (
      isMainSubtitleTrack(track ?? ref, mainId) ||
      (mainTrack && isSameLangFamily((track ?? ref)?.lan ?? ref.lang, mainTrack.lan))
    ) {
      return { kind: "none", reason: "main-track" };
    }
    if (!track && !String(ref.url || "")) {
      return { kind: "none", reason: "no-track" };
    }
    return { kind: "target", target: resolveTrackTarget(track ?? ref) };
  }

  if (!canUseNativeBilingualPair(tracks, state.clip.site)) {
    return { kind: "none", reason: "no-track" };
  }

  const pick = String(state.settings.secondarySubtitleLang || "").trim();
  if (!pick) {
    return { kind: "none", reason: "no-preference" };
  }
  const track = findSecondaryTrackByPreferredLang(tracks, pick, mainId);
  if (track) {
    return { kind: "target", target: resolveTrackTarget(track) };
  }
  if (
    mainTrack &&
    pick === DEFAULT_SETTINGS.secondarySubtitleLang &&
    isSameLangFamily(pick, mainTrack.lan) &&
    getLangFamily(mainTrack.lan) !== "zh"
  ) {
    const zhPartner = findSecondaryTrackByPreferredLang(tracks, "zh-CN", mainId);
    if (zhPartner) {
      return { kind: "target", target: resolveTrackTarget(zhPartner) };
    }
  }
  return { kind: "none", reason: findTrackByPreferredLang(tracks, pick) ? "main-track" : "no-track" };
}

function startNativeSecondaryLoad(target: SecondaryTarget, forceRefresh: boolean): SecondaryEnsureOutcome {
  const token = ++loadToken;
  const expectedRunId = state.clip.fetchRunId;
  inFlightLoads.add(token);
  const settled = (async (): Promise<SecondaryLoadSettlement> => {
    let error: unknown = null;
    try {
      const chain = await ensureSummarizeChain();
      await chain.loadSecondarySubtitle(target.url, target.lang, expectedRunId, target.id, forceRefresh);
    } catch (failure) {
      error = failure;
      logWarn("[BILISCRIPT] failed to load secondary subtitle", failure);
    } finally {
      inFlightLoads.delete(token);
    }
    return { error };
  })();
  return { kind: "started", target, settled };
}

function ensureNativeSecondaryLoaded(options?: {
  target?: SecondaryTarget;
  forceRefresh?: boolean;
}): SecondaryEnsureOutcome {
  const target = options?.target;
  const forceRefresh = options?.forceRefresh === true;
  if (target) {
    return startNativeSecondaryLoad(target, forceRefresh);
  }
  if (state.settings.bilingualSubtitles !== true) {
    return { kind: "skipped", reason: "bilingual-off" };
  }
  if (isTranslationSecondaryScenario(currentTracks())) {
    return { kind: "skipped", reason: "no-track" };
  }
  const slot = state.clip.secondarySubtitle;
  if (!slot || slot.state !== "idle") {
    return { kind: "skipped", reason: "slot-busy" };
  }
  const resolution = resolveSecondaryTarget();
  if (resolution.kind === "none") {
    return { kind: "skipped", reason: resolution.reason };
  }
  return startNativeSecondaryLoad(resolution.target, forceRefresh);
}

function activatePreferredNativeSecondary(): SecondaryEnsureOutcome {
  if (isSecondarySubtitleLoadInFlight()) {
    return { kind: "skipped", reason: "slot-busy" };
  }
  return ensureNativeSecondaryLoaded();
}

function clearSecondarySubtitleIfShadowedByMain(): boolean {
  const slot = state.clip.secondarySubtitle;
  const tracks = currentTracks();
  const isStaleTranslatedSlot =
    !isTranslationSecondaryScenario(tracks) &&
    !slot.url &&
    (Boolean(slot.id) || slot.state !== "idle");
  const mainTrack = findTrackByRef(tracks, { id: state.clip.selectedSubtitleId, url: state.clip.selectedSubtitleUrl });
  const subTrack = slot.url ? findTrackByRef(tracks, { id: slot.id, url: slot.url }) : null;
  if (
    !isStaleTranslatedSlot &&
    !isMainSubtitleTrack(slot, state.clip.selectedSubtitleId) &&
    !(mainTrack && subTrack && isSameLangFamily(mainTrack.lan, subTrack.lan))
  ) {
    return false;
  }
  clearSecondary();
  return true;
}

let activeAbort: AbortController | null = null;
let progress: { total: number; done: number; failed: number } = { total: 0, done: 0, failed: 0 };
let startRequested = false;
let contextKey = "";
let aiRefineVideoKey = "";

function currentVideoKey(): string {
  return `${state.clip.site}|${state.clip.bvid}|${state.clip.cid}`;
}

function currentContextKey(): string {
  return `${state.clip.site}|${state.clip.bvid}|${state.clip.cid}|${clipState.fetchRunId}|${state.clip.selectedSubtitleId}`;
}

function syncTranslationContext(): void {
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

function isAiRefineOverrideActive(): boolean {
  const key = currentVideoKey();
  return Boolean(aiRefineVideoKey && aiRefineVideoKey === key);
}

function setAiRefineOverride(enabled: boolean): void {
  aiRefineVideoKey = enabled ? currentVideoKey() : "";
}

function isTranslationSecondaryScenario(
  tracks: ReadonlyArray<{ id?: string; lan?: string; subtitleUrl?: string; source?: string; origin?: string; kind?: string; site?: string }> | null | undefined = state.clip.subtitles
): boolean {
  const list = tracks || [];
  const loadableNative = list.filter(isLoadableNativeTrack);
  const canPairNative = canUseNativeBilingualPair(list, state.clip.site);
  if (isAiRefineOverrideActive() && (loadableNative.length > 0 || hasAsrPseudoTrack(list))) {
    return true;
  }
  if (
    hasAsrPseudoTrack(list) &&
    (loadableNative.length === 0 || !canPairNative || isCurrentMainTrackAsr(list))
  ) {
    return true;
  }
  return loadableNative.length > 0 && !canPairNative;
}

function resolveTranslationLang(
  sourceLan: unknown = resolveCurrentMainTrackLan()
): LiveInterpretTargetLang {
  return resolveTargetLang(sourceLan, state.settings.liveInterpretTargetLang);
}

function cancelTranslationInternal(options: { notify?: boolean } = {}): void {
  startRequested = false;
  activeAbort?.abort();
  activeAbort = null;
  progress = { total: 0, done: 0, failed: 0 };
  if (options.notify !== false) {
    notifyReaderPresenter({ kind: "rerender" });
  }
}

async function ensureTranslation(
  mode: TranslationEnsureMode = "cache-only"
): Promise<TranslationEnsureResult> {
  syncTranslationContext();
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
  const effectiveMode: TranslationEnsureMode = startRequested ? "translate" : mode;
  startRequested = false;
  const lang = resolveTranslationLang();
  const abort = new AbortController();
  activeAbort = abort;
  const unregisterBoundary = registerSubtitleSessionBoundaryHooks({
    onAbortAndClear: () => cancelTranslationInternal()
  });
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
      isStale: () => resolveTranslationLang() !== lang,
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
    if (abort.signal.aborted) {
      return { kind: "skipped" };
    }
    logWarn("[BILISCRIPT] subtitle translation failed", error);
    notifyReaderPresenter({ kind: "notice", text: `译文生成失败：${getErrorMessage(error)}` });
    return { kind: "skipped" };
  } finally {
    unregisterBoundary();
    if (activeAbort === abort) {
      activeAbort = null;
    }
    notifyReaderPresenter({ kind: "rerender" });
  }
}

async function activateAiTranslationRefineInternal(options?: {
  preferManualForeignSource?: boolean;
}): Promise<TranslationEnsureResult> {
  const tracks = currentTracks();
  const foreignTrack = options?.preferManualForeignSource
    ? findManualForeignTrackForAiRefine(tracks)
    : null;

  cancelTranslationInternal({ notify: false });
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
    contextKey = currentContextKey();
  } else {
    await triggerSubtitleSessionBoundary("processing-switch");
  }

  notifyReaderPresenter({ kind: "rerender" });
  return ensureTranslation("translate");
}

function resolveAiRefineAction(tracks: SubtitleTrack[]): BilingualAiRefineAction | null {
  if (!canUseNativeBilingualPair(tracks, state.clip.site) || isCurrentMainTrackAsr(tracks)) {
    return null;
  }
  if (isAiRefineOverrideActive()) {
    return { kind: "exit-refine", label: "返回原生副字幕" };
  }
  if (findManualForeignTrackForAiRefine(tracks)) {
    return { kind: "foreign-refine", label: "基于原版外语轨 AI 精翻" };
  }
  return { kind: "manual-refine", label: "改用 AI 重新精翻" };
}

export function resolveBilingualPickerView(): BilingualPickerView {
  syncTranslationContext();
  const tracks = currentTracks();
  const bilingual = state.settings.bilingualSubtitles === true;
  const switchDisabled = isBilingualSwitchDisabled(tracks);
  const translationScenario = isTranslationSecondaryScenario(tracks);
  const aiRefineAction = resolveAiRefineAction(tracks);
  const slotState: SecondarySubtitleState = state.clip.secondarySubtitle.state;

  if (translationScenario) {
    const sourceLan = resolveCurrentMainTrackLan(tracks);
    const lang = resolveTranslationLang(sourceLan);
    const translationOptions = getAvailableTargetLangOptions(sourceLan);
    const inFlight = activeAbort !== null;
    const hasBody = (state.clip.subtitleBody || []).length > 0;
    let note = "";
    let action: BilingualSecondaryAction | null = null;

    if (inFlight) {
      note = progress.total > 0 ? `正在生成译文 ${progress.done}/${progress.total} 片` : "";
    } else if (slotState === "error") {
      action = { kind: "retry", label: "重试", disabled: false };
    } else if (slotState === "ready") {
      if (progress.failed > 0) {
        note = "译文已生成，部分分片失败";
        action = { kind: "fill", label: `补齐失败的 ${progress.failed} 片`, disabled: false };
      }
    } else if (hasBody) {
      action = { kind: "start", label: "开始生成译文", disabled: false };
    }

    return {
      mode: "translation",
      bilingual,
      switchDisabled,
      heading: SUB_HEAD_TEXT_TRANSLATION,
      note,
      footerNote: "",
      selectedValue: lang,
      selectDisabled: false,
      busy: inFlight,
      action,
      aiRefineAction,
      translationOptions
    };
  }

  const resolution = resolveSecondaryTarget();
  const busy = isSecondarySubtitleLoadInFlight() || slotState === "loading";
  let note = "";
  let footerNote = "";
  let selectedValue = "";
  let action: BilingualSecondaryAction | null = null;

  if (resolution.kind === "none") {
    if (resolution.reason === "no-preference") {
      note = SECONDARY_EMPTY_PICK_TEXT;
    } else if (resolution.reason === "no-track") {
      const pick = String(state.settings.secondarySubtitleLang || "").trim();
      const label = resolveSubtitleLangLabel(pick);
      const name = label === pick ? ` ${label} ` : label;
      note = `${SECONDARY_MISSING_PREFIX}${name}${SECONDARY_MISSING_SUFFIX}`;
    } else {
      footerNote = SECONDARY_COLLISION_TEXT;
    }
  } else {
    selectedValue = resolution.target.url;
    if (slotState === "error") {
      action = { kind: "retry", label: SECONDARY_RETRY_TEXT, disabled: false };
    }
  }

  return {
    mode: "native",
    bilingual,
    switchDisabled,
    heading: SUB_HEAD_TEXT_TRACK,
    note,
    footerNote,
    selectedValue,
    selectDisabled: busy,
    busy,
    action,
    aiRefineAction,
    translationOptions: []
  };
}

export function ensureSecondarySubtitleForCurrentClip(): SecondaryEnsureOutcome {
  if (state.settings.bilingualSubtitles !== true) {
    return { kind: "skipped", reason: "bilingual-off" };
  }
  if (isTranslationSecondaryScenario(currentTracks())) {
    return { kind: "translation", settled: ensureTranslation("cache-only") };
  }
  return ensureNativeSecondaryLoaded();
}

export function handleMainSubtitleSwitched(switched: boolean): SecondaryEnsureOutcome {
  if (!switched) {
    clearSecondarySubtitleIfShadowedByMain();
    return { kind: "skipped", reason: "bilingual-off" };
  }
  const nextTranslationScenario = isTranslationSecondaryScenario(currentTracks());
  if (nextTranslationScenario) {
    cancelTranslationInternal({ notify: false });
    clipState.clearSecondarySubtitle();
    if (state.settings.bilingualSubtitles === true) {
      return { kind: "translation", settled: ensureTranslation("cache-only") };
    }
    return { kind: "skipped", reason: "bilingual-off" };
  }
  cancelTranslationInternal({ notify: false });
  clearSecondarySubtitleIfShadowedByMain();
  if (state.settings.bilingualSubtitles === true) {
    return activatePreferredNativeSecondary();
  }
  return { kind: "skipped", reason: "bilingual-off" };
}

export function toggleBilingualSubtitles(
  enabled: boolean = state.settings.bilingualSubtitles !== true
): SecondaryEnsureOutcome {
  state.setSettings({ ...state.settings, bilingualSubtitles: enabled });
  persistReaderSettingsThroughSeam();
  if (isTranslationSecondaryScenario(currentTracks())) {
    if (enabled) {
      const settled = ensureTranslation("translate");
      notifyReaderPresenter({ kind: "rerender" });
      return { kind: "translation", settled };
    }
    cancelTranslationInternal({ notify: false });
    notifyReaderPresenter({ kind: "rerender" });
    return { kind: "skipped", reason: "bilingual-off" };
  }
  const outcome: SecondaryEnsureOutcome = enabled
    ? activatePreferredNativeSecondary()
    : { kind: "skipped", reason: "bilingual-off" };
  notifyReaderPresenter({ kind: "rerender" });
  return outcome;
}

export function selectSecondaryOption(selection: SecondaryOptionSelection): SecondarySelectionOutcome {
  if (isTranslationSecondaryScenario(currentTracks())) {
    const rawValue = selection.value ?? selection.lang;
    const lang = resolveTargetLang(resolveCurrentMainTrackLan(), rawValue);
    state.setSettings({ ...state.settings, liveInterpretTargetLang: lang });
    persistReaderSettingsThroughSeam();
    cancelTranslationInternal({ notify: false });
    void triggerSubtitleSessionBoundary("processing-switch");
    clipState.clearSecondarySubtitle();
    notifyReaderPresenter({ kind: "rerender" });
    return { kind: "translation", settled: ensureTranslation("translate") };
  }

  if (isSecondarySubtitleLoadInFlight()) {
    return { kind: "skipped", reason: "in-flight" };
  }
  const url = String(selection.url || selection.value || "");
  if (!url) {
    return { kind: "skipped", reason: "no-track" };
  }
  setAiRefineOverride(false);
  cancelTranslationInternal({ notify: false });
  const lang = String(selection.lang || "");
  state.setSettings({ ...state.settings, secondarySubtitleLang: lang });
  persistReaderSettingsThroughSeam();
  const resolution = resolveSecondaryTarget({ id: selection.id, url, lang });
  if (resolution.kind === "none") {
    if (resolution.reason === "main-track") {
      clearSecondary();
      notifyReaderPresenter({ kind: "rerender" });
      return { kind: "main-track" };
    }
    return { kind: "skipped", reason: "no-track" };
  }
  const outcome = ensureNativeSecondaryLoaded({ target: resolution.target });
  if (outcome.kind !== "started") {
    return { kind: "skipped", reason: "no-track" };
  }
  return outcome;
}

export function triggerSecondaryAction(): SecondaryEnsureOutcome {
  if (isTranslationSecondaryScenario(currentTracks())) {
    return { kind: "translation", settled: ensureTranslation("translate") };
  }
  if (isSecondarySubtitleLoadInFlight()) {
    return { kind: "skipped", reason: "slot-busy" };
  }
  const resolution = resolveSecondaryTarget();
  if (resolution.kind === "none") {
    return { kind: "skipped", reason: resolution.reason };
  }
  return ensureNativeSecondaryLoaded({ target: resolution.target, forceRefresh: true });
}

export function triggerAiRefineAction(kind: BilingualAiRefineAction["kind"]): SecondaryEnsureOutcome {
  if (kind === "exit-refine") {
    setAiRefineOverride(false);
    cancelTranslationInternal({ notify: false });
    clearSecondary();
    const outcome = activatePreferredNativeSecondary();
    notifyReaderPresenter({ kind: "rerender" });
    return outcome;
  }
  return {
    kind: "translation",
    settled: activateAiTranslationRefineInternal({
      preferManualForeignSource: kind === "foreign-refine"
    })
  };
}

export function syncBilingualSettingsFromStorage(
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>
): BilingualStorageSyncResult {
  const bilingual = changes["bilingualSubtitles"];
  const lang = changes["secondarySubtitleLang"];
  const translateLang = changes["liveInterpretTargetLang"];
  const displayOrder = changes["bilingualDisplayOrder"];
  if (!bilingual && !lang && !translateLang && !displayOrder) {
    return {
      changed: false,
      loadOutcome: { kind: "skipped", reason: "bilingual-off" }
    };
  }
  const updates: Partial<Settings> = {};
  if (bilingual) {
    updates.bilingualSubtitles = bilingual.newValue === true;
  }
  if (lang && typeof lang.newValue === "string") {
    updates.secondarySubtitleLang = lang.newValue;
  }
  if (translateLang && typeof translateLang.newValue === "string") {
    updates.liveInterpretTargetLang = normalizeLiveInterpretTargetLang(translateLang.newValue);
  }
  if (displayOrder && typeof displayOrder.newValue === "string") {
    updates.bilingualDisplayOrder = normalizeBilingualDisplayOrder(displayOrder.newValue);
  }
  state.setSettings({ ...state.settings, ...updates });
  const loadOutcome: SecondaryEnsureOutcome =
    state.settings.bilingualSubtitles === true
      ? activatePreferredNativeSecondary()
      : { kind: "skipped", reason: "bilingual-off" };
  if (displayOrder) {
    notifyReaderPresenter({ kind: "rerender" });
  }
  return { changed: true, loadOutcome };
}
