import type { LiveSettingsTarget } from "../../live/fullscreen-live-overlay.js";
import {
  registerReaderSettingsBackInterceptor,
  registerReaderSettingsCloseListener
} from "../../reader/settings-mode.js";
import { ids } from "../../reader/state.js";
import { activeById } from "../../shared/active-host.js";
import { supportsLiveCompanion } from "../../shared/runtime-capabilities.js";
import type { AiCredentialLinkTarget } from "../ai-credential-link.js";
import {
  cancelNavTransition,
  runHorizontalLayerTransition,
  supportsWebAnimations,
  type NavDirection
} from "../nav-motion.js";
import { SETTINGS_PANEL_DOM_IDS } from "./dom-ids.js";
import { collectElements, type SettingsElements } from "./elements.js";

export type SettingsSubpageId =
  | "ai-providers"
  | "live"
  | "asr"
  | "search"
  | "ai-prompt"
  | "subtitle"
  | "appearance"
  | "agent"
  | "advanced";

export type SettingsViewId = "root" | SettingsSubpageId | "agent-address";

export type SettingsOpenTarget = LiveSettingsTarget | "appearance" | "note-export";

export const SETTINGS_VIEW_TITLES: Record<SettingsViewId, string> = {
  root: "设置",
  "ai-providers": "AI 模型平台",
  live: "实时伴看",
  asr: "语音转写",
  search: "联网搜索",
  "ai-prompt": "AI 对话与快捷动作",
  subtitle: "字幕翻译与导出",
  appearance: "阅读器与播放器",
  agent: "本地 Agent 连接",
  "agent-address": "连接地址",
  advanced: "高级设置"
};

export interface SettingsNavigatorDeps {
  getHost: () => HTMLElement | null;
  ensureRendered: () => Promise<void>;
  onAgentAddressClosed?: (options: { focusButton: boolean }) => void;
  openLinkedCredentialEditor?: (target: AiCredentialLinkTarget) => Promise<void> | void;
}

export interface SettingsNavigator {
  navigateSettingsView(
    host: HTMLElement,
    view: SettingsViewId,
    options?: { returnButton?: HTMLButtonElement | null; focusOnEnter?: boolean; animate?: boolean }
  ): void;
  bindSettingsNavigation(host: HTMLElement, elements: SettingsElements): void;
  openSettingsTarget(target: SettingsOpenTarget): Promise<void>;
  focusSettingsView(view: SettingsSubpageId): void;
  flushPendingTarget(): void;
  dispose(): void;
}

function getSettingsViewDepth(view: SettingsViewId): number {
  if (view === "root") return 0;
  if (view === "agent-address") return 2;
  return 1;
}

export function getScrollContainer(host: HTMLElement): HTMLElement {
  return host.closest<HTMLElement>(`#${ids.readingSettingsPanel}`) ?? host;
}

export function getViewElement(elements: SettingsElements, view: SettingsViewId): HTMLElement {
  switch (view) {
    case "root": return elements.settingsRootView;
    case "ai-providers": return elements.subpageAiProviders;
    case "live": return elements.subpageLive;
    case "asr": return elements.subpageAsr;
    case "search": return elements.subpageSearch;
    case "ai-prompt": return elements.subpageAiPrompt;
    case "subtitle": return elements.subpageSubtitle;
    case "appearance": return elements.subpageAppearance;
    case "agent": return elements.subpageAgent;
    case "agent-address": return elements.agentBridgeAddressView;
    case "advanced": return elements.subpageAdvanced;
  }
}

export function getEntryButtonForSubpage(elements: SettingsElements, view: SettingsSubpageId): HTMLButtonElement {
  switch (view) {
    case "ai-providers": return elements.openAiProvidersBtn;
    case "live": return elements.openLiveSettingsBtn;
    case "asr": return elements.openAsrSettingsBtn;
    case "search": return elements.openSearchSettingsBtn;
    case "ai-prompt": return elements.openAiPromptBtn;
    case "subtitle": return elements.openSubtitleSettingsBtn;
    case "appearance": return elements.openAppearanceBtn;
    case "agent": return elements.openAgentSettingsBtn;
    case "advanced": return elements.openAdvancedSettingsBtn;
  }
}

