import { DEFAULT_SETTINGS, type Settings } from "../core/defaults.js";
import { state } from "../core/state.js";
import type { SecondarySubtitleState } from "../core/state.js";
import { logWarn } from "../shared/logging.js";
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import { resolveSubtitleLangLabel } from "../subtitle/labels.js";
import {
  findSecondaryTrackByPreferredLang,
  findTrackByPreferredLang,
  findTrackByRef,
  getLangFamily,
  isMainSubtitleTrack,
  isMonolingualNativeTracks,
  isSameLangFamily,
  resolveTrackTarget,
  type SubtitleTrackRef,
  type SubtitleTrackTarget
} from "../subtitle/selection.js";
import { clearSecondary } from "../subtitle/slot.js";
import type { SubtitleTrack } from "../bilibili/gateway.js";
import {
  normalizeBilingualDisplayOrder,
  normalizeLiveInterpretTargetLang
} from "../core/validators.js";
import {
  cancelAsrTranslation,
  ensureAsrTranslation,
  isTranslationSecondaryScenario,
  setAiRefineOverride
} from "./asr-translation.js";
import { notifyReaderPresenter, persistReaderSettingsThroughSeam } from "./reader-bus.js";

export type SecondaryTarget = SubtitleTrackTarget;

export type SecondaryTargetMissReason = "no-preference" | "no-track" | "main-track";

export type SecondaryTargetResolution =
  | { kind: "target"; target: SecondaryTarget }
  | { kind: "none"; reason: SecondaryTargetMissReason };

export type SecondaryTrackRef = SubtitleTrackRef;

export type SecondaryEnsureSkipReason = SecondaryTargetMissReason | "bilingual-off" | "slot-busy";

export interface SecondaryLoadSettlement {
  error: unknown | null;
}

export type SecondaryEnsureOutcome =
  | { kind: "started"; target: SecondaryTarget; settled: Promise<SecondaryLoadSettlement> }
  | { kind: "skipped"; reason: SecondaryEnsureSkipReason };

export interface EnsureSecondaryOptions {
  target?: SecondaryTarget;
  forceRefresh?: boolean;
}

function currentTracks(): SubtitleTrack[] {
  return (state.clip.subtitles || []) as unknown as SubtitleTrack[];
}

