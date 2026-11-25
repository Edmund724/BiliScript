import { buildPlayerAiQuickActionIconSvg, buildPlayerLiveQuickActionIconSvg } from "../ui/icons.js";
import { bindPanelPreloadOnButton } from "../ui/panel-preload.js";
import {
  createThrottledLiveToggleHandler,
  isControlBarLiveToggleMounted,
  mountControlBarLiveToggle,
  syncPlayerLiveToggleButton
} from "../live/player-live-toggle.js";
import { createLazyLoader } from "../shared/lazy-import.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { getSettings } from "../core/runtime.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { exitPlayerFullscreenIfNeeded } from "../bilibili/fullscreen.js";
import { isReaderDetached } from "../shared/active-host.js";
import { state } from "../core/state.js";
import { playerAiState } from "./player-ai-state.js";
import { isVisibleReaderControl } from "../shared/dom-utils.js";
import { supportsLiveCompanion } from "../shared/runtime-capabilities.js";
import { logInfoAlways } from "../shared/logging.js";
import { ensurePlayerAiStyles, removePlayerAiStyles } from "../shared/style-injector.js";
import { decidePlayerAiQuickAction } from "./player-ai-mount-decision.js";
import {
  DEFAULT_PLAYER_CONTAINER_SELECTOR,
  applyControlBarPlacement,
  isControlBarItemMounted,
  observePlayerContainer,
  resolveControlBarPlacement
} from "../bilibili/player-control-mount.js";
import {
  BILI_HOST_SELECTORS,
  PLAYER_SUBTITLE_CONTROL_ROOTS_SELECTOR,
  findPlayerHostFromVideo,
  findPlayerHostWithVideoArea
} from "../bilibili/host-adapter.js";
import { detectActiveSite, getSiteCapabilities, type SiteCapabilities } from "../shared/site.js";
import {
  YOUTUBE_PLAYER_SELECTORS,
  findYoutubePlayerHost,
  getYoutubeVideoElement,
  isYoutubeWatchDocument
} from "../youtube/host-adapter.js";
import { createDisposableContext, type DisposableContext } from "../shared/typed-event-bus.js";

ensurePlayerAiStyles();

const PLAYER_AI_FRAME_RETRY_BUDGET = 20;
let playerAiQuickActionRetryCount = 0;
let playerAiQuickActionFrameRetriesLeft = PLAYER_AI_FRAME_RETRY_BUDGET;
type LiveCompanionSessionModule = typeof import("../live/live-companion-session.js");
let liveCompanionSessionLoader: ReturnType<typeof createLazyLoader<LiveCompanionSessionModule>> | null = null;
function getLiveCompanionSessionLoader() {
  if (!liveCompanionSessionLoader) {
    liveCompanionSessionLoader = createLazyLoader(() => import("../live/live-companion-session.js"));
  }
  return liveCompanionSessionLoader;
}
const playerInterpretLoader = createLazyLoader(() => import("../live/player-interpret.js"));
type PlayerInterpretModule = Awaited<ReturnType<typeof playerInterpretLoader.load>>;
let loadedPlayerInterpret: PlayerInterpretModule | null = null;

async function loadPlayerInterpret(): Promise<PlayerInterpretModule> {
  const mod = await playerInterpretLoader.load();
  loadedPlayerInterpret = mod;
  return mod;
}

function shouldSyncPlayerInterpretOnMount(button: HTMLButtonElement): boolean {
  if (playerInterpretLoader.isLoaded()) {
    return true;
  }
  if (
    button.classList.contains("is-active") ||
    button.classList.contains("is-connecting") ||
    document.getElementById("biliscript-interpret-menu") !== null
  ) {
    return true;
  }
  const hasSettledSubtitles =
    state.clip.subtitleFetchState === "ready" || state.clip.subtitleFetchState === "empty";
  const hasConfiguredInterpretMode = Boolean(
    state.settings?.bilingualSubtitles ||
      (state.settings?.liveInterpretDisplayMode && state.settings.liveInterpretDisplayMode !== "auto")
  );
  return hasSettledSubtitles && hasConfiguredInterpretMode;
}

