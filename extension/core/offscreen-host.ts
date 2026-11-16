// Service-worker host for the shared offscreen document and Bilibili media DNR session rules.

import { getErrorMessage } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";
import { OFFSCREEN_CREATE_REASONS, OFFSCREEN_URL } from "../shared/offscreen-constants.js";
import type { MessageSender } from "../shared/messaging-protocol.js";
import { ASR_OFFSCREEN_REJECTION_MESSAGE } from "../asr/protocol.js";
import { createAsrSessionRuleManager } from "../asr/session-rule-manager.js";

export const BILI_MEDIA_CDN_DOMAINS = ["bilivideo.com", "bilivideo.cn", "akamaized.net"] as const;
export const BILI_MEDIA_ORIGIN_PAGE = "https://www.bilibili.com" as const;

export const OFFSCREEN_SENDER_REJECTION_MESSAGE = ASR_OFFSCREEN_REJECTION_MESSAGE;

export type BiliMediaSessionRuleKind = "audio-xhr" | "video-media";

const OFFSCREEN_ALREADY_EXISTS_RE = /already exist|single offscreen/i;
const OFFSCREEN_JUSTIFICATION =
  "Run AI streams, ASR audio decoding, live companion sessions, and background video frame capture.";

type ServiceWorkerScopeLike = {
  clients?: {
    matchAll?: (options: { includeUncontrolled: boolean }) => Promise<Array<{ url?: string }>>;
  };
};

const sessionRuleManager = createAsrSessionRuleManager();

async function hasExistingOffscreenDocument(url: string): Promise<boolean> {
  if (typeof chrome.runtime?.getContexts === "function") {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [url]
      });
      return Array.isArray(contexts) && contexts.length > 0;
    } catch {
      // Fall back to ServiceWorkerGlobalScope.clients.matchAll on Chrome <116 or query failure.
    }
  }
  const swScope = typeof self !== "undefined" ? (self as unknown as ServiceWorkerScopeLike) : undefined;
  if (typeof swScope?.clients?.matchAll === "function") {
    try {
      const clients = await swScope.clients.matchAll({ includeUncontrolled: true });
      return Array.isArray(clients) && clients.some((client) => client.url?.includes(OFFSCREEN_URL));
    } catch {
      return false;
    }
  }
  return false;
}

/** Ensures the shared offscreen document exists, creating it with BLOBS reason when absent. */
export async function ensureOffscreenDocument(): Promise<boolean> {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  if (await hasExistingOffscreenDocument(url)) {
    return true;
  }
  try {
    await chrome.offscreen.createDocument({
      url,
      reasons: [...OFFSCREEN_CREATE_REASONS],
      justification: OFFSCREEN_JUSTIFICATION
    });
    return true;
  } catch (error) {
    if (OFFSCREEN_ALREADY_EXISTS_RE.test(getErrorMessage(error))) {
      return true;
    }
    logWarn("[BILISCRIPT] ensureOffscreenDocument createDocument failed", {
      error: getErrorMessage(error)
    });
    throw error;
  }
}

/** Closes the shared offscreen document via the service worker API. */
export async function closeOffscreenDocument(): Promise<void> {
  await chrome.offscreen.closeDocument();
}

/** Returns true only when the runtime message sender is the offscreen document itself. */
export function isOffscreenDocumentSender(sender: MessageSender): boolean {
  return !sender?.tab && sender?.url === chrome.runtime.getURL(OFFSCREEN_URL);
}

async function addBiliMediaSessionRule(ruleId: number, kind: BiliMediaSessionRuleKind): Promise<void> {
  const id = Number(ruleId) || 0;
  if (id <= 0) {
    throw new Error("缺少防盗链规则 id");
  }
  const isVideoMedia = kind === "video-media";
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Referer", operation: "set", value: BILI_MEDIA_ORIGIN_PAGE },
            { header: "Origin", operation: "set", value: BILI_MEDIA_ORIGIN_PAGE }
          ],
          ...(isVideoMedia
            ? {
                responseHeaders: [
                  { header: "Access-Control-Allow-Origin", operation: "set", value: "*" }
                ]
              }
            : {})
        },
        condition: {
          requestDomains: [...BILI_MEDIA_CDN_DOMAINS],
          resourceTypes: [isVideoMedia ? "media" : "xmlhttprequest"]
        }
      }
    ]
  });
}

/** Ensures the offscreen document and installs an isolated Bilibili media DNR session rule. */
export async function acquireBiliMediaSessionRule(
  kind: BiliMediaSessionRuleKind,
  ownerKey = "o"
): Promise<number> {
  let ruleId = 0;
  try {
    await sessionRuleManager.ensureReconciled();
    await sessionRuleManager.reapOrphans();
    ruleId = await sessionRuleManager.allocate(ownerKey);
    await ensureOffscreenDocument();
    await addBiliMediaSessionRule(ruleId, kind);
    return ruleId;
  } catch (error) {
    if (ruleId) {
      sessionRuleManager.release(ruleId);
    }
    throw error;
  }
}

/** Verifies recorded rule ownership (if provided), removes the DNR session rule, and releases its id. */
export async function releaseBiliMediaSessionRule(ruleId: number, ownerKey?: string): Promise<void> {
  const id = Number(ruleId) || 0;
  if (id <= 0) {
    return;
  }
  if (ownerKey !== undefined) {
    const recordedOwner = sessionRuleManager.getOwner(id);
    if (recordedOwner && recordedOwner !== ownerKey) {
      throw new Error("防盗链规则不属于当前来源");
    }
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id]
  });
  sessionRuleManager.release(id);
}

/** Runs an async operation under a scoped Bilibili media DNR rule and releases it in finally. */
export async function withBiliMediaSessionRule<T>(
  kind: BiliMediaSessionRuleKind,
  run: () => Promise<T>,
  ownerKey?: string
): Promise<T> {
  const ruleId = await acquireBiliMediaSessionRule(kind, ownerKey);
  try {
    return await run();
  } finally {
    await releaseBiliMediaSessionRule(ruleId, ownerKey);
  }
}

/** Removes all session rules in the pool range and resets the rule manager ledger. */
export async function reapAllBiliMediaSessionRules(): Promise<void> {
  await sessionRuleManager.clearAll();
}

/** Returns the recorded owner key for an active session rule id, or "" if unrecorded. */
export function getBiliMediaSessionRuleOwner(ruleId: number): string {
  return sessionRuleManager.getOwner(ruleId) ?? "";
}
