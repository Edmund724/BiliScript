import { getSubtitleStatusPhase } from "../shared/subtitle-status-bus.js";
import { state } from "./state.js";

export function isReaderTranscribing(): boolean {
  return getSubtitleStatusPhase() === "asr-transcribing" && !(state.clip.subtitleBody?.length > 0);
}
