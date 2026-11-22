import { isReaderMode, isSupportedVideoPage } from "../bilibili/video-id-shared.js";
import { buildReaderModeUrl } from "../bilibili/reader-url.js";
import { dispatchContentScriptMessage } from "../shared/messaging.js";
import { isReaderViewOpen } from "../reader/state.js";
import { isReaderShellIntact } from "../reader/shell-intact.js";
import { bindPanelPreloadOnButton, schedulePanelPreloadOnIdle } from "./panel-preload.js";
import { TOOLBAR_HOST_SELECTOR } from "../bilibili/host-selectors.js";
import { contentEventBus } from "../shared/content-event-bus.js";
import { SELF_HEAL_INTERVAL_MS } from "../shared/self-heal.js";
import { logInfoAlways } from "../shared/logging.js";

const SCRIPT_BUTTON_ID = "biliscript-script-button";

const REINJECT_INTERVAL_MS = SELF_HEAL_INTERVAL_MS;
const PAUSED_INTERVAL_MS = 2000;

const BUTTON_BASE_STYLE =
  "display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;" +
  "height:34px;padding:0 20px;border:none;border-radius:8px;cursor:pointer;" +
  "font-size:14px;font-weight:500;line-height:20px;color:#fff;white-space:nowrap;";

const MODULE_BOOT_AT = Date.now();
let mountTimingLogged = false;

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    setTickInterval(REINJECT_INTERVAL_MS);
    syncScriptButton();
  }
});
contentEventBus.on("reader:closed", () => {
  setTickInterval(REINJECT_INTERVAL_MS);
  syncScriptButton();
});

let tickTimer = 0;
let tickIntervalMs = 0;

function setTickInterval(ms: number): void {
  if (tickTimer && tickIntervalMs === ms) {
    return;
  }
  if (tickTimer) {
    window.clearInterval(tickTimer);
  }
  tickTimer = window.setInterval(syncScriptButton, ms);
  tickIntervalMs = ms;
}

const RESTORE_CONFIRM_TICKS = 3;
const RESTORE_RETRY_BACKOFF_MS = 4000;
let brokenTicks = 0;
let lastRestoreAt = 0;

function syncScriptButton(): void {
  if (!isSupportedVideoPage()) {
    brokenTicks = 0;
    anchorPhase = "init";
    anchorGraceBeats = 0;
    setTickInterval(REINJECT_INTERVAL_MS);
    removeScriptButton();
    return;
  }
  const viewOpen = isReaderViewOpen();
  const readerUrlMode = isReaderMode();
  if (viewOpen && isReaderShellIntact()) {
    brokenTicks = 0;
    setTickInterval(PAUSED_INTERVAL_MS);
    removeScriptButton();
    return;
  }
  if (viewOpen || readerUrlMode) {
    setTickInterval(REINJECT_INTERVAL_MS);
    if (++brokenTicks >= RESTORE_CONFIRM_TICKS) {
      const now = Date.now();
      if (now - lastRestoreAt >= RESTORE_RETRY_BACKOFF_MS) {
        brokenTicks = 0;
        lastRestoreAt = now;
        dispatchContentScriptMessage(
          { type: "reader-restore", readerUrl: buildReaderModeUrl(location.href) },
          () => {}
        );
      }
    }
    return;
  }
  brokenTicks = 0;
  setTickInterval(REINJECT_INTERVAL_MS);
  injectScriptButton();
}

type AnchorPhase = "init" | "anchor" | "grace" | "fallback";
let anchorPhase: AnchorPhase = "init";
let anchorGraceBeats = 0;
let anchorGraceWaitLogged = false;
const ANCHOR_GRACE_BEATS = 2;

function logAnchor(message: string): void {
  logInfoAlways(`[BILISCRIPT] script-button: ${message}`);
}

function logMountTiming(target: string): void {
  if (mountTimingLogged) {
    return;
  }
  mountTimingLogged = true;
  logAnchor(`按钮已挂载（${target}），装载→挂载耗时 ${Date.now() - MODULE_BOOT_AT}ms`);
}

