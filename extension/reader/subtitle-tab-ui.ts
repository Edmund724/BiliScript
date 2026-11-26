import { activeById, onActiveHostChange } from "../shared/active-host.js";
import {
  isEditableTarget,
  isHtmlElement,
  requireActiveById,
  resolveNodeDocument,
  resolveNodeWindow,
  safeRemoveListener,
} from "../shared/cross-doc.js";
import { logWarn } from "../shared/logging.js";
import { escapeHtml } from "../shared/string-utils.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { ensureBilingualSubtitleStyles } from "../shared/style-injector.js";
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import {
  formatSubtitleTrackOptionLabel,
  resolveSubtitleTrackLabel,
  shouldMarkAiSubtitleTracks
} from "../subtitle/labels.js";
import {
  isLoadableNativeTrack,
  resolveSubtitleTrackOrigin,
  resolveTrackTarget,
  type SubtitleTrackOrigin
} from "../subtitle/selection.js";
import type { SubtitleTrack } from "../bilibili/gateway.js";
import { isReadingSubtitleBodyVisible, ids } from "./state.js";
import {
  FOLLOW_BUTTON_LABEL,
  isElementScrollable,
  isPointerOnVerticalScrollbar,
  projectReaderFollowUi,
  subtitleScrollFollow
} from "./subtitle-scroll-follow.js";
import { READER_SETTINGS_WATCH_KEYS } from "./presentation-fields.js";
import { state } from "../core/state.js";
import { withReader } from "../ui/reader-gate.js";
import { initCustomSelect, rebuildCustomSelectOptions, setCustomSelectSlots, setCustomSelectState, setCustomSelectValue } from "../ui/custom-select.js";
import { READING_COPY_ICON, READING_DOWNLOAD_ICON } from "../ui/reading-icons.js";
import { flashCopyFailure, flashCopySuccess } from "../ui/copy-feedback.js";
import {
  handleMainSubtitleSwitched,
  resolveBilingualPickerView,
  selectSecondaryOption,
  syncBilingualSettingsFromStorage,
  toggleBilingualSubtitles,
  triggerAiRefineAction,
  triggerSecondaryAction,
  type BilingualPickerView,
  type BilingualTranslationOption,
  type SecondaryEnsureOutcome
} from "./secondary-subtitle.js";
import { beginReaderAsrSetupFlow } from "./setup-resume.js";
import { playTrackSwitchAnimation } from "./track-switch-animation.js";
import { TRANSCRIBE_BANNER_COPY, isReaderTranscribing } from "./transcribe-banner.js";
import { subscribeSubtitleStatusPhase } from "../shared/subtitle-status-bus.js";
import { removeSubtitleItemHighlight } from "./subtitle-highlights-ui.js";
import { showSubtitleNotice } from "./subtitle-notice.js";

ensureBilingualSubtitleStyles();

export function buildSubtitleTabBodyHtml(): string {
  return `
            <div class="biliscript-reading-sub-toolbar">
              <div class="biliscript-reading-search">
                <input
                  id="${ids.readingSearchInput}"
                  class="biliscript-reading-search-input"
                  type="text"
                  placeholder="搜索字幕…"
                  aria-label="搜索字幕"
                />
                <button
                  id="${ids.readingSearchClearBtn}"
                  type="button"
                  class="biliscript-reading-search-clear"
                  title="清空搜索"
                  aria-label="清空搜索"
                  hidden
                >×</button>
                <span id="${ids.readingSearchCount}" class="biliscript-reading-search-count" aria-live="polite"></span>
                <button
                  id="${ids.readingSearchPrevBtn}"
                  type="button"
                  class="biliscript-reading-search-nav"
                  title="上一条（Shift+Enter）"
                  aria-label="上一条搜索结果"
                  disabled
                >↑</button>
                <button
                  id="${ids.readingSearchNextBtn}"
                  type="button"
                  class="biliscript-reading-search-nav"
                  title="下一条（Enter）"
                  aria-label="下一条搜索结果"
                  disabled
                >↓</button>
              </div>
              <select
                id="${ids.readingSubtitleSelect}"
                class="biliscript-reading-track-select"
                aria-label="${SUBTITLE_TRACK_FIELD_LABEL}"
              ></select>
              <button id="${ids.readingCopySubtitleBtn}" type="button" class="biliscript-reading-icon-btn" title="复制字幕" aria-label="复制字幕">${READING_COPY_ICON}</button>
              <button id="${ids.readingExportSubtitleBtn}" type="button" class="biliscript-reading-icon-btn" title="导出字幕" aria-label="导出字幕">${READING_DOWNLOAD_ICON}</button>
            </div>

            <p id="${ids.readingSubtitleNotice}" class="biliscript-reading-subtitle-notice" role="alert" hidden></p>

            <aside id="${ids.readingTranscribeBanner}" class="biliscript-reading-asr-banner" role="status" aria-live="polite" hidden>
              <div id="${ids.readingTranscribeBannerTitle}" class="biliscript-reading-asr-title">${TRANSCRIBE_BANNER_COPY["asr-transcribing"].title}</div>
              <p id="${ids.readingTranscribeBannerCopy}" class="biliscript-reading-asr-copy">${TRANSCRIBE_BANNER_COPY["asr-transcribing"].copy}</p>
              <div class="biliscript-reading-asr-track" aria-hidden="true"><div class="biliscript-reading-asr-fill"></div></div>
              <div id="${ids.readingTranscribeProgress}" class="biliscript-reading-asr-foot">正在准备转写…</div>
            </aside>

            <section class="biliscript-reading-main">
              <div id="${ids.readingSubtitleList}" class="biliscript-reading-subtitle"></div>
            </section>

            <button id="${ids.readingFollowBtn}" type="button" class="biliscript-reading-follow-btn"><span class="biliscript-reading-follow-label">${FOLLOW_BUTTON_LABEL}</span><span class="biliscript-reading-follow-meta" hidden><span class="biliscript-reading-follow-sep" aria-hidden="true"> · </span><span class="biliscript-reading-follow-time"></span></span></button>
  `;
}

