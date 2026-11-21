// BILISCRIPT_DUAL_INSTANCE_STATEFUL
import { createLazyLoader } from "../shared/lazy-import.js";
import type {
  AsrTranslationArgs,
  AsrTranslationResult
} from "./asr-translation.js";

export interface SummarizeChain {
  refreshClip(): Promise<void>;
  loadSubtitle(
    url: string,
    lang: string,
    runId?: number,
    subtitleId?: string,
    forceRefresh?: boolean
  ): Promise<void>;
  loadSecondarySubtitle(
    url: string,
    lang: string,
    runId?: number,
    subtitleId?: string,
    forceRefresh?: boolean
  ): Promise<void>;
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
  (fetcher as { initSummarizeChain(): void }).initSummarizeChain();
  return {
    ...fetcher,
    ...chainUi,
    ensureAsrTranslation: asrTranslation.ensureAsrSecondarySubtitle
  } as SummarizeChain;
}

const chainLoader = createLazyLoader(loadSummarizeChain);

export function ensureSummarizeChain(): Promise<SummarizeChain> {
  return chainLoader.load();
}
