import { state } from "../core/state.js";
import { isReaderTranscribing } from "../core/reader-transcribing.js";
import { activeById } from "../shared/active-host.js";
import { getSubtitleStatusPhase, subscribeSubtitleStatusPhase } from "../shared/subtitle-status-bus.js";
import { ids } from "./state.js";

export { isReaderTranscribing };

export interface TranscribeBannerCopy {
  title: string;
  copy: string;
}

export const TRANSCRIBE_BANNER_COPY: Record<string, TranscribeBannerCopy> = {
  "asr-transcribing": {
    title: "当前视频无字幕，正在进行语音转写…",
    copy: "转写完成后将自动展示字幕与概览，期间可继续观看视频"
  }
};

const FALLBACK_BANNER_COPY = TRANSCRIBE_BANNER_COPY["asr-transcribing"];

function bannerCopyForPhase(phase: string): TranscribeBannerCopy {
  return TRANSCRIBE_BANNER_COPY[phase] || FALLBACK_BANNER_COPY;
}

export function updateReadingTranscribeBanner(): void {
  const banner = activeById(ids.readingTranscribeBanner);
  if (!banner) {
    return;
  }
  const transcribing = isReaderTranscribing();
  const nextHidden = !transcribing;
  if (banner.hidden !== nextHidden) {
    banner.hidden = nextHidden;
  }
  const tabBody = activeById(ids.readingTabBodySubtitle);
  tabBody?.classList.toggle("is-transcribing", transcribing);
  if (transcribing) {
    const copy = bannerCopyForPhase(getSubtitleStatusPhase());
    const titleNode = activeById(ids.readingTranscribeBannerTitle);
    if (titleNode && titleNode.textContent !== copy.title) {
      titleNode.textContent = copy.title;
    }
    const copyNode = activeById(ids.readingTranscribeBannerCopy);
    if (copyNode && copyNode.textContent !== copy.copy) {
      copyNode.textContent = copy.copy;
    }
    const progressNode = activeById(ids.readingTranscribeProgress);
    const text = String(state.ui.statusText || "").trim() || "正在转写…";
    if (progressNode && progressNode.textContent !== text) {
      progressNode.textContent = text;
    }
  }
}

let bannerStatusBound = false;
export function bindReadingTranscribeBanner(): void {
  if (bannerStatusBound) {
    return;
  }
  bannerStatusBound = true;
  subscribeSubtitleStatusPhase(() => {
    if (state.reader.readingViewOpen) {
      updateReadingTranscribeBanner();
    }
  });
}
