import {
  contentEventBus,
  getLastSubtitleStatusPhase,
  setLastSubtitleStatusPhase
} from "./content-event-bus.js";
import type { EventSubscribeOptions } from "./typed-event-bus.js";

type SubtitleStatusListener = (phase: string) => void;

export function publishSubtitleStatusPhase(phase: string): void {
  const next = String(phase || "");
  if (!next) {
    return;
  }
  setLastSubtitleStatusPhase(next);
  contentEventBus.emit("subtitle:status-phase", next);
}

export function getSubtitleStatusPhase(): string {
  return getLastSubtitleStatusPhase();
}

export function subscribeSubtitleStatusPhase(
  listener: SubtitleStatusListener,
  options?: EventSubscribeOptions
): () => void {
  return contentEventBus.on("subtitle:status-phase", listener, options);
}