function syncPlayerInterpretQuickActionLazy(): void {
  if (loadedPlayerInterpret) {
    loadedPlayerInterpret.syncPlayerInterpretQuickAction();
    return;
  }
  void loadPlayerInterpret()
    .then((mod) => {
      mod.syncPlayerInterpretQuickAction();
    })
    .catch(() => {});
}

function closePlayerInterpretMenuLazy(): void {
  if (!playerInterpretLoader.isLoaded()) {
    return;
  }
  if (loadedPlayerInterpret) {
    loadedPlayerInterpret.closePlayerInterpretMenu();
    return;
  }
  void loadPlayerInterpret()
    .then((mod) => {
      mod.closePlayerInterpretMenu();
    })
    .catch(() => {});
}

let liveQuickActionTargetButton: HTMLButtonElement | null = null;
let liveQuickActionToggleHandler: ReturnType<typeof createThrottledLiveToggleHandler> | null = null;
function getLiveQuickActionToggleHandler() {
  if (!liveQuickActionToggleHandler) {
    liveQuickActionToggleHandler = createThrottledLiveToggleHandler(async () => {
      if (!supportsLiveCompanion()) {
        return;
      }
      const liveButton = liveQuickActionTargetButton;
      let session: LiveCompanionSessionModule | null = null;
      try {
        session = await getLiveCompanionSessionLoader().load();
        const isCurrentlyActive = Boolean(
          liveButton?.classList.contains("is-active") ||
            document.body.hasAttribute("data-biliscript-live-active") ||
            session.isLiveCompanionActive() ||
            session.getLiveController()?.getState() === "connected" ||
            session.getLiveController()?.getState() === "connecting"
        );

        if (isCurrentlyActive) {
          session.stopLiveCompanion();
        } else {
          await session.startLiveCompanion();
        }
      } catch {
        const errorMessage = "实时伴看启动失败，请重试";
        try {
          const targetSession = session ?? (await getLiveCompanionSessionLoader().load());
          const overlay = targetSession.ensureFullscreenOverlay();
          overlay.show({ forceExpand: true });
          overlay.syncState("failure", false, errorMessage, "unknown");
        } catch {}
      }
    });
  }
  return liveQuickActionToggleHandler;
}

const MODULE_BOOT_AT = Date.now();
let mountTimingLogged = false;

let playerAiObserverScope: DisposableContext | null = null;
let playerAiLayoutScope: DisposableContext | null = null;
interface CursorSync {
  host: HTMLElement;
  wrap: HTMLElement;
  scope: DisposableContext;
}
let playerAiQuickActionCursorSync: CursorSync | null = null;

let playerAiQuickActionMountedWrap: HTMLElement | null = null;
let playerAiQuickActionMountedHost: HTMLElement | null = null;

let playerAiSubtitleControlCalibrated = false;

const PLAYER_AI_HIT_SIZE_PX = 36;
const PLAYER_AI_ICON_SIZE_PX = 26;
const PLAYER_AI_BASE_COLOR = "#f6f7f8";

function isYoutubeSite(): boolean {
  return state.clip.site === "youtube" || detectActiveSite() === "youtube";
}

function getActiveSiteCapabilities(): SiteCapabilities {
  return getSiteCapabilities(isYoutubeSite() ? "youtube" : "bilibili");
}

function isPlayerLiveQuickActionMountedStable(playerHost: HTMLElement): boolean {
  if (typeof __BILISCRIPT_TARGET__ === "string" && __BILISCRIPT_TARGET__ === "firefox") {
    return true;
  } else {
    if (!supportsLiveCompanion() || !getActiveSiteCapabilities().supportsLiveCompanion) {
      return true;
    }
    const liveWrap = document.getElementById("biliscript-player-live-quick-action-wrap");
    const liveButton = document.getElementById("biliscript-player-live-quick-action");
    if (!liveWrap || !liveButton || !liveWrap.isConnected || !liveWrap.contains(liveButton)) {
      return false;
    }
    return isControlBarLiveToggleMounted(liveWrap, playerHost, { fallbackToHost: true });
  }
}

