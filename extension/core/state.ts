// BILISCRIPT_DUAL_INSTANCE_STATEFUL
import { DEFAULT_SETTINGS, type Settings } from "./defaults.js";
import { logWarnAlways } from "../shared/logging.js";
import type {
  ChapterItem,
  HotComment,
  NoSubtitleReason,
  SubtitleBodyItem,
  SubtitleFetchState,
  SubtitleOption,
  SubtitleTrack,
  SubtitleTrackOrigin
} from "../shared/video-dto.js";

export type {
  ChapterItem,
  HotComment,
  NoSubtitleReason,
  SubtitleBodyItem,
  SubtitleFetchState,
  SubtitleOption,
  SubtitleTrack,
  SubtitleTrackOrigin
} from "../shared/video-dto.js";

export type SecondarySubtitleState = "idle" | "loading" | "ready" | "error";

export interface SecondarySubtitle {
  id: string;
  url: string;
  body: SubtitleBodyItem[];
  state: SecondarySubtitleState;
}

export function emptySecondarySubtitle(): SecondarySubtitle {
  return { id: "", url: "", body: [], state: "idle" };
}

export type ReaderShellState = "closed" | "entering" | "open" | "exiting";

type ReaderBusinessState = {
  readingViewOpen: boolean;
  readingTheme: string;
  readingThemeMode: string;
  readingPalette: string;
  readingSettingsExpanded: boolean;
  readingActiveSubtitleIndex: number;
  readingActiveChapterIndex: number;
  readingNextScrollBehavior: string;
  readingViewReady: boolean;
};

type ReaderInternalState = {
  readingShellState: ReaderShellState;
  readingVideoEl: HTMLVideoElement | null;
  readingDocumentClickBound: boolean;
};

type ReaderSetters = {
  setViewOpen(value: boolean): void;
  setTheme(value: string): void;
  setThemeMode(value: string): void;
  setPalette(value: string): void;
  setSettingsExpanded(value: boolean): void;
  setActiveSubtitleIndex(value: number): void;
  setActiveChapterIndex(value: number): void;
  setNextScrollBehavior(value: string): void;
  setViewReady(value: boolean): void;
};

export type ReaderState = Readonly<ReaderBusinessState> & ReaderInternalState & ReaderSetters;
type ReaderStateWritable = ReaderBusinessState & ReaderInternalState & ReaderSetters;

const localReaderState: ReaderStateWritable = {
  readingShellState: "closed",
  get readingViewOpen() { return this.readingShellState === "open"; },
  set readingViewOpen(value: boolean) { this.readingShellState = value ? "open" : "closed"; },
  readingTheme: "light",
  readingThemeMode: "bilibili",
  readingPalette: "flyme",
  readingSettingsExpanded: false,
  readingActiveSubtitleIndex: -1,
  readingActiveChapterIndex: -1,
  readingNextScrollBehavior: "smooth",
  readingVideoEl: null,
  readingDocumentClickBound: false,
  readingViewReady: false,
  setViewOpen(value) { this.readingViewOpen = value; },
  setTheme(value) { this.readingTheme = value; },
  setThemeMode(value) { this.readingThemeMode = value; },
  setPalette(value) { this.readingPalette = value; },
  setSettingsExpanded(value) { this.readingSettingsExpanded = value; },
  setActiveSubtitleIndex(value) { this.readingActiveSubtitleIndex = value; },
  setActiveChapterIndex(value) { this.readingActiveChapterIndex = value; },
  setNextScrollBehavior(value) { this.readingNextScrollBehavior = value; },
  setViewReady(value) { this.readingViewReady = value; }
};

type ClipBusinessState = {
  currentUrl: string;
  fetchRunId: number;
  acquisitionVersion: number;
  processingVersion: number;
  bvid: string;
  aid: string;
  cid: string;
  cidSource: string;
  pageIndex: number;
  pageCount: number;
  pageTitle: string;
  videoDuration: number;
  description: string;
  title: string;
  author: string;
  uploadDate: string;
  subtitles: SubtitleOption[];
  selectedSubtitleId: string;
  selectedSubtitleUrl: string;
  selectedSubtitleLang: string;
  subtitleBody: SubtitleBodyItem[];
  subtitleFetchState: SubtitleFetchState;
  noSubtitleReason: NoSubtitleReason;
  noSubtitleDetail: string;
  secondarySubtitle: SecondarySubtitle;
  chapters: ChapterItem[];
  hotComments: HotComment[];
  hotCommentsNotice: string;
  markdown: string;
  srt: string;
  txt: string;
  currentClipSignature: string;
};

