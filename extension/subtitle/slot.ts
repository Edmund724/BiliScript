import { clipState } from "../core/state.js";
import type { NoSubtitleReason, SubtitleBodyItem } from "../core/state.js";

export interface SubtitleTrackIdentity {
  id: string;
  url: string;
  lang: string;
}

export interface SecondarySubtitleTrackIdentity {
  id: string;
  url: string;
}

export interface ClearAllOptions {
  keepFetchState?: boolean;
}

export function install(identity: SubtitleTrackIdentity, body: SubtitleBodyItem[]): void {
  clipState.setSelectedSubtitleId(identity.id);
  clipState.setSelectedSubtitleUrl(identity.url);
  clipState.setSelectedSubtitleLang(identity.lang);
  clipState.setSubtitleBody(body);
  clipState.setSubtitleFetchState("ready");
  clipState.setNoSubtitleReason(null);
  clipState.setNoSubtitleDetail("");
}

export function clearToEmpty(reason?: NoSubtitleReason): void {
  clipState.setSelectedSubtitleId("");
  clipState.setSelectedSubtitleUrl("");
  clipState.setSelectedSubtitleLang("");
  clipState.setSubtitleBody([]);
  clipState.setSubtitleFetchState("empty");
  if (reason !== undefined) {
    clipState.setNoSubtitleReason(reason);
  }
}

export function installSecondary(identity: SecondarySubtitleTrackIdentity, body: SubtitleBodyItem[]): void {
  clipState.applySecondarySubtitle({
    id: identity.id,
    url: identity.url,
    body
  });
}

export function markSecondaryLoading(target: SecondarySubtitleTrackIdentity): void {
  clipState.markSecondarySubtitleLoading({
    id: target.id,
    url: target.url
  });
}

export function markSecondaryError(): void {
  clipState.markSecondarySubtitleError();
}

export function clearSecondary(): void {
  clipState.clearSecondarySubtitle();
}

export function clearAllForVideoSwitch(options?: ClearAllOptions): void {
  clipState.setSelectedSubtitleId("");
  clipState.setSelectedSubtitleUrl("");
  clipState.setSelectedSubtitleLang("");
  clipState.setSubtitleBody([]);
  clearSecondary();
  if (!options?.keepFetchState) {
    clipState.setSubtitleFetchState("idle");
  }
  clipState.setNoSubtitleReason(null);
  clipState.setNoSubtitleDetail("");
}

export const slot = {
  install,
  clearToEmpty,
  installSecondary,
  markSecondaryLoading,
  markSecondaryError,
  clearSecondary,
  clearAllForVideoSwitch
};