function resolvePlayerInterpretQuickActionPlacement(playerHost: HTMLElement) {
  if (isYoutubeSite()) {
    const rightControls = playerHost.querySelector<HTMLElement>(".ytp-right-controls");
    if (!rightControls) {
      return null;
    }
    const anchorBtn = rightControls.querySelector<HTMLElement>(
      ".ytp-subtitles-button, .ytp-settings-button"
    );
    if (anchorBtn?.parentElement === rightControls) {
      return {
        kind: "before" as const,
        parent: rightControls,
        reference: anchorBtn
      };
    }
    return {
      kind: "prepend" as const,
      parent: rightControls
    };
  }
  const volumeNode = playerHost.querySelector(BILI_HOST_SELECTORS.playerVolumeControl);
  if (volumeNode?.parentElement instanceof HTMLElement) {
    return {
      kind: "before" as const,
      parent: volumeNode.parentElement,
      reference: volumeNode
    };
  }
  return resolveControlBarPlacement({ host: playerHost, fallbackToHost: true });
}

function isPlayerInterpretQuickActionMountedStable(playerHost: HTMLElement): boolean {
  if (!getActiveSiteCapabilities().supportsPlayerInterpretOverlay) {
    return true;
  }
  const interpretWrap = document.getElementById("biliscript-player-interpret-quick-action-wrap");
  const interpretButton = document.getElementById("biliscript-player-interpret-quick-action");
  if (!interpretWrap || !interpretButton || !interpretWrap.isConnected || !interpretWrap.contains(interpretButton)) {
    return false;
  }
  return isControlBarItemMounted(interpretWrap, resolvePlayerInterpretQuickActionPlacement(playerHost));
}