const SUBTITLE_TRACK_SENTINEL_VALUE = "";
const SUBTITLE_TRACK_EMPTY_TEXT = "暂无字幕";
const SUBTITLE_TRACK_TRANSCRIBING_TEXT = "转写中…";
const SUBTITLE_TRACK_LOADING_TEXT = "抓取中…";

const SUBTITLE_TRACK_FIELD_LABEL = "字幕轨";

function findTrackValueById(trackId: string): string {
  const select = activeById<HTMLSelectElement>(ids.readingSubtitleSelect);
  if (!select) {
    return "";
  }
  const option = [...select.options].find((item) => item.dataset.id === trackId);
  return option?.value || "";
}

function buildSubtitleTrackOptionHtml(track: SubtitleTrack, marked: boolean, selected: boolean): string {
  const bareLabel = resolveSubtitleTrackLabel(track);
  const text = formatSubtitleTrackOptionLabel(track, marked);
  const origin = resolveSubtitleTrackOrigin(track);
  const triggerAttr = text !== bareLabel ? ` data-trigger-label="${escapeHtml(bareLabel)}"` : "";
  return `<option value="${escapeHtml(track.subtitleUrl || "")}" data-lang="${escapeHtml(
    track.lan || ""
  )}" data-id="${escapeHtml(track.id || "")}" data-origin="${escapeHtml(origin)}"${triggerAttr} dir="auto"${selected ? " selected" : ""}>${escapeHtml(text)}</option>`;
}

export interface SubtitleToolbarFacts {
  tracks: SubtitleTrack[];
  transcribing: boolean;
  loading: boolean;
  marked: boolean;
  selectedTrackId: string;
  switchInFlight: string | null;
  bilingualPicker: BilingualPickerView;
}

export function selectSubtitleToolbarFacts(switchInFlight: string | null = null): SubtitleToolbarFacts {
  const tracks = state.clip.subtitles || [];
  return {
    tracks,
    transcribing: isReaderTranscribing(),
    loading: state.clip.subtitleFetchState === "loading",
    marked: shouldMarkAiSubtitleTracks(tracks),
    selectedTrackId: state.clip.selectedSubtitleId,
    switchInFlight,
    bilingualPicker: resolveBilingualPickerView()
  };
}

export interface SubtitleToolbarContext {
  onTrackChange?: (select: HTMLSelectElement) => void;
  onNotice?: SubtitleTrackNotice;
  rerender?: () => void;
}

const trackChangeHandlers = new WeakMap<HTMLSelectElement, (select: HTMLSelectElement) => void>();

export function renderReadingSubtitleTrackPicker(
  selectFacts: () => SubtitleToolbarFacts = selectSubtitleToolbarFacts,
  context?: SubtitleToolbarContext
): void {
  const select = activeById<HTMLSelectElement>(ids.readingSubtitleSelect);
  if (!select) {
    return;
  }
  const facts = selectFacts();
  const tracks = facts.tracks;
  const segmented = tracks.length > 0;
  const transcribing = facts.transcribing;
  const loading = facts.loading;
  const disabled = !segmented || transcribing;
  const marked = facts.marked;

  if (!segmented) {
    const sentinel = transcribing
      ? SUBTITLE_TRACK_TRANSCRIBING_TEXT
      : loading
        ? SUBTITLE_TRACK_LOADING_TEXT
        : SUBTITLE_TRACK_EMPTY_TEXT;
    select.innerHTML = `<option value="${SUBTITLE_TRACK_SENTINEL_VALUE}">${escapeHtml(sentinel)}</option>`;
  } else {
    select.innerHTML = tracks
      .map((track, index) => buildSubtitleTrackOptionHtml(track, marked, index === 0))
      .join("");
  }

  if (context?.onTrackChange) {
    trackChangeHandlers.set(select, context.onTrackChange);
  }
  if (!select.parentElement?.classList.contains("custom-select-wrapper")) {
    initCustomSelect(select, "custom-select-wrapper biliscript-reading-track-picker", {
      onChange: (sel) => {
        trackChangeHandlers.get(sel)?.(sel);
      }
    });
  }

  rebuildCustomSelectOptions(select);

  projectBilingualPicker(facts, context);

  setCustomSelectValue(select, facts.switchInFlight ?? findTrackValueById(facts.selectedTrackId));

  setCustomSelectState(select, {
    disabled: disabled || facts.switchInFlight !== null,
    busy: facts.switchInFlight !== null
  });
}

