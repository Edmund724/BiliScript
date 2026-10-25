// settings-panel.ts — 侧边栏设置面板（script-only-ui）。
//
// 设置项挂载在文摘面板的设置抽屉（ui-renderer 模板内的 #biliscript-reading-settings-host
// 容器，分节、随抽屉滚动）：
//   - 装载（get-settings）→ 渲染平台行（AI/ASR / 搜索平台）与标量设置项；
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
import { sendRuntimeMessage } from "../shared/messaging.js";
import { getSettings } from "../core/runtime.js";
import { buildSettingsHtml, SETTINGS_PANEL_DOM_IDS, type SettingsPanelDomId } from "./settings-panel-html.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { confirmDialog } from "./confirm-dialog.js";
import { initCustomSelect, setCustomSelectValue } from "./custom-select.js";
import { initToggleSwitch, syncToggleSwitch } from "./toggle-switch.js";
import { bindResettableRangeSlider, setResettableRangeValue } from "./range-slider.js";
import { createProviderFamilyRows } from "./provider-family.js";
import type { ProviderRowItem, ProviderRowPreset } from "./provider-row.js";
import { wireProviderRowDrag } from "./provider-row-drag.js";
import { SEARCH_PROVIDER_PRESETS } from "../core/presets.js";
import { isSmartSearchActive } from "../core/search-mode.js";
// DeepSeek 凭据引用三态（GLOSSARY「凭据引用」「官方端点判定」）：行副行状态文案
// 与链装配消费同一判定叶，面板不自行判端点。
import { DEEPSEEK_ROW_STATUS_TEXT, resolveDeepseekCredential } from "../search/deepseek-credential.js";
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
import {
  ensureReaderSettingsStyles,
  whenReaderSettingsStylesReady
} from "../shared/style-injector.js";

ensureReaderSettingsStyles();

let aiPresets: AiProviderPreset[] = [];
let asrPresets: AsrProviderPreset[] = [];

// 设置抽屉宿主引用：单平台保存后的列表重渲需要按 id 重取 elements——renderReaderSettingsPanel 挂载时赋值。
let settingsHostRef: HTMLElement | null = null;
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
    includeDateInFilename: byIdIn<HTMLInputElement>(dom.includeDateInFilename),
    enablePlayerAiQuickAction: byIdIn<HTMLInputElement>(dom.enablePlayerAiQuickAction),
    playerAiQuickPrompt: byIdIn<HTMLTextAreaElement>(dom.playerAiQuickPrompt),
    includeTimestampInBody: byIdIn<HTMLInputElement>(dom.includeTimestampInBody),
    enableDebugLogs: byIdIn<HTMLInputElement>(dom.enableDebugLogs),
    aiProvidersList: byIdIn<HTMLElement>(dom.aiProvidersList),
    aiProvidersEmpty: byIdIn<HTMLElement>(dom.aiProvidersEmpty),
    addAiProviderBtn: byIdIn<HTMLButtonElement>(dom.addAiProviderBtn),
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
    key: "autoOpenReader",
    getElement: (el) => el.autoOpenReader,
    normalize: (val) => val === true
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
      host.innerHTML = buildSettingsHtml();
      applySectionContainment(host);
      bindSettingsEvents(host);
      host.dataset.biliscriptSettingsRendered = "1";
      void loadSettings(collectElements(host));
    })();
    return;
  }
  void loadSettings(collectElements(host));
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