function isPlayerAiQuickActionMountedStable(): boolean {
  const wrap = playerAiQuickActionMountedWrap;
  const host = playerAiQuickActionMountedHost;
  const button = wrap?.firstElementChild;
  if (!(wrap instanceof HTMLElement) || !(host instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
    return false;
  }
  if (!isPlayerLiveQuickActionMountedStable(host) || !isPlayerInterpretQuickActionMountedStable(host)) {
    return false;
  }
  return wrap.isConnected && host.isConnected && wrap.parentElement === host && findPlayerAiQuickActionHost() === host;
}

function isPlayerAiQuickActionVisualsCurrent(button: HTMLElement): boolean {
  const wrap = button.parentElement;
  if (button.style.getPropertyValue("--biliscript-player-ai-action-icon-size") !== `${PLAYER_AI_ICON_SIZE_PX}px`) {
    return false;
  }
  if (!(wrap instanceof HTMLElement)) {
    return true;
  }
  return (
    wrap.style.getPropertyValue("--biliscript-player-ai-action-hit-size") === `${PLAYER_AI_HIT_SIZE_PX}px` &&
    wrap.style.getPropertyValue("--biliscript-player-ai-action-color") === PLAYER_AI_BASE_COLOR
  );
}

function tryRefreshPlayerAiQuickActionVisuals(): boolean {
  if (!isPlayerAiQuickActionMountedStable()) {
    return false;
  }
  const button = playerAiQuickActionMountedWrap?.firstElementChild;
  if (button instanceof HTMLButtonElement && !isPlayerAiQuickActionVisualsCurrent(button)) {
    syncPlayerAiQuickActionVisuals(button);
  }
  return true;
}

function clearPlayerAiQuickActionMountRecord(): void {
  playerAiQuickActionMountedWrap = null;
  playerAiQuickActionMountedHost = null;
}

export function resetPlayerAiQuickActionRetryCount(): void {
  playerAiQuickActionRetryCount = 0;
  playerAiQuickActionFrameRetriesLeft = PLAYER_AI_FRAME_RETRY_BUDGET;
}

export function startPlayerAiQuickAction(): void {
  bindPlayerAiQuickActionLayoutEvents();
  startPlayerAiQuickActionObserver();
  schedulePlayerAiQuickActionSync(0);
}

export function stopPlayerAiQuickAction(): void {
  removePlayerAiStyles();
  if (playerAiObserverScope) {
    playerAiObserverScope.dispose();
    playerAiObserverScope = null;
  }
  playerAiState.setObserver(null);
  unbindPlayerAiQuickActionLayoutEvents();
  unbindPlayerAiQuickActionCursorSync();
  cancelPlayerAiQuickActionSync();
  resetPlayerAiQuickActionRetryCount();
  removePlayerAiQuickActionButton();
  playerAiSubtitleControlCalibrated = false;
  if (!(typeof __BILISCRIPT_TARGET__ === "string" && __BILISCRIPT_TARGET__ === "firefox")) {
    liveQuickActionToggleHandler?.reset();
    liveQuickActionTargetButton = null;
  }
}

export function startPlayerAiQuickActionObserver(): void {
  if (playerAiObserverScope || playerAiState.playerAiQuickActionObserver || !document.body) {
    return;
  }

  const sync = (records: MutationRecord[] = []) => {
    if (!records.some((record) => record.type === "childList") && tryRefreshPlayerAiQuickActionVisuals()) {
      return;
    }
    schedulePlayerAiQuickActionSync(0);
  };

  const scope = createDisposableContext();
  playerAiObserverScope = scope;
  observePlayerContainer({
    containerSelector: isYoutubeSite() ? YOUTUBE_PLAYER_SELECTORS : DEFAULT_PLAYER_CONTAINER_SELECTOR,
    containerObserveOptions: {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"]
    },
    signal: scope.signal,
    onMutations: sync,
    onObserverChange: (observer) => {
      playerAiState.setObserver(observer);
    }
  });
}

export function bindPlayerAiQuickActionLayoutEvents(): void {
  if (playerAiState.playerAiQuickActionLayoutBound) {
    return;
  }
  const scope = createDisposableContext();
  playerAiLayoutScope = scope;
  const schedule = () => schedulePlayerAiQuickActionSync(80);
  scope.addListener(window, "resize", schedule, { passive: true });
  scope.addListener(window, "scroll", schedule, { passive: true });
  scope.addListener(window, "pageshow", schedule, { passive: true });
  scope.addListener(document, "fullscreenchange", schedule);
  scope.addListener(document, "webkitfullscreenchange", schedule);
  scope.addListener(window.visualViewport, "resize", schedule, { passive: true });
  playerAiState.setLayoutBound(true);
}

function unbindPlayerAiQuickActionLayoutEvents(): void {
  if (!playerAiLayoutScope && !playerAiState.playerAiQuickActionLayoutBound) {
    return;
  }
  playerAiLayoutScope?.dispose();
  playerAiLayoutScope = null;
  playerAiState.setLayoutBound(false);
}

export function schedulePlayerAiQuickActionSync(delayMs = 120): void {
  cancelPlayerAiQuickActionSync();
  if (delayMs === 0) {
    const rafId = window.requestAnimationFrame(() => {
      playerAiState.setSyncTimer(0);
      syncPlayerAiQuickActionButton();
    });
    playerAiState.setSyncTimer(-rafId);
    return;
  }
  playerAiState.setSyncTimer(window.setTimeout(() => {
    playerAiState.setSyncTimer(0);
    syncPlayerAiQuickActionButton();
  }, delayMs));
}

function cancelPlayerAiQuickActionSync(): void {
  const handle = playerAiState.playerAiQuickActionSyncTimer;
  if (!handle) {
    return;
  }
  if (handle < 0) {
    window.cancelAnimationFrame(-handle);
  } else {
    window.clearTimeout(handle);
  }
  playerAiState.setSyncTimer(0);
}

function schedulePlayerAiQuickActionRetry(): void {
  if (playerAiQuickActionFrameRetriesLeft > 0) {
    playerAiQuickActionFrameRetriesLeft -= 1;
    schedulePlayerAiQuickActionSync(0);
    return;
  }
  const delay = Math.min(100 * (playerAiQuickActionRetryCount + 1), 1000);
  playerAiQuickActionRetryCount += 1;
  schedulePlayerAiQuickActionSync(delay);
}

function mountPlayerLiveQuickAction(playerHost: HTMLElement): void {
  if (typeof __BILISCRIPT_TARGET__ === "string" && __BILISCRIPT_TARGET__ === "firefox") {
    document.getElementById("biliscript-player-live-quick-action-wrap")?.remove();
    document.getElementById("biliscript-player-live-quick-action")?.remove();
    return;
  } else {
    if (!supportsLiveCompanion() || !getActiveSiteCapabilities().supportsLiveCompanion) {
      document.getElementById("biliscript-player-live-quick-action-wrap")?.remove();
      document.getElementById("biliscript-player-live-quick-action")?.remove();
      return;
    }
    const existingLive = document.getElementById("biliscript-player-live-quick-action");
    let liveButton: HTMLButtonElement | null = existingLive instanceof HTMLButtonElement ? existingLive : null;
    const existingWrap = document.getElementById("biliscript-player-live-quick-action-wrap");
    let liveWrap = existingWrap instanceof HTMLElement ? existingWrap : null;
    const isActive = Boolean(
      document.body.hasAttribute("data-biliscript-live-active") ||
        existingLive?.classList.contains("is-active") ||
        existingWrap?.classList.contains("is-active")
    );

    if (!liveWrap) {
      liveWrap = document.createElement("div");
      liveWrap.id = "biliscript-player-live-quick-action-wrap";
      liveWrap.className = "bpx-player-ctrl-btn biliscript-player-live-quick-action-wrap";
      liveWrap.setAttribute("data-biliscript-extension-node", "live-quick-action");
    }

    let iconWrap = liveWrap.querySelector(".bpx-player-ctrl-btn-icon");
    if (!iconWrap) {
      iconWrap = document.createElement("div");
      iconWrap.className = "bpx-player-ctrl-btn-icon";
      liveWrap.appendChild(iconWrap);
    }

    if (!liveButton) {
      liveButton = document.createElement("button");
      liveButton.id = "biliscript-player-live-quick-action";
      liveButton.type = "button";
      liveButton.className = "biliscript-player-live-quick-action";
      liveButton.innerHTML = buildPlayerLiveQuickActionIconSvg();
      liveButton.addEventListener("click", handlePlayerLiveQuickActionClick, true);
    }

    syncPlayerLiveToggleButton({ button: liveButton, wrap: liveWrap, active: isActive });

    if (liveButton.parentElement !== iconWrap) {
      iconWrap.replaceChildren(liveButton);
    }

    mountControlBarLiveToggle(liveWrap, playerHost, { fallbackToHost: true });
  }
}

function mountPlayerInterpretQuickAction(playerHost: HTMLElement): void {
  if (!getActiveSiteCapabilities().supportsPlayerInterpretOverlay) {
    closePlayerInterpretMenuLazy();
    document.getElementById("biliscript-player-interpret-quick-action-wrap")?.remove();
    document.getElementById("biliscript-player-interpret-quick-action")?.remove();
    return;
  }
  const existing = document.getElementById("biliscript-player-interpret-quick-action");
  let button = existing instanceof HTMLButtonElement ? existing : null;
  const existingWrap = document.getElementById("biliscript-player-interpret-quick-action-wrap");
  let wrap = existingWrap instanceof HTMLElement ? existingWrap : null;

  const youtubeSite = isYoutubeSite();
  const wrapClassName = youtubeSite
    ? "biliscript-player-interpret-quick-action-wrap biliscript-player-interpret-quick-action-wrap--youtube"
    : "bpx-player-ctrl-btn bpx-player-ctrl-subtitle biliscript-player-interpret-quick-action-wrap";
  const buttonClassName = youtubeSite
    ? "ytp-button biliscript-player-interpret-quick-action biliscript-player-interpret-quick-action--youtube"
    : "bpx-player-ctrl-subtitle-result biliscript-player-interpret-quick-action";

  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "biliscript-player-interpret-quick-action-wrap";
    wrap.className = wrapClassName;
    wrap.setAttribute("data-biliscript-extension-node", "interpret-quick-action");
  } else if (wrap.className !== wrapClassName) {
    wrap.className = wrapClassName;
  }
  if (!button) {
    button = document.createElement("button");
    button.id = "biliscript-player-interpret-quick-action";
    button.type = "button";
    button.className = buttonClassName;
    button.textContent = "字幕";
    button.title = "字幕";
    button.setAttribute("aria-label", "字幕");
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-disabled", "false");
    button.addEventListener("click", handlePlayerInterpretQuickActionClick, true);
  }
  if (button.parentElement !== wrap) {
    wrap.replaceChildren(button);
  }

  const placement = resolvePlayerInterpretQuickActionPlacement(playerHost);
  if (placement) {
    applyControlBarPlacement(wrap, placement);
  }
  if (shouldSyncPlayerInterpretOnMount(button)) {
    syncPlayerInterpretQuickActionLazy();
  }
}

