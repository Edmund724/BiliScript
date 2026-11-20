// Offscreen media background handlers delegating document & DNR lifecycle to core/offscreen-host.ts.

import {
  BILI_MEDIA_CDN_DOMAINS,
  BILI_MEDIA_ORIGIN_PAGE,
  OFFSCREEN_SENDER_REJECTION_MESSAGE,
  acquireBiliMediaSessionRule,
  hasOpenBilibiliTabs,
  isOffscreenDocumentSender,
  reapAllBiliMediaSessionRules,
  releaseBiliMediaSessionRule,
  tryCloseOffscreenDocument
} from "../core/offscreen-host.js";
import type {
  MessageSender,
  OffloadTaskResponse,
  OffscreenRequestCloseMessage,
  OffscreenRequestCloseResponse
} from "../shared/messaging-protocol.js";
import {
  ASR_AUDIO_SESSION_RULE_ID_BASE,
  ASR_AUDIO_SESSION_RULE_ID_MAX,
  createAsrSessionRuleManager
} from "./session-rule-manager.js";

export const ASR_AUDIO_CDN_DOMAINS = BILI_MEDIA_CDN_DOMAINS;
export const ASR_AUDIO_CDN_DOMAIN = BILI_MEDIA_CDN_DOMAINS[0];
export const ASR_AUDIO_ORIGIN_PAGE = BILI_MEDIA_ORIGIN_PAGE;

export {
  ASR_AUDIO_SESSION_RULE_ID_BASE,
  ASR_AUDIO_SESSION_RULE_ID_MAX,
  createAsrSessionRuleManager,
  isOffscreenDocumentSender
};

function taskOwnerKey(sender: MessageSender): string {
  const tabId = sender?.tab?.id;
  return tabId != null ? "t" + String(tabId) : "o";
}

function toErrorText(error: unknown): string {
  return String((error as { message?: string } | null)?.message || error);
}

/** Clears all pooled Bilibili media session rules and resets rule ledger state. */
export async function reapAllSessionRules(): Promise<void> {
  await reapAllBiliMediaSessionRules();
}

async function prepareOffscreenMediaTask(
  sender: MessageSender,
  sendResponse: (response: OffloadTaskResponse) => void,
  kind: "audio-xhr" | "video-media"
): Promise<void> {
  try {
    const ruleId = await acquireBiliMediaSessionRule(kind, taskOwnerKey(sender));
    sendResponse({ ok: true, ruleId });
  } catch (error) {
    sendResponse({ ok: false, error: toErrorText(error) });
  }
}

/** Handles ASR offscreen decode preparation (ensure offscreen document + audio-xhr DNR rule). */
export async function handleAsrDecodePrepare(
  _message: unknown,
  sender: MessageSender,
  sendResponse: (response: OffloadTaskResponse) => void
): Promise<void> {
  await prepareOffscreenMediaTask(sender, sendResponse, "audio-xhr");
}

/** Handles video frame capture preparation (ensure offscreen document + video-media DNR rule). */
export async function handleVideoFramePrepare(
  _message: unknown,
  sender: MessageSender,
  sendResponse: (response: OffloadTaskResponse) => void
): Promise<void> {
  await prepareOffscreenMediaTask(sender, sendResponse, "video-media");
}

/** Handles cleanup of a task-scoped Bilibili media DNR rule after verifying sender ownership. */
export async function handleAsrDecodeCleanup(
  message: unknown,
  sender: MessageSender,
  sendResponse: (response: OffloadTaskResponse) => void
): Promise<void> {
  try {
    const ruleId = Number((message as { ruleId?: number } | null)?.ruleId) || 0;
    if (ruleId > 0) {
      await releaseBiliMediaSessionRule(ruleId, taskOwnerKey(sender));
    }
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ ok: false, error: toErrorText(error) });
  }
}

/** Executes offscreen document self-close on behalf of verified offscreen senders. */
export async function handleOffscreenRequestClose(
  message: unknown,
  sender: MessageSender,
  sendResponse: (response: OffscreenRequestCloseResponse) => void
): Promise<void> {
  if (!isOffscreenDocumentSender(sender)) {
    sendResponse({ ok: false, error: OFFSCREEN_SENDER_REJECTION_MESSAGE });
    return;
  }
  const request = message as Partial<OffscreenRequestCloseMessage> | null | undefined;
  try {
    if (request?.onlyIfNoBilibiliTabs && (await hasOpenBilibiliTabs())) {
      sendResponse({ ok: true, closed: false });
      return;
    }
    const closed = await tryCloseOffscreenDocument();
    sendResponse(closed ? { ok: true } : { ok: true, closed: false });
  } catch (error) {
    sendResponse({ ok: false, error: toErrorText(error) });
  }
}