let anchorSeat: HTMLElement | null = null;

export function injectScriptButton(): void {
  const existing = document.getElementById(SCRIPT_BUTTON_ID);
  if (existing?.isConnected && anchorSeat && existing.nextElementSibling === anchorSeat) {
    anchorPhase = "anchor";
    anchorGraceBeats = 0;
    anchorGraceWaitLogged = false;
    return;
  }
  const hostPresent = document.querySelector(TOOLBAR_HOST_SELECTOR) !== null;
  if (!isToolbarObserverActive() || toolbarObserverExpectsHost !== hostPresent) {
    bindToolbarObserver();
  }
  const complaint = hostPresent ? findComplaintNode() : null;

  if (complaint && complaint.parentElement) {
    if (anchorPhase !== "anchor") {
      logAnchor(
        anchorPhase === "fallback"
          ? "锚点①恢复，升回「稿件举报」左侧"
          : "锚点①命中"
      );
    }
    anchorPhase = "anchor";
    anchorGraceBeats = 0;
    anchorGraceWaitLogged = false;
    if (existing?.isConnected && existing.nextElementSibling === complaint) {
      anchorSeat = complaint;
      return;
    }
    const button = existing?.isConnected ? existing : createScriptButton();
    styleScriptButton(button, { position: "before-complaint" });
    complaint.parentElement.insertBefore(button, complaint);
    anchorSeat = complaint;
    bindPanelPreloadOnButton(button);
    schedulePanelPreloadOnIdle();
    logMountTiming("锚点①「稿件举报」左侧");
    return;
  }

  if (anchorPhase === "anchor") {
    anchorPhase = "grace";
    anchorGraceBeats = ANCHOR_GRACE_BEATS;
    anchorGraceWaitLogged = false;
    logAnchor("锚点①失配（「稿件举报」节点消失），进入宽限等待重渲染恢复");
  }
  if (anchorPhase === "grace") {
    if (anchorGraceBeats > 0) {
      anchorGraceBeats -= 1;
      if (existing?.isConnected) {
        return;
      }
      if (!anchorGraceWaitLogged) {
        anchorGraceWaitLogged = true;
        logAnchor("宽限期内暂不注入（等锚点①恢复，避免闪漂）");
      }
      return;
    }
    anchorPhase = "fallback";
    anchorGraceWaitLogged = false;
    logAnchor("宽限耗尽，锚点①未恢复");
  }

  anchorSeat = null;
  const toolbarLeft = hostPresent ? findToolbarLeftWithoutRight() : null;
  if (toolbarLeft && toolbarLeft.parentElement) {
    anchorPhase = "fallback";
    if (existing?.isConnected && existing.previousElementSibling === toolbarLeft) {
      return;
    }
    const button = existing?.isConnected ? existing : createScriptButton();
    styleScriptButton(button, { position: "toolbar-end" });
    toolbarLeft.parentElement.insertBefore(button, toolbarLeft.nextSibling);
    bindPanelPreloadOnButton(button);
    schedulePanelPreloadOnIdle();
    logMountTiming("工具栏右侧槽位（无「稿件举报」时）");
    return;
  }

  if (existing?.isConnected) {
    existing.remove();
  }
}

function createScriptButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.id = SCRIPT_BUTTON_ID;
  button.type = "button";
  button.textContent = "文摘";
  button.title = "阅读这期视频的字幕与文摘";
  button.setAttribute("aria-label", "阅读这期视频的字幕与文摘");
  button.setAttribute("data-biliscript-extension-node", "script-button");
  button.addEventListener("click", handleScriptButtonClick);
  return button;
}

export function removeScriptButton(): void {
  unbindToolbarObserver();
  document.getElementById(SCRIPT_BUTTON_ID)?.remove();
}

let toolbarObserver: MutationObserver | null = null;
let toolbarObserverTargets: Element[] = [];
let toolbarObserverExpectsHost = false;

function onToolbarMutation(): void {
  syncScriptButton();
}