function mountPlayerAiQuickActionButtonToHost(playerHost: HTMLElement): void {
  const existing = document.getElementById("biliscript-player-ai-quick-action");
  const existingWrap = existing?.closest(".biliscript-player-ai-wrap");

  let button: HTMLButtonElement | null = existing instanceof HTMLButtonElement ? existing : null;
  let wrap = existingWrap instanceof HTMLElement ? existingWrap : null;
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "biliscript-player-ai-wrap";
    wrap.setAttribute("data-biliscript-extension-node", "ai-quick-action");
  }
  if (!button) {
    button = document.createElement("button");
    button.id = "biliscript-player-ai-quick-action";
    button.type = "button";
    button.className = "biliscript-player-ai-quick-action";
    button.title = "用 AI 分析这期视频";
    button.setAttribute("aria-label", "用 AI 分析这期视频");
    button.innerHTML = buildPlayerAiQuickActionIconSvg();
    button.addEventListener("click", handlePlayerAiQuickActionClick, true);
    button.addEventListener("dblclick", stopPlayerAiButtonPropagation, true);
  }

  if (button.parentElement !== wrap) {
    wrap.replaceChildren(button);
  }
  if (wrap.parentElement !== playerHost) {
    playerHost.appendChild(wrap);
  }
  bindPanelPreloadOnButton(button);
  bindPlayerAiQuickActionCursorSync(wrap);
  syncPlayerAiQuickActionVisuals(button);

  mountPlayerLiveQuickAction(playerHost);
  mountPlayerInterpretQuickAction(playerHost);

  playerAiQuickActionMountedWrap = wrap;
  playerAiQuickActionMountedHost = playerHost;
  playerAiQuickActionRetryCount = 0;
  playerAiQuickActionFrameRetriesLeft = PLAYER_AI_FRAME_RETRY_BUDGET;
  if (!mountTimingLogged) {
    mountTimingLogged = true;
    logInfoAlways(
      `[BILISCRIPT] player-ai: AI 键已挂载，装载→挂载耗时 ${Date.now() - MODULE_BOOT_AT}ms`
    );
  }
}

