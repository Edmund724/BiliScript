// settings-panel.ts — 侧边栏设置面板（script-only-ui）。
//
// 设置项挂载在文摘面板的设置抽屉（ui-renderer 模板内的 #biliscript-reading-settings-host
// 容器，分节、随抽屉滚动）：
//   - 装载（get-settings）→ 渲染平台行（AI/ASR / 搜索 / MOSS-LIVE）与标量设置项；
//   - 标量设置项按 SCALAR_FIELD_BINDINGS 声明式驱动水合、即时保存与跨端同步；
//   - 平台经 provider-editor Modal 的单平台事务 provider-transaction 保存，
//     平台行构建与验证复用 ../ui/provider-family.ts、../core/validators.ts；
//   - 平台测试（AI/ASR 探针）只验证连通性，不落盘——保存只发生在 Modal 的
//     保存按钮链路上；
//   - content script 语境没有 chrome.permissions API（Chromium 仅扩展自有页面/SW
//     可用），host 权限申请改走 "request-provider-origins" 消息由 background SW
//     代为申请（手势随一次 runtime 消息传导；SW 监听器在调用
//     chrome.permissions.request 前零 await）。

import { DEFAULT_SETTINGS, type KnownSettingKey, type Settings } from "../core/defaults.js";
import {
  DEFAULT_AI_SYSTEM_PROMPT,
  DEFAULT_PLAYER_AI_QUICK_PROMPT,
  MAX_INITIAL_QUICK_PROMPTS
} from "../core/default-prompts.js";
import {
  normalizeDownloadFormat,
  normalizePlayerAiQuickPrompt,
  normalizeReaderPalette,
  normalizeChatInputGlow,
  normalizeWebSearchMaxToolCalls,
  normalizeCustomPanelWidth,
  normalizeReaderFontSizeScale,
  normalizeChatLineHeight,
  normalizeChatParagraphSpacing,
  normalizeSpeechVoiceVolume,
  normalizeLiveVoiceVolume,
  normalizeLiveVoiceSpeed,
  normalizeLiveVoicePriority,
  normalizeLiveShareVideoAudio
} from "../core/validators.js";
import { applyReadingViewTypography, applyChatInputGlow, applyReadingViewPresentation } from "../reader/presentation.js";
import { state } from "../core/state.js";
import { relayoutScriptHost } from "../reader/script-host.js";
import { closeReaderSettingsMode, openReaderSettingsMode } from "../reader/settings-mode.js";
import type { OverviewSetupErrorClass } from "../core/overview-setup-error.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { getSettings } from "../core/runtime.js";
import { buildSettingsHtml, SETTINGS_PANEL_DOM_IDS, type SettingsPanelDomId } from "./settings-panel-html.js";
import { bindAgentBridgeSettings, type AgentBridgeSettingsController } from "./agent-bridge-settings.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { confirmDialog } from "./confirm-dialog.js";
import { cleanExpiredConversations } from "../chat/conversation-store.js";
import { initCustomSelect, rebuildCustomSelectOptions, setCustomSelectState, setCustomSelectValue } from "./custom-select.js";
import { escapeHtml } from "../shared/string-utils.js";
import { buildModelOptionValue, normalizeProviderModels, parseModelOptionValue, resolveCatalogModel } from "../shared/selected-provider.js";
import {
  resolveAiActiveModelProjection,
  resolveSubtitleFollowProjection,
  type AiActiveModelProjection
} from "../ai/active-model-projection.js";
import {
  formatAiDefaultSummaryLine,
  formatSubtitleFollowHint,
  subtitleFollowHintState,
  syncAiDefaultModelLine
} from "./ai-active-projection.js";
import { AI_PROVIDERS_STORAGE, AI_PROVIDER_KEYS_STORAGE } from "../core/ai-provider-store.js";
import { initToggleSwitch, syncToggleSwitch } from "./toggle-switch.js";
import { bindResettableRangeSlider, setResettableRangeValue } from "./range-slider.js";
import type { ProviderRowItem } from "./provider-row.js";
import { resolveAsrSetupState } from "../asr/asr-setup.js";
import {
  consumeAsrSetupResumeToken,
  currentPageVideoKey,
  invalidateReaderSetupFlows,
  peekAsrSetupResumeToken,
  setAsrSetupResumeToken
} from "../reader/setup-resume.js";
import { requestSubtitleRefresh } from "../reader/reader-bus.js";
import { kickSubtitleFetch } from "../subtitle/kick-subtitle-fetch.js";
import { logWarn } from "../shared/logging.js";
import {
  applyLiveAudioSettings,
  persistLiveAudioSettings,
  type LiveAudioSettingsPatch
} from "../live/live-audio-settings.js";
import type { SaveSettingsResponse } from "../shared/messaging-protocol.js";
import {
  LIVE_VOICE_FALLBACK_NOTICE_TEXT,
  takeLiveVoiceFallbackNotice
} from "../live/live-voice-fallback-notice.js";
import { createProviderSettingsHost, type ProviderSettingsHost } from "./provider-settings-host.js";
import { ids } from "../reader/state.js";
import type { LiveSettingsTarget } from "../live/fullscreen-live-overlay.js";
import {
  ensureReaderSettingsStyles,
  whenReaderSettingsStylesReady
} from "../shared/style-injector.js";

ensureReaderSettingsStyles();

// 设置抽屉宿主引用：单平台保存后的列表重渲需要按 id 重取 elements——renderReaderSettingsPanel 挂载时赋值。
let settingsHostRef: HTMLElement | null = null;
let agentBridgeSettings: AgentBridgeSettingsController | null = null;
let pendingSettingsTarget: LiveSettingsTarget | "appearance" | null = null;
let renderSettingsPromise: Promise<void> | null = null;
let renderSettingsHost: HTMLElement | null = null;
let providerHost: ProviderSettingsHost | null = null;

// ===== 分区渲染隔离 =====
// .biliscript-set-group 是随抽屉滚动的自包含布局区：contain: layout style 把行增删/
// 校验错误显示/保存重渲等分区内部变更的 style/layout 失效圈在分区内，不上溯
// 阅读壳与宿主 B 站页面。
// 不取 paint containment：paint 会把后代裁剪到分区 padding box，而本面板弹层
//（custom-select-dropdown，absolute top:100%+6px）刻意溢出分区边界盖过相邻卡片；
// layout containment 建立的堆叠上下文由 reader-settings-rows.css 的
// .biliscript-set-group:has(...) 规则在展开下拉时整区抬升配对。
function applySectionContainment(host: HTMLElement): void {
  host.querySelectorAll<HTMLElement>(".biliscript-set-group").forEach((group) => {
    group.style.contain = "layout style";
  });
}

// ===== 元素收集（模板渲染后按 id 取自宿主容器） =====
// 查询 id 全部取自 settings-panel-html.ts 的 SETTINGS_PANEL_DOM_IDS（id 词汇表
// 单一声明，模板属性同源）；byIdIn 入参类型即该表值域，写不出表外 id。