type ClipSetters = {
  setCurrentUrl(value: string): void;
  setFetchRunId(value: number): void;
  advanceSubtitleVersions(scope?: "both" | "processing"): { acquisitionVersion: number; processingVersion: number };
  setBvid(value: string): void;
  setAid(value: string): void;
  setCid(value: string): void;
  setCidSource(value: string): void;
  setPageIndex(value: number): void;
  setPageCount(value: number): void;
  setPageTitle(value: string): void;
  setVideoDuration(value: number): void;
  setDescription(value: string): void;
  setTitle(value: string): void;
  setAuthor(value: string): void;
  setUploadDate(value: string): void;
  setSubtitles(value: SubtitleOption[]): void;
  setSelectedSubtitleId(value: string): void;
  setSelectedSubtitleUrl(value: string): void;
  setSelectedSubtitleLang(value: string): void;
  setSubtitleBody(value: SubtitleBodyItem[]): void;
  setSubtitleFetchState(value: SubtitleFetchState): void;
  setNoSubtitleReason(value: NoSubtitleReason): void;
  setNoSubtitleDetail(value: string): void;
  markSecondarySubtitleLoading(value: { id: string; url: string }): void;
  applySecondarySubtitle(value: { id: string; url: string; body: SubtitleBodyItem[] }): void;
  markSecondarySubtitleError(): void;
  clearSecondarySubtitle(): void;
  setChapters(value: ChapterItem[]): void;
  setHotComments(value: HotComment[]): void;
  setHotCommentsNotice(value: string): void;
  setMarkdown(value: string): void;
  setSrt(value: string): void;
  setTxt(value: string): void;
  setCurrentClipSignature(value: string): void;
};

export type ClipState = Readonly<ClipBusinessState> & ClipSetters;
type ClipStateWritable = ClipBusinessState & ClipSetters;

const localClipState: ClipStateWritable = {
  currentUrl: typeof location !== "undefined" ? location.href : "",
  fetchRunId: 0,
  acquisitionVersion: 0,
  processingVersion: 0,
  bvid: "",
  aid: "",
  cid: "",
  cidSource: "",
  pageIndex: 1,
  pageCount: 0,
  pageTitle: "",
  videoDuration: 0,
  description: "",
  title: "",
  author: "",
  uploadDate: "",
  subtitles: [],
  selectedSubtitleId: "",
  selectedSubtitleUrl: "",
  selectedSubtitleLang: "",
  subtitleBody: [],
  subtitleFetchState: "idle",
  noSubtitleReason: null,
  noSubtitleDetail: "",
  secondarySubtitle: emptySecondarySubtitle(),
  chapters: [],
  hotComments: [],
  hotCommentsNotice: "",
  markdown: "",
  srt: "",
  txt: "",
  currentClipSignature: "",
  setCurrentUrl(value) { this.currentUrl = value; },
  setFetchRunId(value) { this.fetchRunId = value; },
  advanceSubtitleVersions(scope = "both") {
    if (scope === "both") {
      this.acquisitionVersion += 1;
    }
    this.processingVersion += 1;
    return {
      acquisitionVersion: this.acquisitionVersion,
      processingVersion: this.processingVersion
    };
  },
  setBvid(value) { this.bvid = value; },
  setAid(value) { this.aid = value; },
  setCid(value) { this.cid = value; },
  setCidSource(value) { this.cidSource = value; },
  setPageIndex(value) { this.pageIndex = value; },
  setPageCount(value) { this.pageCount = value; },
  setPageTitle(value) { this.pageTitle = value; },
  setVideoDuration(value) { this.videoDuration = value; },
  setDescription(value) { this.description = value; },
  setTitle(value) { this.title = value; },
  setAuthor(value) { this.author = value; },
  setUploadDate(value) { this.uploadDate = value; },
  setSubtitles(value) { this.subtitles = value; },
  setSelectedSubtitleId(value) { this.selectedSubtitleId = value; },
  setSelectedSubtitleUrl(value) { this.selectedSubtitleUrl = value; },
  setSelectedSubtitleLang(value) { this.selectedSubtitleLang = value; },
  setSubtitleBody(value) { this.subtitleBody = value; },
  setSubtitleFetchState(value) { this.subtitleFetchState = value; },
  setNoSubtitleReason(value) { this.noSubtitleReason = value; },
  setNoSubtitleDetail(value) { this.noSubtitleDetail = value; },
  markSecondarySubtitleLoading({ id, url }) {
    this.secondarySubtitle = { id, url, body: [], state: "loading" };
  },
  applySecondarySubtitle({ id, url, body }) {
    this.secondarySubtitle = { id, url, body, state: "ready" };
  },
  markSecondarySubtitleError() {
    this.secondarySubtitle = { ...this.secondarySubtitle, body: [], state: "error" };
  },
  clearSecondarySubtitle() {
    this.secondarySubtitle = emptySecondarySubtitle();
  },
  setChapters(value) { this.chapters = value; },
  setHotComments(value) { this.hotComments = value; },
  setHotCommentsNotice(value) { this.hotCommentsNotice = value; },
  setMarkdown(value) { this.markdown = value; },
  setSrt(value) { this.srt = value; },
  setTxt(value) { this.txt = value; },
  setCurrentClipSignature(value) { this.currentClipSignature = value; }
};

type UiBusinessState = {
  uiEventsBound: boolean;
  runtimeEventsBound: boolean;
  settingsWatcherBound: boolean;
  normalPageStateGuardBound: boolean;
  urlWatcherStarted: boolean;
  statusText: string;
};

