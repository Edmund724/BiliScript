// Background host for the shared offscreen document (Chrome offscreen API / Firefox Event Page iframe)
// and Bilibili media DNR session rules.

import { getErrorMessage } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";
import { OFFSCREEN_CREATE_REASONS, OFFSCREEN_URL } from "../shared/offscreen-constants.js";
import type { MessageSender } from "../shared/messaging-protocol.js";
import { isFirefoxRuntime } from "../shared/runtime-capabilities.js";
import { ASR_OFFSCREEN_REJECTION_MESSAGE } from "../asr/protocol.js";
import { createAsrSessionRuleManager } from "../asr/session-rule-manager.js";

export const BILI_MEDIA_CDN_DOMAINS = ["bilivideo.com", "bilivideo.cn", "akamaized.net"] as const;
export const BILI_MEDIA_ORIGIN_PAGE = "https://www.bilibili.com" as const;
export const BILIBILI_TAB_URL_PATTERN = "*://*.bilibili.com/*" as const;

export const INDEX_TRANSLATE_SESSION_RULE_ID = 9003;
export const INDEX_TRANSLATE_DOMAIN = "index-translate.bilibili.com" as const;
export const INDEX_TRANSLATE_ORIGIN_HEADER = "https://index-translate.bilibili.com" as const;
export const INDEX_TRANSLATE_USER_AGENT_VALUE = "Index-Translate-Client/1.0" as const;

export const OFFSCREEN_IFRAME_ID = "biliscript-offscreen-iframe";
export const OFFSCREEN_SENDER_REJECTION_MESSAGE = ASR_OFFSCREEN_REJECTION_MESSAGE;
// chrome.tabs.TAB_ID_NONE: matches requests not originating from any browser tab (background / offscreen).
export const NON_TAB_DNR_TAB_ID = -1;

export type BiliMediaSessionRuleKind = "audio-xhr" | "video-media";

const OFFSCREEN_ALREADY_EXISTS_RE = /already exist|single offscreen/i;
const OFFSCREEN_JUSTIFICATION =
  "Run AI streams, ASR audio decoding, live companion sessions, and background video frame capture.";

type ServiceWorkerScopeLike = {
  clients?: {
    matchAll?: (options: { includeUncontrolled: boolean }) => Promise<Array<{ url?: string }>>;
  };
};

type LifecycleOpKind = "ensure" | "close";

