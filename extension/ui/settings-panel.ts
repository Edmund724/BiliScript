import type { OverviewSetupErrorClass } from "../core/overview-setup-error.js";
import { getSettings } from "../core/runtime.js";
import { state } from "../core/state.js";
import type { LiveSettingsTarget } from "../live/fullscreen-live-overlay.js";
import { isChatDisplaySliderAvailable } from "../reader/chat-display-settings.js";
import { hasReaderSettingsOverlayOpen, stepBackReaderSettings } from "../reader/settings-mode.js";
import { peekAsrSetupResumeToken } from "../reader/setup-resume.js";
import { ids } from "../reader/state.js";
import {
  activeById,
  getActiveReaderDocument,
  isReaderDetached,
  requestDetachedModeSwitch,
} from "../shared/active-host.js";
import { supportsLiveCompanion } from "../shared/runtime-capabilities.js";
import { detectActiveSite, getSiteCapabilities } from "../shared/site.js";
import { ensureReaderSettingsStyles, whenReaderSettingsStylesReady } from "../shared/style-injector.js";
import {
  bindAgentBridgeSettings,
  type AgentBridgeSettingsController,
  type AgentBridgeSettingsState
} from "./agent-bridge-settings.js";
import {
  createProviderSettingsHost,
  type ProviderSettingsHost,
  type ProviderSummarySnapshot
} from "./provider-settings-host.js";
import { buildSettingsHtml } from "./settings-panel-html.js";
import { animateNavFadeIn } from "./nav-motion.js";
import { applySectionContainment, collectElements, setStatus, type SettingsElements } from "./settings/elements.js";
import { bindModelSelectEvents, renderAiModelSelects } from "./settings/model-selects.js";
import { createSettingsNavigator } from "./settings/navigation.js";
import { SCALAR_FIELD_BINDINGS, type ScalarBindingRuntimeHooks } from "./settings/scalar-bindings.js";
import {
  bindScalarExternalSync,
  bindScalarFieldEvents,
  bindScalarSectionActions,
  clearStatusClearTimer,
  loadSettings,
  saveSettingField
} from "./settings/scalar-engine.js";
import {
  createSetupFlows,
  loadAiProviders,
  resumeAsrSubtitleFetchAfterSetup,
  type AiSetupSession,
  type AiSetupTarget
} from "./settings/setup-flows.js";
import { syncAllSummaries } from "./settings/summaries.js";

ensureReaderSettingsStyles();

let settingsHostRef: HTMLElement | null = null;
let agentBridgeSettings: AgentBridgeSettingsController | null = null;
let renderSettingsPromise: Promise<void> | null = null;
let renderSettingsHost: HTMLElement | null = null;
let providerHost: ProviderSettingsHost | null = null;
let lastProviderSnapshot: ProviderSummarySnapshot | null = null;
let lastAgentBridgeState: AgentBridgeSettingsState | null = null;

function syncSummaries(elements: SettingsElements): void {
  syncAllSummaries(elements, {
    providerSnapshot: lastProviderSnapshot,
    agentBridgeState: lastAgentBridgeState ?? agentBridgeSettings?.getSummaryState() ?? null
  });
}

const navigator = createSettingsNavigator({
  getHost: () => settingsHostRef,
  ensureRendered: () => renderReaderSettingsPanel(),
  onAgentAddressClosed: (options) => agentBridgeSettings?.onAddressViewClosed(options),
  openLinkedCredentialEditor: (target) => providerHost?.openLinkedCredentialEditor(target)
});

const setupFlows = createSetupFlows({
  ensureRendered: () => renderReaderSettingsPanel(),
  getHost: () => settingsHostRef,
  getProviderHost: () => providerHost,
  openView: (view) => navigator.focusSettingsView(view)
});

function getPanelSiteCapabilities() {
  const site =
    state.clip.site === "youtube" || detectActiveSite() === "youtube"
      ? "youtube"
      : state.clip.site;
  return getSiteCapabilities(site);
}

function setElementGated(el: HTMLElement | null | undefined, gated: boolean): void {
  if (!el) return;
  el.hidden = gated;
  if (gated) {
    el.setAttribute("aria-hidden", "true");
  } else {
    el.removeAttribute("aria-hidden");
  }
}

