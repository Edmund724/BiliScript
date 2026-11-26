import { AI_PROVIDERS_STORAGE } from "../core/ai-provider-store.js";
import type { OverviewSetupErrorClass } from "../core/overview-setup-error.js";
import { getSettings } from "../core/runtime.js";
import type { LiveSettingsTarget } from "../live/fullscreen-live-overlay.js";
import {
  LIVE_VOICE_FALLBACK_NOTICE_TEXT,
  takeLiveVoiceFallbackNotice
} from "../live/live-voice-fallback-notice.js";
import {
  isChatDisplaySliderAvailable,
  watchChatDisplaySettings
} from "../reader/chat-display-settings.js";
import { hasReaderSettingsOverlayOpen, stepBackReaderSettings } from "../reader/settings-mode.js";
import { peekAsrSetupResumeToken } from "../reader/setup-resume.js";
import { ids } from "../reader/state.js";
import {
  activeById,
  getActiveReaderDocument,
  isReaderDetached,
  requestDetachedModeSwitch,
} from "../shared/active-host.js";
import { ensureReaderSettingsStyles, whenReaderSettingsStylesReady } from "../shared/style-injector.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { closeAgentBridgeInstallDialog } from "./agent-bridge-install-dialog.js";
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
import {
  applySectionContainment,
  collectElements,
  resolveSettingsCapabilities,
  setStatus,
  type SettingsCapabilities,
  type SettingsElements
} from "./settings/elements.js";
import {
  bindModelSelectEvents,
  refreshSiliconFlowTranslateKeyStatus,
  renderAiModelSelects
} from "./settings/model-selects.js";
import {
  SILICONFLOW_TRANSLATE_PROVIDER_ID,
  hasSavedSiliconFlowAsrKey
} from "../ai/subtitle-translate-config.js";
import { createSettingsNavigator } from "./settings/navigation.js";
import {
  WATCHED_SCALAR_SYNC_KEYS,
  applyChatDisplayPatch,
  applyScalarStorageChanges,
  bindScalarSettings,
  disposeScalarBindings,
  hydrateScalarSettings,
  saveSettingField,
  type ScalarBindingRuntimeHooks
} from "./settings/scalar-engine.js";
import {
  createSetupFlows,
  ensureDownloadsPermissionForNoteSettings,
  loadAiProviders,
  resumeAsrSubtitleFetchAfterSetup,
  type AiSetupSession,
  type AiSetupTarget
} from "./settings/setup-flows.js";
import { syncAllSummaries } from "./settings/summaries.js";

ensureReaderSettingsStyles();

const AI_MODEL_EXTERNAL_SYNC_KEYS = [
  "defaultModel",
  "defaultAiModel",
  "subtitleTranslateProviderId",
  "subtitleTranslateModel",
  AI_PROVIDERS_STORAGE
] as const;

interface MountedSettingsHost {
  readonly host: HTMLElement;
  readonly elements: SettingsElements;
  capabilities: SettingsCapabilities;
  agentBridge: AgentBridgeSettingsController | null;
  providerHost: ProviderSettingsHost | null;
  lastProviderSnapshot: ProviderSummarySnapshot | null;
  lastAgentBridgeState: AgentBridgeSettingsState | null;
  unwatchStorageSync: (() => void) | null;
  unwatchChatDisplay: (() => void) | null;
}

let mounted: MountedSettingsHost | null = null;
let renderSettingsPromise: Promise<void> | null = null;
let renderSettingsHost: HTMLElement | null = null;

function syncSummaries(ctx: MountedSettingsHost): void {
  syncAllSummaries(ctx.elements, {
    providerSnapshot: ctx.lastProviderSnapshot,
    agentBridgeState: ctx.lastAgentBridgeState ?? ctx.agentBridge?.getSummaryState() ?? null
  });
}

const navigator = createSettingsNavigator({
  getMounted: () => mounted,
  ensureRendered: () => renderReaderSettingsPanel(),
  onAgentAddressClosed: (options) => mounted?.agentBridge?.onAddressViewClosed(options),
  openLinkedCredentialEditor: (target) => mounted?.providerHost?.openLinkedCredentialEditor(target)
});

const setupFlows = createSetupFlows({
  ensureRendered: () => renderReaderSettingsPanel(),
  getHost: () => mounted?.host ?? null,
  getProviderHost: () => mounted?.providerHost ?? null,
  openView: (view) => navigator.focusSettingsView(view)
});

function setElementGated(el: HTMLElement | null | undefined, gated: boolean): void {
  if (!el) return;
  el.hidden = gated;
  if (gated) {
    el.setAttribute("aria-hidden", "true");
  } else {
    el.removeAttribute("aria-hidden");
  }
}