function collectElements(host: HTMLElement) {
  const dom = SETTINGS_PANEL_DOM_IDS;
  const byIdIn = <T extends HTMLElement>(id: SettingsPanelDomId): T =>
    host.querySelector(`#${id}`) as T;
  return {
    backBtn: byIdIn<HTMLButtonElement>(dom.readingSettingsBackBtn),
    settingsNav: byIdIn<HTMLElement>(dom.settingsNav),
    downloadFormat: byIdIn<HTMLSelectElement>(dom.downloadFormat),
    readerPalette: byIdIn<HTMLSelectElement>(dom.readerPalette),
    chatInputGlow: byIdIn<HTMLInputElement>(dom.chatInputGlow),
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
    customPanelWidthContainer: byIdIn<HTMLElement>(dom.customPanelWidthContainer),
    customPanelWidth: byIdIn<HTMLInputElement>(dom.customPanelWidth),
    customPanelWidthValue: byIdIn<HTMLElement>(dom.customPanelWidthValue),
    customPanelWidthResetBtn: byIdIn<HTMLButtonElement>(dom.customPanelWidthResetBtn),
    autoOpenReader: byIdIn<HTMLInputElement>(dom.autoOpenReader),
    enableExtraPlaybackRates: byIdIn<HTMLInputElement>(dom.enableExtraPlaybackRates),
    includeDateInFilename: byIdIn<HTMLInputElement>(dom.includeDateInFilename),
    enablePlayerAiQuickAction: byIdIn<HTMLInputElement>(dom.enablePlayerAiQuickAction),
    playerAiQuickPrompt: byIdIn<HTMLTextAreaElement>(dom.playerAiQuickPrompt),
    includeTimestampInBody: byIdIn<HTMLInputElement>(dom.includeTimestampInBody),
    enableDebugLogs: byIdIn<HTMLInputElement>(dom.enableDebugLogs),
    enableAgentBridge: byIdIn<HTMLInputElement>(dom.enableAgentBridge),
    agentBridgeConnectBtn: byIdIn<HTMLButtonElement>(dom.agentBridgeConnectBtn),
    agentBridgeAddressBtn: byIdIn<HTMLButtonElement>(dom.agentBridgeAddressBtn),
    agentBridgeAddressView: byIdIn<HTMLElement>(dom.agentBridgeAddressView),
    agentBridgeAddressBackBtn: byIdIn<HTMLButtonElement>(dom.agentBridgeAddressBackBtn),
    agentBridgeUrl: byIdIn<HTMLInputElement>(dom.agentBridgeUrl),
    agentBridgeResetUrlBtn: byIdIn<HTMLButtonElement>(dom.agentBridgeResetUrlBtn),
    agentBridgeTestBtn: byIdIn<HTMLButtonElement>(dom.agentBridgeTestBtn),
    agentBridgeSaveBtn: byIdIn<HTMLButtonElement>(dom.agentBridgeSaveBtn),
    agentBridgeAddressStatus: byIdIn<HTMLElement>(dom.agentBridgeAddressStatus),
    cleanConversationsOlderThan30Days: byIdIn<HTMLInputElement>(dom.cleanConversationsOlderThan30Days),
    aiProvidersList: byIdIn<HTMLElement>(dom.aiProvidersList),
    aiProvidersEmpty: byIdIn<HTMLElement>(dom.aiProvidersEmpty),
    addAiProviderBtn: byIdIn<HTMLButtonElement>(dom.addAiProviderBtn),
    liveSettingsHeader: byIdIn<HTMLElement>(dom.liveSettingsHeader),
    liveProvidersList: byIdIn<HTMLElement>(dom.liveProvidersList),
    liveProvidersEmpty: byIdIn<HTMLElement>(dom.liveProvidersEmpty),
    liveVoiceFallbackHint: byIdIn<HTMLElement>(dom.liveVoiceFallbackHint),
    addLiveProviderBtn: byIdIn<HTMLButtonElement>(dom.addLiveProviderBtn),
    liveLowBandwidth: byIdIn<HTMLInputElement>(dom.liveLowBandwidth),
    subtitleTranslateModel: byIdIn<HTMLSelectElement>(dom.subtitleTranslateModel),
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
    aiInitialQuickPrompts: host.querySelectorAll<HTMLInputElement>(".ai-initial-quick-prompt"),
    toggleSearchChainBtn: byIdIn<HTMLElement>(dom.toggleSearchChainBtn),
    searchChainContainer: byIdIn<HTMLElement>(dom.searchChainContainer),
    searchChainActiveSummary: byIdIn<HTMLElement>(dom.searchChainActiveSummary),
    aiActiveDefaultSummary: byIdIn<HTMLElement>(dom.aiActiveDefaultSummary),
    aiDefaultModel: byIdIn<HTMLSelectElement>(dom.aiDefaultModel),
    subtitleTranslateFollowHint: byIdIn<HTMLElement>(dom.subtitleTranslateFollowHint),
    resetBtn: byIdIn<HTMLButtonElement>(dom.resetBtn),
    status: byIdIn<HTMLElement>(dom.status)
  };
}

type SettingsElements = ReturnType<typeof collectElements>;

// ===== 标量设置项声明式绑定 =====
// 每个标量设置项声明控件类型、DOM 引用键、归一化与即时预览副作用；
// loadSettings（水合）、bindSettingsEvents（事件持久化）与 watchStorageKeys（跨端同步）
// 共用同一张表。

interface SelectFieldBinding<K extends KnownSettingKey = KnownSettingKey> {
  readonly kind: "select";
  readonly key: K;
  readonly getElement: (elements: SettingsElements) => HTMLSelectElement;
  readonly normalize: (value: unknown) => Settings[K] & string;
  readonly patchState?: boolean;
  readonly watchSync?: boolean;
  readonly onApply?: (val: Settings[K] & string) => void;
}

type ScalarFieldPersist = (patch: Record<string, unknown>) => Promise<SaveSettingsResponse>;

const persistLiveAudioField: ScalarFieldPersist = (patch) =>
  persistLiveAudioSettings(patch as LiveAudioSettingsPatch);

interface ToggleFieldBinding<K extends KnownSettingKey = KnownSettingKey> {
  readonly kind: "toggle";
  readonly key: K;
  readonly getElement: (elements: SettingsElements) => HTMLInputElement;
  readonly normalize: (value: unknown) => boolean;
  readonly patchState?: boolean;
  readonly watchSync?: boolean;
  readonly persist?: ScalarFieldPersist;
  readonly onApply?: (val: boolean) => void;
  // 落盘成功后的生效回调（票 04：自动转写开关打开并保存成功后重新进入字幕抓取）。
  // 只有写盘成功才调用——onApply 在保存前触发，失败时也会跑，不能承担续跑。
  readonly onSaved?: (val: boolean) => void;
}

interface SliderFieldBinding<K extends KnownSettingKey = KnownSettingKey> {
  readonly kind: "slider";
  readonly key: K;
  readonly getElement: (elements: SettingsElements) => HTMLInputElement;
  readonly getBadge: (elements: SettingsElements) => HTMLElement;
  readonly getResetBtn: (elements: SettingsElements) => HTMLButtonElement;
  readonly defaultValue: number;
  readonly normalize: (value: unknown) => number;
  readonly format?: (val: number) => string;
  readonly patchState?: boolean;
  readonly watchSync?: boolean;
  readonly persist?: ScalarFieldPersist;
  // 滑块提交/预览时随主键一并 patch 与落盘的附加键（如宽度滑块置位
  // customPanelWidthEnabled 显式自定义标记）。
  readonly commitExtras?: () => Record<string, unknown>;
  // 重置键的附加清除键：提供后重置走完整替代路径（主键回默认值 + 附加键 +
  // patch + 落盘），替代默认的「主键默认值 + onCommit」。
  readonly resetExtras?: () => Record<string, unknown>;
  readonly onPreview?: (val: number) => void;
}

interface DebouncedTextFieldBinding<K extends KnownSettingKey = KnownSettingKey> {
  readonly kind: "debounced-text";
  readonly key: K;
  readonly getElement: (elements: SettingsElements) => HTMLTextAreaElement | HTMLInputElement;
  readonly normalize: (value: unknown) => string;
  readonly patchState?: boolean;
  readonly watchSync?: boolean;
}

type ScalarFieldBinding =
  | SelectFieldBinding
  | ToggleFieldBinding
  | SliderFieldBinding
  | DebouncedTextFieldBinding;