export type SubtitleTrackNotice = (text: string) => void;

export interface SubtitleToolbarDeps {
  onNotice?: SubtitleTrackNotice;
}

export interface SubtitleToolbar {
  render: (selectFacts?: () => SubtitleToolbarFacts) => void;
  bindEvents: () => void;
}

const TRACK_PICKER_PHASES = new Set(["asr-transcribing", "asr-done", "asr-failed"]);

let activeSubtitleToolbar: SubtitleToolbar | null = null;

export function createSubtitleToolbar(deps: SubtitleToolbarDeps = {}): SubtitleToolbar {
  let switchInFlight: string | null = null;
  const onNotice = deps.onNotice;

  function render(selectFacts?: () => SubtitleToolbarFacts): void {
    const factsGetter = selectFacts ?? (() => selectSubtitleToolbarFacts(switchInFlight));
    renderReadingSubtitleTrackPicker(factsGetter, {
      onTrackChange: handleTrackPickerChange,
      onNotice,
      rerender: () => render()
    });
  }

  function handleTrackPickerChange(select: HTMLSelectElement): void {
    if (select.disabled) {
      return;
    }
    const option = select.options[select.selectedIndex];
    const rawOrigin = option?.dataset.origin;
    const optionOrigin: SubtitleTrackOrigin | undefined =
      rawOrigin === "asr" || rawOrigin === "bilibili" || rawOrigin === "youtube"
        ? rawOrigin
        : undefined;
    const target = resolveTrackTarget(
      {
        id: option?.dataset.id,
        url: select.value,
        lang: option?.dataset.lang,
        origin: optionOrigin
      },
      state.clip.subtitles
    );
    if (target.origin !== "asr" && !target.url) {
      logWarn("[BILISCRIPT] subtitle track is not switchable (no url)", {
        id: target.id
      });
      render();
      return;
    }
    const optionValue = select.value;
    switchInFlight = optionValue;
    const expectedRunId = state.clip.fetchRunId;
    setCustomSelectValue(select, optionValue);
    setCustomSelectState(select, { disabled: true, busy: true });
    let switched = false;
    void (async () => {
      try {
        const chain = await ensureSummarizeChain();
        if (target.origin === "asr") {
          await chain.loadAsrSubtitle({
            runId: expectedRunId,
            sourceLabel: target.lang,
            allowTranscribe: true
          });
        } else if (state.clip.site === "youtube") {
          await chain.loadSubtitle(
            target.url,
            target.lang,
            expectedRunId,
            target.id,
            false,
            { preferTimedtextPot: true }
          );
        } else {
          await chain.loadSubtitle(target.url, target.lang, expectedRunId, target.id);
        }
        switched = true;
      } catch (error) {
        onNotice?.(`字幕切换失败：${getErrorMessage(error)}`);
        logWarn("[BILISCRIPT] failed to switch subtitle track", error);
      } finally {
        switchInFlight = null;
        const secondaryOutcome = handleMainSubtitleSwitched(switched);
        render();
        if (secondaryOutcome.kind === "started") {
          projectSecondaryLoad(secondaryOutcome);
        }
        if (switched && state.reader.readingViewOpen) {
          playTrackSwitchAnimation(requireActiveById(ids.readingSubtitleList));
        }
      }
    })();
  }

  let bound = false;

  function bindEvents(): void {
    if (bound) {
      return;
    }
    bound = true;
    subscribeSubtitleStatusPhase((phase) => {
      if (!TRACK_PICKER_PHASES.has(phase)) {
        return;
      }
      if (state.reader.readingViewOpen) {
        render();
      }
    });

    watchStorageKeys(
      (changes) => {
        const synced = syncBilingualSettingsFromStorage(changes);
        if (!synced.changed) {
          return;
        }
        projectSecondaryLoad(synced.loadOutcome);
        render();
      },
      { sync: READER_SETTINGS_WATCH_KEYS }
    );
  }

  const toolbar: SubtitleToolbar = {
    render,
    bindEvents
  };
  activeSubtitleToolbar = toolbar;
  return toolbar;
}

const SUBTITLE_BILINGUAL_SWITCH_LABEL = "双语字幕";
const SUBTITLE_BILINGUAL_BADGE_TEXT = "双语";
const SUBTITLE_BILINGUAL_BADGE_ID = "biliscript-reading-bilingual-badge";
const SECONDARY_SUBTITLE_FIELD_LABEL = "副字幕轨";
const SINGLE_TRACK_HINT_TEXT = "本视频只有一条字幕轨";

