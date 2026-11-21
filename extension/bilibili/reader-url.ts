import { clipState } from "../core/state.js";
import { computeCurrentClipSignature } from "./video-id-shared.js";
import { shouldDebugLog } from "../shared/logging.js";

export { buildReaderModeUrl } from "./video-id-shared.js";

export function replaceReaderModeUrl(nextUrl: unknown): void {
  const targetUrl = String(nextUrl || "").trim();
  if (!targetUrl || targetUrl === location.href) {
    return;
  }

  try {
    clipState.setCurrentUrl(targetUrl);
    clipState.setCurrentClipSignature(computeCurrentClipSignature(targetUrl));
    history.replaceState(history.state, "", targetUrl);
    clipState.setCurrentUrl(location.href);
    clipState.setCurrentClipSignature(computeCurrentClipSignature(location.href));
  } catch (error) {
    if (shouldDebugLog()) {
      console.warn("[BILISCRIPT] failed to replace reader mode url", error);
    }
  }
}