const SCALAR_FIELD_BINDINGS: readonly ScalarFieldBinding[] = [
  {
    kind: "select",
    key: "downloadFormat",
    getElement: (el) => el.downloadFormat,
    normalize: normalizeDownloadFormat
  },
  {
    kind: "select",
    key: "readerPalette",
    getElement: (el) => el.readerPalette,
    normalize: normalizeReaderPalette,
    onApply: (val) => {
      state.reader?.setPalette?.(val);
      applyReadingViewPresentation();
    }
  },
  {
    kind: "slider",
    key: "readerFontSizeScale",
    getElement: (el) => el.readerFontSizeScale,
    getBadge: (el) => el.readerFontSizeScaleValue,
    getResetBtn: (el) => el.readerFontSizeScaleResetBtn,
    defaultValue: DEFAULT_SETTINGS.readerFontSizeScale,
    normalize: normalizeReaderFontSizeScale,
    format: (val) => `${val}%`,
    onPreview: () => {
      applyReadingViewTypography();
    }
  },
  {
    kind: "slider",
    key: "chatLineHeight",
    getElement: (el) => el.chatLineHeight,
    getBadge: (el) => el.chatLineHeightValue,
    getResetBtn: (el) => el.chatLineHeightResetBtn,
    defaultValue: DEFAULT_SETTINGS.chatLineHeight,
    normalize: normalizeChatLineHeight,
    format: (val) => `${val}%`,
    watchSync: true,
    onPreview: () => applyReadingViewTypography()
  },
  {
    kind: "slider",
    key: "chatParagraphSpacing",
    getElement: (el) => el.chatParagraphSpacing,
    getBadge: (el) => el.chatParagraphSpacingValue,
    getResetBtn: (el) => el.chatParagraphSpacingResetBtn,
    defaultValue: DEFAULT_SETTINGS.chatParagraphSpacing,
    normalize: normalizeChatParagraphSpacing,
    format: (val) => `${val}px`,
    watchSync: true,
    onPreview: () => applyReadingViewTypography()
  },
  {
    kind: "slider",
    key: "speechVoiceVolume",
    getElement: (el) => el.speechVoiceVolume,
    getBadge: (el) => el.speechVoiceVolumeValue,
    getResetBtn: (el) => el.speechVoiceVolumeResetBtn,
    defaultValue: DEFAULT_SETTINGS.speechVoiceVolume,
    normalize: normalizeSpeechVoiceVolume,
    format: (val) => `${val}%`,
    watchSync: true
  },
  {
    kind: "slider",
    key: "customPanelWidth",
    getElement: (el) => el.customPanelWidth,
    getBadge: (el) => el.customPanelWidthValue,
    getResetBtn: (el) => el.customPanelWidthResetBtn,
    defaultValue: DEFAULT_SETTINGS.customPanelWidth,
    normalize: normalizeCustomPanelWidth,
    format: (width) => `${width}px`,
    commitExtras: () => ({ customPanelWidthEnabled: true }),
    resetExtras: () => ({ customPanelWidthEnabled: false }),
    onPreview: () => {
      relayoutScriptHost();
    }
  },
  {
    kind: "toggle",
    key: "includeDateInFilename",
    getElement: (el) => el.includeDateInFilename,
    normalize: (val) => val !== false
  },
  {
    kind: "toggle",
    key: "enablePlayerAiQuickAction",
    getElement: (el) => el.enablePlayerAiQuickAction,
    normalize: (val) => Boolean(val)
  },
  {
    kind: "debounced-text",
    key: "playerAiQuickPrompt",
    getElement: (el) => el.playerAiQuickPrompt,
    normalize: normalizePlayerAiQuickPrompt
  },
  {
    kind: "toggle",
    key: "includeTimestampInBody",
    getElement: (el) => el.includeTimestampInBody,
    normalize: (val) => Boolean(val)
  },
  {
    kind: "toggle",
    key: "enableDebugLogs",
    getElement: (el) => el.enableDebugLogs,
    normalize: (val) => Boolean(val)
  },
  {
    kind: "toggle",
    key: "enableAgentBridge",
    getElement: (el) => el.enableAgentBridge,
    normalize: (val) => val === true,
    patchState: false,
    watchSync: true,
    onSaved: () => {
      void agentBridgeSettings?.refresh();
    }
  },
  {
    kind: "toggle",
    key: "cleanConversationsOlderThan30Days",
    getElement: (el) => el.cleanConversationsOlderThan30Days,
    normalize: (val) => val === true,
    onApply: async (val) => {
      if (val) {
        await cleanExpiredConversations();
      }
    }
  },
  {
    kind: "toggle",
    key: "autoOpenReader",
    getElement: (el) => el.autoOpenReader,
    normalize: (val) => val === true
  },
  {
    kind: "toggle",
    key: "enableExtraPlaybackRates",
    getElement: (el) => el.enableExtraPlaybackRates,
    normalize: (val) => Boolean(val)
  },
  {
    kind: "toggle",
    key: "chatInputGlow",
    getElement: (el) => el.chatInputGlow,
    normalize: normalizeChatInputGlow,
    onApply: () => {
      applyChatInputGlow();
    }
  },
  {
    kind: "debounced-text",
    key: "aiSystemPrompt",
    getElement: (el) => el.aiSystemPrompt,
    normalize: (val) => String(val || "").trim()
  },
  {
    kind: "toggle",
    key: "asrAutoFallback",
    getElement: (el) => el.asrAutoFallback,
    normalize: (val) => val !== false,
    patchState: false,
    watchSync: true,
    // 从配置类阻塞直达开关的启用路径：打开并落盘成功后，若底层 ASR 平台或 Key
    // 仍缺配置则进入对应 ASR 编辑器；否则回到原任务续跑。
    onSaved: (val) => {
      if (val && peekAsrSetupResumeToken() !== null && settingsHostRef) {
        void continueAsrSetupAfterToggleEnabled(collectElements(settingsHostRef));
      }
    }
  },
  {
    kind: "slider",
    key: "liveVoiceVolume",
    getElement: (el) => el.liveVoiceVolume,
    getBadge: (el) => el.liveVoiceVolumeValue,
    getResetBtn: (el) => el.liveVoiceVolumeResetBtn,
    defaultValue: DEFAULT_SETTINGS.liveVoiceVolume,
    normalize: normalizeLiveVoiceVolume,
    format: (val) => `${val}%`,
    patchState: false,
    watchSync: true,
    persist: persistLiveAudioField,
    onPreview: (val) => applyLiveAudioSettings({ liveVoiceVolume: val })
  },
  {
    kind: "slider",
    key: "liveVoiceSpeed",
    getElement: (el) => el.liveVoiceSpeed,
    getBadge: (el) => el.liveVoiceSpeedValue,
    getResetBtn: (el) => el.liveVoiceSpeedResetBtn,
    defaultValue: DEFAULT_SETTINGS.liveVoiceSpeed,
    normalize: (value) => normalizeLiveVoiceSpeed(typeof value === "string" ? Number(value) : value),
    format: (val) => `${val}×`,
    patchState: false,
    watchSync: true,
    persist: persistLiveAudioField,
    onPreview: (val) => applyLiveAudioSettings({ liveVoiceSpeed: val })
  },
  {
    kind: "toggle",
    key: "liveShareVideoAudio",
    getElement: (el) => el.liveShareVideoAudio,
    normalize: normalizeLiveShareVideoAudio,
    patchState: false,
    watchSync: true,
    persist: persistLiveAudioField
  },
  {
    kind: "toggle",
    key: "liveVoicePriority",
    getElement: (el) => el.liveVoicePriority,
    normalize: normalizeLiveVoicePriority,
    patchState: false,
    watchSync: true,
    persist: persistLiveAudioField
  },
  {
    kind: "toggle",
    key: "liveLowBandwidth",
    getElement: (el) => el.liveLowBandwidth,
    normalize: (val) => val === true,
    patchState: false,
    watchSync: true
  },
  {
    kind: "toggle",
    key: "allowPaidSearchProviders",
    getElement: (el) => el.allowPaidSearchProviders,
    normalize: (val) => val === true,
    patchState: false,
    watchSync: true
  },
  {
    kind: "slider",
    key: "webSearchMaxToolCalls",
    getElement: (el) => el.webSearchMaxToolCalls,
    getBadge: (el) => el.webSearchMaxToolCallsValue,
    getResetBtn: (el) => el.webSearchMaxToolCallsResetBtn,
    defaultValue: DEFAULT_SETTINGS.webSearchMaxToolCalls,
    normalize: normalizeWebSearchMaxToolCalls,
    patchState: false,
    watchSync: true
  }
];

function hydrateScalarField(binding: ScalarFieldBinding, elements: SettingsElements, rawValue: unknown): void {
  switch (binding.kind) {
    case "select": {
      const el = binding.getElement(elements);
      setCustomSelectValue(el, binding.normalize(rawValue));
      initCustomSelect(el, "custom-select-wrapper");
      break;
    }
    case "toggle": {
      const el = binding.getElement(elements);
      el.checked = binding.normalize(rawValue);
      syncToggleSwitch(el);
      break;
    }
    case "slider": {
      setResettableRangeValue(binding.getElement(elements), rawValue);
      break;
    }
    case "debounced-text": {
      binding.getElement(elements).value = String(rawValue || "");
      break;
    }
  }
}