function syncPlayerAiQuickActionButton(): void {
  const youtubeSite = isYoutubeSite();
  const siteAllowed =
    getActiveSiteCapabilities().supportsPlayerQuickAiButton &&
    (!youtubeSite || isYoutubeWatchDocument());
  const enabled =
    siteAllowed &&
    Boolean(state.settings?.enablePlayerAiQuickAction) &&
    Date.now() >= playerAiState.playerAiQuickActionSuppressedUntil;
  const calibrated = playerAiSubtitleControlCalibrated;
  const hasSubtitleControl =
    enabled && !calibrated && !youtubeSite ? Boolean(findPlayerSubtitleControlNode()) : false;
  const mountedStable = enabled ? isPlayerAiQuickActionMountedStable() : false;
  const host = enabled ? findPlayerAiQuickActionHost() : null;

  const decision = decidePlayerAiQuickAction({
    enabled,
    calibrated,
    hasSubtitleControl,
    mountedStable,
    hasHost: Boolean(host)
  });

  switch (decision) {
    case "none":
      removePlayerAiQuickActionButton();
      resetPlayerAiQuickActionRetryCount();
      return;

    case "refresh-visuals":
      tryRefreshPlayerAiQuickActionVisuals();
      playerAiQuickActionRetryCount = 0;
      playerAiQuickActionFrameRetriesLeft = PLAYER_AI_FRAME_RETRY_BUDGET;
      return;

    case "unmount-retry": {
      const existing = document.getElementById("biliscript-player-ai-quick-action");
      const existingWrap = existing?.closest(".biliscript-player-ai-wrap");
      existingWrap?.remove();
      existing?.remove();
      clearPlayerAiQuickActionMountRecord();
      schedulePlayerAiQuickActionRetry();
      return;
    }

    case "recalibrate":
      playerAiSubtitleControlCalibrated = true;
      clearPlayerAiQuickActionMountRecord();
      if (host) {
        mountPlayerAiQuickActionButtonToHost(host);
      }
      return;

    case "mount":
      if (host) {
        mountPlayerAiQuickActionButtonToHost(host);
      }
      return;
  }
}

