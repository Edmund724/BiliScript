import { state } from "../../core/state.js";
import { supportsLiveCompanion } from "../../shared/runtime-capabilities.js";
import { detectActiveSite, getSiteCapabilities, type SiteCapabilities } from "../../shared/site.js";
import { SETTINGS_PANEL_DOM_IDS, type SettingsPanelDomId } from "./dom-ids.js";

export interface SettingsCapabilities {
  readonly siteCaps: SiteCapabilities;
  readonly liveAvailable: boolean;
  readonly asrAvailable: boolean;
  readonly agentAvailable: boolean;
  readonly playerQuickAiAvailable: boolean;
}

export function resolveSettingsCapabilities(): SettingsCapabilities {
  const site =
    state.clip.site === "youtube" || detectActiveSite() === "youtube"
      ? "youtube"
      : state.clip.site;
  const siteCaps = getSiteCapabilities(site);
  return {
    siteCaps,
    liveAvailable: supportsLiveCompanion() && siteCaps.supportsLiveCompanion,
    asrAvailable: siteCaps.supportsAsr,
    agentAvailable: siteCaps.supportsAgentBridge,
    playerQuickAiAvailable: siteCaps.supportsPlayerQuickAiButton
  };
}

export function applySectionContainment(host: HTMLElement): void {
  host.querySelectorAll<HTMLElement>(".biliscript-set-group").forEach((group) => {
    group.style.contain = "layout style";
  });
}

export function queryElementByIdIn<T extends HTMLElement>(host: HTMLElement, id: SettingsPanelDomId): T | null {
  const doc = host.ownerDocument;
  if (host.isConnected && doc) {
    const candidate = doc.getElementById(id);
    if (candidate && candidate !== host && host.contains(candidate)) {
      return candidate as T;
    }
  }
  return host.querySelector<T>(`#${id}`);
}

