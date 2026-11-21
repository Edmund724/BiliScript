export { enterReaderMode, focusReadingView } from "./lifecycle.js";
export { beginClosingReadingView, closeReadingView, restoreReadingViewFocus } from "./lifecycle.js";
export { renderReadingView } from "./lifecycle.js";
export { updateReaderPreferences } from "./lifecycle.js";
export { renderReaderPanels } from "./view-render.js";
export { handleReaderPresenterNotification, onReaderSubtitleReady } from "./lifecycle.js";
export { createReaderDebugSnapshot } from "./debug-snapshot.js";

export { bindReadingViewVideo } from "./video-bind.js";

export { startReadingViewSync } from "./sync.js";
export { stopReadingViewSync } from "./sync.js";
export { syncReadingViewPlayback } from "./sync.js";
export { jumpReadingTarget } from "./sync.js";
export { seekReadingTarget } from "./sync.js";
export { onReadingSubtitleClick } from "./sync.js";
export { markSubtitlePointerDownSelection } from "./sync.js";
export { noteManualReaderInteraction } from "./sync.js";
export { updateReaderFollowState } from "./sync.js";
export { resumeReaderFollowPlayback, resetReaderScrollFollow } from "./sync.js";

export { refreshReadingSubtitleSearch, moveReadingSubtitleSearch, clearReadingSubtitleSearch } from "./lifecycle.js";
export { updateReadingTranscribeBanner, isReaderTranscribing } from "./transcribe-banner.js";

export {
  openReaderExplainCard,
  onReaderExplainCardClick,
  closeReaderExplainCard,
  isReaderExplainCardOpen
} from "./explain-card.js";

export {
  overviewCoordinator,
  ensureReaderOverviewTab,
  triggerReaderOverviewGeneration,
  renderReadingOverview,
  cancelReaderOverview,
  resetReaderOverviewState,
  getReaderOverviewPhase,
  getReaderOverviewSnapshot
} from "./lifecycle.js";
export type {
  ReaderOverviewPhase,
  ReaderOverviewSnapshot,
  ReaderOverviewCoordinator
} from "./overview-coordinator.js";
export { onReadingOverviewClick } from "./overview-ui.js";

export {
  openQuoteShareModal,
  closeQuoteShareModal,
  isQuoteShareModalOpen
} from "./quote-share-modal.js";

export {
  openCommandPalette,
  closeCommandPalette,
  toggleCommandPalette,
  isCommandPaletteOpen
} from "./command-palette.js";