interface QueuedLifecycleOp {
  kind: LifecycleOpKind;
  promise: Promise<unknown>;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

const sessionRuleManager = createAsrSessionRuleManager();

let inflightIframePromise: Promise<boolean> | null = null;
let cancelInflightIframe: ((reason: Error) => void) | null = null;

// Serialized lifecycle queue and generation counter shared across ensure/close operations.
// Prevents Chromium closeDocument/createDocument races and lets queued close operations
// bail out cleanly when a newer ensure request is already waiting in line.
let activeLifecycleOp: LifecycleOpKind | null = null;
let activeEnsurePromise: Promise<boolean> | null = null;
let queuedEnsureEntry: QueuedLifecycleOp | null = null;
let ensureGeneration = 0;
const lifecycleQueue: QueuedLifecycleOp[] = [];

function hasNativeOffscreenCreate(): boolean {
  return typeof chrome !== "undefined" && typeof chrome.offscreen?.createDocument === "function";
}

function hasNativeOffscreenClose(): boolean {
  return typeof chrome !== "undefined" && typeof chrome.offscreen?.closeDocument === "function";
}

function hasDomBody(): boolean {
  return typeof document !== "undefined" && Boolean(document.body);
}

function getExistingOffscreenIframe(): HTMLIFrameElement | null {
  if (typeof document === "undefined") {
    return null;
  }
  const node = document.getElementById(OFFSCREEN_IFRAME_ID);
  if (typeof HTMLIFrameElement !== "undefined" && node instanceof HTMLIFrameElement) {
    return node;
  }
  return null;
}

function isLiveOffscreenIframe(iframe: HTMLIFrameElement | null): iframe is HTMLIFrameElement {
  return iframe !== null && iframe.contentWindow !== null;
}

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

/** Returns true if an offscreen document (native or Firefox hidden iframe) currently exists. */
export async function hasOffscreenDocument(): Promise<boolean> {
  if (typeof chrome === "undefined" || typeof chrome.runtime?.getURL !== "function") {
    return false;
  }
  if (!hasNativeOffscreenCreate() && !hasNativeOffscreenClose()) {
    return isLiveOffscreenIframe(getExistingOffscreenIframe());
  }
  return hasExistingOffscreenDocument(chrome.runtime.getURL(OFFSCREEN_URL));
}

/** Returns true if at least one Bilibili tab (`*://*.bilibili.com/*`) is currently open. */
export async function hasOpenBilibiliTabs(): Promise<boolean> {
  if (typeof chrome === "undefined" || typeof chrome.tabs?.query !== "function") {
    return true;
  }
  try {
    const tabs = await chrome.tabs.query({ url: BILIBILI_TAB_URL_PATTERN });
    return Array.isArray(tabs) && tabs.length > 0;
  } catch {
    // Query failure falls back conservatively so light idle fallback handles teardown instead of premature close.
    return true;
  }
}

function ensureOffscreenIframe(url: string): Promise<boolean> {
  if (inflightIframePromise) {
    return inflightIframePromise;
  }
  if (isLiveOffscreenIframe(getExistingOffscreenIframe())) {
    return Promise.resolve(true);
  }
  // Remove any stale iframe (contentWindow === null) or colliding node before mounting a fresh one.
  document.getElementById(OFFSCREEN_IFRAME_ID)?.remove();

  let settled = false;
  const promise = new Promise<boolean>((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.id = OFFSCREEN_IFRAME_ID;
    iframe.hidden = true;
    iframe.style.display = "none";

    const clearInflight = () => {
      iframe.removeEventListener("load", onLoad);
      iframe.removeEventListener("error", onError);
      if (cancelInflightIframe === onCancel) {
        cancelInflightIframe = null;
      }
      inflightIframePromise = null;
    };
    const onLoad = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearInflight();
      resolve(true);
    };
    const onError = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearInflight();
      iframe.remove();
      const error = new Error(`Failed to load offscreen iframe: ${url}`);
      logWarn("[BILISCRIPT] ensureOffscreenDocument iframe load failed", {
        error: error.message
      });
      reject(error);
    };
    const onCancel = (reason: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInflight();
      reject(reason);
    };

    cancelInflightIframe = onCancel;
    iframe.addEventListener("load", onLoad);
    iframe.addEventListener("error", onError);
    try {
      iframe.src = url;
      document.body.appendChild(iframe);
    } catch (error) {
      settled = true;
      clearInflight();
      iframe.remove();
      reject(error);
    }
  });

  if (!settled) {
    inflightIframePromise = promise;
  }
  return promise;
}