// ===== 对外入口 =====

// 渲染设置面板（renderReaderPanels 打开抽屉时调用）：模板只建一次，数据每次
// 打开都重新装载。首建分支等设置分区样式表 onload 就绪再渲染，避免首帧闪变。
export function renderReaderSettingsPanel(): Promise<void> {
  const host = document.getElementById(ids.readingSettingsHost);
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
      const shouldRestoreBackFocus = document.activeElement?.id === ids.readingSettingsBackBtn;
      host.innerHTML = buildSettingsHtml();
      applySectionContainment(host);
      bindSettingsEvents(host);
      if (shouldRestoreBackFocus) {
        document.getElementById(ids.readingSettingsBackBtn)?.focus({ preventScroll: true });
      }
      host.dataset.biliscriptSettingsRendered = "1";
      await loadSettings(collectElements(host));
      const pendingTarget = pendingSettingsTarget;
      pendingSettingsTarget = null;
      if (pendingTarget) void openSettingsTarget(pendingTarget);
    })().finally(() => {
      if (renderSettingsPromise === promise) {
        renderSettingsPromise = null;
        renderSettingsHost = null;
      }
    });
    renderSettingsPromise = promise;
    return promise;
  }
  return loadSettings(collectElements(host));
}

export function openLiveSettings(target: LiveSettingsTarget): Promise<void> {
  return openSettingsTarget(target);
}

export function openAppearanceSettings(): Promise<void> {
  return openSettingsTarget("appearance");
}

async function openSettingsTarget(target: LiveSettingsTarget | "appearance"): Promise<void> {
  const host = settingsHostRef ?? document.getElementById(ids.readingSettingsHost);
  if (!host) return;
  pendingSettingsTarget = target;
  if (!host.dataset.biliscriptSettingsRendered) {
    await renderReaderSettingsPanel();
    return;
  }
  pendingSettingsTarget = null;
  const section = target === "appearance" ? "appearance" : target === "live" ? "live" : "llm";
  host.querySelector<HTMLButtonElement>(`.biliscript-settings-nav-item[data-section="${section}"]`)?.click();
  const sectionHeading = target === "appearance"
    ? host.querySelector<HTMLElement>(`#${SETTINGS_PANEL_DOM_IDS.chatPreferencesHeading}`)
    : host.querySelector<HTMLElement>(`.biliscript-set-group[data-settings-section="${section}"] .biliscript-set-h`);
  if (target === "appearance") {
    const scrollTarget = sectionHeading?.closest<HTMLElement>("[data-settings-subgroup]") ?? sectionHeading;
    scrollTarget?.scrollIntoView({ behavior: "auto", block: "start" });
  }
  sectionHeading?.setAttribute("tabindex", "-1");
  sectionHeading?.focus({ preventScroll: true });
  if (target !== "gemini-key") return;
  await providerHost?.openLinkedCredentialEditor("gemini-live");
}

// ===== 概览首配直达入口 =====

// 首配编辑会话回调：保存成功后与编辑器会话结束时的装配方出口（消费/作废续跑
// 意图、退出设置抽屉），由 reader 装配根注入。
export interface AiSetupSession {
  onAfterSave(): void;
  onSessionEnd(): void;
}

// 概览配置类错误（无平台 / 缺 Key / 无模型）的「去设置」直达：
// - "no-provider"：无记录 → 直接新增 AI 平台编辑器（保存并继续语义）；
// - "missing-key"：定位缺 Key 的启用记录 → 直接编辑该记录并聚焦 Key 输入框；
//   定位不到（缺失 / 禁用 / 无需 Key）则结束会话并在状态栏提示；
// - "no-model"：定位可编辑的启用 AI 平台并聚焦模型配置区。
export interface AiSetupTarget {
  // 缺 Key / 缺模型时调用方已知的已选平台记录：优先直达该记录；缺省按解析策略定位。
  providerId?: string;
  setupContextBanner?: string | null;
  focusField?: "apiKey" | "models";
}

export async function openReaderAiSetup(
  errorClass: OverviewSetupErrorClass,
  session: AiSetupSession,
  target: AiSetupTarget = {}
): Promise<void> {
  openReaderSettingsMode();
  await renderReaderSettingsPanel();
  focusSettingsNavSection("llm");
  const host = settingsHostRef ?? document.getElementById(ids.readingSettingsHost);
  const defaultBanner =
    errorClass === "missing-key"
      ? target.focusField === "models"
        ? "请至少添加一个可用模型后保存继续"
        : "请补充 API Key 后保存继续"
      : errorClass === "no-model"
        ? "请至少添加一个可用模型后保存继续"
        : "保存可用 AI 平台后将自动返回继续";
  const setupContextBanner =
    target.setupContextBanner !== undefined ? target.setupContextBanner : defaultBanner;

  if (errorClass === "missing-key") {
    const record = await findMissingKeyAiProvider(target.providerId);
    if (!record) {
      session?.onSessionEnd?.();
      if (host) {
        setStatus(
          collectElements(host),
          "未找到需要补充 API Key 的启用 AI 平台，请检查平台启用状态或新增平台",
          true
        );
      }
      return;
    }
    await providerHost?.openEditor({
      kind: "ai",
      providerId: String(record.id || ""),
      setupSession: session,
      setupContextBanner,
      initialFocusField: target.focusField === "models" ? "models" : "apiKey"
    });
    return;
  }

  if (errorClass === "no-model") {
    const resolvedId = String(target.providerId || "").trim() || (await resolveEditableAiProviderId());
    const providers = await loadAiProviders();
    const record = resolvedId
      ? providers.find((p) => p && p.enabled !== false && String(p.id || "") === resolvedId) || null
      : null;
    if (!record) {
      session?.onSessionEnd?.();
      if (host) {
        setStatus(collectElements(host), "未找到可用的 AI 平台，请先添加并启用平台", true);
      }
      return;
    }
    await providerHost?.openEditor({
      kind: "ai",
      providerId: String(record.id || ""),
      setupSession: session,
      setupContextBanner,
      initialFocusField: "models"
    });
    return;
  }

  await providerHost?.openEditor({
    kind: "ai",
    providerId: "",
    setupSession: session,
    setupContextBanner
  });
}

// ===== ASR 配置类阻塞直达入口 =====

// 配置完成后的续跑（开关落盘 / 编辑器保存共用）：取走一次性令牌并校验——
// 令牌缺失、换视频或换分 P（页面身份键失配）都不续跑；
// 已在飞或字幕在手由 kick 的在手/在飞判定让位，通过后重新进入既有字幕抓取链。
export function resumeAsrSubtitleFetchAfterSetup(): boolean {
  const token = consumeAsrSetupResumeToken();
  if (!token) {
    return false;
  }
  if (token.videoKey !== currentPageVideoKey()) {
    return false;
  }
  void kickSubtitleFetch(() => requestSubtitleRefresh(), {
    skipIfInHandOrInFlight: true,
    awaitRefresh: false,
    onChainLoadFailed: (error) => logWarn("[BILISCRIPT] asr setup resume (summarize chain load) failed", { error }),
    onRefreshFailed: (error) => logWarn("[BILISCRIPT] asr setup resume refresh failed", { error })
  });
  return true;
}