type UiSetters = {
  setEventsBound(value: boolean): void;
  setRuntimeEventsBound(value: boolean): void;
  setSettingsWatcherBound(value: boolean): void;
  setNormalPageStateGuardBound(value: boolean): void;
  setUrlWatcherStarted(value: boolean): void;
  setStatusText(value: string): void;
};

export type UiState = Readonly<UiBusinessState> & UiSetters;
type UiStateWritable = UiBusinessState & UiSetters;

const localUiState: UiStateWritable = {
  uiEventsBound: false,
  runtimeEventsBound: false,
  settingsWatcherBound: false,
  normalPageStateGuardBound: false,
  urlWatcherStarted: false,
  statusText: "准备就绪，点击“刷新抓取”开始。",
  setEventsBound(value) { this.uiEventsBound = value; },
  setRuntimeEventsBound(value) { this.runtimeEventsBound = value; },
  setSettingsWatcherBound(value) { this.settingsWatcherBound = value; },
  setNormalPageStateGuardBound(value) { this.normalPageStateGuardBound = value; },
  setUrlWatcherStarted(value) { this.urlWatcherStarted = value; },
  setStatusText(value) { this.statusText = value; }
};

export interface State {
  settings: Settings;
  reader: ReaderState;
  clip: ClipState;
  ui: UiState;
  setSettings(next: Settings): void;
  patchSettings(patch: Partial<Settings>): void;
}

const localState: State = {
  settings: { ...DEFAULT_SETTINGS },
  reader: localReaderState,
  clip: localClipState,
  ui: localUiState,
  setSettings(next) { this.settings = next; },
  patchSettings(patch) { this.settings = { ...this.settings, ...patch }; }
};

export type SubtitleSessionBoundaryReason = "clip-switch" | "source-track-switch" | "processing-switch";

export interface SubtitleSessionBoundarySnapshot {
  reason: SubtitleSessionBoundaryReason;
  acquisitionVersion: number;
  processingVersion: number;
}

export interface SubtitleSessionBoundaryHook {
  flush?: (reason: SubtitleSessionBoundaryReason) => Promise<void> | void;
  onAbortAndClear?: (snapshot: SubtitleSessionBoundarySnapshot) => void;
}

interface StateBundle {
  readerState: ReaderStateWritable;
  clipState: ClipStateWritable;
  uiState: UiStateWritable;
  state: State;
  sessionBoundaryHooks: Set<SubtitleSessionBoundaryHook>;
}

const STATE_SLOT_KEY = "__BILISCRIPT_STATE__";

const stateBundle: StateBundle = ((globalThis as unknown as Record<string, StateBundle | undefined>)[STATE_SLOT_KEY] ??= {
  readerState: localReaderState,
  clipState: localClipState,
  uiState: localUiState,
  state: localState,
  sessionBoundaryHooks: new Set<SubtitleSessionBoundaryHook>()
});

export const state: State = stateBundle.state;
export const clipState = stateBundle.clipState;
export const uiState = stateBundle.uiState;

function getSessionBoundaryHooks(): Set<SubtitleSessionBoundaryHook> {
  return (stateBundle.sessionBoundaryHooks ??= new Set<SubtitleSessionBoundaryHook>());
}

export function registerSubtitleSessionBoundaryHooks(hook: SubtitleSessionBoundaryHook): () => void {
  const hooks = getSessionBoundaryHooks();
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

export async function triggerSubtitleSessionBoundary(
  reason: SubtitleSessionBoundaryReason
): Promise<{ acquisitionVersion: number; processingVersion: number }> {
  const hooks = [...getSessionBoundaryHooks()];
  const flushTasks: Promise<void>[] = [];
  for (const hook of hooks) {
    if (!hook.flush) continue;
    try {
      flushTasks.push(Promise.resolve(hook.flush(reason)));
    } catch {
    }
  }

  const scope = reason === "processing-switch" ? "processing" : "both";
  const versions = clipState.advanceSubtitleVersions(scope);
  const snapshot: SubtitleSessionBoundarySnapshot = {
    reason,
    acquisitionVersion: versions.acquisitionVersion,
    processingVersion: versions.processingVersion
  };

  for (const hook of hooks) {
    try {
      hook.onAbortAndClear?.(snapshot);
    } catch {
    }
  }

  await Promise.allSettled(flushTasks);
  return versions;
}

const READER_SHELL_TRANSITIONS: Record<ReaderShellState, readonly ReaderShellState[]> = {
  closed: ["entering", "open"],
  entering: ["open", "closed"],
  open: ["exiting", "closed"],
  exiting: ["closed", "open"]
};

export function getReaderShellState(): ReaderShellState {
  return state.reader.readingShellState;
}

export function transitionReaderShell(to: ReaderShellState): boolean {
  const from = state.reader.readingShellState;
  if (from === to) {
    return true;
  }
  if (!READER_SHELL_TRANSITIONS[from].includes(to)) {
    logWarnAlways(`[BILISCRIPT] 非法阅读壳状态迁移：${from} → ${to}，已拒绝`);
    return false;
  }
  state.reader.readingShellState = to;
  return true;
}