function bindToolbarObserver(): void {
  if (typeof MutationObserver === "undefined") {
    return;
  }
  if (!toolbarObserver) {
    toolbarObserver = new MutationObserver(onToolbarMutation);
  }
  toolbarObserver.disconnect();
  toolbarObserverTargets = [];
  const hosts = document.querySelectorAll(TOOLBAR_HOST_SELECTOR);
  toolbarObserverExpectsHost = hosts.length > 0;
  if (!toolbarObserverExpectsHost) {
    toolbarObserver.observe(document.body, { childList: true, subtree: true });
    toolbarObserverTargets = [document.body];
    return;
  }
  for (const host of hosts) {
    toolbarObserver.observe(host, { childList: true, subtree: true });
    toolbarObserverTargets.push(host);
  }
}

function isToolbarObserverActive(): boolean {
  return toolbarObserverTargets.some((target) => target.isConnected);
}

function unbindToolbarObserver(): void {
  toolbarObserver?.disconnect();
  toolbarObserver = null;
  toolbarObserverTargets = [];
}

const COMPLAINT_CLASS_SIGNAL = /complaint/i;
const COMPLAINT_TEXT_SIGNAL = /稿件举报|投诉/;

function findComplaintNode(): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestScore = 0;
  const consider = (node: Element, requireBoth = false): void => {
    if (bestScore >= 2 || !(node instanceof HTMLElement) || !node.parentElement) {
      return;
    }
    const classHit = COMPLAINT_CLASS_SIGNAL.test(
      typeof node.className === "string" ? node.className : ""
    );
    const attrText = [
      node.getAttribute("aria-label"),
      node.getAttribute("title"),
      node.getAttribute("data-text")
    ]
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .join(" ");
    const textHit =
      COMPLAINT_TEXT_SIGNAL.test(attrText) ||
      ((classHit || node.firstElementChild === null) &&
        COMPLAINT_TEXT_SIGNAL.test(node.textContent ?? ""));
    if ((!classHit && !textHit) || (requireBoth && !(classHit && textHit))) {
      return;
    }
    const score = (classHit ? 1 : 0) + (textHit ? 1 : 0);
    if (score > bestScore) {
      best = node;
      bestScore = score;
    }
  };
  for (const host of document.querySelectorAll(TOOLBAR_HOST_SELECTOR)) {
    host.querySelectorAll("*").forEach((node) => consider(node));
  }
  if (bestScore < 2) {
    document.querySelectorAll("[class*='complaint']").forEach((node) => consider(node, true));
  }
  return best;
}

function findToolbarLeftWithoutRight(): HTMLElement | null {
  for (const host of document.querySelectorAll(TOOLBAR_HOST_SELECTOR)) {
    if (host.querySelector(".video-toolbar-right")) {
      continue;
    }
    const left = host.querySelector(".video-toolbar-left");
    if (left instanceof HTMLElement && left.parentElement) {
      return left;
    }
  }
  return null;
}

function styleScriptButton(
  button: HTMLElement,
  { position }: { position: "before-complaint" | "toolbar-end" }
): void {
  button.style.cssText =
    position === "toolbar-end"
      ? `${BUTTON_BASE_STYLE}background:#fb7299;margin-left:auto;`
      : `${BUTTON_BASE_STYLE}background:#fb7299;margin-right:16px;`;
}

function handleScriptButtonClick(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
  if (isReaderViewOpen() || isReaderMode()) {
    return;
  }
  const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
  const showFailure = (error?: unknown) => {
    if (!button?.isConnected) return;
    const detail = typeof error === "string" ? error.trim() : "";
    const message = detail ? `文摘面板打开失败：${detail}` : "文摘面板打开失败，请刷新浏览器网页重试";
    button.textContent = "文摘打开失败";
    button.title = message;
    button.setAttribute("aria-label", message);
  };
  const dispatched = dispatchContentScriptMessage(
    { type: "reader-enter", readerUrl: buildReaderModeUrl(location.href) },
    (response) => {
      if (!response?.ok) {
        showFailure(response?.error);
      }
    }
  );
  if (!dispatched) {
    showFailure();
  }
}

syncScriptButton();
setTickInterval(REINJECT_INTERVAL_MS);