async function continueAsrSetupAfterToggleEnabled(elements: SettingsElements): Promise<void> {
  const token = peekAsrSetupResumeToken();
  if (!token) return;
  if (token.videoKey !== currentPageVideoKey()) {
    consumeAsrSetupResumeToken();
    closeReaderSettingsMode({ restoreFocus: true });
    return;
  }
  const [settings, providers] = await Promise.all([getSettings(), loadAsrProviders()]);
  const setupState = resolveAsrSetupState({
    asrAutoFallback: true,
    activeAsrProviderId: settings.activeAsrProviderId,
    providers
  });
  if (!setupState.needsProviderSetup) {
    if (resumeAsrSubtitleFetchAfterSetup()) {
      closeReaderSettingsMode({ restoreFocus: true });
    }
    return;
  }
  setAsrSetupResumeToken({ videoKey: token.videoKey, kind: setupState.providerStatus });
  const isMissingKey = setupState.providerStatus === "missing-key";
  const targetId = isMissingKey ? setupState.targetProviderId : "";
  const banner = isMissingKey
    ? "请补充语音转写 API Key 后保存继续"
    : "保存可用语音转写平台后将自动返回继续";
  setStatus(
    elements,
    isMissingKey
      ? "已开启自动转写，请补充语音转写 API Key 后保存继续"
      : "已开启自动转写，请添加语音转写平台后保存继续"
  );
  await providerHost?.openEditor({
    kind: "asr",
    providerId: targetId,
    setupSession: {
      onAfterSave: () => {
        resumeAsrSubtitleFetchAfterSetup();
        closeReaderSettingsMode({ restoreFocus: true });
      },
      onSessionEnd: () => invalidateReaderSetupFlows("asr")
    },
    setupContextBanner: banner,
    ...(isMissingKey ? { initialFocusField: "apiKey" as const } : {})
  });
}

/**
 * ASR 配置类阻塞的「前往设置」直达（字幕空态 / 概览空态 / 对话拦截共用）：
 * 点击时刻重新读实时设置与平台列表；打开前记录一次性续跑令牌，
 * 保存成功或开关落盘成功后回到原任务续跑，取消编辑或关闭抽屉作废令牌。
 */
export async function openReaderAsrSetup(): Promise<void> {
  openReaderSettingsMode();
  await renderReaderSettingsPanel();
  await whenReaderSettingsStylesReady();
  const host = settingsHostRef ?? document.getElementById(ids.readingSettingsHost);
  if (!host) {
    return;
  }
  const elements = collectElements(host);
  const [settings, providers] = await Promise.all([getSettings(), loadAsrProviders()]);
  const setupState = resolveAsrSetupState({
    asrAutoFallback: settings.asrAutoFallback,
    activeAsrProviderId: settings.activeAsrProviderId,
    providers
  });
  focusSettingsNavSection("asr");
  setAsrSetupResumeToken({ videoKey: currentPageVideoKey(), kind: setupState.kind });
  if (!setupState.asrAutoFallback) {
    setStatus(
      elements,
      setupState.blockedByBoth
        ? "请先开启「无字幕时自动生成字幕」，随后补充语音转写平台配置"
        : "请先开启「无字幕时自动生成字幕」以自动转写视频语音"
    );
    elements.asrAutoFallback?.focus();
    return;
  }
  const banner =
    setupState.kind === "no-provider"
      ? "保存可用语音转写平台后将自动返回继续"
      : setupState.kind === "missing-key"
        ? "请补充语音转写 API Key 后保存继续"
        : "确认语音转写平台配置后保存继续";
  const isMissingKey = setupState.kind === "missing-key";
  await providerHost?.openEditor({
    kind: "asr",
    providerId: setupState.providerId,
    setupSession: {
      onAfterSave: () => {
        resumeAsrSubtitleFetchAfterSetup();
        closeReaderSettingsMode({ restoreFocus: true });
      },
      onSessionEnd: () => invalidateReaderSetupFlows("asr")
    },
    setupContextBanner: banner,
    ...(isMissingKey ? { initialFocusField: "apiKey" as const } : {})
  });
}

// 设置分区定位（面板未首建完成时 best-effort 跳过——编辑 Modal 才是该流程焦点）。
function focusSettingsNavSection(section: string): void {
  const host = settingsHostRef;
  if (!host || !host.dataset.biliscriptSettingsRendered) return;
  host
    .querySelector<HTMLButtonElement>(`.biliscript-settings-nav-item[data-section="${section}"]`)
    ?.click();
}

async function loadAiProviders(): Promise<ProviderRowItem[]> {
  if (providerHost) return providerHost.loadRows("ai");
  try {
    const resp = await sendRuntimeMessage({ type: "ai-providers-list" });
    return resp?.ok && Array.isArray(resp.providers) ? resp.providers : [];
  } catch {
    return [];
  }
}

async function loadAsrProviders(): Promise<ProviderRowItem[]> {
  if (providerHost) return providerHost.loadRows("asr");
  try {
    const resp = await sendRuntimeMessage({ type: "asr-providers-list" });
    return resp?.ok && Array.isArray(resp.providers) ? resp.providers : [];
  } catch {
    return [];
  }
}

/**
 * 缺模型错误进入设置时定位要编辑的启用 AI 平台 id（defaultModel 优先，否则首个启用平台）。
 */
export async function resolveEditableAiProviderId(): Promise<string> {
  try {
    const [providers, settings] = await Promise.all([loadAiProviders(), getSettings()]);
    const enabled = providers.filter(
      (item) => Boolean(item) && item.enabled !== false && String(item.id || "").trim() !== ""
    );
    if (!enabled.length) {
      return "";
    }
    const preferredId = String(settings?.defaultModel || "").trim();
    const matched = preferredId ? enabled.find((item) => String(item.id) === preferredId) : null;
    return String((matched || enabled[0]).id || "").trim();
  } catch {
    return "";
  }
}

// 缺 Key 记录定位（resolve-ai-provider 解析策略的镜像：调用方给定的已选平台 →
// defaultModel 精确匹配 → 首个启用回落）：只对 requiresKey !== false 且未存 Key 的
// 启用记录给编辑入口。调用方给定记录时直达它——若已缺失/禁用/无需 Key 则返回 null。
async function findMissingKeyAiProvider(preferredProviderId = ""): Promise<ProviderRowItem | null> {
  const providers = await loadAiProviders();
  const enabled = providers.filter(
    (p) => p && p.enabled !== false && String(p?.id || "").trim() !== ""
  );
  if (!enabled.length) {
    return null;
  }
  const exactId = String(preferredProviderId || "").trim();
  if (exactId) {
    const exact = enabled.find((p) => String(p.id) === exactId);
    return exact && exact.requiresKey !== false ? exact : null;
  }
  const settings = await getSettings();
  const preferredId = String(settings?.defaultModel || "").trim();
  const candidates = [
    ...(preferredId ? enabled.filter((p) => String(p.id) === preferredId) : []),
    ...enabled
  ];
  return candidates.find((p) => p.requiresKey !== false && !p.hasSavedKey) || null;
}

// ===== 装载与保存 =====

function setStatus(elements: SettingsElements, text: unknown, isError = false): void {
  elements.status.textContent = String(text || "");
  elements.status.dataset.error = isError ? "true" : "false";
}

interface ProviderModelSelectGroup {
  provider: ProviderRowItem;
  providerId: string;
  label: string;
  models: string[];
}

function buildEnabledModelSelectGroups(aiProviders: ProviderRowItem[]): ProviderModelSelectGroup[] {
  return (aiProviders || [])
    .filter((p) => p && p.enabled !== false && String(p.id || "").trim() !== "")
    .map((provider) => ({
      provider,
      providerId: String(provider.id || ""),
      label: String(provider.name || provider.model || "自定义").trim() || "自定义",
      models: normalizeProviderModels(provider)
    }))
    .filter((g) => g.models.length > 0);
}

function renderGroupedModelOptionsHtml(
  groups: ProviderModelSelectGroup[],
  leadingEmptyOptionLabel: string
): string {
  const leading = leadingEmptyOptionLabel ? `<option value="">${escapeHtml(leadingEmptyOptionLabel)}</option>` : "";
  return (
    leading +
    groups
      .map((group) => {
        const optionsHtml = group.models
          .map((model) => {
            const val = buildModelOptionValue(group.providerId, model);
            return `<option value="${escapeHtml(val)}">${escapeHtml(model)}</option>`;
          })
          .join("");
        return `<optgroup label="${escapeHtml(group.label)}">${optionsHtml}</optgroup>`;
      })
      .join("")
  );
}