export function createSettingsNavigator(deps: SettingsNavigatorDeps): SettingsNavigator {
  let pendingSettingsTarget: SettingsOpenTarget | null = null;
  let activeSettingsView: SettingsViewId = "root";
  let savedRootScrollTop = 0;
  let subpageReturnButton: HTMLButtonElement | null = null;
  let unregisterBackInterceptor: (() => void) | null = null;
  let unregisterCloseListener: (() => void) | null = null;

  function navigateSettingsView(
    host: HTMLElement,
    view: SettingsViewId,
    options: { returnButton?: HTMLButtonElement | null; focusOnEnter?: boolean; animate?: boolean; elements?: SettingsElements } = {}
  ): void {
    const targetView: SettingsViewId = view === "live" && !supportsLiveCompanion() ? "root" : view;
    const elements = options.elements ?? collectElements(host);
    const previousView = activeSettingsView;
    const scrollContainer = getScrollContainer(host);

    cancelNavTransition(host);

    const shouldAnimate =
      options.animate !== false
      && previousView !== targetView
      && !scrollContainer.hidden
      && supportsWebAnimations(host);
    const prevEl = shouldAnimate ? getViewElement(elements, previousView) : null;
    const oldScrollTop = shouldAnimate ? scrollContainer.scrollTop : 0;
    const prevTop = prevEl ? prevEl.offsetTop : 0;

    if (previousView === "root" && targetView !== "root") {
      savedRootScrollTop = scrollContainer.scrollTop;
      if (targetView !== "agent-address") {
        subpageReturnButton = options.returnButton ?? getEntryButtonForSubpage(elements, targetView);
      }
    }

    const allViews: SettingsViewId[] = [
      "root",
      "ai-providers",
      "live",
      "asr",
      "search",
      "ai-prompt",
      "subtitle",
      "appearance",
      "agent",
      "agent-address",
      "advanced"
    ];
    for (const key of allViews) {
      getViewElement(elements, key).hidden = key !== targetView;
    }

    activeSettingsView = targetView;
    elements.settingsTitle.textContent = SETTINGS_VIEW_TITLES[targetView];
    elements.resetBtn.hidden = targetView !== "root";
    elements.backBtn.setAttribute(
      "aria-label",
      targetView === "root" ? "返回" : targetView === "agent-address" ? "返回本地 Agent 连接" : "返回设置总览"
    );

    const shouldFocus = options.focusOnEnter !== false;
    let handledFocus = false;
    if (previousView === "agent-address" && targetView !== "agent-address") {
      deps.onAgentAddressClosed?.({ focusButton: targetView === "agent" && shouldFocus });
      if (targetView === "agent") {
        scrollContainer.scrollTop = 0;
        handledFocus = true;
      }
    }

    if (!handledFocus) {
      if (targetView === "root") {
        scrollContainer.scrollTop = savedRootScrollTop;
        const returnTarget = subpageReturnButton?.isConnected ? subpageReturnButton : null;
        subpageReturnButton = null;
        if (shouldFocus) {
          (returnTarget ?? elements.backBtn)?.focus({ preventScroll: true });
        }
      } else {
        scrollContainer.scrollTop = 0;
        if (shouldFocus && targetView !== "agent-address") {
          const viewEl = getViewElement(elements, targetView);
          const firstFocusable = viewEl.querySelector<HTMLElement>(
            "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])"
          );
          (firstFocusable ?? elements.backBtn)?.focus({ preventScroll: true });
        }
      }
    }

    if (shouldAnimate && prevEl) {
      const targetEl = getViewElement(elements, targetView);
      const direction: NavDirection =
        getSettingsViewDepth(targetView) >= getSettingsViewDepth(previousView) ? "forward" : "backward";
      const actualScrollTop = scrollContainer.scrollTop;
      const deltaY = actualScrollTop - oldScrollTop;
      const viewportClipHeight =
        scrollContainer.clientHeight > 0
          ? Math.max(0, scrollContainer.clientHeight + oldScrollTop - prevTop)
          : 0;

      prevEl.setAttribute("data-settings-view-leaving", direction);
      prevEl.style.top = `${prevTop}px`;
      if (viewportClipHeight > 0) {
        prevEl.style.maxHeight = `${viewportClipHeight}px`;
      }

      runHorizontalLayerTransition({
        scope: host,
        direction,
        outgoing: [{ el: prevEl, offsetY: deltaY, distancePx: direction === "forward" ? 16 : 20 }],
        incoming: [{ el: targetEl, distancePx: direction === "forward" ? 20 : 16 }],
        title: elements.settingsTitle,
        durationEnterMs: direction === "forward" ? 220 : 200,
        durationExitMs: 100,
        enterDelayMs: 24,
        onExitDone: () => {
          prevEl.removeAttribute("data-settings-view-leaving");
          prevEl.style.top = "";
          prevEl.style.maxHeight = "";
        }
      });
    }
  }

  function bindSettingsNavigation(host: HTMLElement, elements: SettingsElements): void {
    activeSettingsView = "root";
    savedRootScrollTop = 0;
    subpageReturnButton = null;
    navigateSettingsView(host, "root", { focusOnEnter: false, animate: false, elements });

    const entries: ReadonlyArray<[HTMLButtonElement, SettingsSubpageId]> = [
      [elements.openAiProvidersBtn, "ai-providers"],
      [elements.openLiveSettingsBtn, "live"],
      [elements.openAsrSettingsBtn, "asr"],
      [elements.openSearchSettingsBtn, "search"],
      [elements.openAiPromptBtn, "ai-prompt"],
      [elements.openSubtitleSettingsBtn, "subtitle"],
      [elements.openAppearanceBtn, "appearance"],
      [elements.openAgentSettingsBtn, "agent"],
      [elements.openAdvancedSettingsBtn, "advanced"]
    ];

    for (const [button, view] of entries) {
      button.addEventListener("click", () => {
        navigateSettingsView(host, view, { returnButton: button, focusOnEnter: true, elements });
      });
    }

    unregisterBackInterceptor?.();
    unregisterBackInterceptor = registerReaderSettingsBackInterceptor(() => {
      if (activeSettingsView === "root") return false;
      if (activeSettingsView === "agent-address") {
        navigateSettingsView(host, "agent", { focusOnEnter: true, elements });
        return true;
      }
      navigateSettingsView(host, "root", { focusOnEnter: true, elements });
      return true;
    });

    unregisterCloseListener?.();
    unregisterCloseListener = registerReaderSettingsCloseListener(() => {
      savedRootScrollTop = 0;
      subpageReturnButton = null;
      if (activeSettingsView !== "root") {
        navigateSettingsView(host, "root", { focusOnEnter: false, animate: false, elements });
      }
    });
  }

  async function openSettingsTarget(target: SettingsOpenTarget): Promise<void> {
    if ((target === "live" || target === "gemini-key") && !supportsLiveCompanion()) {
      return;
    }
    const host = deps.getHost() ?? activeById(ids.readingSettingsHost);
    if (!host) return;
    pendingSettingsTarget = target;
    if (!host.dataset.biliscriptSettingsRendered) {
      await deps.ensureRendered();
      return;
    }
    pendingSettingsTarget = null;
    const view: SettingsSubpageId =
      target === "appearance" ? "ai-prompt" : target === "note-export" ? "subtitle" : "live";
    navigateSettingsView(host, view, { focusOnEnter: false, animate: false });
    const sectionHeading = target === "appearance"
      ? host.querySelector<HTMLElement>(`#${SETTINGS_PANEL_DOM_IDS.chatPreferencesHeading}`)
      : target === "note-export"
        ? host.querySelector<HTMLElement>(`.biliscript-set-group[data-settings-section="note-export"] .biliscript-set-h`)
        : host.querySelector<HTMLElement>(`.biliscript-set-group[data-settings-section="live"] .biliscript-set-h`);
    if (target === "appearance" || target === "note-export") {
      const scrollTarget = sectionHeading?.closest<HTMLElement>("[data-settings-subgroup], [data-settings-section]") ?? sectionHeading;
      scrollTarget?.scrollIntoView({ behavior: "auto", block: "start" });
    }
    if (target === "gemini-key") {
      await deps.openLinkedCredentialEditor?.("gemini-live");
      return;
    }
    sectionHeading?.setAttribute("tabindex", "-1");
    sectionHeading?.focus({ preventScroll: true });
  }

  function focusSettingsView(view: SettingsSubpageId): void {
    const host = deps.getHost();
    if (!host || !host.dataset.biliscriptSettingsRendered) return;
    navigateSettingsView(host, view, { focusOnEnter: false, animate: false });
  }

  function flushPendingTarget(): void {
    const pendingTarget = pendingSettingsTarget;
    pendingSettingsTarget = null;
    if (pendingTarget) {
      void openSettingsTarget(pendingTarget);
    }
  }

  function dispose(): void {
    cancelNavTransition(deps.getHost());
    pendingSettingsTarget = null;
    activeSettingsView = "root";
    savedRootScrollTop = 0;
    subpageReturnButton = null;
    unregisterBackInterceptor?.();
    unregisterBackInterceptor = null;
    unregisterCloseListener?.();
    unregisterCloseListener = null;
  }

  return {
    navigateSettingsView,
    bindSettingsNavigation,
    openSettingsTarget,
    focusSettingsView,
    flushPendingTarget,
    dispose
  };
}
