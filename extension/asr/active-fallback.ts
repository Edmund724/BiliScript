import { getSettings } from "../core/runtime.js";
import { setStatus } from "../core/ui-status.js";
import { createLazyLoader } from "../shared/lazy-import.js";
import { publishSubtitleStatusPhase } from "../shared/subtitle-status-bus.js";
import { acceptSubtitle, commitNoSubtitle } from "../subtitle/commit.js";
import { loadAsrProviderList } from "./asr-setup.js";
import type { AsrFallback } from "./fallback.js";

function broadcastSubtitleStatus(phase: string): void {
  publishSubtitleStatusPhase(phase);
  try {
    const promise = chrome.runtime.sendMessage({ type: "biliscript-subtitle-status", phase });
    if (promise && typeof promise.catch === "function") {
      promise.catch(() => {});
    }
  } catch {
  }
}

const asrFallbackLoader = createLazyLoader(async () => {
  const [
    { runAsrPipeline },
    { createAsrFallback },
    { probeYoutubeAudioTrack, createYoutubeAudioStreamSource }
  ] = await Promise.all([
    import("./pipeline.js"),
    import("./fallback.js"),
    import("../youtube/audio-source.js")
  ]);
  return createAsrFallback({
    getSettings,
    loadProviders: loadAsrProviderList,
    setStatus,
    acceptSubtitle,
    commitNoSubtitle,
    runAsrPipeline,
    broadcastSubtitleStatus,
    probeYoutubeAudioTrack,
    createYoutubeAudioStreamSource
  });
});

export function loadActiveAsrFallback(): Promise<AsrFallback> {
  return asrFallbackLoader.load();
}