function renderAiDefaultModelOptions(
  selectEl: HTMLSelectElement | null,
  aiProviders: ProviderRowItem[],
  currentProviderId?: unknown,
  currentModel?: unknown
): void {
  if (!selectEl) return;
  const groups = buildEnabledModelSelectGroups(aiProviders);
  if (!groups.length) {
    selectEl.innerHTML = '<option value="">暂无可用模型</option>';
    selectEl.value = "";
    selectEl.disabled = true;
    rebuildCustomSelectOptions(selectEl);
    setCustomSelectValue(selectEl, "");
    initCustomSelect(selectEl, "custom-select-wrapper");
    setCustomSelectState(selectEl, { disabled: true });
    return;
  }

  selectEl.disabled = false;
  selectEl.innerHTML = renderGroupedModelOptionsHtml(groups, "");

  const preferredProviderId = String(currentProviderId || "").trim();
  const preferredModel = String(currentModel || "").trim();
  const matchedGroup = preferredProviderId
    ? groups.find((g) => g.providerId === preferredProviderId) || groups[0]
    : groups[0];
  const resolvedModel = resolveCatalogModel(matchedGroup.provider, matchedGroup.providerId === preferredProviderId ? preferredModel : "");
  const selectedValue = buildModelOptionValue(matchedGroup.providerId, resolvedModel);
  selectEl.value = selectedValue;
  rebuildCustomSelectOptions(selectEl);
  setCustomSelectValue(selectEl, selectedValue);
  initCustomSelect(selectEl, "custom-select-wrapper");
  setCustomSelectState(selectEl, { disabled: false });
}

function renderSubtitleTranslateModelOptions(
  selectEl: HTMLSelectElement | null,
  aiProviders: ProviderRowItem[],
  currentProviderId?: unknown,
  currentModel?: unknown
): void {
  if (!selectEl) return;
  const preferredProviderId = String(currentProviderId || "").trim();
  const preferredModel = String(currentModel || "").trim();
  const groups = buildEnabledModelSelectGroups(aiProviders);
  selectEl.innerHTML = renderGroupedModelOptionsHtml(groups, "跟随 AI 默认平台");

  let selectedValue = "";
  if (preferredProviderId && preferredModel) {
    const targetVal = buildModelOptionValue(preferredProviderId, preferredModel);
    selectEl.value = targetVal;
    if (selectEl.value === targetVal) {
      selectedValue = targetVal;
    } else {
      selectEl.value = "";
    }
  } else {
    selectEl.value = "";
  }
  rebuildCustomSelectOptions(selectEl);
  setCustomSelectValue(selectEl, selectedValue);
  initCustomSelect(selectEl, "custom-select-wrapper");
}

// ===== 生效投影刷新 =====
// 概览/解释缺省摘要、默认行模型副行与字幕跟随提示共用一次刷新：
// 数据全部来自 ai/active-model-projection.ts（与真实请求同一解析链），本函数
// 只做展示落盘。任何失败静默——投影是展示增强，不阻断设置面板主链。
async function refreshAiActiveProjection(
  elements: SettingsElements,
  _knownProviders?: ProviderRowItem[]
): Promise<void> {
  try {
    const [projection, subtitleFollow] = await Promise.all([
      resolveAiActiveModelProjection(),
      resolveSubtitleFollowProjection()
    ]);
    elements.aiActiveDefaultSummary.textContent = formatAiDefaultSummaryLine(projection);
    elements.aiActiveDefaultSummary.dataset.state =
      projection.state === "unavailable"
        ? "unavailable"
        : projection.isFallback
          ? "fallback"
          : "active";
    syncAiDefaultModelLine(
      elements.aiProvidersList,
      projection.state === "ok" ? String(projection.provider.id || "") : "",
      projection.state === "ok" ? projection.model : ""
    );
    const followHint = formatSubtitleFollowHint(subtitleFollow);
    const followHintNode = elements.subtitleTranslateFollowHint;
    followHintNode.textContent = followHint;
    followHintNode.dataset.state = subtitleFollowHintState(subtitleFollow);
    // 选了专属模型时副行无话可说：控件值本身就是答案
    elements.subtitleTranslateFollowHint.hidden =
      !followHint || (elements.subtitleTranslateModel?.value || "") !== "";
  } catch {
    // 投影刷新失败保留上一帧展示，不打扰设置主链
  }
}

async function loadSettings(elements: SettingsElements): Promise<void> {
  const settings = await getSettings();

  for (const binding of SCALAR_FIELD_BINDINGS) {
    hydrateScalarField(binding, elements, settings[binding.key]);
  }
  agentBridgeSettings?.sync(settings);
  renderInitialQuickPromptInputs(elements, settings.aiInitialQuickPrompts);

  await providerHost?.load(settings);
  await syncLiveVoiceFallbackHint(elements);
}

// 音色回退提示（仅一次）：信箱内容在读取时清除，重开设置不再重复出现。
async function syncLiveVoiceFallbackHint(elements: SettingsElements): Promise<void> {
  const notice = await takeLiveVoiceFallbackNotice();
  const hint = elements.liveVoiceFallbackHint;
  if (!hint) return;
  hint.textContent = notice ? LIVE_VOICE_FALLBACK_NOTICE_TEXT : "";
  hint.hidden = !notice;
}

function renderInitialQuickPromptInputs(elements: SettingsElements, value: unknown): void {
  // 留空 = 按视频内容自动生成（见 chat/quick-prompts.ts 的三档取用）：空数组
  // 是合法值，输入位就留空。
  const prompts = Array.isArray(value) ? value : [];
  elements.aiInitialQuickPrompts.forEach((input, index) => {
    input.value = String(prompts[index] || "");
  });
}

function collectInitialQuickPrompts(elements: SettingsElements): string[] {
  return Array.from(elements.aiInitialQuickPrompts || [])
    .map((input) => String(input.value || "").trim())
    .filter(Boolean)
    .slice(0, MAX_INITIAL_QUICK_PROMPTS);
}

function setBusy(elements: SettingsElements, isBusy: boolean): void {
  elements.resetBtn.disabled = isBusy;
  elements.resetBtn.textContent = isBusy ? "处理中..." : "恢复默认偏好";
}

// 偏好重置的默认值载荷：本面板管理的偏好键面（save-settings 按键面白名单落盘，
// aiProviders/asrProviders/密钥不在 settings 键面，天然不受影响）。defaultModel
// 与 ASR 标量（activeAsrProviderId / asrAutoFallback / asrLanguage）是平台域配置，
// 不参与重置。aiBtnDefaultOnMigrated 是安装/更新迁移旗标，readerThemeUserSet 是
// 用户手动改过主题的一次性哨兵，webSearchMaxToolCalls 是搜索上限平台配置，均不参与重置。
function buildDefaultPreferencePayload() {
  return {
    downloadFormat: DEFAULT_SETTINGS.downloadFormat,
    includeDateInFilename: DEFAULT_SETTINGS.includeDateInFilename,
    enablePlayerAiQuickAction: DEFAULT_SETTINGS.enablePlayerAiQuickAction,
    playerAiQuickPrompt: DEFAULT_PLAYER_AI_QUICK_PROMPT,
    includeTimestampInBody: DEFAULT_SETTINGS.includeTimestampInBody,
    enableDebugLogs: DEFAULT_SETTINGS.enableDebugLogs,
    enableAgentBridge: DEFAULT_SETTINGS.enableAgentBridge,
    readerTheme: DEFAULT_SETTINGS.readerTheme,
    readerPalette: DEFAULT_SETTINGS.readerPalette,
    readerFontSizeScale: DEFAULT_SETTINGS.readerFontSizeScale,
    chatLineHeight: DEFAULT_SETTINGS.chatLineHeight,
    chatParagraphSpacing: DEFAULT_SETTINGS.chatParagraphSpacing,
    speechVoiceVolume: DEFAULT_SETTINGS.speechVoiceVolume,
    liveVoiceVolume: DEFAULT_SETTINGS.liveVoiceVolume,
    liveVoiceSpeed: DEFAULT_SETTINGS.liveVoiceSpeed,
    liveShareVideoAudio: DEFAULT_SETTINGS.liveShareVideoAudio,
    liveVoicePriority: DEFAULT_SETTINGS.liveVoicePriority,
    aiSystemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
    aiInitialQuickPrompts: [],
    bilingualSubtitles: DEFAULT_SETTINGS.bilingualSubtitles,
    secondarySubtitleLang: DEFAULT_SETTINGS.secondarySubtitleLang,
    customPanelWidthEnabled: DEFAULT_SETTINGS.customPanelWidthEnabled,
    customPanelWidth: DEFAULT_SETTINGS.customPanelWidth,
    autoOpenReader: DEFAULT_SETTINGS.autoOpenReader,
    enableExtraPlaybackRates: DEFAULT_SETTINGS.enableExtraPlaybackRates,
    chatInputGlow: DEFAULT_SETTINGS.chatInputGlow
  };
}

