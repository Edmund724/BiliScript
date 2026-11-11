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
import { PRESETS, ASR_PROVIDER_PRESETS } from "../core/presets.js";
import type { AiProviderPreset, AsrProviderPreset } from "../core/presets.js";
import {
  normalizeDownloadFormat,
  normalizePlayerAiQuickPrompt,
  normalizeReaderPalette,
  normalizeChatInputGlow,
  normalizeWebSearchMaxToolCalls,
  normalizeCustomPanelWidth,
  normalizeReaderFontSizeScale,
} from "../core/validators.js";
import { applyReadingViewTypography, applyChatInputGlow, applyReadingViewPresentation } from "../reader/presentation.js";
import { state } from "../core/state.js";
import { relayoutScriptHost } from "../reader/script-host.js";
import { closeReaderSettingsMode, openReaderSettingsMode } from "../reader/settings-mode.js";
import type { OverviewSetupErrorClass } from "../core/overview-setup-error.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { getSettings } from "../core/runtime.js";
import { buildSettingsHtml, SETTINGS_PANEL_DOM_IDS, type SettingsPanelDomId } from "./settings-panel-html.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { confirmDialog, isConfirmDialogOpen } from "./confirm-dialog.js";
import { isProviderEditorOpen } from "./provider-editor.js";
import { cleanExpiredConversations } from "../chat/conversation-store.js";
import { initCustomSelect, rebuildCustomSelectOptions, setCustomSelectValue } from "./custom-select.js";
import { escapeHtml } from "../shared/string-utils.js";
import { buildModelOptionValue, parseModelOptionValue, SELECTED_PROVIDER_KEY } from "../shared/selected-provider.js";
import {
  readChatSelectedModel,
  resolveAiActiveModelProjection,
  resolveSubtitleFollowProjection,
  type AiActiveModelProjection
} from "../ai/active-model-projection.js";
import {
  formatAiDefaultSummaryLine,
  formatChatSelectionLine,
  formatSubtitleFollowHint,
  syncAiDefaultBadge
} from "./ai-active-projection.js";
import { AI_PROVIDERS_STORAGE, AI_PROVIDER_KEYS_STORAGE } from "../core/ai-provider-store.js";
import { initToggleSwitch, syncToggleSwitch } from "./toggle-switch.js";
import { bindResettableRangeSlider, setResettableRangeValue } from "./range-slider.js";
import { createProviderFamilyRows, PROVIDER_FAMILY_ROWS } from "./provider-family.js";
import type { ProviderRowItem, ProviderRowPreset } from "./provider-row.js";
import { resolveActiveAsrProviderId } from "../asr/asr-provider-normalize.js";
// ASR 配置类阻塞的设置目标解析（票 04）：无记录 / 缺 Key / 开关关闭三态。
import { resolveAsrSetupPlan } from "../asr/asr-setup.js";
// ASR 配置续跑（票 04）：页面内存一次性意图 + 续跑后重新进入既有字幕抓取链。
import {
  clearAsrSetupResumeIntent,
  consumeAsrSetupResumeIntent,
  currentPageVideoKey,
  setAsrSetupResumeIntent
} from "../reader/asr-setup-resume.js";
import { requestSubtitleRefresh } from "../reader/reader-bus.js";
import { kickSubtitleFetch } from "../subtitle/kick-subtitle-fetch.js";
import { logWarn } from "../shared/logging.js";
import { LIVE_PROVIDER_PRESETS, resolveActiveLiveProviderId } from "../live/live-provider-store.js";
import {
  LIVE_VOICE_FALLBACK_NOTICE_TEXT,
  takeLiveVoiceFallbackNotice
} from "../live/live-voice-fallback-notice.js";
import { wireProviderRowDrag } from "./provider-row-drag.js";
import { SEARCH_PROVIDER_PRESETS } from "../core/presets.js";
import { isSmartSearchActive } from "../core/search-mode.js";
// 跨族凭据引用四态（GLOSSARY「凭据引用」「官方端点判定」）：搜索侧 DeepSeek 与
// 伴看侧 Gemini Live 行副行状态文案统一经 core/ai-credential-reference 注入。
import { annotateAiCredentialRows } from "../core/ai-credential-reference.js";
// 消费族凭据同层往返编排（票 07/08）：伴看 Gemini Live 与搜索 DeepSeek 的编辑器
// 内联凭据行 + 暂存/恢复原草稿共用同一份编排。
import {
  enterAiCredentialEditor,
  linkedCredentialFor,
  resolveAiCredentialPlan,
  stashEditorDraft,
  type AiCredentialLinkTarget,
  type AiEditorStash
} from "./ai-credential-link.js";
import type { EditorDraft, EditorDraftView } from "./provider-editor-state.js";
// 顺序规则（归一 + 排序键）单源在零依赖叶 search/search-order.js：
// 本模块不直接 import search-chain（避免把 search-executor → 六适配器拖进设置抽屉的懒 chunk）。
import { normalizeSearchProviderOrder, providerOrderRank } from "../search/search-order.js";
import { SEARCH_PROVIDER_ORDER_STORAGE } from "../search/search-provider-store.js";
import type { ProviderEditorKind } from "./provider-editor.js";
import {
  requestProviderOriginsViaBackground,
  revokeOrphanOrigin,
  permissionRevokeErrorMessage
} from "../core/host-permissions.js";
import { createProviderTransactions, loadOriginSharingProviders } from "./provider-transaction.js";
import { ids } from "../reader/state.js";
import type { LiveSettingsTarget } from "../live/fullscreen-live-overlay.js";
import {
  ensureReaderSettingsStyles,
  whenReaderSettingsStylesReady
} from "../shared/style-injector.js";

ensureReaderSettingsStyles();

let aiPresets: AiProviderPreset[] = [];
let asrPresets: AsrProviderPreset[] = [];

// 设置抽屉宿主引用：单平台保存后的列表重渲需要按 id 重取 elements——renderReaderSettingsPanel 挂载时赋值。
let settingsHostRef: HTMLElement | null = null;
let pendingLiveSettingsTarget: LiveSettingsTarget | null = null;
let navSyncRef: { updateActiveIndicator: (smooth?: boolean) => void } | null = null;

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
    agentBridgeInstall: byIdIn<HTMLElement>(dom.agentBridgeInstall),
    copyAgentBridgeInstallBtn: byIdIn<HTMLButtonElement>(dom.copyAgentBridgeInstallBtn),
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
    aiChatSelectionSummary: byIdIn<HTMLElement>(dom.aiChatSelectionSummary),
    subtitleTranslateFollowHint: byIdIn<HTMLElement>(dom.subtitleTranslateFollowHint),
    resetBtn: byIdIn<HTMLButtonElement>(dom.resetBtn),
    status: byIdIn<HTMLElement>(dom.status)
  };
}

type SettingsElements = ReturnType<typeof collectElements>;
type NavSync = { updateActiveIndicator: (smooth?: boolean) => void };

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
  readonly onApply?: (val: Settings[K] & string, navSync: NavSync) => void;
}

