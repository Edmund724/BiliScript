// BILISCRIPT_DUAL_INSTANCE_STATEFUL
import { ids } from "../shared/dom-ids.js";

export { ids };

import { state } from "../core/state.js";

export function isReaderViewOpen() {
  return state.reader.readingViewOpen;
}

export type ReaderScriptTab = "subtitle" | "overview" | "chat";

let readingActiveScriptTab: ReaderScriptTab = "subtitle";

export function setReaderActiveScriptTab(tab: ReaderScriptTab) {
  readingActiveScriptTab = tab;
}

export function getReaderActiveScriptTab(): ReaderScriptTab {
  return readingActiveScriptTab;
}

export function isReadingSubtitleBodyVisible(): boolean {
  return (
    state.reader.readingViewOpen &&
    readingActiveScriptTab === "subtitle" &&
    !state.reader.readingSettingsExpanded
  );
}

export function isReadingOverviewBodyVisible(): boolean {
  return (
    state.reader.readingViewOpen &&
    readingActiveScriptTab === "overview" &&
    !state.reader.readingSettingsExpanded
  );
}

import { uiState } from "../core/state.js";
import { isReaderMode, isSupportedVideoPage } from "../bilibili/video-id-shared.js";
import { READER_GUARD_CLEAR_ATTRS, READER_GUARD_FILTER } from "./presentation-fields.js";

export function clearReaderModePageState() {
  for (const attr of READER_GUARD_CLEAR_ATTRS.html) {
    document.documentElement.removeAttribute(attr);
  }
  for (const attr of READER_GUARD_CLEAR_ATTRS.body) {
    document.body.removeAttribute(attr);
  }
}

function shouldForceNormalPageState(url = location.href) {
  return !isSupportedVideoPage(url) || (!isReaderMode(url) && !state.reader.readingViewOpen);
}

export function enforceNormalPageStateIfNeeded(url = location.href) {
  if (!shouldForceNormalPageState(url)) {
    return;
  }
  clearReaderModePageState();
}

export function bindNormalPageStateGuard() {
  if (state.ui.normalPageStateGuardBound) {
    return;
  }
  uiState.setNormalPageStateGuardBound(true);

  const observer = new MutationObserver(() => {
    enforceNormalPageStateIfNeeded();
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: READER_GUARD_FILTER.html
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: READER_GUARD_FILTER.body
  });
  enforceNormalPageStateIfNeeded();
}