async function performEnsureOffscreenDocument(): Promise<boolean> {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  if (!hasNativeOffscreenCreate()) {
    if (hasDomBody()) {
      return ensureOffscreenIframe(url);
    }
    throw new Error("Offscreen document host is unavailable in this environment.");
  }
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

async function performCloseOffscreenDocument(): Promise<void> {
  if (hasNativeOffscreenClose()) {
    await chrome.offscreen.closeDocument();
    return;
  }
  if (cancelInflightIframe) {
    cancelInflightIframe(new Error("Offscreen iframe closed before load completed."));
  }
  const existing = getExistingOffscreenIframe();
  if (existing) {
    existing.src = "about:blank";
    existing.remove();
  }
}

function drainLifecycleQueue(): void {
  if (activeLifecycleOp !== null || lifecycleQueue.length === 0) {
    return;
  }
  const next = lifecycleQueue.shift()!;
  if (queuedEnsureEntry === next) {
    queuedEnsureEntry = null;
  }
  activeLifecycleOp = next.kind;
  if (next.kind === "ensure") {
    activeEnsurePromise = next.promise as Promise<boolean>;
  }

  let taskPromise: Promise<unknown>;
  try {
    taskPromise = Promise.resolve(next.run());
  } catch (error) {
    taskPromise = Promise.reject(error);
  }

  void taskPromise.then(
    (value) => {
      next.resolve(value);
    },
    (reason) => {
      next.reject(reason);
    }
  ).finally(() => {
    activeLifecycleOp = null;
    if (activeEnsurePromise === next.promise) {
      activeEnsurePromise = null;
    }
    drainLifecycleQueue();
  });
}

function startActiveLifecycleOp<T>(kind: LifecycleOpKind, run: () => Promise<T>): Promise<T> {
  activeLifecycleOp = kind;
  let taskPromise: Promise<T>;
  try {
    taskPromise = Promise.resolve(run());
  } catch (error) {
    taskPromise = Promise.reject(error);
  }

  const tracked = new Promise<T>((resolve, reject) => {
    void taskPromise.then(resolve, reject).finally(() => {
      activeLifecycleOp = null;
      if (activeEnsurePromise === tracked) {
        activeEnsurePromise = null;
      }
      drainLifecycleQueue();
    });
  });

  if (kind === "ensure") {
    activeEnsurePromise = tracked as Promise<boolean>;
  }
  return tracked;
}

function enqueueLifecycleOp<T>(kind: LifecycleOpKind, run: () => Promise<T>): QueuedLifecycleOp {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as (value: unknown) => void;
    reject = rej;
  });
  const entry: QueuedLifecycleOp = {
    kind,
    promise,
    run,
    resolve,
    reject
  };
  lifecycleQueue.push(entry);
  return entry;
}

/** Ensures the shared offscreen document exists, serialized through the lifecycle queue. */
export function ensureOffscreenDocument(): Promise<boolean> {
  ensureGeneration += 1;

  if (activeLifecycleOp === "ensure" && lifecycleQueue.length === 0 && activeEnsurePromise) {
    return activeEnsurePromise;
  }
  if (
    lifecycleQueue.length > 0 &&
    queuedEnsureEntry !== null &&
    lifecycleQueue[lifecycleQueue.length - 1] === queuedEnsureEntry
  ) {
    return queuedEnsureEntry.promise as Promise<boolean>;
  }
  if (activeLifecycleOp === null) {
    return startActiveLifecycleOp("ensure", performEnsureOffscreenDocument);
  }
  const entry = enqueueLifecycleOp("ensure", performEnsureOffscreenDocument);
  queuedEnsureEntry = entry;
  return entry.promise as Promise<boolean>;
}

/**
 * Closes the shared offscreen document via the serialized lifecycle queue.
 * If a newer ensureOffscreenDocument() request enters the queue before this close runs,
 * the close is skipped and the existing document is reused. Returns true if teardown ran.
 */
export function tryCloseOffscreenDocument(): Promise<boolean> {
  const enqueuedGeneration = ensureGeneration;
  const runClose = async (): Promise<boolean> => {
    if (ensureGeneration > enqueuedGeneration) {
      return false;
    }
    await performCloseOffscreenDocument();
    return true;
  };

  if (activeLifecycleOp === null) {
    return startActiveLifecycleOp("close", runClose);
  }

  const entry = enqueueLifecycleOp("close", runClose);
  queuedEnsureEntry = null;

  // On Firefox Event Page iframe path, an in-flight iframe load waits on external DOM events;
  // cancelling it unblocks teardown immediately when close is requested before load completes.
  if (activeLifecycleOp === "ensure" && !hasNativeOffscreenCreate() && cancelInflightIframe) {
    cancelInflightIframe(new Error("Offscreen iframe closed before load completed."));
  }

  return entry.promise as Promise<boolean>;
}

/** Closes the shared offscreen document via the service worker API or Event Page iframe teardown. */
export async function closeOffscreenDocument(): Promise<void> {
  await tryCloseOffscreenDocument();
}