export function removePlayerAiQuickActionButton(): void {
  clearPlayerAiQuickActionMountRecord();
  if (playerAiState.playerAiQuickActionCursorHideTimer) {
    window.clearTimeout(playerAiState.playerAiQuickActionCursorHideTimer);
    playerAiState.setCursorHideTimer(0);
  }
  closePlayerInterpretMenuLazy();
  document.getElementById("biliscript-player-interpret-quick-action-wrap")?.remove();
  document.getElementById("biliscript-player-interpret-quick-action")?.remove();
  document.getElementById("biliscript-player-live-quick-action-wrap")?.remove();
  document.getElementById("biliscript-player-live-quick-action")?.remove();
  document.getElementById("biliscript-player-ai-quick-action")?.closest(".biliscript-player-ai-wrap")?.remove();
}

function bindPlayerAiQuickActionCursorSync(wrap: HTMLElement): void {
  if (!(wrap instanceof HTMLElement)) {
    return;
  }
  const host = wrap.parentElement instanceof HTMLElement ? wrap.parentElement : null;
  if (!host) {
    return;
  }
  if (
    playerAiQuickActionCursorSync &&
    playerAiQuickActionCursorSync.host === host &&
    playerAiQuickActionCursorSync.wrap === wrap
  ) {
    return;
  }
  unbindPlayerAiQuickActionCursorSync();
  const hideForIdle = () => {
    playerAiState.setCursorHideTimer(0);
    wrap.classList.remove("is-active");
  };
  const showForCursorActivity = () => {
    if (!wrap.isConnected) {
      wrap.classList.remove("is-active");
      return;
    }
    wrap.classList.add("is-active");
    if (playerAiState.playerAiQuickActionCursorHideTimer) {
      window.clearTimeout(playerAiState.playerAiQuickActionCursorHideTimer);
    }
    playerAiState.setCursorHideTimer(window.setTimeout(hideForIdle, 1900));
  };
  const hideImmediately = () => {
    if (playerAiState.playerAiQuickActionCursorHideTimer) {
      window.clearTimeout(playerAiState.playerAiQuickActionCursorHideTimer);
      playerAiState.setCursorHideTimer(0);
    }
    wrap.classList.remove("is-active");
  };
  const scope = createDisposableContext();
  scope.addListener(host, "mousemove", showForCursorActivity, { passive: true });
  scope.addListener(host, "mouseenter", showForCursorActivity, { passive: true });
  scope.addListener(host, "mouseleave", hideImmediately, { passive: true });
  playerAiQuickActionCursorSync = { host, wrap, scope };
}

function unbindPlayerAiQuickActionCursorSync(): void {
  if (!playerAiQuickActionCursorSync) {
    return;
  }
  playerAiQuickActionCursorSync.scope.dispose();
  if (playerAiState.playerAiQuickActionCursorHideTimer) {
    window.clearTimeout(playerAiState.playerAiQuickActionCursorHideTimer);
    playerAiState.setCursorHideTimer(0);
  }
  playerAiQuickActionCursorSync = null;
}

function findPlayerSubtitleControlNode(): Element | null {
  const controlRoots = Array.from(
    document.querySelectorAll(PLAYER_SUBTITLE_CONTROL_ROOTS_SELECTOR)
  );

  for (const root of controlRoots) {
    const candidates = Array.from(
      root.querySelectorAll(
        "[aria-label*='字幕'], [title*='字幕'], [data-text*='字幕'], [class*='subtitle'], [class*='caption'], button, [role='button']"
      )
    );
    const matched = candidates.find((node) => isPlayerSubtitleControlNode(node));
    if (matched) {
      return matched;
    }
  }

  return null;
}

function isPlayerSubtitleControlNode(node: unknown): boolean {
  if (!(node instanceof Element)) {
    return false;
  }
  if (node.closest("[data-biliscript-extension-node]")) {
    return false;
  }
  const text = [
    node.getAttribute("aria-label"),
    node.getAttribute("title"),
    node.getAttribute("data-text"),
    node.textContent,
    typeof node.className === "string" ? node.className : ""
  ]
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .join(" ");
  return /字幕|subtitle/i.test(text);
}