interface ToggleFieldBinding<K extends KnownSettingKey = KnownSettingKey> {
  readonly kind: "toggle";
  readonly key: K;
  readonly getElement: (elements: SettingsElements) => HTMLInputElement;
  readonly normalize: (value: unknown) => boolean;
  readonly patchState?: boolean;
  readonly watchSync?: boolean;
  readonly onApply?: (val: boolean, navSync: NavSync) => void;
  // 落盘成功后的生效回调（票 04：自动转写开关打开并保存成功后重新进入字幕抓取）。
  // 只有写盘成功才调用——onApply 在保存前触发，失败时也会跑，不能承担续跑。
  readonly onSaved?: (val: boolean, navSync: NavSync) => void;
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
  // 滑块提交/预览时随主键一并 patch 与落盘的附加键（如宽度滑块置位
  // customPanelWidthEnabled 显式自定义标记）。
  readonly commitExtras?: () => Record<string, unknown>;
  // 重置键的附加清除键：提供后重置走完整替代路径（主键回默认值 + 附加键 +
  // patch + 落盘），替代默认的「主键默认值 + onCommit」。
  readonly resetExtras?: () => Record<string, unknown>;
  readonly onPreview?: (val: number, navSync: NavSync) => void;
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
    onPreview: (_val, navSync) => {
      applyReadingViewTypography();
      navSync.updateActiveIndicator(false);
    }
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
    onPreview: (_width, navSync) => {
      relayoutScriptHost();
      navSync.updateActiveIndicator(false);
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
    onApply: (val) => syncAgentBridgeInstall(val)
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
    // 票 04：从配置类阻塞直达开关的启用路径——打开并落盘成功后回到原任务，
    // 重新进入既有字幕抓取链（无待续跑意图时续跑是空操作，普通开关切换无副作用）。
    onSaved: (val) => {
      if (val && resumeAsrSubtitleFetchAfterSetup()) {
        closeReaderSettingsMode({ restoreFocus: true });
      }
    }
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
export function renderReaderSettingsPanel(): void {
  const host = document.getElementById(ids.readingSettingsHost);
  if (!host) {
    return;
  }
  settingsHostRef = host;
  if (!host.dataset.biliscriptSettingsRendered) {
    void (async () => {
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
      void loadSettings(collectElements(host));
      const pendingTarget = pendingLiveSettingsTarget;
      pendingLiveSettingsTarget = null;
      if (pendingTarget) void openLiveSettings(pendingTarget);
    })();
    return;
  }
  void loadSettings(collectElements(host));
}

export async function openLiveSettings(target: LiveSettingsTarget): Promise<void> {
  const host = settingsHostRef ?? document.getElementById(ids.readingSettingsHost);
  if (!host) return;
  pendingLiveSettingsTarget = target;
  if (!host.dataset.biliscriptSettingsRendered) {
    renderReaderSettingsPanel();
    return;
  }
  pendingLiveSettingsTarget = null;
  const section = target === "live" ? "live" : "llm";
  host.querySelector<HTMLButtonElement>(`.biliscript-settings-nav-item[data-section="${section}"]`)?.click();
  const sectionHeading = host.querySelector<HTMLElement>(`.biliscript-set-group[data-settings-section="${section}"] .biliscript-set-h`);
  sectionHeading?.setAttribute("tabindex", "-1");
  sectionHeading?.focus({ preventScroll: true });
  if (target === "live") return;
  // target === "gemini-key"：四态直达凭据编辑器——无记录 / 非官方地址新建官方
  // Gemini 记录（不静默改写中转地址），缺 Key / 可用编辑实际引用记录并聚焦 Key；
  // 经横幅/会话故障直达，无伴看草稿可恢复，保存 / 取消即停在本编辑器
  const providers = await PROVIDER_FAMILY_UI.ai.loadProviders();
  await enterAiCredentialEditor({
    target: "gemini-live",
    plan: resolveAiCredentialPlan("gemini-live", providers),
    aiPresets: aiPresets,
    onSave: providerTransactions.upsertProvider,
    onDelete: providerTransactions.deleteProvider
  });
}

// ===== 概览首配直达入口（票 provider-onboarding-consistency/01）=====

// 首配编辑会话回调：保存成功后与编辑器会话结束时的装配方出口（消费/作废续跑
// 意图、退出设置抽屉），由 reader 装配根注入。
export interface AiSetupSession {
  onAfterSave(): void;
  onSessionEnd(): void;
}

// 概览配置类错误（无平台 / 缺 Key）的「去设置」直达：
// - "no-provider"：无记录 → 直接新增 AI 平台编辑器（保存并继续语义）；
// - "missing-key"：定位缺 Key 的启用记录 → 直接编辑该记录并聚焦 Key 输入框；
//   定位不到（列表在报错后已被改动）则只打开设置抽屉。
// 连通性测试不是必经步骤：保存只做本地校验 + 落盘。
export interface AiSetupTarget {
  // 缺 Key 时调用方已知的已选平台记录（AI 对话回合错误，票 03）：优先直达该
  // 记录；缺省按解析策略定位（概览 / 解释链，票 01/02）。
  providerId?: string;
}

export async function openReaderAiSetup(
  errorClass: OverviewSetupErrorClass,
  session: AiSetupSession,
  target: AiSetupTarget = {}
): Promise<void> {
  openReaderSettingsMode();
  renderReaderSettingsPanel();
  focusSettingsNavSection("llm");
  if (errorClass === "missing-key") {
    const record = await findMissingKeyAiProvider(target.providerId);
    if (record) {
      await openProviderEditorById("ai", String(record.id || ""), undefined, session);
      document.querySelector<HTMLInputElement>(".provider-editor-apikey")?.focus();
    }
    return;
  }
  await openProviderEditorById("ai", "", undefined, session);
}

// ===== ASR 配置类阻塞直达入口（票 provider-onboarding-consistency/04）=====

// 配置完成后的续跑（开关落盘 / 编辑器保存共用）：取走一次性意图并校验——
// 意图缺失（已消费 / 已取消）、换视频或换分 P（页面身份键失配）都不续跑；
// 已在飞或字幕在手（别的抓取已接手）由 kick 的在手/在飞判定让位，不另起一轮。
// 通过后重新进入既有字幕抓取链：refreshClip → 无字幕出口 → ASR 转写 → 字幕
// 接受事务，不建第二条转写管线；浮空发起，保存链路不被整轮转写挂住。
export function resumeAsrSubtitleFetchAfterSetup(): boolean {
  const intent = consumeAsrSetupResumeIntent();
  if (!intent) {
    return false;
  }
  if (intent.videoKey !== currentPageVideoKey()) {
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

/**
 * ASR 配置类阻塞的「前往设置」直达（字幕空态 / 概览空态 / 对话拦截共用）：
 * - 自动转写关闭：打开设置抽屉并定位开关（启用路径），不代用户改设置；
 * - 无 ASR 记录：直接打开新增编辑器；
 * - 激活记录缺 Key：打开该记录的编辑器并聚焦 Key；
 * - 其余配置类（域名未授权 / 模型不可用 / Key 失效）：打开激活记录的编辑器。
 * 点击时刻重新读实时设置与平台列表（跨端设置变化后按新配置解析）；打开前记录
 * 一次性续跑意图（页面内存单槽），保存成功或开关落盘成功后回到原任务续跑，
 * 取消编辑 / 关闭抽屉作废意图。
 */
export async function openReaderAsrSetup(): Promise<void> {
  openReaderSettingsMode();
  renderReaderSettingsPanel();
  // 首建分支要等样式表就绪才写 DOM：等同一就绪 promise（内部那次 await 先注册、
  // 先于本处继续），随后的分区定位与开关聚焦才有宿主可寻。
  await whenReaderSettingsStylesReady();
  const host = settingsHostRef ?? document.getElementById(ids.readingSettingsHost);
  if (!host) {
    return;
  }
  const [settings, providers] = await Promise.all([getSettings(), loadAsrProviders()]);
  const plan = resolveAsrSetupPlan({
    asrAutoFallback: settings.asrAutoFallback,
    activeAsrProviderId: settings.activeAsrProviderId,
    providers
  });
  focusSettingsNavSection("asr");
  setAsrSetupResumeIntent({ videoKey: currentPageVideoKey(), kind: plan.kind });
  if (plan.kind === "disabled") {
    host.querySelector<HTMLElement>(`#${SETTINGS_PANEL_DOM_IDS.asrAutoFallback}`)?.focus();
    return;
  }
  await openProviderEditorById("asr", plan.providerId, undefined, {
    onAfterSave: () => {
      // 先续跑（消费意图）再退出设置抽屉：抽屉关闭的意图清除落到已消费的空槽。
      resumeAsrSubtitleFetchAfterSetup();
      closeReaderSettingsMode({ restoreFocus: true });
    },
    onSessionEnd: () => clearAsrSetupResumeIntent()
  });
  if (plan.kind === "missing-key") {
    document.querySelector<HTMLInputElement>(".provider-editor-apikey")?.focus();
  }
}

// 设置分区定位（面板未首建完成时 best-effort 跳过——编辑 Modal 才是该流程焦点）。
function focusSettingsNavSection(section: string): void {
  const host = settingsHostRef;
  if (!host || !host.dataset.biliscriptSettingsRendered) return;
  host
    .querySelector<HTMLButtonElement>(`.biliscript-settings-nav-item[data-section="${section}"]`)
    ?.click();
}

// 缺 Key 记录定位（resolve-ai-provider 解析策略的镜像：调用方给定的已选平台 →
// defaultModel 精确匹配 → 首个启用回落）：只对 requiresKey !== false 且未存 Key 的
// 启用记录给编辑入口。调用方给定记录时直达它——那是本回合实际请求的平台（票 03：
// AI 对话缺 Key 回合），列表后续改动也不改变这条结论。
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
    if (exact) {
      return exact;
    }
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

async function loadAiPresets(): Promise<void> {
  try {
    const resp = await sendRuntimeMessage({ type: "ai-presets-list" });
    if (resp?.ok && Array.isArray(resp.presets)) {
      aiPresets = resp.presets;
      return;
    }
  } catch {
    // fallback to built-in list when background is unreachable
  }
  aiPresets = PRESETS.slice();
}

async function loadAsrPresets(): Promise<void> {
  try {
    const resp = await sendRuntimeMessage({ type: "asr-presets-list" });
    if (resp?.ok && Array.isArray(resp.presets)) {
      asrPresets = resp.presets;
      return;
    }
  } catch {
    // fallback to built-in list when background is unreachable
  }
  asrPresets = ASR_PROVIDER_PRESETS.slice();
}

let presetsLoaded = false;

async function ensurePresetsLoaded(): Promise<void> {
  if (presetsLoaded) {
    return;
  }
  await Promise.all([loadAiPresets(), loadAsrPresets()]);
  presetsLoaded = true;
}

function setStatus(elements: SettingsElements, text: unknown, isError = false): void {
  elements.status.textContent = String(text || "");
  elements.status.dataset.error = isError ? "true" : "false";
}

function syncAgentBridgeInstall(enabled: boolean): void {
  const install = settingsHostRef?.querySelector<HTMLElement>(`#${SETTINGS_PANEL_DOM_IDS.agentBridgeInstall}`);
  if (install) install.hidden = !enabled;
}

function normalizeProviderModels(provider: { models?: unknown; model?: unknown }): string[] {
  if (Array.isArray(provider?.models)) {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entry of provider.models) {
      const id = String(entry ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
    return result;
  }
  const legacy = String(provider?.model || "").trim();
  return legacy ? [legacy] : [];
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

  const groups = (aiProviders || [])
    .filter((p) => p && p.enabled !== false && String(p.id || "").trim() !== "")
    .map((provider) => ({
      provider,
      models: normalizeProviderModels(provider)
    }))
    .filter((g) => g.models.length > 0);

  let html = '<option value="">跟随 AI 默认平台</option>';
  for (const group of groups) {
    const providerId = String(group.provider.id || "");
    const providerLabel = String(group.provider.name || group.provider.model || "自定义").trim() || "自定义";
    const optionsHtml = group.models
      .map((model) => {
        const val = buildModelOptionValue(providerId, model);
        return `<option value="${escapeHtml(val)}">${escapeHtml(model)}</option>`;
      })
      .join("");
    html += `<optgroup label="${escapeHtml(providerLabel)}">${optionsHtml}</optgroup>`;
  }
  selectEl.innerHTML = html;

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

// ===== 生效投影刷新（票 05）=====
// 概览/解释缺省摘要、对话另选提示、默认行徽标与字幕跟随提示共用一次刷新：
// 数据全部来自 ai/active-model-projection.ts（与真实请求同一解析链），本函数
// 只做展示落盘。任何失败静默——投影是展示增强，不阻断设置面板主链。
// providers 为调用方已查到的列表（loadSettings / AI 族重渲路径直接复用，不再
// 多发一轮 ai-providers-list）；缺省（跨端 storage 刷新路径）才现查。
async function refreshAiActiveProjection(
  elements: SettingsElements,
  knownProviders?: ProviderRowItem[]
): Promise<void> {
  try {
    const [projection, subtitleFollow, providers] = await Promise.all([
      resolveAiActiveModelProjection(),
      resolveSubtitleFollowProjection(),
      knownProviders ? Promise.resolve(knownProviders) : loadAiProviders()
    ]);
    elements.aiActiveDefaultSummary.textContent = formatAiDefaultSummaryLine(projection);
    syncAiDefaultBadge(
      elements.aiProvidersList,
      projection.state === "ok" ? String(projection.provider.id || "") : "",
      projection.state === "ok" ? projection.model : ""
    );
    const chatLine = formatChatSelectionLine(await resolveChatOverride(projection, providers));
    elements.aiChatSelectionSummary.hidden = !chatLine;
    elements.aiChatSelectionSummary.textContent = chatLine;
    const followHint = formatSubtitleFollowHint(subtitleFollow);
    elements.subtitleTranslateFollowHint.hidden = !followHint;
    elements.subtitleTranslateFollowHint.textContent = followHint;
  } catch {
    // 投影刷新失败保留上一帧展示，不打扰设置主链
  }
}

// 对话另选判定：对话 tab 的 storage 选中项解析到「启用平台 + 目录内模型」，且
// 与生效投影不同（平台或模型任一不同）才算另选——选中项悬空 / 指向禁用平台时
// 对话自己会回落，不算另选。名称解析与翻译模型下拉的标签口径一致。
async function resolveChatOverride(
  projection: AiActiveModelProjection,
  providers: ProviderRowItem[]
): Promise<{ providerId: string; name: string; model: string } | null> {
  if (projection.state !== "ok") return null;
  const selected = await readChatSelectedModel();
  const selectedProviderId = String(selected.providerId || "").trim();
  const selectedModel = String(selected.model || "").trim();
  if (!selectedProviderId || !selectedModel) return null;
  if (
    selectedProviderId === String(projection.provider.id || "") &&
    selectedModel === projection.model
  ) {
    return null;
  }
  const provider = (providers || []).find((item) => String(item?.id || "") === selectedProviderId);
  if (!provider || provider.enabled === false) return null;
  if (!normalizeProviderModels(provider).includes(selectedModel)) return null;
  const name = String(provider.name || provider.model || "自定义").trim() || "自定义";
  return { providerId: selectedProviderId, name, model: selectedModel };
}

async function loadSettings(elements: SettingsElements): Promise<void> {
  await ensurePresetsLoaded();
  const settings = await getSettings();

  for (const binding of SCALAR_FIELD_BINDINGS) {
    hydrateScalarField(binding, elements, settings[binding.key]);
  }
  syncAgentBridgeInstall(settings.enableAgentBridge === true);
  renderInitialQuickPromptInputs(elements, settings.aiInitialQuickPrompts);

  // AI 配置
  const providers = await loadAiProviders();
  familyRows.ai.render(elements.aiProvidersList, elements.aiProvidersEmpty, providers, { presets: PRESETS });
  renderSubtitleTranslateModelOptions(
    elements.subtitleTranslateModel,
    providers,
    settings.subtitleTranslateProviderId,
    settings.subtitleTranslateModel
  );
  void refreshAiActiveProjection(elements, providers);

  // 实时伴看平台配置与 ASR 配置：列表非空时必有激活平台（为空或悬空自动回退首项并写回设置）
  const liveProviders = await loadLiveProviders();
  renderActiveRadioFamily(
    "live",
    elements,
    annotateAiCredentialRows("live", liveProviders, providers),
    settings.activeLiveProviderId
  );
  // 音色回退提示：会话侧写入的一次性信箱，读到即清（设置里只出现一次）
  await syncLiveVoiceFallbackHint(elements);

  const asrProviders = await loadAsrProviders();
  renderActiveRadioFamily("asr", elements, asrProviders, settings.activeAsrProviderId);

  // 搜索平台配置（预设是纯数据常量，直接 import，不设 presets-list 消息）
  const searchProviders = await loadSearchProviders();
  // 列表顺序 = 链序：先取用户拖拽序（归一后），再按「order 下标 > 内置默认序」
  // 排序渲染。DeepSeek 行副行 = 凭据引用四态文案与命中来源（AI 族列表在同一份 loadSettings 里已取到）。
  searchProviderOrder = await loadSearchProviderOrder(searchProviders);
  familyRows.search.render(
    elements.searchProvidersList,
    elements.searchProvidersEmpty,
    annotateAiCredentialRows("search", sortSearchProviders(searchProviders), providers),
    {
      presets: SEARCH_PROVIDER_PRESETS,
      activeId: settings.activeSearchProviderId || ""
    }
  );
  syncResetSearchOrderButton(elements);
  // 悬空链首提示：链首指向已不存在的记录时露条件提示行；用户改选或链首指向在场记录即隐藏。
  syncSearchDanglingHint(elements, String(settings.activeSearchProviderId || ""), searchProviders);
  syncSearchModeControls(elements);
  syncSearchChainActiveSummary(elements);
  navSyncRef?.updateActiveIndicator(false);
}

// 面板当前生效的用户拖拽顺序（记录 id 数组；空 = 无自定义顺序，按内置默认序渲染）。
// searchProviderOrder 与列表同侧（chrome.storage.sync）：面板直读直写，读失败 / 脏值
// 按无自定义顺序，写失败静默——顺序是偏好不是数据。
let searchProviderOrder: string[] = [];

async function loadSearchProviderOrder(providers: ProviderRowItem[]): Promise<string[]> {
  try {
    const stored = await chrome.storage.sync.get([SEARCH_PROVIDER_ORDER_STORAGE]);
    return normalizeSearchProviderOrder(
      stored?.[SEARCH_PROVIDER_ORDER_STORAGE],
      providers.map((provider) => String(provider?.id || ""))
    );
  } catch {
    return [];
  }
}

// 列表渲染顺序 = 链序：在 order 中的按数组下标排在先，不在数组中的排到其后、
// 相互之间按内置默认序。键算法单源在 search-order.js 的 providerOrderRank。
function sortSearchProviders(providers: ProviderRowItem[]): ProviderRowItem[] {
  return providers
    .map((provider) => ({
      provider,
      rank: providerOrderRank(
        String(provider?.id || ""),
        String(provider?.presetId || ""),
        searchProviderOrder
      )
    }))
    .sort((left, right) =>
      left.rank[0] !== right.rank[0] ? left.rank[0] - right.rank[0] : left.rank[1] - right.rank[1]
    )
    .map((entry) => entry.provider);
}

// 「恢复默认顺序」按钮态：无自定义顺序时禁用。
function syncResetSearchOrderButton(elements: SettingsElements): void {
  elements.resetSearchProviderOrderBtn.disabled = searchProviderOrder.length === 0;
}

function rerenderLiveProviders(
  elements: SettingsElements,
  providers: ProviderRowItem[],
  knownAiProviders?: readonly ProviderRowItem[]
): void {
  if (knownAiProviders) {
    renderActiveRadioFamily("live", elements, annotateAiCredentialRows("live", providers, knownAiProviders));
    return;
  }
  void loadAiProviders().then((aiProviders) => {
    renderActiveRadioFamily("live", elements, annotateAiCredentialRows("live", providers, aiProviders));
  });
}

// 列表重渲（保存 / 编辑 / 恢复默认顺序后）：顺序按当前生效的拖拽序，选中态从
// 行内 radio 现读。DeepSeek 行副行 = 凭据引用四态文案与命中来源（现查 AI 族列表）。

// 摘要与模式控件同步（票 06）：折叠摘要让读者无需展开即可判断「智能回退 / 单平台
// 调用、失败是否回退、是否可能付费」；展开体内只留对当前模式有效的控件。
//
// 摘要取值以 DOM 选中态为准（行 radio 现读）：智能模式按列表顺序回退，单平台模式
// 只用它且失败不回退。已删除 / 不可用的旧单选 id 没有任何行选中（悬空按空处理走
// 智能链，spec §6.8），现读后自然落到智能文案，不再误报单个平台。
const SMART_SUMMARY_BASE = "智能搜索 · 失败自动回退";
const SINGLE_MODE_NOTE =
  "已单选平台：只使用选中的平台搜索，失败不会切换到其他平台。";
const SMART_MODE_NOTE =
  "智能搜索：按下方列表顺序依次尝试，失败自动回退到下一个平台；拖动行可调整顺序。";

// 当前模式（DOM 真值）：单平台返回选中行元素，否则（智能 / 悬空 / 未选）返回 null。
function resolveSelectedSearchRow(elements: SettingsElements): HTMLElement | null {
  const checked = elements.searchProvidersList?.querySelector<HTMLInputElement>(
    ".search-provider-active-radio:checked"
  );
  const row = checked?.closest(".search-provider-row") as HTMLElement | null;
  if (!row || isSmartSearchActive(row.dataset.providerId || "")) return null;
  return row;
}

function isPaidSearchRow(row: HTMLElement): boolean {
  const presetId = row.dataset.currentPresetId || "";
  return SEARCH_PROVIDER_PRESETS.some((preset) => preset.id === presetId && preset.access === "paid");
}

function syncSearchChainActiveSummary(elements: SettingsElements): void {
  const summaryEl = elements.searchChainActiveSummary;
  if (!summaryEl) return;
  const row = resolveSelectedSearchRow(elements);
  if (!row) {
    // 智能（含悬空旧 id 的实际行为）：付费准入开时才提示可能产生付费。
    const paidAdmitted = elements.allowPaidSearchProviders?.checked === true;
    summaryEl.textContent = paidAdmitted ? `${SMART_SUMMARY_BASE} · 可能使用付费平台` : SMART_SUMMARY_BASE;
    return;
  }
  const name = row.querySelector(".provider-row-name")?.textContent?.trim() || "所选平台";
  summaryEl.textContent = `仅使用 ${name} · 失败不回退${isPaidSearchRow(row) ? " · 可能付费" : ""}`;
}

// 模式控件显隐：智能模式 = 有序回退说明 + 拖拽 + 恢复默认 + 付费准入；单平台模式
// 隐藏这些对单选无效的控件（把手经 search-chain-single-mode 类隐藏，样式在
// reader-settings-rows.css），说明行改口「失败不回退」——关键后果不只存在于悬停。
function syncSearchModeControls(elements: SettingsElements): void {
  const single = resolveSelectedSearchRow(elements) !== null;
  const note = elements.searchChainContainer?.querySelector<HTMLElement>(".search-chain-mode-note");
  if (note) note.textContent = single ? SINGLE_MODE_NOTE : SMART_MODE_NOTE;
  const footer = elements.searchChainContainer?.querySelector<HTMLElement>(".search-chain-footer-bar");
  if (footer) footer.hidden = single;
  const paidRow = elements.allowPaidSearchProviders?.closest<HTMLElement>(".biliscript-toggle-row");
  if (paidRow) paidRow.hidden = single;
  elements.searchProvidersList?.classList.toggle("search-chain-single-mode", single);
}

function rerenderSearchProviders(
  elements: SettingsElements,
  providers: ProviderRowItem[],
  knownAiProviders?: readonly ProviderRowItem[]
): void {
  const render = (aiProviders: readonly ProviderRowItem[]) => {
    familyRows.search.render(
      elements.searchProvidersList,
      elements.searchProvidersEmpty,
      annotateAiCredentialRows("search", sortSearchProviders(providers), aiProviders),
      {
        presets: SEARCH_PROVIDER_PRESETS,
        activeId: getActiveSearchProviderId(elements.searchProvidersList)
      }
    );
    syncResetSearchOrderButton(elements);
    syncSearchModeControls(elements);
    syncSearchChainActiveSummary(elements);
  };
  if (knownAiProviders) {
    render(knownAiProviders);
    return;
  }
  void loadAiProviders().then(render);
}

// 悬空链首提示行的显隐：activeSearchProviderId 指向不存在记录才出现。
// 哨兵不算悬空：选中「智能」不得误露「原选用平台已不可用」。
function syncSearchDanglingHint(
  elements: SettingsElements,
  activeSearchProviderId: string,
  providers: ProviderRowItem[]
): void {
  const hint = elements.searchProvidersDanglingHint;
  if (!hint) return;
  const activeId = activeSearchProviderId.trim();
  hint.hidden =
    !activeId ||
    isSmartSearchActive(activeId) ||
    providers.some((provider) => String(provider?.id || "") === activeId);
}

// 族无关的整列表现查：失败 / 形状坏一律回空数组（编辑 Modal 打开前用）。
async function loadProviderRows(request: () => Promise<ProviderListResponse>): Promise<ProviderRowItem[]> {
  try {
    const resp = await request();
    if (!resp?.ok) return [];
    return Array.isArray(resp.providers) ? resp.providers : [];
  } catch {
    return [];
  }
}

function loadAiProviders(): Promise<ProviderRowItem[]> {
  return loadProviderRows(() => sendRuntimeMessage({ type: "ai-providers-list" }));
}

function loadAsrProviders(): Promise<ProviderRowItem[]> {
  return loadProviderRows(() => sendRuntimeMessage({ type: "asr-providers-list" }));
}

function loadSearchProviders(): Promise<ProviderRowItem[]> {
  return loadProviderRows(() => sendRuntimeMessage({ type: "search-providers-list" }));
}

function loadLiveProviders(): Promise<ProviderRowItem[]> {
  return loadProviderRows(() => sendRuntimeMessage({ type: "live-providers-list" }));
}

// 音色回退提示（仅一次）：信箱内容在读取时清除，重开设置不再重复出现。
async function syncLiveVoiceFallbackHint(elements: SettingsElements): Promise<void> {
  const notice = await takeLiveVoiceFallbackNotice();
  const hint = elements.liveVoiceFallbackHint;
  if (!hint) return;
  hint.textContent = notice ? LIVE_VOICE_FALLBACK_NOTICE_TEXT : "";
  hint.hidden = !notice;
}

// ===== provider 各族分派表 =====

type ProviderListResponse = {
  ok: boolean;
  providers?: ProviderRowItem[];
  error?: string;
};

// 族 → 设置面板分派表。各族在本面板的分派点（整列表消息、新平台 id
// 生成、现查列表、预设装载、列表重渲、optional host 权限策略）同构，Record 全键覆盖。
// 各族的消息 type 写在本族箭头函数体内、保持单字面量以保留 ResponseOf 推断。
interface ProviderFamilyUi {
  list: () => Promise<ProviderListResponse>;
  loadProviders: () => Promise<ProviderRowItem[]>;
  save: (providers: ProviderRowItem[]) => Promise<ProviderListResponse>;
  remove: (providerId: string) => Promise<ProviderListResponse>;
  generateId: () => string;
  presets: () => readonly ProviderRowPreset[];
  rerender: (elements: SettingsElements, providers: ProviderRowItem[]) => void;
  optionalHostPermission: boolean;
}

// 单选激活族（activeRadio 非空且无智能哨兵：live / asr）的共享重渲与删除回退：
// 保持「列表非空即有激活平台」不变量，原激活项仍在列表则保留，为空或已删则回退到首项并同步落盘。
type ActiveRadioFamilyKind = "live" | "asr";

interface ActiveRadioFamilySpec {
  readonly settingsKey: "activeLiveProviderId" | "activeAsrProviderId";
  readonly getListNode: (elements: SettingsElements) => HTMLElement;
  readonly getEmptyNode: (elements: SettingsElements) => HTMLElement;
  readonly getPresets: () => readonly ProviderRowPreset[];
  readonly resolveActiveId: (
    providers: ReadonlyArray<{ id?: string | null }>,
    activeId?: string | null
  ) => string;
}

const ACTIVE_RADIO_FAMILY_SPEC: Record<ActiveRadioFamilyKind, ActiveRadioFamilySpec> = {
  live: {
    settingsKey: "activeLiveProviderId",
    getListNode: (el) => el.liveProvidersList,
    getEmptyNode: (el) => el.liveProvidersEmpty,
    getPresets: () => LIVE_PROVIDER_PRESETS,
    resolveActiveId: resolveActiveLiveProviderId
  },
  asr: {
    settingsKey: "activeAsrProviderId",
    getListNode: (el) => el.asrProvidersList,
    getEmptyNode: (el) => el.asrProvidersEmpty,
    getPresets: () => asrPresets,
    resolveActiveId: resolveActiveAsrProviderId
  }
};

function renderActiveRadioFamily(
  kind: ActiveRadioFamilyKind,
  elements: SettingsElements,
  providers: ProviderRowItem[],
  rawActiveId?: string
): void {
  const spec = ACTIVE_RADIO_FAMILY_SPEC[kind];
  const listNode = spec.getListNode(elements);
  const prevActiveId =
    rawActiveId !== undefined
      ? String(rawActiveId || "").trim()
      : familyRows[kind].getActiveId?.(listNode) || "";
  const nextActiveId = spec.resolveActiveId(providers, prevActiveId);
  familyRows[kind].render(listNode, spec.getEmptyNode(elements), providers, {
    presets: spec.getPresets(),
    activeId: nextActiveId
  });
  if (nextActiveId !== prevActiveId) {
    state.patchSettings({ [spec.settingsKey]: nextActiveId });
    void sendRuntimeMessage({ type: "save-settings", settings: { [spec.settingsKey]: nextActiveId } });
  }
}

function bindActiveRadioDeleteHandler(kind: ActiveRadioFamilyKind, elements: SettingsElements): void {
  const spec = ACTIVE_RADIO_FAMILY_SPEC[kind];
  const decl = PROVIDER_FAMILY_ROWS[kind];
  const radioClass = `${decl.activeRadio!.classPrefix}-provider-active-radio`;
  familyRows[kind].controller.setDeleteHandler(async () => {
    const listNode = spec.getListNode(elements);
    const remainingRows = Array.from(listNode.querySelectorAll<HTMLElement>(`.${decl.rowClass}`));
    const currentCheckedId = familyRows[kind].getActiveId?.(listNode) || "";
    const nextActiveId = spec.resolveActiveId(
      remainingRows.map((row) => ({ id: row.dataset.providerId || "" })),
      currentCheckedId
    );
    if (nextActiveId && nextActiveId !== currentCheckedId) {
      const targetRadio = remainingRows
        .find((row) => row.dataset.providerId === nextActiveId)
        ?.querySelector<HTMLInputElement>(`.${radioClass}`);
      if (targetRadio) targetRadio.checked = true;
    }
    if (nextActiveId !== currentCheckedId || remainingRows.length === 0) {
      state.patchSettings({ [spec.settingsKey]: nextActiveId });
      await sendRuntimeMessage({ type: "save-settings", settings: { [spec.settingsKey]: nextActiveId } });
    }
  });
}

const PROVIDER_FAMILY_UI: Record<ProviderEditorKind, ProviderFamilyUi> = {
  live: {
    list: () => sendRuntimeMessage({ type: "live-providers-list" }),
    loadProviders: loadLiveProviders,
    save: (providers) => sendRuntimeMessage({ type: "live-providers-save", providers }),
    remove: (providerId) => sendRuntimeMessage({ type: "live-providers-delete", providerId }),
    generateId: () => familyRows.live.controller.generateId(),
    presets: () => LIVE_PROVIDER_PRESETS,
    rerender: rerenderLiveProviders,
    optionalHostPermission: true
  },

  ai: {
    list: () => sendRuntimeMessage({ type: "ai-providers-list" }),
    loadProviders: loadAiProviders,
    save: (providers) => sendRuntimeMessage({ type: "ai-providers-save", providers }),
    remove: (providerId) => sendRuntimeMessage({ type: "ai-providers-delete", providerId }),
    generateId: () => familyRows.ai.controller.generateId(),
    presets: () => aiPresets,
    rerender: (elements, providers) => {
      familyRows.ai.render(elements.aiProvidersList, elements.aiProvidersEmpty, providers);
      void getSettings().then((settings) => {
        renderSubtitleTranslateModelOptions(
          elements.subtitleTranslateModel,
          providers,
          settings.subtitleTranslateProviderId,
          settings.subtitleTranslateModel
        );
      });
      void refreshAiActiveProjection(elements, providers);
    },
    optionalHostPermission: true
  },
  asr: {
    list: () => sendRuntimeMessage({ type: "asr-providers-list" }),
    loadProviders: loadAsrProviders,
    save: (providers) => sendRuntimeMessage({ type: "asr-providers-save", providers }),
    remove: (providerId) => sendRuntimeMessage({ type: "asr-providers-delete", providerId }),
    generateId: () => familyRows.asr.controller.generateId(),
    presets: () => asrPresets,
    rerender: (elements, providers) => renderActiveRadioFamily("asr", elements, providers),
    optionalHostPermission: true
  },
  search: {
    list: () => sendRuntimeMessage({ type: "search-providers-list" }),
    loadProviders: loadSearchProviders,
    save: (providers) => sendRuntimeMessage({ type: "search-providers-save", providers }),
    remove: (providerId) => sendRuntimeMessage({ type: "search-providers-delete", providerId }),
    generateId: () => familyRows.search.controller.generateId(),
    presets: () => SEARCH_PROVIDER_PRESETS,
    rerender: (elements, providers) => rerenderSearchProviders(elements, providers),
    optionalHostPermission: false
  }
};

const familyRows = createProviderFamilyRows({
  onRowEdit: (kind, providerId) => void openProviderEditorById(kind, providerId)
});

function getActiveSearchProviderId(listNode: HTMLElement): string {
  return familyRows.search.getActiveId?.(listNode) || "";
}

// ===== 单平台保存与删除 =====

const providerTransactions = createProviderTransactions({
  families: PROVIDER_FAMILY_UI,
  requestOrigins: requestProviderOriginsViaBackground,
  rerender: rerenderProviderList,
  reportOriginRevokeFailure: (message) => {
    const host = settingsHostRef;
    if (host) {
      setStatus(collectElements(host), message, true);
    }
  }
});

function rerenderProviderList(kind: ProviderEditorKind, providers: ProviderRowItem[]): void {
  const host = settingsHostRef;
  if (!host) {
    return;
  }
  const elements = collectElements(host);
  PROVIDER_FAMILY_UI[kind].rerender(elements, providers);
  if (kind === "ai") {
    // AI 族变更后，实时伴看与搜索两类凭据引用行同事务重渲：两族列表先并发取回，
    // 再用同一份 AI 列表快照渲染，避免逐族现查出现一前一后的陈旧状态
    void Promise.all([loadLiveProviders(), loadSearchProviders()]).then(
      ([liveProviders, searchProviders]) => {
        rerenderLiveProviders(elements, liveProviders, providers);
        rerenderSearchProviders(elements, searchProviders, providers);
      }
    );
  }
}

// 编辑器内联凭据引用行（票 07/08）：伴看 Gemini Live 与搜索 DeepSeek 的编辑器内
// 展示 AI 族四态文案 + 同层进入 AI 族编辑器的动作；他族/他平台不渲染。
function linkedCredentialTargetOf(
  kind: ProviderEditorKind,
  item: ProviderRowItem | null
): AiCredentialLinkTarget | null {
  if (!item) return null;
  if (kind === "live" && (item.type === "gemini-live" || item.presetId === "gemini-live")) {
    return "gemini-live";
  }
  if (kind === "search" && item.presetId === "deepseek") return "deepseek";
  return null;
}

async function openProviderEditorById(
  kind: ProviderEditorKind,
  providerId: string,
  presetId?: string,
  setupSession?: AiSetupSession,
  restore?: { initialDraft: EditorDraft; baselineDraft: EditorDraftView | null }
): Promise<void> {
  const family = PROVIDER_FAMILY_UI[kind];
  const providers = await family.loadProviders();
  const item = providerId ? providers.find((p) => String(p?.id || "") === providerId) || null : null;
  if (providerId && !item) {
    return;
  }
  const linkedTarget = linkedCredentialTargetOf(kind, item);
  const linkedCredential = linkedTarget
    ? linkedCredentialFor(
        linkedTarget,
        resolveAiCredentialPlan(linkedTarget, await loadAiProviders()),
        () => {
          void enterLinkedCredentialEditor(linkedTarget);
        }
      )
    : null;
  try {
    const { openProviderEditor } = await import("./provider-editor.js");
    openProviderEditor({
      kind,
      item,
      presetId,
      presets: family.presets(),
      onSave: providerTransactions.upsertProvider,
      onDelete: providerTransactions.deleteProvider,
      // 首配模式（票 01）：保存钮「保存并继续」+ AI 至少一个模型 + 会话回调
      ...(setupSession
        ? {
            submitLabel: "保存并继续",
            firstSetup: true,
            onAfterSave: setupSession.onAfterSave,
            onSessionEnd: setupSession.onSessionEnd
          }
        : {}),
      ...(linkedCredential ? { linkedCredential } : {}),
      ...(restore ? { initialDraft: restore.initialDraft, baselineDraft: restore.baselineDraft } : {})
    });
  } catch (error) {
    const host = settingsHostRef;
    if (host) {
      setStatus(collectElements(host), (error as Error).message || "编辑器加载失败", true);
    }
  }
}

// 消费族编辑器内联凭据动作（票 07/08）：暂存原草稿 → 同层打开 AI 族凭据编辑器
// （复用同一宿主，不增加可见 Modal 层）；保存成功或取消都会话结束后恢复原草稿
// （dirty 基线一并带回），保存成功另提示仍需显式保存消费族记录
async function enterLinkedCredentialEditor(target: AiCredentialLinkTarget): Promise<void> {
  const kind = target === "deepseek" ? "search" : "live";
  const stash = stashEditorDraft(kind);
  const aiProviders = await loadAiProviders();
  await enterAiCredentialEditor({
    target,
    plan: resolveAiCredentialPlan(target, aiProviders),
    aiPresets: aiPresets,
    onSave: providerTransactions.upsertProvider,
    onDelete: providerTransactions.deleteProvider,
    stash,
    reopenConsumerEditor: (stashed, hint) => {
      void restoreConsumerEditorAfterCredential(kind, stashed, hint);
    }
  });
}

async function restoreConsumerEditorAfterCredential(
  kind: "live" | "search",
  stash: AiEditorStash,
  hint: string | null
): Promise<void> {
  const host = settingsHostRef;
  if (!host) return;
  // 抽屉收起的强制关闭路径不恢复：草稿随既有规则丢弃，不得在抽屉外重开编辑器
  if (document.getElementById(ids.readingSettingsPanel)?.hidden) return;
  // 重新装载消费族与 AI 族列表：行状态文案 / 命中来源随新引用刷新（annotate 与
  // 恢复后的编辑器内联行共用同一份 AI 列表快照）
  const [consumerProviders, aiProviders] = await Promise.all([
    kind === "live" ? loadLiveProviders() : loadSearchProviders(),
    loadAiProviders()
  ]);
  const elements = collectElements(host);
  if (kind === "live") {
    rerenderLiveProviders(elements, consumerProviders, aiProviders);
  } else {
    rerenderSearchProviders(elements, consumerProviders, aiProviders);
  }
  if (hint) setStatus(elements, hint);
  await openProviderEditorById(kind, stash.editingId, undefined, undefined, {
    initialDraft: stash.draft,
    baselineDraft: stash.baseline
  });
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
    const resp = await sendRuntimeMessage({ type: "save-settings", settings: buildDefaultPreferencePayload() });
    if (!resp?.ok) {
      setStatus(elements, resp?.error || "重置失败", true);
      return;
    }
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
  patch: Record<string, unknown>
): Promise<boolean> {
  try {
    const resp = await sendRuntimeMessage({ type: "save-settings", settings: patch });
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

function bindSettingsNav(host: HTMLElement): NavSync {
  const nav = host.querySelector<HTMLElement>(`#${SETTINGS_PANEL_DOM_IDS.settingsNav}`);
  if (!nav) {
    const noop = { updateActiveIndicator: () => {} };
    navSyncRef = noop;
    return noop;
  }

  const navItems = Array.from(nav.querySelectorAll<HTMLButtonElement>(".biliscript-settings-nav-item"));
  const indicator = nav.querySelector<HTMLElement>(".biliscript-settings-nav-indicator");
  const groups = Array.from(host.querySelectorAll<HTMLElement>(".biliscript-set-group[data-settings-section]"));

  function updateIndicator(activeBtn: HTMLButtonElement, smooth = true): void {
    if (!indicator) return;
    const rawWidth = activeBtn.offsetWidth;
    const btnWidth = rawWidth > 0 ? rawWidth : Math.max(24, (activeBtn.textContent?.trim().length ?? 2) * 14 + 8);
    const btnLeft = activeBtn.offsetLeft;
    const targetWidth = Math.max(18, btnWidth - 8);
    const targetLeft = btnLeft + (btnWidth - targetWidth) / 2;
    if (!smooth) {
      indicator.style.transition = "none";
    }
    indicator.style.transform = `translateX(${targetLeft}px)`;
    indicator.style.width = `${targetWidth}px`;
    if (!smooth) {
      void indicator.offsetWidth;
      indicator.style.transition = "";
    }
  }

  function getActiveBtn(): HTMLButtonElement | null {
    return navItems.find((btn) => btn.classList.contains("is-active")) ?? navItems[0] ?? null;
  }

  function updateActiveIndicator(smooth = true): void {
    const activeBtn = getActiveBtn();
    if (activeBtn) {
      updateIndicator(activeBtn, smooth);
    }
  }

  const navSync = { updateActiveIndicator };
  navSyncRef = navSync;

  if (typeof ResizeObserver !== "undefined") {
    const resizeObserver = new ResizeObserver(() => {
      updateActiveIndicator(false);
    });
    navItems.forEach((btn) => resizeObserver.observe(btn));
    resizeObserver.observe(nav);
  }

  window.addEventListener("resize", () => {
    updateActiveIndicator(false);
  });

  function setActive(sectionKey: string, smoothIndicator = true): void {
    let activeBtn: HTMLButtonElement | null = null;
    navItems.forEach((btn) => {
      const match = btn.dataset.section === sectionKey;
      btn.classList.toggle("is-active", match);
      if (match) activeBtn = btn;
    });
    if (activeBtn) {
      updateIndicator(activeBtn, smoothIndicator);
      if (typeof (activeBtn as HTMLElement).scrollIntoView === "function") {
        (activeBtn as HTMLElement).scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      }
    }
  }

  const initialActive = nav.querySelector<HTMLButtonElement>(".biliscript-settings-nav-item.is-active") ?? navItems[0];
  if (initialActive) {
    updateIndicator(initialActive, false);
    if (initialActive.offsetWidth === 0 && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        updateIndicator(initialActive, false);
      });
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
      setActive(sectionKey, true);
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
    return navSync;
  }

  const scrollContainer = host.closest<HTMLElement>("#biliscript-reading-settings-panel") ?? host.parentElement;
  if (!scrollContainer) return navSync;

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
  return navSync;
}

function bindScalarFieldEvents(binding: ScalarFieldBinding, elements: SettingsElements, navSync: NavSync): void {
  switch (binding.kind) {
    case "select": {
      const el = binding.getElement(elements);
      el.addEventListener("change", () => {
        const val = binding.normalize(el.value);
        if (binding.patchState !== false) {
          state.patchSettings({ [binding.key]: val });
        }
        binding.onApply?.(val, navSync);
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
        binding.onApply?.(val, navSync);
        void saveSettingField(elements, { [binding.key]: val }).then((ok) => {
          if (ok) binding.onSaved?.(val, navSync);
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
        onPreview: binding.onPreview
          ? (val) => {
              if (binding.patchState !== false) {
                state.patchSettings({ [binding.key]: val, ...(binding.commitExtras?.() ?? {}) });
              }
              binding.onPreview!(val, navSync);
            }
          : undefined,
        onCommit: (val) => {
          void saveSettingField(elements, { [binding.key]: val, ...(binding.commitExtras?.() ?? {}) });
        },
        onReset: binding.resetExtras
          ? (val) => {
              const patch = { [binding.key]: val, ...binding.resetExtras!() };
              if (binding.patchState !== false) {
                state.patchSettings(patch);
              }
              void saveSettingField(elements, patch);
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
  const navSync = bindSettingsNav(host);

  elements.backBtn?.addEventListener("click", () => {
    closeReaderSettingsMode();
  });

  for (const binding of SCALAR_FIELD_BINDINGS) {
    bindScalarFieldEvents(binding, elements, navSync);
  }

  elements.copyAgentBridgeInstallBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText("npx skills add Edmund724/BiliScript");
      setStatus(elements, "安装命令已复制");
    } catch {
      setStatus(elements, "复制失败，请手动复制安装命令", true);
    }
  });

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

  bindActiveRadioDeleteHandler("live", elements);
  bindActiveRadioDeleteHandler("asr", elements);
  familyRows.ai.controller.setDeleteHandler(async () => {
    // 列表行删除不经过 providerTransactions（消息已在行内发出）：删除后同一份 AI
    // 快照 + 两族列表并发取回，实时伴看与搜索两类引用行同事务重渲
    const [aiProviders, liveProviders, searchProviders] = await Promise.all([
      loadAiProviders(),
      loadLiveProviders(),
      loadSearchProviders()
    ]);
    rerenderLiveProviders(elements, liveProviders, aiProviders);
    rerenderSearchProviders(elements, searchProviders, aiProviders);
  });
  familyRows.search.controller.setDeleteHandler(async (providerId) => {
    if (providerId && String(getActiveSearchProviderId(elements.searchProvidersList) || "") === providerId) {
      await sendRuntimeMessage({ type: "save-settings", settings: { activeSearchProviderId: "" } });
    }
  });
  // 搜索平台列表拖拽排序：落定即直写 sync。
  wireProviderRowDrag(elements.searchProvidersList, {
    onCommit: async (ids) => {
      searchProviderOrder = ids;
      syncResetSearchOrderButton(elements);
      try {
        await chrome.storage.sync.set({ [SEARCH_PROVIDER_ORDER_STORAGE]: ids });
      } catch {}
    }
  });
  // 「恢复默认顺序」= 删除该 storage key + 按内置默认序重渲染。
  elements.resetSearchProviderOrderBtn.addEventListener("click", async () => {
    try {
      await chrome.storage.sync.remove(SEARCH_PROVIDER_ORDER_STORAGE);
    } catch {}
    searchProviderOrder = [];
    rerenderSearchProviders(elements, await loadSearchProviders());
  });
  // 搜索平台卡片内原地折叠展开（原生 button：Enter/Space 由浏览器原生触发 click）
  const toggleSearchChain = () => {
    const isHidden = elements.searchChainContainer.hidden;
    elements.searchChainContainer.hidden = !isHidden;
    elements.toggleSearchChainBtn.setAttribute("aria-expanded", String(isHidden));
    elements.toggleSearchChainBtn.setAttribute(
      "aria-label",
      isHidden ? "收起搜索平台与回退链" : "展开搜索平台与回退链"
    );
  };
  elements.toggleSearchChainBtn?.addEventListener("click", toggleSearchChain);
  // 付费准入开关改变 → 智能摘要的「可能使用付费平台」段跟着改口
  elements.allowPaidSearchProviders?.addEventListener("change", () => {
    syncSearchChainActiveSummary(elements);
  });

  // 悬空链首提示与摘要 / 模式控件随用户改选更新
  elements.searchProvidersList?.addEventListener("change", () => {
    if (getActiveSearchProviderId(elements.searchProvidersList)) {
      elements.searchProvidersDanglingHint.hidden = true;
    }
    syncSearchModeControls(elements);
    syncSearchChainActiveSummary(elements);
  });
  // 删除平台时回收 host 权限：判定是「origin 不再被任何参与族（分派表里
  // optionalHostPermission 的并集，当前 ai+asr+live）的存活平台使用才 remove」。
  const revokeOriginOnDelete = async (providerId: string, baseUrl: string): Promise<void> => {
    const providers = await loadOriginSharingProviders(PROVIDER_FAMILY_UI);
    const { origins, revoked } = await revokeOrphanOrigin({ id: providerId, baseUrl }, providers);
    if (origins.length > 0 && !revoked) {
      setStatus(elements, permissionRevokeErrorMessage(origins), true);
    }
  };
  familyRows.ai.controller.setBeforeDeleteHandler(revokeOriginOnDelete);
  familyRows.asr.controller.setBeforeDeleteHandler(revokeOriginOnDelete);
  familyRows.live.controller.setBeforeDeleteHandler(revokeOriginOnDelete);

  elements.subtitleTranslateModel?.addEventListener("change", () => {
    const val = elements.subtitleTranslateModel?.value || "";
    const { providerId, model } = parseModelOptionValue(val);
    void saveSettingField(elements, {
      subtitleTranslateProviderId: providerId,
      subtitleTranslateModel: model
    });
  });

  elements.resetBtn?.addEventListener("click", () => void resetPreferences(elements));

  // 添加平台：直接进空白编辑 Modal
  elements.addAiProviderBtn.addEventListener("click", () => void openProviderEditorById("ai", ""));
  elements.addAsrProviderBtn.addEventListener("click", () => void openProviderEditorById("asr", ""));
  elements.addLiveProviderBtn.addEventListener("click", () => void openProviderEditorById("live", ""));
  elements.addSearchProviderBtn.addEventListener("click", () => void openProviderEditorById("search", ""));

  // onChanged 回读他端改动（逐键按需存在性判空，避免单键变更时访问未变更键的 newValue 抛错）。
  const watchedSyncBindings = SCALAR_FIELD_BINDINGS.filter((binding) => binding.watchSync);
  watchStorageKeys(
    (changes) => {
      for (const binding of watchedSyncBindings) {
        const change = changes[binding.key];
        if (change) {
          hydrateScalarField(binding, elements, change.newValue);
          if (binding.key === "enableAgentBridge") {
            syncAgentBridgeInstall(change.newValue === true);
          }
        }
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
      }
    },
    {
      sync: [
        ...watchedSyncBindings.map((binding) => binding.key),
        "subtitleTranslateProviderId",
        "subtitleTranslateModel"
      ]
    }
  );

  // 生效投影跨端同步（票 05）：默认平台记录（settings.defaultModel）、平台列表 /
  // 密钥存储（aiProviders / aiProviderKeys，他端增删改启停）与对话选中项
  // （biliscript_ai_selected_provider）任一变更加发一次投影刷新——摘要、默认
  // 徽标与字幕跟随提示随之更新，不展示陈旧状态。
  watchStorageKeys(
    () => {
      void refreshAiActiveProjection(collectElements(host));
    },
    {
      sync: ["defaultModel", AI_PROVIDERS_STORAGE, AI_PROVIDER_KEYS_STORAGE],
      local: [SELECTED_PROVIDER_KEY]
    }
  );
}
