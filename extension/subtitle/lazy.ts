// BILISCRIPT_DUAL_INSTANCE_STATEFUL
import { createLazyLoader } from "../shared/lazy-import.js";
import type {
  AsrTranslationArgs,
  AsrTranslationResult
} from "./asr-translation.js";

export interface SummarizeChain {
  refreshClip(options?: { forceRefresh?: boolean }): Promise<void>;
  loadSubtitle(
    url: string,
    lang: string,
    runId?: number,
    subtitleId?: string,
    forceRefresh?: boolean,
    options?: { preferTimedtextPot?: boolean }
  ): Promise<void>;
  loadAsrSubtitle(options?: {
    runId?: number;
    sourceLabel?: string;
    allowTranscribe?: boolean;
  }): Promise<void>;
  loadSecondarySubtitle(
    url: string,
    lang: string,
    runId?: number,
    subtitleId?: string,
    forceRefresh?: boolean,
    options?: { preferTimedtextPot?: boolean }
  ): Promise<void>;
  isYoutubeCoarseTranscriptLoaded?(videoId: string, url: string): Promise<boolean>;
  resetClipState(options?: { keepFetchState?: boolean }): void;
  ensureAsrTranslation(args: AsrTranslationArgs): Promise<AsrTranslationResult>;
  copySubtitleTranscript(): Promise<boolean>;
  downloadSubtitle(options?: { format?: string }): Promise<boolean>;
}

async function loadSummarizeChain(): Promise<SummarizeChain> {
  const [fetcher, chainUi, asrTranslation] = await Promise.all([
    import("./fetcher.js"),
    import("./ui.js"),
    import("./asr-translation.js")
  ]);
  fetcher.initSummarizeChain();
  return {
    refreshClip: fetcher.refreshClip,
    loadSubtitle: fetcher.loadSubtitle,
    loadAsrSubtitle: fetcher.loadAsrSubtitle,
    loadSecondarySubtitle: fetcher.loadSecondarySubtitle,
    isYoutubeCoarseTranscriptLoaded: fetcher.isYoutubeCoarseTranscriptLoaded,
    resetClipState: fetcher.resetClipState,
    ensureAsrTranslation: asrTranslation.ensureAsrSecondarySubtitle,
    copySubtitleTranscript: chainUi.copySubtitleTranscript,
    downloadSubtitle: chainUi.downloadSubtitle
  };
}

const chainLoader = createLazyLoader(loadSummarizeChain);

export function ensureSummarizeChain(): Promise<SummarizeChain> {
  return chainLoader.load();
}