function applySiteSettingsGating(
  host: HTMLElement,
  elements: SettingsElements,
  capabilities: SettingsCapabilities
): void {
  const { siteCaps, liveAvailable, asrAvailable, agentAvailable } = capabilities;

  setElementGated(elements.openLiveSettingsBtn, !liveAvailable);
  if (!liveAvailable) {
    elements.subpageLive.hidden = true;
  }

  setElementGated(elements.openAsrSettingsBtn, !asrAvailable);
  if (!asrAvailable) {
    elements.subpageAsr.hidden = true;
  }

  setElementGated(elements.openAgentSettingsBtn, !agentAvailable);
  if (!agentAvailable) {
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

async function syncLiveVoiceFallbackHint(
  elements: SettingsElements,
  liveAvailable: boolean
): Promise<void> {
  if (!liveAvailable) {
    return;
  }
  const notice = await takeLiveVoiceFallbackNotice();
  const hint = elements.liveVoiceFallbackHint;
  hint.textContent = notice ? LIVE_VOICE_FALLBACK_NOTICE_TEXT : "";
  hint.hidden = !notice;
}

function createScalarHooks(ctx: MountedSettingsHost): ScalarBindingRuntimeHooks {
  return {
    onAgentBridgeSaved: () => {
      if (mounted !== ctx || !ctx.capabilities.agentAvailable) return;
      void ctx.agentBridge?.refresh();
    },
    onAsrAutoFallbackSaved: (val, elements) => {
      if (mounted !== ctx || !ctx.capabilities.asrAvailable) return;
      if (val && peekAsrSetupResumeToken() !== null) {
        void setupFlows.continueAsrSetupAfterToggleEnabled(elements);
      }
    },
    onDetachedWindowModeChanged: (mode, elements) => {
      if (isReaderDetached()) {
        try {
          void Promise.resolve(requestDetachedModeSwitch(mode))
            .then((switched) => {
              if (switched === false && mounted === ctx && ctx.host.isConnected) {
                setStatus(
                  elements,
                  "浏览器阻止了模式切换，已保留当前窗口；下次弹出时生效。",
                  true
                );
              }
            })
            .catch(() => {});
        } catch {
        }
      }
    },
    onDownloadsPermissionNeeded: (elements) =>
      ensureDownloadsPermissionForNoteSettings(
        elements,
        () => mounted === ctx && ctx.host.isConnected
      )
  };
}

async function loadPanelSettings(ctx: MountedSettingsHost): Promise<void> {
  const settings = await getSettings();
  if (mounted !== ctx) return;

  hydrateScalarSettings(ctx.elements, settings);
  if (ctx.capabilities.agentAvailable) {
    ctx.agentBridge?.sync(settings);
  }
  syncSummaries(ctx);

  await ctx.providerHost?.load(settings);
  if (mounted !== ctx) return;
  await syncLiveVoiceFallbackHint(ctx.elements, ctx.capabilities.liveAvailable);
  if (mounted !== ctx) return;
  syncSummaries(ctx);
}

function bindExternalSync(ctx: MountedSettingsHost): void {
  ctx.unwatchChatDisplay = watchChatDisplaySettings((patch) => {
    if (mounted !== ctx || !ctx.host.isConnected) return;
    applyChatDisplayPatch(ctx.elements, patch);
    syncSummaries(ctx);
  });

  ctx.unwatchStorageSync = watchStorageKeys(
    (changes) => {
      if (mounted !== ctx || !ctx.host.isConnected) return;
      applyScalarStorageChanges(ctx.elements, changes);
      if (changes.agentBridgeUrl && ctx.capabilities.agentAvailable) {
        ctx.agentBridge?.updateUrl(changes.agentBridgeUrl.newValue);
      }
      if (changes.enableAgentBridge && ctx.capabilities.agentAvailable) {
        void ctx.agentBridge?.refresh();
      }
      if (AI_MODEL_EXTERNAL_SYNC_KEYS.some((key) => Boolean(changes[key]))) {
        void Promise.all([loadAiProviders(ctx.providerHost), getSettings()]).then(([providers, settings]) => {
          if (mounted !== ctx || !ctx.host.isConnected) return;
          renderAiModelSelects(ctx.elements, providers, settings, () => syncSummaries(ctx));
        });
      }
      syncSummaries(ctx);
    },
    {
      sync: [
        ...WATCHED_SCALAR_SYNC_KEYS,
        "agentBridgeUrl",
        ...AI_MODEL_EXTERNAL_SYNC_KEYS
      ]
    }
  );
}

function teardownMountedHost(): void {
  disposeScalarBindings();
  const prev = mounted;
  mounted = null;
  if (!prev) return;
  prev.unwatchChatDisplay?.();
  prev.unwatchChatDisplay = null;
  prev.unwatchStorageSync?.();
  prev.unwatchStorageSync = null;
  prev.agentBridge?.dispose();
  prev.agentBridge = null;
  prev.providerHost?.dispose();
  prev.providerHost = null;
  prev.lastProviderSnapshot = null;
  prev.lastAgentBridgeState = null;
}

function mountSettingsHost(host: HTMLElement): MountedSettingsHost {
  teardownMountedHost();

  const elements = collectElements(host);
  const capabilities = resolveSettingsCapabilities();
  const ctx: MountedSettingsHost = {
    host,
    elements,
    capabilities,
    agentBridge: null,
    providerHost: null,
    lastProviderSnapshot: null,
    lastAgentBridgeState: null,
    unwatchStorageSync: null,
    unwatchChatDisplay: null
  };
  mounted = ctx;

  navigator.bindSettingsNavigation(host, elements);
  applySiteSettingsGating(host, elements, capabilities);
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

  if (capabilities.agentAvailable) {
    ctx.agentBridge = bindAgentBridgeSettings(
      elements,
      (text, isError) => setStatus(elements, text, isError),
      {
        onOpenAddress: () => {
          if (mounted !== ctx || !ctx.capabilities.agentAvailable) return;
          navigator.navigateSettingsView("agent-address", { focusOnEnter: false });
        },
        onStateChange: (bridgeState) => {
          if (mounted !== ctx) return;
          ctx.lastAgentBridgeState = bridgeState;
          syncSummaries(ctx);
        }
      }
    );
  }

  const mountedFamilies: Array<"ai" | "live" | "asr" | "search"> = ["ai"];
  if (capabilities.liveAvailable) {
    mountedFamilies.push("live");
  }
  if (capabilities.asrAvailable) {
    mountedFamilies.push("asr");
  }
  mountedFamilies.push("search");

  ctx.providerHost = createProviderSettingsHost({
    host,
    mountedFamilies,
    onStatus: (message, isError) => setStatus(elements, message, isError),
    canRestoreConsumerEditor: () => !activeById(ids.readingSettingsPanel)?.hidden,
    onAiChanged: (providers, { settings: known }) => {
      if (mounted !== ctx) return;
      if (known) {
        renderAiModelSelects(elements, providers, known, () => syncSummaries(ctx));
        return;
      }
      void getSettings().then((s) => {
        if (mounted !== ctx) return;
        renderAiModelSelects(elements, providers, s, () => syncSummaries(ctx));
      });
    },
    onSummaryChange: (snapshot) => {
      if (mounted !== ctx) return;
      ctx.lastProviderSnapshot = snapshot;
      syncSummaries(ctx);
      if (elements.subtitleTranslateSource?.value === SILICONFLOW_TRANSLATE_PROVIDER_ID) {
        void refreshSiliconFlowTranslateKeyStatus(elements, hasSavedSiliconFlowAsrKey(snapshot.asrProviders));
      }
    }
  });

  bindModelSelectEvents(elements, {
    savePatch: saveSettingField,
    loadAiProviders: () => loadAiProviders(ctx.providerHost),
    syncSummaries: () => syncSummaries(ctx),
    setStatus
  });

  bindScalarSettings(elements, {
    syncSummaries: () => syncSummaries(ctx),
    reloadSettings: () => loadPanelSettings(ctx),
    hooks: createScalarHooks(ctx)
  });

  bindExternalSync(ctx);

  return ctx;
}

export function renderReaderSettingsPanel(): Promise<void> {
  const host = activeById(ids.readingSettingsHost);
  if (!host) {
    return Promise.resolve();
  }
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
      const ctx = mountSettingsHost(host);
      if (shouldRestoreBackFocus) {
        activeById(ids.readingSettingsBackBtn)?.focus({ preventScroll: true });
      }
      host.dataset.biliscriptSettingsRendered = "1";
      const settingsPanel = activeById(ids.readingSettingsPanel);
      if (settingsPanel && !settingsPanel.hidden) {
        const visibleView = host.querySelector<HTMLElement>(".biliscript-settings-view:not([hidden])");
        animateNavFadeIn(visibleView, 140);
      }
      await loadPanelSettings(ctx);
      if (mounted === ctx) {
        navigator.flushPendingTarget();
      }
    })().finally(() => {
      if (renderSettingsPromise === promise) {
        renderSettingsPromise = null;
        renderSettingsHost = null;
      }
    });
    renderSettingsPromise = promise;
    return promise;
  }

  const capabilities = resolveSettingsCapabilities();
  if (!mounted || mounted.host !== host || !host.contains(mounted.elements.status)) {
    teardownMountedHost();
    mounted = {
      host,
      elements: collectElements(host),
      capabilities,
      agentBridge: null,
      providerHost: null,
      lastProviderSnapshot: null,
      lastAgentBridgeState: null,
      unwatchStorageSync: null,
      unwatchChatDisplay: null
    };
  } else {
    mounted.capabilities = capabilities;
  }

  applySiteSettingsGating(host, mounted.elements, capabilities);
  return loadPanelSettings(mounted);
}

export function disposeReaderSettingsPanel(): void {
  navigator.dispose();
  teardownMountedHost();
  closeAgentBridgeInstallDialog();
  renderSettingsPromise = null;
  renderSettingsHost = null;
}

export function openLiveSettings(target: LiveSettingsTarget): Promise<void> {
  if (!resolveSettingsCapabilities().liveAvailable) {
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
  if (!resolveSettingsCapabilities().asrAvailable) {
    return Promise.resolve();
  }
  return setupFlows.openReaderAsrSetup();
}

export function resolveEditableAiProviderId(): Promise<string> {
  return setupFlows.resolveEditableAiProviderId();
}