async function loadSettings(elements: SettingsElements): Promise<void> {
  await ensurePresetsLoaded();
  const settings = await getSettings();

  for (const binding of SCALAR_FIELD_BINDINGS) {
    hydrateScalarField(binding, elements, settings[binding.key]);
  }
  renderInitialQuickPromptInputs(elements, settings.aiInitialQuickPrompts);

  // AI 配置
  const providers = await loadAiProviders();
  familyRows.ai.render(elements.aiProvidersList, elements.aiProvidersEmpty, providers, { presets: PRESETS });

  // ASR 配置
  const asrProviders = await loadAsrProviders();
  familyRows.asr.render(elements.asrProvidersList, elements.asrProvidersEmpty, asrProviders, {
    presets: asrPresets,
    activeId: settings.activeAsrProviderId || ""
  });

  // 搜索平台配置（预设是纯数据常量，直接 import，不设 presets-list 消息）
  const searchProviders = await loadSearchProviders();
  // 列表顺序 = 链序：先取用户拖拽序（归一后），再按「order 下标 > 内置默认序」
  // 排序渲染。DeepSeek 行副行 = 凭据引用三态文案（AI 族列表在同一份 loadSettings 里已取到）。
  searchProviderOrder = await loadSearchProviderOrder(searchProviders);
  familyRows.search.render(
    elements.searchProvidersList,
    elements.searchProvidersEmpty,
    annotateDeepseekRows(sortSearchProviders(searchProviders), providers),
    {
      presets: SEARCH_PROVIDER_PRESETS,
      activeId: settings.activeSearchProviderId || ""
    }
  );
  syncResetSearchOrderButton(elements);
  // 悬空链首提示：链首指向已不存在的记录时露条件提示行；用户改选或链首指向在场记录即隐藏。
  syncSearchDanglingHint(elements, String(settings.activeSearchProviderId || ""), searchProviders);
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

// DeepSeek 行凭据引用三态文案（GLOSSARY「凭据引用」）：搜索侧 DeepSeek 记录没有
// 自有 Key，副行状态由 AI 族记录 + 官方端点判定得出；无 DeepSeek 行时零开销原样返回。
function annotateDeepseekRows(
  items: ProviderRowItem[],
  aiProviders: readonly ProviderRowItem[]
): ProviderRowItem[] {
  if (!items.some((item) => String(item.presetId || "") === "deepseek")) {
    return items;
  }
  const { status } = resolveDeepseekCredential(aiProviders as Parameters<typeof resolveDeepseekCredential>[0]);
  const text = DEEPSEEK_ROW_STATUS_TEXT[status];
  return items.map((item) =>
    String(item.presetId || "") === "deepseek" ? { ...item, statusNote: text } : item
  );
}

// 列表重渲（保存 / 编辑 / 恢复默认顺序后）：顺序按当前生效的拖拽序，选中态从
// 行内 radio 现读。DeepSeek 行副行 = 凭据引用三态文案（现查 AI 族列表）。
function rerenderSearchProviders(elements: SettingsElements, providers: ProviderRowItem[]): void {
  void loadAiProviders().then((aiProviders) => {
    familyRows.search.render(
      elements.searchProvidersList,
      elements.searchProvidersEmpty,
      annotateDeepseekRows(sortSearchProviders(providers), aiProviders),
      {
        presets: SEARCH_PROVIDER_PRESETS,
        activeId: getActiveSearchProviderId(elements.searchProvidersList)
      }
    );
    syncResetSearchOrderButton(elements);
  });
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

// ===== provider 三族分派表 =====

type ProviderListResponse = {
  ok: boolean;
  providers?: ProviderRowItem[];
  error?: string;
};

// 族 → 设置面板分派表。AI/ASR/搜索三族在本面板的分派点（整列表消息、新平台 id
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

const PROVIDER_FAMILY_UI: Record<ProviderEditorKind, ProviderFamilyUi> = {
  ai: {
    list: () => sendRuntimeMessage({ type: "ai-providers-list" }),
    loadProviders: loadAiProviders,
    save: (providers) => sendRuntimeMessage({ type: "ai-providers-save", providers }),
    remove: (providerId) => sendRuntimeMessage({ type: "ai-providers-delete", providerId }),
    generateId: () => familyRows.ai.controller.generateId(),
    presets: () => aiPresets,
    rerender: (elements, providers) => familyRows.ai.render(elements.aiProvidersList, elements.aiProvidersEmpty, providers),
    optionalHostPermission: true
  },
  asr: {
    list: () => sendRuntimeMessage({ type: "asr-providers-list" }),
    loadProviders: loadAsrProviders,
    save: (providers) => sendRuntimeMessage({ type: "asr-providers-save", providers }),
    remove: (providerId) => sendRuntimeMessage({ type: "asr-providers-delete", providerId }),
    generateId: () => familyRows.asr.controller.generateId(),
    presets: () => asrPresets,
    rerender: (elements, providers) => familyRows.asr.render(elements.asrProvidersList, elements.asrProvidersEmpty, providers, {
      presets: asrPresets,
      activeId: getActiveAsrProviderId(elements.asrProvidersList)
    }),
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

function getActiveAsrProviderId(listNode: HTMLElement): string {
  return familyRows.asr.getActiveId?.(listNode) || "";
}
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
}

async function openProviderEditorById(kind: ProviderEditorKind, providerId: string): Promise<void> {
  const family = PROVIDER_FAMILY_UI[kind];
  const providers = await family.loadProviders();
  const item = providerId ? providers.find((p) => String(p?.id || "") === providerId) || null : null;
  if (providerId && !item) {
    return;
  }
  try {
    const { openProviderEditor } = await import("./provider-editor.js");
    openProviderEditor({
      kind,
      item,
      presets: family.presets(),
      onSave: providerTransactions.upsertProvider,
      onDelete: providerTransactions.deleteProvider
    });
  } catch (error) {
    const host = settingsHostRef;
    if (host) {
      setStatus(collectElements(host), (error as Error).message || "编辑器加载失败", true);
    }
  }
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
        void saveSettingField(elements, { [binding.key]: val });
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
                state.patchSettings({ [binding.key]: val });
              }
              binding.onPreview!(val, navSync);
            }
          : undefined,
        onCommit: (val) => {
          void saveSettingField(elements, { [binding.key]: val });
        }
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

  for (const binding of SCALAR_FIELD_BINDINGS) {
    bindScalarFieldEvents(binding, elements, navSync);
  }

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

  familyRows.asr.controller.setDeleteHandler(async (providerId) => {
    if (providerId && String(getActiveAsrProviderId(elements.asrProvidersList) || "") === providerId) {
      await sendRuntimeMessage({ type: "save-settings", settings: { activeAsrProviderId: "" } });
    }
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
  // 悬空链首提示随用户改选消失：选中任一在场记录即不再悬空。
  elements.searchProvidersList?.addEventListener("change", () => {
    if (getActiveSearchProviderId(elements.searchProvidersList)) {
      elements.searchProvidersDanglingHint.hidden = true;
    }
  });
  // 删除平台时回收 host 权限：判定是「origin 不再被任何参与族（分派表里
  // optionalHostPermission 的并集，当前 ai+asr）的存活平台使用才 remove」。
  const revokeOriginOnDelete = async (providerId: string, baseUrl: string): Promise<void> => {
    const providers = await loadOriginSharingProviders(PROVIDER_FAMILY_UI);
    const { origins, revoked } = await revokeOrphanOrigin({ id: providerId, baseUrl }, providers);
    if (origins.length > 0 && !revoked) {
      setStatus(elements, permissionRevokeErrorMessage(origins), true);
    }
  };
  familyRows.ai.controller.setBeforeDeleteHandler(revokeOriginOnDelete);
  familyRows.asr.controller.setBeforeDeleteHandler(revokeOriginOnDelete);

  elements.resetBtn?.addEventListener("click", () => void resetPreferences(elements));

  // 添加平台：直接进空白编辑 Modal
  elements.addAiProviderBtn.addEventListener("click", () => void openProviderEditorById("ai", ""));
  elements.addAsrProviderBtn.addEventListener("click", () => void openProviderEditorById("asr", ""));
  elements.addSearchProviderBtn.addEventListener("click", () => void openProviderEditorById("search", ""));

  // onChanged 回读他端改动（逐键按需存在性判空，避免单键变更时访问未变更键的 newValue 抛错）。
  const watchedSyncBindings = SCALAR_FIELD_BINDINGS.filter((binding) => binding.watchSync);
  watchStorageKeys(
    (changes) => {
      for (const binding of watchedSyncBindings) {
        const change = changes[binding.key];
        if (change) {
          hydrateScalarField(binding, elements, change.newValue);
        }
      }
    },
    { sync: watchedSyncBindings.map((binding) => binding.key) }
  );
}