export function collectElements(host: HTMLElement) {
  const dom = SETTINGS_PANEL_DOM_IDS;
  const byIdIn = <T extends HTMLElement>(id: SettingsPanelDomId): T => {
    const el = queryElementByIdIn<T>(host, id);
    if (!el) {
      throw new Error(`Missing required settings element: #${id}`);
    }
    return el;
  };
  return {
    backBtn: byIdIn<HTMLButtonElement>(dom.readingSettingsBackBtn),
    settingsTitle: byIdIn<HTMLElement>(dom.settingsTitle),
    settingsRootView: byIdIn<HTMLElement>(dom.settingsRootView),
    subpageAiProviders: byIdIn<HTMLElement>(dom.subpageAiProviders),
    subpageLive: byIdIn<HTMLElement>(dom.subpageLive),
    subpageAsr: byIdIn<HTMLElement>(dom.subpageAsr),
    subpageSearch: byIdIn<HTMLElement>(dom.subpageSearch),
    subpageAiPrompt: byIdIn<HTMLElement>(dom.subpageAiPrompt),
    subpageSubtitle: byIdIn<HTMLElement>(dom.subpageSubtitle),
    subpageNotes: byIdIn<HTMLElement>(dom.subpageNotes),
    subpageAppearance: byIdIn<HTMLElement>(dom.subpageAppearance),
    subpageAgent: byIdIn<HTMLElement>(dom.subpageAgent),
    subpageAdvanced: byIdIn<HTMLElement>(dom.subpageAdvanced),
    openAiProvidersBtn: byIdIn<HTMLButtonElement>(dom.openAiProvidersBtn),
    aiProvidersSummary: byIdIn<HTMLElement>(dom.aiProvidersSummary),
    openLiveSettingsBtn: byIdIn<HTMLButtonElement>(dom.openLiveSettingsBtn),
    liveSettingsSummary: byIdIn<HTMLElement>(dom.liveSettingsSummary),
    openAsrSettingsBtn: byIdIn<HTMLButtonElement>(dom.openAsrSettingsBtn),
    asrSettingsSummary: byIdIn<HTMLElement>(dom.asrSettingsSummary),
    openSearchSettingsBtn: byIdIn<HTMLButtonElement>(dom.openSearchSettingsBtn),
    searchSettingsSummary: byIdIn<HTMLElement>(dom.searchSettingsSummary),
    openAiPromptBtn: byIdIn<HTMLButtonElement>(dom.openAiPromptBtn),
    aiPromptSummary: byIdIn<HTMLElement>(dom.aiPromptSummary),
    openSubtitleSettingsBtn: byIdIn<HTMLButtonElement>(dom.openSubtitleSettingsBtn),
    subtitleSettingsSummary: byIdIn<HTMLElement>(dom.subtitleSettingsSummary),
    openNotesSettingsBtn: byIdIn<HTMLButtonElement>(dom.openNotesSettingsBtn),
    notesSettingsSummary: byIdIn<HTMLElement>(dom.notesSettingsSummary),
    openAppearanceBtn: byIdIn<HTMLButtonElement>(dom.openAppearanceBtn),
    appearanceSettingsSummary: byIdIn<HTMLElement>(dom.appearanceSettingsSummary),
    openAgentSettingsBtn: byIdIn<HTMLButtonElement>(dom.openAgentSettingsBtn),
    agentSettingsSummary: byIdIn<HTMLElement>(dom.agentSettingsSummary),
    openAdvancedSettingsBtn: byIdIn<HTMLButtonElement>(dom.openAdvancedSettingsBtn),
    advancedSettingsSummary: byIdIn<HTMLElement>(dom.advancedSettingsSummary),
    openOnboardingBtn: byIdIn<HTMLButtonElement>(dom.openOnboardingBtn),
    downloadFormat: byIdIn<HTMLSelectElement>(dom.downloadFormat),
    noteExportTemplate: byIdIn<HTMLTextAreaElement>(dom.noteExportTemplate),
    noteExportResetTemplateBtn: byIdIn<HTMLButtonElement>(dom.noteExportResetTemplateBtn),
    noteExportTarget: byIdIn<HTMLSelectElement>(dom.noteExportTarget),
    noteDownloadSubdir: byIdIn<HTMLInputElement>(dom.noteDownloadSubdir),
    notePromptPreset: byIdIn<HTMLSelectElement>(dom.notePromptPreset),
    noteCustomPrompt: byIdIn<HTMLTextAreaElement>(dom.noteCustomPrompt),
    noteIncludeKeyframes: byIdIn<HTMLInputElement>(dom.noteIncludeKeyframes),
    obsidianVaultName: byIdIn<HTMLInputElement>(dom.obsidianVaultName),
    obsidianFolder: byIdIn<HTMLInputElement>(dom.obsidianFolder),
    readerTheme: byIdIn<HTMLSelectElement>(dom.readerTheme),
    readerPalette: byIdIn<HTMLSelectElement>(dom.readerPalette),
    chatInputGlow: byIdIn<HTMLInputElement>(dom.chatInputGlow),
    reduceTransparency: byIdIn<HTMLInputElement>(dom.reduceTransparency),
    readerFontSizeScaleContainer: byIdIn<HTMLElement>(dom.readerFontSizeScaleContainer),
    readerFontSizeScale: byIdIn<HTMLInputElement>(dom.readerFontSizeScale),
    readerFontSizeScaleValue: byIdIn<HTMLElement>(dom.readerFontSizeScaleValue),
    readerFontSizeScaleResetBtn: byIdIn<HTMLButtonElement>(dom.readerFontSizeScaleResetBtn),
    chatPreferencesHeading: byIdIn<HTMLElement>(dom.chatPreferencesHeading),
    chatLineHeight: byIdIn<HTMLInputElement>(dom.chatLineHeight),
    chatLineHeightValue: byIdIn<HTMLElement>(dom.chatLineHeightValue),
    chatLineHeightResetBtn: byIdIn<HTMLButtonElement>(dom.chatLineHeightResetBtn),
    chatParagraphSpacing: byIdIn<HTMLInputElement>(dom.chatParagraphSpacing),
    chatParagraphSpacingValue: byIdIn<HTMLElement>(dom.chatParagraphSpacingValue),
    chatParagraphSpacingResetBtn: byIdIn<HTMLButtonElement>(dom.chatParagraphSpacingResetBtn),
    speechVoiceVolume: byIdIn<HTMLInputElement>(dom.speechVoiceVolume),
    speechVoiceVolumeValue: byIdIn<HTMLElement>(dom.speechVoiceVolumeValue),
    speechVoiceVolumeResetBtn: byIdIn<HTMLButtonElement>(dom.speechVoiceVolumeResetBtn),
    liveVoiceVolume: byIdIn<HTMLInputElement>(dom.liveVoiceVolume),
    liveVoiceVolumeValue: byIdIn<HTMLElement>(dom.liveVoiceVolumeValue),
    liveVoiceVolumeResetBtn: byIdIn<HTMLButtonElement>(dom.liveVoiceVolumeResetBtn),
    liveVoiceSpeed: byIdIn<HTMLInputElement>(dom.liveVoiceSpeed),
    liveVoiceSpeedValue: byIdIn<HTMLElement>(dom.liveVoiceSpeedValue),
    liveVoiceSpeedResetBtn: byIdIn<HTMLButtonElement>(dom.liveVoiceSpeedResetBtn),
    liveShareVideoAudio: byIdIn<HTMLInputElement>(dom.liveShareVideoAudio),
    liveVoicePriority: byIdIn<HTMLInputElement>(dom.liveVoicePriority),
    detachedWindowMode: byIdIn<HTMLSelectElement>(dom.detachedWindowMode),
    autoOpenReader: byIdIn<HTMLInputElement>(dom.autoOpenReader),
    enableExtraPlaybackRates: byIdIn<HTMLInputElement>(dom.enableExtraPlaybackRates),
    includeDateInFilename: byIdIn<HTMLInputElement>(dom.includeDateInFilename),
    enablePlayerAiQuickAction: byIdIn<HTMLInputElement>(dom.enablePlayerAiQuickAction),
    playerAiActionMode: byIdIn<HTMLSelectElement>(dom.playerAiActionMode),
    playerAiQuickPrompt: byIdIn<HTMLTextAreaElement>(dom.playerAiQuickPrompt),
    playerAiAutoExportNote: byIdIn<HTMLInputElement>(dom.playerAiAutoExportNote),
    includeTimestampInBody: byIdIn<HTMLInputElement>(dom.includeTimestampInBody),
    enableDebugLogs: byIdIn<HTMLInputElement>(dom.enableDebugLogs),
    enableAgentBridge: byIdIn<HTMLInputElement>(dom.enableAgentBridge),
    agentBridgeConnectBtn: byIdIn<HTMLButtonElement>(dom.agentBridgeConnectBtn),
    agentBridgeAddressBtn: byIdIn<HTMLButtonElement>(dom.agentBridgeAddressBtn),
    agentBridgeAddressSummary: byIdIn<HTMLElement>(dom.agentBridgeAddressSummary),
    agentBridgeAddressView: byIdIn<HTMLElement>(dom.agentBridgeAddressView),
    agentBridgeUrl: byIdIn<HTMLInputElement>(dom.agentBridgeUrl),
    agentBridgeResetUrlBtn: byIdIn<HTMLButtonElement>(dom.agentBridgeResetUrlBtn),
    agentBridgeTestBtn: byIdIn<HTMLButtonElement>(dom.agentBridgeTestBtn),
    agentBridgeSaveBtn: byIdIn<HTMLButtonElement>(dom.agentBridgeSaveBtn),
    agentBridgeAddressStatus: byIdIn<HTMLElement>(dom.agentBridgeAddressStatus),
    chatHistoryMaxCount: byIdIn<HTMLSelectElement>(dom.chatHistoryMaxCount),
    videoCacheMaxMb: byIdIn<HTMLSelectElement>(dom.videoCacheMaxMb),
    videoCacheUsage: byIdIn<HTMLElement>(dom.videoCacheUsage),
    aiProvidersList: byIdIn<HTMLElement>(dom.aiProvidersList),
    aiProvidersEmpty: byIdIn<HTMLElement>(dom.aiProvidersEmpty),
    addAiProviderBtn: byIdIn<HTMLButtonElement>(dom.addAiProviderBtn),
    liveSettingsHeader: byIdIn<HTMLElement>(dom.liveSettingsHeader),
    liveProvidersList: byIdIn<HTMLElement>(dom.liveProvidersList),
    liveProvidersEmpty: byIdIn<HTMLElement>(dom.liveProvidersEmpty),
    liveVoiceFallbackHint: byIdIn<HTMLElement>(dom.liveVoiceFallbackHint),
    addLiveProviderBtn: byIdIn<HTMLButtonElement>(dom.addLiveProviderBtn),
    liveLowBandwidth: byIdIn<HTMLInputElement>(dom.liveLowBandwidth),
    subtitleTranslateSource: byIdIn<HTMLSelectElement>(dom.subtitleTranslateSource),
    subtitleTranslateModel: byIdIn<HTMLSelectElement>(dom.subtitleTranslateModel),
    subtitleTranslateSiliconFlowKeyRow: byIdIn<HTMLElement>(dom.subtitleTranslateSiliconFlowKeyRow),
    subtitleTranslateSiliconFlowKey: byIdIn<HTMLInputElement>(dom.subtitleTranslateSiliconFlowKey),
    subtitleTranslateSiliconFlowKeySaveBtn: byIdIn<HTMLButtonElement>(dom.subtitleTranslateSiliconFlowKeySaveBtn),
    subtitleTranslateGlossary: byIdIn<HTMLTextAreaElement>(dom.subtitleTranslateGlossary),
    bilingualDisplayOrder: byIdIn<HTMLSelectElement>(dom.bilingualDisplayOrder),
    subtitleSegmentationStrategy: byIdIn<HTMLSelectElement>(dom.subtitleSegmentationStrategy),
    asrProvidersList: byIdIn<HTMLElement>(dom.asrProvidersList),
    asrProvidersEmpty: byIdIn<HTMLElement>(dom.asrProvidersEmpty),
    addAsrProviderBtn: byIdIn<HTMLButtonElement>(dom.addAsrProviderBtn),
    asrAutoFallback: byIdIn<HTMLInputElement>(dom.asrAutoFallback),
    searchProvidersList: byIdIn<HTMLElement>(dom.searchProvidersList),
    searchProvidersEmpty: byIdIn<HTMLElement>(dom.searchProvidersEmpty),
    searchProvidersDanglingHint: byIdIn<HTMLElement>(dom.searchProvidersDanglingHint),
    addSearchProviderBtn: byIdIn<HTMLButtonElement>(dom.addSearchProviderBtn),
    resetSearchProviderOrderBtn: byIdIn<HTMLButtonElement>(dom.resetSearchProviderOrderBtn),
    allowPaidSearchProviders: byIdIn<HTMLInputElement>(dom.allowPaidSearchProviders),
    webSearchMaxToolCallsContainer: byIdIn<HTMLElement>(dom.webSearchMaxToolCallsContainer),
    webSearchMaxToolCalls: byIdIn<HTMLInputElement>(dom.webSearchMaxToolCalls),
    webSearchMaxToolCallsValue: byIdIn<HTMLElement>(dom.webSearchMaxToolCallsValue),
    webSearchMaxToolCallsResetBtn: byIdIn<HTMLButtonElement>(dom.webSearchMaxToolCallsResetBtn),
    aiSystemPrompt: byIdIn<HTMLTextAreaElement>(dom.aiSystemPrompt),
    aiSystemPromptResetBtn: byIdIn<HTMLButtonElement>(dom.aiSystemPromptResetBtn),
    aiInitialQuickPrompts: host.querySelectorAll<HTMLInputElement>(".ai-initial-quick-prompt"),
    aiDefaultModel: byIdIn<HTMLSelectElement>(dom.aiDefaultModel),
    enableCostGuard: byIdIn<HTMLInputElement>(dom.enableCostGuard),
    resetBtn: byIdIn<HTMLButtonElement>(dom.resetBtn),
    status: byIdIn<HTMLElement>(dom.status)
  };
}