function loadableSecondaryTracks(tracks: SubtitleTrack[]): SubtitleTrack[] {
  return tracks.filter(isLoadableNativeTrack);
}

interface BilingualCardNodes {
  mainSelect: HTMLSelectElement;
  pickerWrapper: HTMLElement;
  root: HTMLElement;
  mainHead: HTMLElement;
  hint: HTMLElement;
  mainList: HTMLElement;
  subCol: HTMLElement;
  subHead: HTMLElement;
  aiRefine: HTMLButtonElement;
  retry: HTMLButtonElement;
  secondaryHost: HTMLElement;
  secondarySelect: HTMLSelectElement;
  empty: HTMLElement;
  footerNote: HTMLElement;
  toggle: HTMLButtonElement;
  badge: HTMLElement;
  context?: SubtitleToolbarContext;
}

let bilingualCardNodes: BilingualCardNodes | null = null;

function buildColumnHead(text: string, doc: Document): HTMLElement {
  const head = doc.createElement("div");
  head.className = "biliscript-bilingual-col-head";
  head.textContent = text;
  return head;
}

function ensureBilingualCard(): BilingualCardNodes | null {
  const mainSelect = activeById<HTMLSelectElement>(ids.readingSubtitleSelect);
  const pickerWrapper = mainSelect?.closest<HTMLElement>(".biliscript-reading-track-picker") ?? null;
  if (!mainSelect || !pickerWrapper) {
    return null;
  }
  const existing = bilingualCardNodes;
  if (existing && existing.pickerWrapper === pickerWrapper) {
    return existing;
  }
  bilingualCardNodes = buildBilingualCard(mainSelect, pickerWrapper);
  return bilingualCardNodes;
}

function buildBilingualCard(mainSelect: HTMLSelectElement, pickerWrapper: HTMLElement): BilingualCardNodes {
  const doc = resolveNodeDocument(mainSelect);
  const root = doc.createElement("li");
  root.className = "biliscript-bilingual-popover";
  root.setAttribute("role", "presentation");

  const main = doc.createElement("div");
  main.className = "biliscript-bilingual-main";
  const cols = doc.createElement("div");
  cols.className = "biliscript-bilingual-cols";

  const mainCol = doc.createElement("div");
  mainCol.className = "biliscript-bilingual-col";
  mainCol.dataset.col = "main";
  const mainHead = buildColumnHead("主字幕", doc);
  mainHead.hidden = true;
  const hint = doc.createElement("div");
  hint.className = "biliscript-bilingual-hint";
  hint.textContent = SINGLE_TRACK_HINT_TEXT;
  hint.hidden = true;
  const mainList = doc.createElement("ul");
  mainList.className = "biliscript-bilingual-list";
  mainList.setAttribute("role", "presentation");
  mainCol.append(mainHead, hint, mainList);

  const subCol = doc.createElement("div");
  subCol.className = "biliscript-bilingual-col";
  subCol.dataset.col = "sub";
  const subHead = buildColumnHead("副字幕", doc);
  const aiRefine = doc.createElement("button");
  aiRefine.type = "button";
  aiRefine.className = "biliscript-bilingual-ai-refine";
  aiRefine.hidden = true;
  aiRefine.addEventListener("click", handleAiRefineClick);
  const retry = doc.createElement("button");
  retry.type = "button";
  retry.className = "biliscript-bilingual-retry";
  retry.hidden = true;
  retry.addEventListener("click", handleSecondaryRetryClick);
  const secondaryHost = doc.createElement("div");
  secondaryHost.className = "biliscript-bilingual-secondary";
  const secondarySelect = doc.createElement("select");
  secondarySelect.id = ids.readingSecondarySubtitleSelect;
  secondarySelect.className = "biliscript-reading-track-select";
  secondarySelect.setAttribute("aria-label", SECONDARY_SUBTITLE_FIELD_LABEL);
  secondaryHost.appendChild(secondarySelect);
  const empty = doc.createElement("div");
  empty.className = "biliscript-bilingual-empty";
  subCol.append(subHead, aiRefine, retry, empty, secondaryHost);
  cols.append(mainCol, subCol);
  main.appendChild(cols);

  const footer = doc.createElement("div");
  footer.className = "biliscript-bilingual-footer";
  const label = doc.createElement("span");
  label.className = "biliscript-bilingual-footer-label";
  label.textContent = SUBTITLE_BILINGUAL_SWITCH_LABEL;
  const footerNote = doc.createElement("span");
  footerNote.className = "biliscript-bilingual-footer-note";
  footerNote.hidden = true;
  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.className = "biliscript-bilingual-switch";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-label", SUBTITLE_BILINGUAL_SWITCH_LABEL);
  toggle.addEventListener("click", handleBilingualSwitchClick);
  footer.append(label, footerNote, toggle);

  const badge = doc.createElement("span");
  badge.className = "biliscript-bilingual-badge";
  badge.id = SUBTITLE_BILINGUAL_BADGE_ID;
  badge.textContent = SUBTITLE_BILINGUAL_BADGE_TEXT;

  root.append(main, footer);
  initCustomSelect(secondarySelect, "custom-select-wrapper biliscript-bilingual-secondary-picker", {
    onChange: handleSecondaryTrackPickerChange,
    inline: true
  });
  return {
    mainSelect,
    pickerWrapper,
    root,
    mainHead,
    hint,
    mainList,
    subCol,
    subHead,
    aiRefine,
    retry,
    secondaryHost,
    secondarySelect,
    empty,
    footerNote,
    toggle,
    badge
  };
}