/** Returns true only when the runtime message sender is the offscreen document itself. */
export function isOffscreenDocumentSender(sender: MessageSender): boolean {
  return !sender?.tab && sender?.url === chrome.runtime.getURL(OFFSCREEN_URL);
}

function resolveExtensionInitiatorDomain(): string | null {
  if (typeof chrome === "undefined") {
    return null;
  }
  const getHostnameFromRuntimeUrl = (): string | null => {
    try {
      const baseUrl = chrome.runtime?.getURL?.("");
      if (typeof baseUrl === "string" && baseUrl) {
        const hostname = new URL(baseUrl).hostname.trim();
        if (hostname) {
          return hostname;
        }
      }
    } catch {
      // Ignore malformed runtime URLs.
    }
    return null;
  };
  // Firefox 下 chrome.runtime.id 是清单 gecko.id（如 biliscript@edmund724.github.io），
  // 含 "@" 不符合规范域名且与实际 initiator（moz-extension://<uuid>）不一致，必须取 runtime.getURL("") 的内部 UUID。
  if (isFirefoxRuntime()) {
    return getHostnameFromRuntimeUrl();
  }
  const runtimeId = typeof chrome.runtime?.id === "string" ? chrome.runtime.id.trim() : "";
  if (runtimeId && !runtimeId.includes("@")) {
    return runtimeId;
  }
  return getHostnameFromRuntimeUrl();
}

async function addBiliMediaSessionRule(ruleId: number, kind: BiliMediaSessionRuleKind): Promise<void> {
  const id = Number(ruleId) || 0;
  if (id <= 0) {
    throw new Error("缺少防盗链规则 id");
  }
  const isVideoMedia = kind === "video-media";
  const initiatorDomain = resolveExtensionInitiatorDomain();
  const action: chrome.declarativeNetRequest.RuleAction = {
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
  };
  const baseCondition: chrome.declarativeNetRequest.RuleCondition = {
    requestDomains: [...BILI_MEDIA_CDN_DOMAINS],
    tabIds: [NON_TAB_DNR_TAB_ID],
    resourceTypes: [isVideoMedia ? "media" : "xmlhttprequest"]
  };
  const scopedCondition: chrome.declarativeNetRequest.RuleCondition = initiatorDomain
    ? {
        ...baseCondition,
        initiatorDomains: [initiatorDomain]
      }
    : baseCondition;

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 1,
          action,
          condition: scopedCondition
        }
      ]
    });
  } catch (error) {
    // Firefox 部分运行时可能拒绝 moz-extension UUID 作为 initiatorDomains；保留 tabIds: [-1] 隔离并降级重试。
    if (!isFirefoxRuntime() || !initiatorDomain) {
      throw error;
    }
    logWarn("[BILISCRIPT] Firefox DNR initiatorDomains rejected, falling back to tabIds-only isolation", {
      error: getErrorMessage(error)
    });
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 1,
          action,
          condition: baseCondition
        }
      ]
    });
  }
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

/**
 * Ensures the DNR session rule (ruleId 9003) for Bilibili Index-Translate requests
 * from extension/offscreen contexts: injects the required User-Agent and a compliant
 * Origin header so requests are not rejected by Bilibili WAF (HTTP 412).
 */
export async function ensureIndexTranslateSessionRule(): Promise<void> {
  if (
    typeof chrome === "undefined" ||
    !chrome.declarativeNetRequest ||
    typeof chrome.declarativeNetRequest.updateSessionRules !== "function"
  ) {
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [INDEX_TRANSLATE_SESSION_RULE_ID],
    addRules: [
      {
        id: INDEX_TRANSLATE_SESSION_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "User-Agent", operation: "set", value: INDEX_TRANSLATE_USER_AGENT_VALUE },
            { header: "Origin", operation: "set", value: INDEX_TRANSLATE_ORIGIN_HEADER }
          ]
        },
        condition: {
          requestDomains: [INDEX_TRANSLATE_DOMAIN],
          resourceTypes: ["xmlhttprequest"]
        }
      }
    ]
  });
}