function applySiteSettingsGating(host: HTMLElement, elements: SettingsElements): void {
  const siteCaps = getPanelSiteCapabilities();
  const liveAvailable = supportsLiveCompanion() && siteCaps.supportsLiveCompanion;

  setElementGated(elements.openLiveSettingsBtn, !liveAvailable);
  if (!liveAvailable) {
    elements.subpageLive.hidden = true;
  }

  setElementGated(elements.openAsrSettingsBtn, !siteCaps.supportsAsr);
  if (!siteCaps.supportsAsr) {
    elements.subpageAsr.hidden = true;
  }

  setElementGated(elements.openAgentSettingsBtn, !siteCaps.supportsAgentBridge);
  if (!siteCaps.supportsAgentBridge) {
    elements.subpageAgent.hidden = true;
    elements.agentBridgeAddressView.hidden = true;
  }

  const aiButtonSection = host.querySelector<HTMLElement>(
    '.biliscript-set-group[data-settings-section="ai-button"]'
  );
  setElementGated(aiButtonSection, !siteCaps.supportsPlayerQuickAiButton);

  const extraRatesRow = elements.enableExtraPlaybackRates.closest<HTMLElement>(".biliscript-toggle-row");
  setElementGated(extraRatesRow, !siteCaps.supportsExtraPlaybackRates);
}

const scalarHooks: ScalarBindingRuntimeHooks = {
  onAgentBridgeSaved: () => {
    if (!getPanelSiteCapabilities().supportsAgentBridge) return;
    void agentBridgeSettings?.refresh();
  },
  onAsrAutoFallbackSaved: (val) => {
    if (!getPanelSiteCapabilities().supportsAsr) return;
    if (val && peekAsrSetupResumeToken() !== null && settingsHostRef) {
      void setupFlows.continueAsrSetupAfterToggleEnabled(collectElements(settingsHostRef));
    }
  },
  onDetachedWindowModeChanged: (mode) => {
    if (isReaderDetached()) {
      try {
        void Promise.resolve(requestDetachedModeSwitch(mode))
          .then((switched) => {
            if (switched === false && settingsHostRef?.isConnected) {
              setStatus(
                collectElements(settingsHostRef),
                "浏览器阻止了模式切换，已保留当前窗口；下次弹出时生效。",
                true
              );
            }
          })
          .catch(() => {});
      } catch {
      }
    }
  }
};

function loadPanelSettings(elements: SettingsElements): Promise<void> {
  const siteCaps = getPanelSiteCapabilities();
  return loadSettings(elements, {
    syncAgentBridge: (settings) => {
      if (siteCaps.supportsAgentBridge) {
        agentBridgeSettings?.sync(settings);
      }
    },
    loadProviders: (settings) => providerHost?.load(settings) ?? Promise.resolve(),
    syncSummaries
  });
}

function bindSettingsEvents(host: HTMLElement): void {
  const elements = collectElements(host);
  lastProviderSnapshot = null;
  lastAgentBridgeState = null;
  clearStatusClearTimer();

  navigator.bindSettingsNavigation(host, elements);
  applySiteSettingsGating(host, elements);
  if (!isChatDisplaySliderAvailable("speechVoiceVolume")) {
    elements.chatPreferencesHeading.textContent = "对话阅读";
    const speechVolumeRow = elements.speechVoiceVolume.closest<HTMLElement>(".biliscript-slider-row");
    if (speechVolumeRow) {
      speechVolumeRow.hidden = true;
    }
  }

  elements.backBtn?.addEventListener("click", (event) => {
    if (hasReaderSettingsOverlayOpen()) return;
    event.stopPropagation();
    stepBackReaderSettings();
  });

  for (const binding of SCALAR_FIELD_BINDINGS) {
    bindScalarFieldEvents(binding, elements, { syncSummaries, hooks: scalarHooks });
  }

  agentBridgeSettings = bindAgentBridgeSettings(
    elements,
    (text, isError) => setStatus(elements, text, isError),
    {
      onOpenAddress: () => {
        if (!getPanelSiteCapabilities().supportsAgentBridge) return;
        navigator.navigateSettingsView(host, "agent-address", { focusOnEnter: false });
      },
      onStateChange: (bridgeState) => {
        lastAgentBridgeState = bridgeState;
        syncSummaries(collectElements(host));
      }
    }
  );

  const siteCaps = getPanelSiteCapabilities();
  const liveAvailable = supportsLiveCompanion() && siteCaps.supportsLiveCompanion;
  const mountedFamilies: Array<"ai" | "live" | "asr" | "search"> = ["ai"];
  if (liveAvailable) {
    mountedFamilies.push("live");
  }
  if (siteCaps.supportsAsr) {
    mountedFamilies.push("asr");
  }
  mountedFamilies.push("search");

  providerHost?.dispose();
  providerHost = createProviderSettingsHost({
    host,
    mountedFamilies,
    onStatus: (message, isError) => setStatus(elements, message, isError),
    canRestoreConsumerEditor: () => !activeById(ids.readingSettingsPanel)?.hidden,
    onAiChanged: (providers, { settings: known }) => {
      if (known) {
        renderAiModelSelects(elements, providers, known, syncSummaries);
        return;
      }
      void getSettings().then((s) => {
        renderAiModelSelects(elements, providers, s, syncSummaries);
      });
    },
    onSummaryChange: (snapshot) => {
      lastProviderSnapshot = snapshot;
      syncSummaries(collectElements(host));
    }
  });

  bindModelSelectEvents(elements, {
    savePatch: saveSettingField,
    loadAiProviders: () => loadAiProviders(providerHost),
    syncSummaries
  });

  bindScalarSectionActions(elements, {
    syncSummaries,
    reloadSettings: loadPanelSettings
  });

  bindScalarExternalSync(host, elements, {
    syncSummaries,
    onAgentBridgeUrlChanged: (newValue) => {
      if (!getPanelSiteCapabilities().supportsAgentBridge) return;
      agentBridgeSettings?.updateUrl(newValue);
    },
    onEnableAgentBridgeChanged: () => {
      if (!getPanelSiteCapabilities().supportsAgentBridge) return;
      void agentBridgeSettings?.refresh();
    },
    onAiModelsExternalChanged: (currentElements) => {
      void Promise.all([loadAiProviders(providerHost), getSettings()]).then(([providers, settings]) => {
        renderAiModelSelects(currentElements, providers, settings, syncSummaries);
      });
    }
  });
}