function projectBilingualPicker(facts: SubtitleToolbarFacts, context?: SubtitleToolbarContext): void {
  const nodes = ensureBilingualCard();
  if (!nodes) {
    return;
  }
  if (context) {
    nodes.context = context;
  }
  const tracks = facts.tracks;
  const picker = facts.bilingualPicker;
  const dual = picker.bilingual && !picker.switchDisabled;
  setCustomSelectSlots(nodes.mainSelect, {
    extras: [nodes.root],
    optionsHost: nodes.mainList,
    triggerExtra: dual ? nodes.badge : null
  });

  nodes.pickerWrapper.dataset.bilingual = dual ? "true" : "false";
  nodes.mainHead.hidden = !dual;
  nodes.hint.hidden = dual || tracks.length === 0 || !picker.switchDisabled;
  nodes.subCol.hidden = !dual;
  nodes.subHead.textContent = picker.heading;
  const refineAction = dual ? picker.aiRefineAction : null;
  nodes.aiRefine.hidden = !refineAction;
  if (refineAction) {
    nodes.aiRefine.textContent = refineAction.label;
    nodes.aiRefine.dataset.action = refineAction.kind;
    nodes.aiRefine.disabled = picker.selectDisabled;
  } else {
    delete nodes.aiRefine.dataset.action;
  }
  const action = dual ? picker.action : null;
  nodes.retry.hidden = !action;
  if (action) {
    nodes.retry.textContent = action.label;
    nodes.retry.disabled = action.disabled;
  }
  const noteText = dual ? picker.note : "";
  nodes.empty.hidden = !noteText;
  if (noteText) {
    nodes.empty.textContent = noteText;
  }
  const footerNoteText = dual ? picker.footerNote : "";
  nodes.footerNote.hidden = !footerNoteText;
  nodes.footerNote.textContent = footerNoteText;
  nodes.secondaryHost.hidden = !dual;

  if (dual && picker.mode === "translation") {
    writeTranslationOptions(nodes.secondarySelect, picker.selectedValue, picker.translationOptions);
    setCustomSelectValue(nodes.secondarySelect, picker.selectedValue);
    setCustomSelectState(nodes.secondarySelect, {
      disabled: picker.selectDisabled,
      busy: picker.busy
    });
  } else if (dual) {
    writeSecondaryOptions(nodes.secondarySelect, tracks, picker.selectedValue);
    setCustomSelectValue(nodes.secondarySelect, picker.selectedValue);
    setCustomSelectState(nodes.secondarySelect, {
      disabled: picker.selectDisabled,
      busy: picker.busy
    });
  } else {
    writeSecondaryOptions(nodes.secondarySelect, [], "");
    setCustomSelectState(nodes.secondarySelect, { disabled: true, busy: false });
  }

  const on = picker.bilingual;
  nodes.toggle.setAttribute("aria-checked", on ? "true" : "false");
  nodes.toggle.dataset.on = on ? "true" : "false";
  nodes.toggle.disabled = picker.switchDisabled;
}

function writeSecondaryOptions(select: HTMLSelectElement | null, tracks: SubtitleTrack[], selectedUrl: string): void {
  if (!select) {
    return;
  }
  const secondaryTracks = loadableSecondaryTracks(tracks);
  if (secondaryTracks.length === 0) {
    select.innerHTML = "";
  } else {
    const marked = shouldMarkAiSubtitleTracks(secondaryTracks);
    select.innerHTML = secondaryTracks
      .map((track) => {
        const url = String(track.subtitleUrl || "");
        return buildSubtitleTrackOptionHtml(track, marked, Boolean(url) && url === selectedUrl);
      })
      .join("");
  }
  rebuildCustomSelectOptions(select);
}

function writeTranslationOptions(
  select: HTMLSelectElement | null,
  selectedLang: string,
  options: ReadonlyArray<BilingualTranslationOption>
): void {
  if (!select) {
    return;
  }
  const unchanged =
    select.options.length === options.length &&
    options.every((option, index) => {
      const existing = select.options[index];
      return (
        existing.value === option.value &&
        existing.dataset.id === `translate-${option.value}` &&
        existing.textContent === option.label
      );
    });
  if (unchanged) {
    return;
  }
  select.innerHTML = options.map((option) => {
    const selected = option.value === selectedLang ? " selected" : "";
    return `<option value="${escapeHtml(option.value)}" data-lang="${escapeHtml(option.value)}" data-id="${escapeHtml(
      `translate-${option.value}`
    )}"${selected}>${escapeHtml(option.label)}</option>`;
  }).join("");
  rebuildCustomSelectOptions(select);
}

