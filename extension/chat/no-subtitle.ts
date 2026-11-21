import type { NoSubtitleReason as ClipNoSubtitleReason } from "../core/state.js";
import { buildAsrNoSubtitleMessage, requiresAsrSetup } from "../core/asr-failure-notice.js";

export type NoSubtitleReason = ClipNoSubtitleReason | undefined;

export function buildNoSubtitleNotice(reason: NoSubtitleReason): { message: string; openSettings: boolean } {
  return {
    message: buildAsrNoSubtitleMessage("sidepanel", reason ?? null),
    openSettings: requiresAsrSetup(reason ?? null)
  };
}