// 恢复默认偏好：面板内确认弹层通过后，把本面板的偏好键面一次性写回默认值，随后重载表单。
async function resetPreferences(elements: SettingsElements): Promise<void> {
  if (!(await confirmDialog({
    message: "确定要把偏好设置恢复默认值吗？AI 平台、密钥与语音转写配置不受影响。",
    confirmText: "恢复默认",
    danger: true
  }))) {
    return;
  }
  setBusy(elements, true);
  try {
    const payload = buildDefaultPreferencePayload();
    const resp = await sendRuntimeMessage({ type: "save-settings", settings: payload });
    if (!resp?.ok) {
      setStatus(elements, resp?.error || "重置失败", true);
      return;
    }
    state.patchSettings(payload);
    applyReadingViewTypography();
    applyLiveAudioSettings({
      liveVoiceVolume: payload.liveVoiceVolume,
      liveVoiceSpeed: payload.liveVoiceSpeed,
      liveShareVideoAudio: payload.liveShareVideoAudio,
      liveVoicePriority: payload.liveVoicePriority
    });
    await loadSettings(elements);
    setStatus(elements, "已恢复默认设置");
  } catch (error) {
    setStatus(elements, (error as Error).message || "重置失败", true);
  } finally {
    setBusy(elements, false);
  }
}

let statusClearTimer: ReturnType<typeof setTimeout> | null = null;

async function saveSettingField(
  elements: SettingsElements,
  patch: Record<string, unknown>,
  persist?: ScalarFieldPersist
): Promise<boolean> {
  try {
    const resp = persist
      ? await persist(patch)
      : await sendRuntimeMessage({ type: "save-settings", settings: patch });
    if (!resp?.ok) {
      setStatus(elements, resp?.error || "保存失败", true);
      return false;
    }
    setStatus(elements, "已保存");
    if (statusClearTimer) {
      clearTimeout(statusClearTimer);
    }
    statusClearTimer = setTimeout(() => {
      if (elements.status.dataset.error !== "true" && elements.status.textContent === "已保存") {
        setStatus(elements, "");
      }
    }, 1500);
    return true;
  } catch (error) {
    setStatus(elements, (error as Error).message || "保存失败", true);
    return false;
  }
}

function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delayMs: number
): T & { cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: unknown[] | null = null;
  const debounced = ((...args: unknown[]) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      lastArgs = null;
      fn(...args);
    }, delayMs);
  }) as T & { cancel: () => void; flush: () => void };

  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      lastArgs = null;
    }
  };
  debounced.flush = () => {
    if (timer && lastArgs) {
      clearTimeout(timer);
      timer = null;
      const args = lastArgs;
      lastArgs = null;
      fn(...args);
    }
  };
  return debounced;
}

// ===== 事件绑定（模板渲染后一次性接线） =====

function bindSettingsNav(host: HTMLElement): void {
  const nav = host.querySelector<HTMLElement>(`#${SETTINGS_PANEL_DOM_IDS.settingsNav}`);
  if (!nav) return;

  const navItems = Array.from(nav.querySelectorAll<HTMLButtonElement>(".biliscript-settings-nav-item"));
  const groups = Array.from(host.querySelectorAll<HTMLElement>(".biliscript-set-group[data-settings-section]"));

  // 横向滚动条按需现身：静止态导航底部不留第二条线，指针进入导航条或正在横向滚动时
  // 才显形。显隐只能切类——Chromium 不刷新 scrollbar 伪元素上由宿主 :hover 触发的样式。
  const hasOverflow = (): boolean => nav.scrollWidth - nav.clientWidth > 1;
  const setScrollbarVisible = (visible: boolean): void => {
    nav.classList.toggle("is-scrollbar-visible", visible);
  };
  let scrollbarHideTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelScrollbarHide = (): void => {
    if (scrollbarHideTimer) {
      clearTimeout(scrollbarHideTimer);
      scrollbarHideTimer = null;
    }
  };
  const scheduleScrollbarHide = (delayMs: number): void => {
    cancelScrollbarHide();
    scrollbarHideTimer = setTimeout(() => {
      scrollbarHideTimer = null;
      setScrollbarVisible(false);
    }, delayMs);
  };

  nav.addEventListener("pointerenter", () => {
    if (!hasOverflow()) return;
    cancelScrollbarHide();
    setScrollbarVisible(true);
  });
  nav.addEventListener("pointerleave", () => {
    if (hasOverflow()) scheduleScrollbarHide(360);
  });
  nav.addEventListener(
    "scroll",
    () => {
      if (!hasOverflow()) {
        setScrollbarVisible(false);
        return;
      }
      setScrollbarVisible(true);
      scheduleScrollbarHide(900);
    },
    { passive: true }
  );
  if (typeof ResizeObserver !== "undefined") {
    // 面板宽度或字号变化后可能从可滚变成放得下，残留的拇指要收掉。
    new ResizeObserver(() => {
      if (hasOverflow()) return;
      cancelScrollbarHide();
      setScrollbarVisible(false);
    }).observe(nav);
  }

  function setActive(sectionKey: string): void {
    let activeBtn: HTMLButtonElement | null = null;
    navItems.forEach((btn) => {
      const match = btn.dataset.section === sectionKey;
      btn.classList.toggle("is-active", match);
      if (match) activeBtn = btn;
    });
    if (activeBtn && typeof (activeBtn as HTMLElement).scrollIntoView === "function") {
      (activeBtn as HTMLElement).scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  }

  let userClickLock = false;
  let clickLockTimer: ReturnType<typeof setTimeout> | null = null;

  nav.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(".biliscript-settings-nav-item");
    if (!btn) return;
    const sectionKey = btn.dataset.section;
    if (!sectionKey) return;
    const target = host.querySelector<HTMLElement>(`.biliscript-set-group[data-settings-section="${sectionKey}"]`);
    if (target) {
      userClickLock = true;
      setActive(sectionKey);
      if (typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      if (clickLockTimer) clearTimeout(clickLockTimer);
      clickLockTimer = setTimeout(() => {
        userClickLock = false;
      }, 600);
    }
  });

  if (typeof IntersectionObserver === "undefined") {
    return;
  }

  const scrollContainer = host.closest<HTMLElement>("#biliscript-reading-settings-panel") ?? host.parentElement;
  if (!scrollContainer) return;

  const intersectingKeys = new Map<HTMLElement, number>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        if (entry.isIntersecting) {
          intersectingKeys.set(target, entry.boundingClientRect.top);
        } else {
          intersectingKeys.delete(target);
        }
      }
      if (userClickLock || intersectingKeys.size === 0) return;

      let topmostEl: HTMLElement | null = null;
      let minTop = Infinity;
      for (const el of intersectingKeys.keys()) {
        const rectTop = el.getBoundingClientRect().top;
        if (rectTop < minTop) {
          minTop = rectTop;
          topmostEl = el;
        }
      }
      if (topmostEl?.dataset.settingsSection) {
        setActive(topmostEl.dataset.settingsSection);
      }
    },
    {
      root: scrollContainer,
      rootMargin: "-44px 0px -40% 0px",
      threshold: 0
    }
  );

  groups.forEach((group) => observer.observe(group));
}