function projectSecondaryLoad(outcome: SecondaryEnsureOutcome): void {
  if (outcome.kind !== "started") {
    return;
  }
  const nodes = ensureBilingualCard();
  const select = nodes?.secondarySelect ?? null;
  if (select) {
    setCustomSelectValue(select, outcome.target.url);
    setCustomSelectState(select, { disabled: true, busy: true });
  }
  const rerender = nodes?.context?.rerender ?? renderReadingSubtitleTrackPicker;
  rerender();
  void outcome.settled.then(({ error }) => {
    if (error) {
      nodes?.context?.onNotice?.(`副字幕加载失败：${getErrorMessage(error)}`);
    }
    rerender();
  });
}

function handleBilingualSwitchClick(event: Event): void {
  const toggle = event.currentTarget as HTMLButtonElement | null;
  if (toggle?.disabled) {
    return;
  }
  const outcome = toggleBilingualSubtitles();
  if (outcome.kind === "started") {
    projectSecondaryLoad(outcome);
    return;
  }
  const nodes = ensureBilingualCard();
  const rerender = nodes?.context?.rerender ?? renderReadingSubtitleTrackPicker;
  rerender();
}

function handleSecondaryTrackPickerChange(select: HTMLSelectElement): void {
  const nodes = ensureBilingualCard();
  const rerender = nodes?.context?.rerender ?? renderReadingSubtitleTrackPicker;
  const option = select.options[select.selectedIndex];
  const outcome = selectSecondaryOption({
    id: option?.dataset.id,
    url: select.value,
    lang: option?.dataset.lang,
    value: select.value
  });
  if (outcome.kind === "translation") {
    return;
  }
  if (outcome.kind === "skipped") {
    rerender();
    return;
  }
  if (outcome.kind === "main-track") {
    rerender();
    if (state.reader.readingViewOpen) {
      playTrackSwitchAnimation(requireActiveById(ids.readingSubtitleList));
    }
    return;
  }
  projectSecondaryLoad(outcome);
  void outcome.settled.then((settlement) => {
    if (!settlement.error && state.reader.readingViewOpen) {
      playTrackSwitchAnimation(requireActiveById(ids.readingSubtitleList));
    }
  });
}

function handleSecondaryRetryClick(): void {
  const outcome = triggerSecondaryAction();
  if (outcome.kind === "started") {
    projectSecondaryLoad(outcome);
  }
}

function handleAiRefineClick(event: Event): void {
  const button = event.currentTarget as HTMLButtonElement | null;
  if (!button || button.disabled) {
    return;
  }
  const action = button.dataset.action;
  if (action !== "exit-refine" && action !== "foreign-refine" && action !== "manual-refine") {
    return;
  }
  const nodes = ensureBilingualCard();
  const rerender = nodes?.context?.rerender ?? renderReadingSubtitleTrackPicker;
  const outcome = triggerAiRefineAction(action);
  if (outcome.kind === "started") {
    projectSecondaryLoad(outcome);
    return;
  }
  if (outcome.kind === "translation") {
    void outcome.settled.finally(() => {
      rerender();
    });
    return;
  }
  rerender();
}

let cleanupSubtitleHostBindings: (() => void) | null = null;

export function unbindSubtitleTabEvents(): void {
  cleanupSubtitleHostBindings?.();
  cleanupSubtitleHostBindings = null;
  bilingualCardNodes = null;
}