export type SettingsElements = ReturnType<typeof collectElements>;

let statusVersion = 0;
let statusClearTimer: ReturnType<typeof setTimeout> | null = null;

export function getStatusVersion(): number {
  return statusVersion;
}

export function clearStatusClearTimer(): void {
  if (statusClearTimer) {
    clearTimeout(statusClearTimer);
    statusClearTimer = null;
  }
}

export function setStatus(elements: SettingsElements, text: unknown, isError = false): void {
  clearStatusClearTimer();
  statusVersion += 1;
  elements.status.textContent = String(text || "");
  elements.status.dataset.error = isError ? "true" : "false";
}

export function scheduleStatusAutoClear(
  elements: SettingsElements,
  expectedText: string,
  delayMs: number
): void {
  clearStatusClearTimer();
  statusClearTimer = setTimeout(() => {
    statusClearTimer = null;
    if (elements.status.dataset.error !== "true" && elements.status.textContent === expectedText) {
      setStatus(elements, "");
    }
  }, delayMs);
}

export function setBusy(elements: SettingsElements, isBusy: boolean): void {
  elements.resetBtn.disabled = isBusy;
  elements.resetBtn.textContent = isBusy ? "处理中..." : "恢复默认偏好";
}

export function debounce<T extends (...args: never[]) => void>(
  fn: T,
  delayMs: number
): ((...args: Parameters<T>) => void) & { cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;
  const debounced = (...args: Parameters<T>): void => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      lastArgs = null;
      fn(...args);
    }, delayMs);
  };

  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      lastArgs = null;
    }
  };
  const flush = (): void => {
    if (timer && lastArgs) {
      clearTimeout(timer);
      timer = null;
      const args = lastArgs;
      lastArgs = null;
      fn(...args);
    }
  };
  return Object.assign(debounced, { cancel, flush });
}