function findYoutubePlayerAiQuickActionHost(): HTMLElement | null {
  const direct = findYoutubePlayerHost(document);
  if (direct && isVisibleReaderControl(direct)) {
    return direct;
  }

  const video = getYoutubeVideoElement(document);
  if (!video) {
    return null;
  }

  const host = video.closest<HTMLElement>("#movie_player, ytd-player");
  if (host && isVisibleReaderControl(host)) {
    return host;
  }

  return null;
}

function findPlayerAiQuickActionHost(): HTMLElement | null {
  if (isYoutubeSite()) {
    return findYoutubePlayerAiQuickActionHost();
  }

  const direct = findPlayerHostWithVideoArea(document, (node) => isVisibleReaderControl(node));
  if (direct) {
    return direct;
  }

  const video = getRuntimeVideoElement();
  if (!video) {
    return null;
  }

  const host = findPlayerHostFromVideo(video, { includeWrapFallbacks: true });
  if (host instanceof HTMLElement && isVisibleReaderControl(host)) {
    return host;
  }

  return null;
}

function stopPlayerAiButtonPropagation(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function syncPlayerAiQuickActionVisuals(button: HTMLElement): void {
  if (!(button instanceof HTMLElement)) {
    return;
  }
  const wrap = button.parentElement instanceof HTMLElement ? button.parentElement : null;
  [wrap, button].filter((node): node is HTMLElement => Boolean(node)).forEach((node) => {
    node.style.setProperty("--biliscript-player-ai-action-hit-size", `${PLAYER_AI_HIT_SIZE_PX}px`);
    node.style.setProperty("--biliscript-player-ai-action-color", PLAYER_AI_BASE_COLOR);
    node.style.setProperty("--biliscript-player-ai-action-hover-color", PLAYER_AI_BASE_COLOR);
  });
  button.style.setProperty("--biliscript-player-ai-action-icon-size", `${PLAYER_AI_ICON_SIZE_PX}px`);
}

async function handlePlayerAiQuickActionClick(event: MouseEvent): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  if (playerAiState.playerAiQuickActionSubmitting || Date.now() < playerAiState.playerAiQuickActionSuppressedUntil) {
    return;
  }

  playerAiState.setSubmitting(true);
  const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
  const buttonWrap = button?.parentElement;
  const buttonHost = buttonWrap?.parentElement;
  if (button) {
    button.disabled = true;
  }

  try {
    state.setSettings(await getSettings());
    if (!state.settings?.enablePlayerAiQuickAction) {
      throw new Error("AI 按钮未开启");
    }
    if (!isReaderDetached()) {
      await exitPlayerFullscreenIfNeeded();
    }
    const resp = await sendRuntimeMessage({ type: "player-ai-quick-action" });
    if (!resp?.ok) {
      throw new Error(resp?.error || "打开 AI 对话失败");
    }
    if (button) {
      button.classList.remove("is-error");
      button.title = "用 AI 分析这期视频";
      button.setAttribute("aria-label", "用 AI 分析这期视频");
    }
  } catch (error) {
    const message = `AI 快捷操作失败：${getErrorMessage(error)}`;
    if (button && buttonWrap && !button.isConnected && buttonHost?.isConnected) {
      buttonHost.appendChild(buttonWrap);
    }
    if (button?.isConnected) {
      button.classList.add("is-error");
      button.title = message;
      button.setAttribute("aria-label", message);
    }
  } finally {
    playerAiState.setSubmitting(false);
    if (button) {
      button.disabled = false;
    }
  }
}

async function handlePlayerInterpretQuickActionClick(event: MouseEvent): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  if (!getActiveSiteCapabilities().supportsPlayerInterpretOverlay) {
    return;
  }
  const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
  if (!button || button.disabled) return;
  const wrap = button.parentElement;
  if (!(wrap instanceof HTMLElement)) return;
  const interpret = await loadPlayerInterpret();
  await interpret.togglePlayerInterpretMenu(wrap);
}

async function handlePlayerLiveQuickActionClick(event: MouseEvent): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  if (typeof __BILISCRIPT_TARGET__ === "string" && __BILISCRIPT_TARGET__ === "firefox") {
    return;
  } else {
    if (!supportsLiveCompanion() || !getActiveSiteCapabilities().supportsLiveCompanion) {
      return;
    }
    liveQuickActionTargetButton =
      event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
    await getLiveQuickActionToggleHandler().handleClick();
  }
}