export function resolveSecondaryTarget(ref?: SecondaryTrackRef): SecondaryTargetResolution {
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

  if (isMonolingualNativeTracks(tracks)) {
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

const SECONDARY_EMPTY_PICK_TEXT = "选择副字幕语言";
const SECONDARY_COLLISION_TEXT = "主副字幕相同";
const SECONDARY_MISSING_PREFIX = "本视频没有";
const SECONDARY_MISSING_SUFFIX = "轨";

export interface SecondaryColumnView {
  note: string;
  footerNote: string;
  selectedUrl: string;
  retry: boolean;
  busy: boolean;
}

export interface SecondaryColumnInput {
  resolution: SecondaryTargetResolution;
  preferenceLang: string;
  slotState: SecondarySubtitleState;
  loadInFlight: boolean;
}

export function resolveSecondaryColumnView({
  resolution,
  preferenceLang,
  slotState,
  loadInFlight
}: SecondaryColumnInput): SecondaryColumnView {
  const busy = loadInFlight || slotState === "loading";
  const view: SecondaryColumnView = { note: "", footerNote: "", selectedUrl: "", retry: false, busy };
  if (resolution.kind === "none") {
    if (resolution.reason === "no-preference") {
      return { ...view, note: SECONDARY_EMPTY_PICK_TEXT };
    }
    if (resolution.reason === "no-track") {
      const pick = String(preferenceLang || "").trim();
      const label = resolveSubtitleLangLabel(pick);
      const name = label === pick ? ` ${label} ` : label;
      return { ...view, note: `${SECONDARY_MISSING_PREFIX}${name}${SECONDARY_MISSING_SUFFIX}` };
    }
    return { ...view, footerNote: SECONDARY_COLLISION_TEXT };
  }
  return { ...view, selectedUrl: resolution.target.url, retry: slotState === "error" };
}

let loadToken = 0;
const inFlightLoads = new Set<number>();

export function isSecondarySubtitleLoadInFlight(): boolean {
  return inFlightLoads.size > 0;
}

function startSecondaryLoad(target: SecondaryTarget, forceRefresh: boolean): SecondaryEnsureOutcome {
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

export function ensureSecondarySubtitleLoaded(options?: EnsureSecondaryOptions): SecondaryEnsureOutcome {
  const target = options?.target;
  const forceRefresh = options?.forceRefresh === true;
  if (target) {
    return startSecondaryLoad(target, forceRefresh);
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
  return startSecondaryLoad(resolution.target, forceRefresh);
}

export function clearSecondarySubtitleIfShadowedByMain(): boolean {
  const slot = state.clip.secondarySubtitle;
  const tracks = currentTracks();
  const mainTrack = findTrackByRef(tracks, { id: state.clip.selectedSubtitleId, url: state.clip.selectedSubtitleUrl });
  const subTrack = slot.url ? findTrackByRef(tracks, { id: slot.id, url: slot.url }) : null;
  if (
    !isMainSubtitleTrack(slot, state.clip.selectedSubtitleId) &&
    !(mainTrack && subTrack && isSameLangFamily(mainTrack.lan, subTrack.lan))
  ) {
    return false;
  }
  clearSecondary();
  return true;
}

export type SecondarySelectionOutcome =
  | { kind: "started"; target: SecondaryTarget; settled: Promise<SecondaryLoadSettlement> }
  | { kind: "main-track" }
  | { kind: "skipped"; reason: "in-flight" | "no-track" };

export function selectSecondarySubtitleTrack(ref: SecondaryTrackRef): SecondarySelectionOutcome {
  if (isSecondarySubtitleLoadInFlight()) {
    return { kind: "skipped", reason: "in-flight" };
  }
  const url = String(ref.url || "");
  if (!url) {
    return { kind: "skipped", reason: "no-track" };
  }
  setAiRefineOverride(false);
  cancelAsrTranslation();
  const lang = String(ref.lang || "");
  state.setSettings({ ...state.settings, secondarySubtitleLang: lang });
  persistReaderSettingsThroughSeam();
  const resolution = resolveSecondaryTarget(ref);
  if (resolution.kind === "none") {
    if (resolution.reason === "main-track") {
      clearSecondary();
      notifyReaderPresenter({ kind: "rerender" });
      return { kind: "main-track" };
    }
    return { kind: "skipped", reason: "no-track" };
  }
  const outcome = ensureSecondarySubtitleLoaded({ target: resolution.target });
  if (outcome.kind !== "started") {
    return { kind: "skipped", reason: "no-track" };
  }
  return outcome;
}

function activatePreferredSecondaryTarget(): SecondaryEnsureOutcome {
  if (isSecondarySubtitleLoadInFlight()) {
    return { kind: "skipped", reason: "slot-busy" };
  }
  return ensureSecondarySubtitleLoaded();
}

export function exitAiRefineAndLoadNativeSecondary(): SecondaryEnsureOutcome {
  setAiRefineOverride(false);
  cancelAsrTranslation();
  clearSecondary();
  const outcome = activatePreferredSecondaryTarget();
  notifyReaderPresenter({ kind: "rerender" });
  return outcome;
}

export function toggleBilingualSubtitles(
  enabled: boolean = state.settings.bilingualSubtitles !== true
): SecondaryEnsureOutcome {
  state.setSettings({ ...state.settings, bilingualSubtitles: enabled });
  persistReaderSettingsThroughSeam();
  const translationScenario = isTranslationSecondaryScenario(currentTracks());
  if (translationScenario) {
    if (enabled) {
      void ensureAsrTranslation("translate");
    } else {
      cancelAsrTranslation();
    }
    notifyReaderPresenter({ kind: "rerender" });
    return { kind: "skipped", reason: enabled ? "no-track" : "bilingual-off" };
  }
  const outcome: SecondaryEnsureOutcome = enabled
    ? activatePreferredSecondaryTarget()
    : { kind: "skipped", reason: "bilingual-off" };
  notifyReaderPresenter({ kind: "rerender" });
  return outcome;
}

export function retrySecondarySubtitleLoad(): SecondaryEnsureOutcome {
  if (isSecondarySubtitleLoadInFlight()) {
    return { kind: "skipped", reason: "slot-busy" };
  }
  const resolution = resolveSecondaryTarget();
  if (resolution.kind === "none") {
    return { kind: "skipped", reason: resolution.reason };
  }
  return ensureSecondarySubtitleLoaded({ target: resolution.target, forceRefresh: true });
}

export interface BilingualStorageSyncResult {
  changed: boolean;
  loadOutcome: SecondaryEnsureOutcome;
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
      ? activatePreferredSecondaryTarget()
      : { kind: "skipped", reason: "bilingual-off" };
  if (displayOrder) {
    notifyReaderPresenter({ kind: "rerender" });
  }
  return { changed: true, loadOutcome };
}