function bindScalarFieldEvents(binding: ScalarFieldBinding, elements: SettingsElements): void {
  switch (binding.kind) {
    case "select": {
      const el = binding.getElement(elements);
      el.addEventListener("change", () => {
        const val = binding.normalize(el.value);
        if (binding.patchState !== false) {
          state.patchSettings({ [binding.key]: val });
        }
        binding.onApply?.(val);
        void saveSettingField(elements, { [binding.key]: val });
      });
      break;
    }
    case "toggle": {
      const el = binding.getElement(elements);
      initToggleSwitch(el);
      el.addEventListener("change", () => {
        const val = el.checked;
        if (binding.patchState !== false) {
          state.patchSettings({ [binding.key]: val });
        }
        binding.onApply?.(val);
        void saveSettingField(elements, { [binding.key]: val }, binding.persist).then((ok) => {
          if (ok) binding.onSaved?.(val);
        });
      });
      break;
    }
    case "slider": {
      bindResettableRangeSlider({
        input: binding.getElement(elements),
        badge: binding.getBadge(elements),
        resetBtn: binding.getResetBtn(elements),
        defaultValue: binding.defaultValue,
        normalize: binding.normalize,
        format: binding.format,
        onPreview: (val) => {
          if (binding.patchState !== false) {
            state.patchSettings({ [binding.key]: val, ...(binding.commitExtras?.() ?? {}) });
          }
          binding.onPreview?.(val);
        },
        onCommit: (val) => {
          void saveSettingField(
            elements,
            { [binding.key]: val, ...(binding.commitExtras?.() ?? {}) },
            binding.persist
          );
        },
        onReset: binding.resetExtras
          ? (val) => {
              const patch = { [binding.key]: val, ...binding.resetExtras!() };
              if (binding.patchState !== false) {
                state.patchSettings(patch);
              }
              void saveSettingField(elements, patch, binding.persist);
            }
          : undefined
      });
      break;
    }
    case "debounced-text": {
      const el = binding.getElement(elements);
      const save = () => {
        const val = binding.normalize(el.value);
        if (binding.patchState !== false) {
          state.patchSettings({ [binding.key]: val });
        }
        void saveSettingField(elements, { [binding.key]: val });
      };
      const debouncedSave = debounce(save, 400);
      el.addEventListener("input", debouncedSave);
      el.addEventListener("blur", () => debouncedSave.flush());
      break;
    }
  }
}

function bindSettingsEvents(host: HTMLElement): void {
  const elements = collectElements(host);
  bindSettingsNav(host);

  elements.backBtn?.addEventListener("click", () => {
    closeReaderSettingsMode();
  });

  for (const binding of SCALAR_FIELD_BINDINGS) {
    bindScalarFieldEvents(binding, elements);
  }

  agentBridgeSettings = bindAgentBridgeSettings(host, elements, (text, isError) => setStatus(elements, text, isError));

  const saveInitialQuickPrompts = () => {
    const prompts = collectInitialQuickPrompts(elements);
    state.patchSettings({ aiInitialQuickPrompts: prompts });
    void saveSettingField(elements, { aiInitialQuickPrompts: prompts });
  };
  const debouncedSaveInitialQuickPrompts = debounce(saveInitialQuickPrompts, 400);
  elements.aiInitialQuickPrompts.forEach((input) => {
    input.addEventListener("input", debouncedSaveInitialQuickPrompts);
    input.addEventListener("blur", () => debouncedSaveInitialQuickPrompts.flush());
  });

  providerHost?.dispose();
  providerHost = createProviderSettingsHost({
    host,
    mountedFamilies: ["ai", "live", "asr", "search"],
    onStatus: (message, isError) => setStatus(elements, message, isError),
    canRestoreConsumerEditor: () => !document.getElementById(ids.readingSettingsPanel)?.hidden,
    onAiChanged: (providers, { settings: known }) => {
      if (known) {
        renderAiDefaultModelOptions(
          elements.aiDefaultModel,
          providers,
          known.defaultModel,
          known.defaultAiModel
        );
        renderSubtitleTranslateModelOptions(
          elements.subtitleTranslateModel,
          providers,
          known.subtitleTranslateProviderId,
          known.subtitleTranslateModel
        );
        void refreshAiActiveProjection(elements, providers);
        return;
      }
      void refreshAiActiveProjection(elements, providers);
      void getSettings().then((s) => {
        renderAiDefaultModelOptions(
          elements.aiDefaultModel,
          providers,
          s.defaultModel,
          s.defaultAiModel
        );
        renderSubtitleTranslateModelOptions(
          elements.subtitleTranslateModel,
          providers,
          s.subtitleTranslateProviderId,
          s.subtitleTranslateModel
        );
      });
    }
  });

  elements.aiDefaultModel?.addEventListener("change", () => {
    const val = elements.aiDefaultModel?.value || "";
    const { providerId, model } = parseModelOptionValue(val);
    if (!providerId || !model) return;
    const prevProviderId = String(state.settings?.defaultModel || "").trim();
    const prevModel = String(state.settings?.defaultAiModel || "").trim();
    state.patchSettings({ defaultModel: providerId, defaultAiModel: model });
    providerHost?.syncDefaultAiProvider(providerId);
    void saveSettingField(elements, {
      defaultModel: providerId,
      defaultAiModel: model
    }).then((saved) => {
      if (!saved) {
        state.patchSettings({ defaultModel: prevProviderId, defaultAiModel: prevModel });
        providerHost?.syncDefaultAiProvider(prevProviderId);
        void loadAiProviders().then((providers) => {
          renderAiDefaultModelOptions(elements.aiDefaultModel, providers, prevProviderId, prevModel);
        });
        return;
      }
      void refreshAiActiveProjection(elements);
    });
  });

  elements.subtitleTranslateModel?.addEventListener("change", () => {
    const val = elements.subtitleTranslateModel?.value || "";
    const { providerId, model } = parseModelOptionValue(val);
    void saveSettingField(elements, {
      subtitleTranslateProviderId: providerId,
      subtitleTranslateModel: model
    }).then((saved) => {
      // 副行只在跟随默认平台时有话可说：切换后按新配置重算，不展示陈旧目标
      if (saved) void refreshAiActiveProjection(elements);
    });
  });

  elements.resetBtn?.addEventListener("click", () => void resetPreferences(elements));

  // onChanged 回读他端改动（逐键按需存在性判空，避免单键变更时访问未变更键的 newValue 抛错）。
  const watchedSyncBindings = SCALAR_FIELD_BINDINGS.filter((binding) => binding.watchSync);
  watchStorageKeys(
    (changes) => {
      for (const binding of watchedSyncBindings) {
        const change = changes[binding.key];
        if (change) hydrateScalarField(binding, elements, change.newValue);
      }
      if (changes.agentBridgeUrl) agentBridgeSettings?.updateUrl(changes.agentBridgeUrl.newValue);
      if (changes.enableAgentBridge) void agentBridgeSettings?.refresh();
      if (changes.subtitleTranslateProviderId || changes.subtitleTranslateModel) {
        void Promise.all([loadAiProviders(), getSettings()]).then(([providers, settings]) => {
          renderSubtitleTranslateModelOptions(
            elements.subtitleTranslateModel,
            providers,
            settings.subtitleTranslateProviderId,
            settings.subtitleTranslateModel
          );
        });
      }
    },
    {
      sync: [
        ...watchedSyncBindings.map((binding) => binding.key),
        "agentBridgeUrl",
        "subtitleTranslateProviderId",
        "subtitleTranslateModel"
      ]
    }
  );

  // 生效投影跨端同步：默认平台/模型记录、平台列表/密钥存储任一变更时重算一次投影。
  watchStorageKeys(
    (changes) => {
      const currentElements = collectElements(host);
      if (changes.defaultModel && typeof changes.defaultModel.newValue === "string") {
        providerHost?.syncDefaultAiProvider(changes.defaultModel.newValue);
      }
      if (changes.defaultModel || changes.defaultAiModel || changes[AI_PROVIDERS_STORAGE]) {
        void Promise.all([loadAiProviders(), getSettings()]).then(([providers, settings]) => {
          renderAiDefaultModelOptions(
            currentElements.aiDefaultModel,
            providers,
            settings.defaultModel,
            settings.defaultAiModel
          );
        });
      }
      void refreshAiActiveProjection(currentElements);
    },
    {
      sync: ["defaultModel", "defaultAiModel", AI_PROVIDERS_STORAGE, AI_PROVIDER_KEYS_STORAGE]
    }
  );
}