export function bindSubtitleTabEvents(toolbarOrDeps?: SubtitleToolbar | { toolbar?: SubtitleToolbar }): void {
  unbindSubtitleTabEvents();

  const toolbar =
    (toolbarOrDeps && "bindEvents" in toolbarOrDeps ? toolbarOrDeps : toolbarOrDeps?.toolbar) ?? activeSubtitleToolbar;
  toolbar?.bindEvents();
  const readingSearchInput = requireActiveById<HTMLInputElement>(ids.readingSearchInput);
  const SEARCH_DEBOUNCE_MS = 180;
  let searchDebounceTimer: number | null = null;
  const searchRefresh = () => {
    withReader("subtitle search refresh", (reader) => reader.refreshReadingSubtitleSearch());
  };
  const flushSearchDebounce = () => {
    if (searchDebounceTimer === null) {
      return;
    }
    window.clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
    searchRefresh();
  };
  readingSearchInput.addEventListener("input", () => {
    if (searchDebounceTimer !== null) {
      window.clearTimeout(searchDebounceTimer);
    }
    searchDebounceTimer = window.setTimeout(() => {
      searchDebounceTimer = null;
      searchRefresh();
    }, SEARCH_DEBOUNCE_MS);
  });
  readingSearchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "Escape") {
      return;
    }
    if (event.isComposing) {
      return;
    }
    event.preventDefault();
    flushSearchDebounce();
    withReader("subtitle search keydown", (reader) => {
      if (event.key === "Enter") {
        reader.moveReadingSubtitleSearch(event.shiftKey ? -1 : 1);
        return;
      }
      readingSearchInput.value = "";
      reader.refreshReadingSubtitleSearch({ scroll: false });
      readingSearchInput.focus({ preventScroll: true });
    });
  });
  requireActiveById(ids.readingSearchPrevBtn).addEventListener("click", () => {
    flushSearchDebounce();
    withReader("subtitle search prev", (reader) => reader.moveReadingSubtitleSearch(-1));
  });
  requireActiveById(ids.readingSearchNextBtn).addEventListener("click", () => {
    flushSearchDebounce();
    withReader("subtitle search next", (reader) => reader.moveReadingSubtitleSearch(1));
  });

  activeById(ids.readingSearchClearBtn)?.addEventListener("click", () => {
    flushSearchDebounce();
    readingSearchInput.value = "";
    withReader("subtitle search clear", (reader) => {
      reader.refreshReadingSubtitleSearch({ scroll: false });
    });
    readingSearchInput.focus({ preventScroll: true });
  });

  const onDocumentSearchShortcut = (event: KeyboardEvent): void => {
    if (
      event.defaultPrevented ||
      !(event.ctrlKey || event.metaKey) ||
      event.shiftKey ||
      event.altKey ||
      event.key.toLowerCase() !== "f"
    ) {
      return;
    }
    if (!isReadingSubtitleBodyVisible()) {
      return;
    }
    const input = activeById<HTMLInputElement>(ids.readingSearchInput);
    if (!input) {
      return;
    }
    event.preventDefault();
    input.focus({ preventScroll: true });
    input.select();
  };

  let subtitleCopyInFlight = false;
  let subtitleExportInFlight = false;
  requireActiveById(ids.readingCopySubtitleBtn).addEventListener("click", async () => {
    if (subtitleCopyInFlight) return;
    subtitleCopyInFlight = true;
    try {
      const chain = await ensureSummarizeChain();
      const ok = await chain.copySubtitleTranscript();
      if (ok) {
        flashCopySuccess(requireActiveById(ids.readingCopySubtitleBtn), {
          originalSvg: READING_COPY_ICON,
          originalLabel: "复制字幕"
        });
      } else {
        flashCopyFailure(requireActiveById(ids.readingCopySubtitleBtn), { originalLabel: "复制字幕" });
      }
    } catch (error) {
      logWarn("[BILISCRIPT] copy subtitle transcript failed", error);
      flashCopyFailure(requireActiveById(ids.readingCopySubtitleBtn), { originalLabel: "复制字幕" });
    } finally {
      subtitleCopyInFlight = false;
    }
  });
  requireActiveById(ids.readingExportSubtitleBtn).addEventListener("click", async () => {
    if (subtitleExportInFlight) return;
    subtitleExportInFlight = true;
    try {
      const chain = await ensureSummarizeChain();
      const ok = await chain.downloadSubtitle();
      if (ok) {
        flashCopySuccess(requireActiveById(ids.readingExportSubtitleBtn), {
          originalSvg: READING_DOWNLOAD_ICON,
          originalLabel: "导出字幕",
          copiedLabel: "已导出"
        });
      } else {
        flashCopyFailure(requireActiveById(ids.readingExportSubtitleBtn), {
          originalLabel: "导出字幕",
          failedLabel: "导出失败"
        });
      }
    } catch (error) {
      logWarn("[BILISCRIPT] download subtitle failed", error);
      flashCopyFailure(requireActiveById(ids.readingExportSubtitleBtn), {
        originalLabel: "导出字幕",
        failedLabel: "导出失败"
      });
    } finally {
      subtitleExportInFlight = false;
    }
  });

  requireActiveById(ids.readingFollowBtn).addEventListener("click", () => {
    withReader("resume reader follow", (reader) => reader.resumeReaderFollowPlayback());
  });

  const subtitleList = requireActiveById(ids.readingSubtitleList);
  const syncManualFollowUi = () => {
    projectReaderFollowUi(subtitleScrollFollow.getMode());
  };
  subtitleList.addEventListener(
    "wheel",
    (event) => {
      if (
        subtitleScrollFollow.handleWheel({
          deltaY: event.deltaY,
          deltaX: event.deltaX,
          canScroll: isElementScrollable(subtitleList)
        })
      ) {
        syncManualFollowUi();
      }
    },
    { passive: true }
  );
  subtitleList.addEventListener(
    "touchmove",
    () => {
      if (
        subtitleScrollFollow.handleTouchMove({
          canScroll: isElementScrollable(subtitleList)
        })
      ) {
        syncManualFollowUi();
      }
    },
    { passive: true }
  );
  subtitleList.addEventListener(
    "scroll",
    () => {
      if (subtitleScrollFollow.handleScroll({ scrollTop: subtitleList.scrollTop })) {
        syncManualFollowUi();
      }
    },
    { passive: true }
  );
  subtitleList.addEventListener(
    "scrollend",
    () => {
      subtitleScrollFollow.handleScrollEnd();
    },
    { passive: true }
  );
  subtitleList.addEventListener("keydown", (event) => {
    const editable = isEditableTarget(event.target);
    if (
      subtitleScrollFollow.handleKeyDown({
        key: event.key,
        canScroll: isElementScrollable(subtitleList),
        editable
      })
    ) {
      syncManualFollowUi();
    }
  });
  subtitleList.addEventListener("pointerdown", (event) => {
    const hasSelection = Boolean(resolveNodeWindow(subtitleList).getSelection()?.toString().trim());
    withReader(null, (reader) => {
      reader.markSubtitlePointerDownSelection(hasSelection);
    });
    const isDirectContainer = event.target === subtitleList;
    const isScrollbar =
      isDirectContainer && isPointerOnVerticalScrollbar(subtitleList, event.clientX);
    if (
      subtitleScrollFollow.handlePointerDown({
        isDirectContainer,
        isScrollbar,
        canScroll: isElementScrollable(subtitleList)
      })
    ) {
      syncManualFollowUi();
    }
  });
  const onScrollPointerRelease = () => {
    subtitleScrollFollow.handlePointerUp();
  };

  let boundShortcutDoc: Document | null = null;
  let boundReleaseWin: Window | null = null;

  const unbindHostListeners = () => {
    safeRemoveListener(boundShortcutDoc, "keydown", onDocumentSearchShortcut);
    safeRemoveListener(boundReleaseWin, "pointerup", onScrollPointerRelease, { passive: true } as EventListenerOptions);
    safeRemoveListener(boundReleaseWin, "pointercancel", onScrollPointerRelease, { passive: true } as EventListenerOptions);
    safeRemoveListener(boundReleaseWin, "blur", onScrollPointerRelease, { passive: true } as EventListenerOptions);
    boundShortcutDoc = null;
    boundReleaseWin = null;
  };

  const bindHostListeners = (doc: Document, win: Window) => {
    unbindHostListeners();
    boundShortcutDoc = doc;
    boundReleaseWin = win;
    doc.addEventListener("keydown", onDocumentSearchShortcut);
    win.addEventListener("pointerup", onScrollPointerRelease, { passive: true });
    win.addEventListener("pointercancel", onScrollPointerRelease, { passive: true });
    win.addEventListener("blur", onScrollPointerRelease, { passive: true });
  };

  bindHostListeners(resolveNodeDocument(readingSearchInput), resolveNodeWindow(subtitleList));
  const stopHostWatch = onActiveHostChange((ctx) => {
    unbindHostListeners();
    let connected = false;
    try {
      connected = Boolean(subtitleList.isConnected);
    } catch {
      connected = false;
    }
    if (connected) {
      bindHostListeners(ctx.doc, ctx.win);
    }
  });
  cleanupSubtitleHostBindings = () => {
    stopHostWatch();
    unbindHostListeners();
  };

  let retryFetchInFlight = false;
  let manualAsrInFlight = false;
  subtitleList.addEventListener("click", (event) => {
    const actionNode = (event.target as Element | null)?.closest?.("[data-subtitle-action]");
    if (isHtmlElement(actionNode)) {
      const action = actionNode.dataset.subtitleAction;
      if (action === "asr-setup") {
        void beginReaderAsrSetupFlow();
        return;
      }
      if (action === "manual-asr") {
        event.preventDefault();
        event.stopPropagation();
        if (manualAsrInFlight) {
          return;
        }
        manualAsrInFlight = true;
        const expectedRunId = state.clip.fetchRunId;
        void ensureSummarizeChain()
          .then((chain) =>
            chain.loadAsrSubtitle({
              runId: expectedRunId,
              allowTranscribe: true
            })
          )
          .catch((error) => {
            const msg = getErrorMessage(error);
            if (msg.includes("未配置语音转写服务")) {
              void beginReaderAsrSetupFlow();
              return;
            }
            showSubtitleNotice(msg);
            logWarn("[BILISCRIPT] manual asr trigger failed", error);
          })
          .finally(() => {
            manualAsrInFlight = false;
          });
        return;
      }
      if (action === "remove-highlight") {
        event.preventDefault();
        event.stopPropagation();
        const itemEl = actionNode.closest<HTMLElement>(".biliscript-reading-item");
        const idx = Number(itemEl?.dataset.index);
        if (Number.isInteger(idx) && idx >= 0) {
          void removeSubtitleItemHighlight(idx);
        }
        return;
      }
      if (action === "retry-fetch") {
        event.preventDefault();
        event.stopPropagation();
        if (retryFetchInFlight) {
          return;
        }
        retryFetchInFlight = true;
        void ensureSummarizeChain()
          .then((chain) => chain.refreshClip({ forceRefresh: true }))
          .catch((error) => logWarn("[BILISCRIPT] retry fetch clip failed", error))
          .finally(() => {
            retryFetchInFlight = false;
          });
        return;
      }
    }
    withReader(null, (reader) => reader.onReadingSubtitleClick(event));
  });
}