export function renderReaderSettingsPanel(): Promise<void> {
  const host = activeById(ids.readingSettingsHost);
  if (!host) {
    return Promise.resolve();
  }
  settingsHostRef = host;
  if (!host.dataset.biliscriptSettingsRendered) {
    if (renderSettingsPromise && renderSettingsHost === host) {
      return renderSettingsPromise;
    }
    renderSettingsHost = host;
    const promise = (async () => {
      await whenReaderSettingsStylesReady();
      if (!host.isConnected || host.dataset.biliscriptSettingsRendered) {
        return;
      }
      const shouldRestoreBackFocus = getActiveReaderDocument().activeElement?.id === ids.readingSettingsBackBtn;
      host.innerHTML = buildSettingsHtml();
      applySectionContainment(host);
      bindSettingsEvents(host);
      if (shouldRestoreBackFocus) {
        activeById(ids.readingSettingsBackBtn)?.focus({ preventScroll: true });
      }
      host.dataset.biliscriptSettingsRendered = "1";
      const settingsPanel = activeById(ids.readingSettingsPanel);
      if (settingsPanel && !settingsPanel.hidden) {
        const visibleView = host.querySelector<HTMLElement>(".biliscript-settings-view:not([hidden])");
        animateNavFadeIn(visibleView, 140);
      }
      await loadPanelSettings(collectElements(host));
      navigator.flushPendingTarget();
    })().finally(() => {
      if (renderSettingsPromise === promise) {
        renderSettingsPromise = null;
        renderSettingsHost = null;
      }
    });
    renderSettingsPromise = promise;
    return promise;
  }
  const existingElements = collectElements(host);
  applySiteSettingsGating(host, existingElements);
  return loadPanelSettings(existingElements);
}

export function openLiveSettings(target: LiveSettingsTarget): Promise<void> {
  if (!supportsLiveCompanion() || !getPanelSiteCapabilities().supportsLiveCompanion) {
    return Promise.resolve();
  }
  return navigator.openSettingsTarget(target);
}

export function openAppearanceSettings(): Promise<void> {
  return navigator.openSettingsTarget("appearance");
}

export function openNoteExportSettings(): Promise<void> {
  return navigator.openSettingsTarget("note-export");
}

export { resumeAsrSubtitleFetchAfterSetup, type AiSetupSession, type AiSetupTarget };

export function openReaderAiSetup(
  errorClass: OverviewSetupErrorClass,
  session: AiSetupSession,
  target: AiSetupTarget = {}
): Promise<void> {
  return setupFlows.openReaderAiSetup(errorClass, session, target);
}

export function openReaderAsrSetup(): Promise<void> {
  if (!getPanelSiteCapabilities().supportsAsr) {
    return Promise.resolve();
  }
  return setupFlows.openReaderAsrSetup();
}

export function resolveEditableAiProviderId(): Promise<string> {
  return setupFlows.resolveEditableAiProviderId();
}
