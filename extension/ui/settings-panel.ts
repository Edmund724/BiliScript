// settings-panel.ts — 侧边栏设置面板（script-only-ui）。
//
// 原独立 options 页（pages/options.{html,css,ts}）的全部设置项搬入 文摘面板
// 的设置抽屉（ui-renderer 模板内的 #biliscript-reading-settings-host 容器，分节、
// 随抽屉滚动），行为与 options 页逐条对应：
//   - 装载（get-settings）→ 渲染平台行（AI/ASR / 搜索平台）与标量设置项；
//   - 保存（同步收集后分路落盘：settings 经 save-settings，平台经
//     provider-editor Modal 的单平台事务 provider-transaction）。平台行构建与
//     验证本体复用 ../ui/provider-family.ts、../core/validators.ts。
//   - 平台测试（AI/ASR 探针）只验证连通性，不落盘——保存只发生在 Modal 的
//     保存按钮链路上。
// 与 options 页的唯一实现差异：content script 语境没有 chrome.permissions
// API（Chromium 仅扩展自有页面/SW 可用），host 权限申请改走
// "request-provider-origins" 消息由 background SW 代为申请（手势随一次
// runtime 消息传导；SW 监听器在调用 chrome.permissions.request 前零 await）。
//
// 2026-09 大文件拆分：抽屉 HTML 模板（buildSettingsHtml，纯字符串零逻辑）
// 迁往 ui/settings-panel-html.ts，本模块只留流程编排（模板挂载/装载/收集
// 校验/保存/事件绑定/编辑 Modal 接线）。未再继续拆「表单收集校验 vs 事件
// 绑定与保存流程」两半：collectFormPayload 读取本模块状态，且 saveSettings /
// saveBtn 的绑定与手势链（settings-panel 侧）钉在本文件，再拆需改签名/外移
// 共享状态，收益不抵扰动。

import { DEFAULT_SETTINGS } from "../core/defaults.js";
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
  normalizeCustomPanelWidthEnabled,
  normalizeCustomPanelWidth,
  normalizeAutoOpenReader,
  normalizeReaderFontSizeScale,
} from "../core/validators.js";
import { applyReadingViewTypography, applyChatInputGlow, applyReadingViewPresentation } from "../reader/presentation.js";
import { state } from "../core/state.js";
import { relayoutScriptHost } from "../reader/script-host.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
// 02 复制粘贴收口：设置读取（消息 + 软超时 + 回落默认值）单源在 core/runtime，
// 本模块不再手抄一份；代价是此处读取也带上了 5s 软超时与超时 warn——超时仍
// 回落默认值，与原先无超时版本的可见行为一致（无网络往返挂死）。
import { getSettings } from "../core/runtime.js";
// 抽屉 HTML 模板（2026-09 拆分）：纯字符串零逻辑，见 settings-panel-html.ts
// 头注（分节顺序）与 SETTINGS_PANEL_DOM_IDS（id 词汇表）。
import { buildSettingsHtml, SETTINGS_PANEL_DOM_IDS, type SettingsPanelDomId } from "./settings-panel-html.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { confirmDialog } from "./confirm-dialog.js";
import { closeAllCustomSelects, initCustomSelect, setCustomSelectValue } from "./custom-select.js";
import { initToggleSwitch, syncToggleSwitch } from "./toggle-switch.js";
import { initRangeSlider, syncRangeProgress } from "./range-slider.js";
import { createProviderFamilyRows } from "./provider-family.js";
import type { ProviderRowItem, ProviderRowPreset } from "./provider-row.js";
import { wireProviderRowDrag } from "./provider-row-drag.js";
import { SEARCH_PROVIDER_PRESETS, type SearchProviderPreset } from "../core/presets.js";
import { isSmartSearchActive } from "../core/search-mode.js";
// DeepSeek 凭据引用三态（GLOSSARY「凭据引用」「官方端点判定」）：行副行状态文案
// 与链装配消费同一判定叶，面板不自行判端点。
import { DEEPSEEK_ROW_STATUS_TEXT, resolveDeepseekCredential } from "../search/deepseek-credential.js";
// 顺序规则（归一 + 排序键）单源在零依赖叶 search/search-order.js（票 15 Q1-a）：
// 本模块不再 import search-chain（那条边会把 search-executor → 六适配器拖进设置
// 抽屉的懒 chunk）；归一与键算法两侧各只有一份实现。
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
// 设置分区样式随本 chunk 按需装载（arch-slim-4/04）：本模块只在抽屉打开时被
// lifecycle.renderReaderPanels 动态 import（player-ai.ts:29 模块顶挂载先例），
// 时序天然对齐——模块求值即挂表。onload 门控在 renderReaderSettingsPanel 首建
// 分支等待 whenReaderSettingsStylesReady（~50ms 兜底），首帧零闪变。
import {
  ensureReaderSettingsStyles,
  whenReaderSettingsStylesReady
} from "../shared/style-injector.js";

ensureReaderSettingsStyles();

let aiPresets: AiProviderPreset[] = [];
let asrPresets: AsrProviderPreset[] = [];

// 设置抽屉宿主引用（provider-master-detail/01）：单平台保存后的列表重渲需要
// 按 id 重取 elements——renderReaderSettingsPanel 挂载时赋值。
let settingsHostRef: HTMLElement | null = null;

// collectFormPayload 的产物形态（save-settings 报文的 settings 载荷）
interface SettingsFormPayload {
  downloadFormat: string;
  includeDateInFilename: boolean;
  enablePlayerAiQuickAction: boolean;
  playerAiQuickPrompt: string;
  includeTimestampInBody: boolean;
  enableDebugLogs: boolean;
  readerPalette: string;
  chatInputGlow: boolean;
  aiSystemPrompt: string;
  aiInitialQuickPrompts: string[];
  readerFontSizeScale: number;
  customPanelWidth: number;
  autoOpenReader: boolean;
}

// ===== 分区渲染隔离（interactions-in-complex-layouts 指南，M15）=====
// .biliscript-set-group 是随抽屉滚动的自包含布局区：contain: layout style 把行增删/
// 校验错误显示/保存重渲等分区内部变更的 style/layout 失效圈在分区内，不上溯
// 阅读壳与宿主 B 站页面。
// 不取 paint containment（r1 评审）：paint 会把后代裁剪到分区 padding box，
// 而本面板弹层（custom-select-dropdown，absolute top:100%+6px）刻意溢出分区
// 边界盖过相邻卡片（reader-settings-rows.css 弹层族注释），末行之下只剩按钮的
// 高度，菜单必被分区底边截断——用户可见回归。也因此不走 content-visibility:auto：
// 按 CSS Containment L2 / MDN，cv:auto 恒含 paint containment（含屏上态），
// 裁剪问题相同。
// 但「无 paint 即无弹层风险」不成立（M15 漏判）：layout containment 本身就让
// 分区建立堆叠上下文，把弹层的 z-index 囚在分区内，被 DOM 序在后的兄弟分区压住
// （custom-select 下拉叠印在相邻分区下）。配对手段在样式表侧：分区含展开中的下拉
// 时整区抬升（reader-settings-rows.css 的 .biliscript-set-group:has(...) 规则），
// 本函数不改。
// 经 TS 内联应用而非落 reader-settings-*.css 样式表：真实原因是样式表文件不在
// 本任务 scope（M15 只放行 settings-panel 等五个文件）；内联也让应用时机与
// 模板构建同处一地。仅首建调用一次，非每次交互。
function applySectionContainment(host: HTMLElement): void {
  host.querySelectorAll<HTMLElement>(".biliscript-set-group").forEach((group) => {
    group.style.contain = "layout style";
  });
}

// ===== 元素收集（模板渲染后按 id 取自宿主容器，id 与原 options 页保持一致，
// provider-family / validators 的行级选择器直接复用） =====
// 查询 id 全部取自 settings-panel-html.ts 的 SETTINGS_PANEL_DOM_IDS（id 词汇表
// 单一声明，模板属性同源）；byIdIn 入参类型即该表值域，本处写不出表外 id。

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

// ===== 对外入口 =====

// 渲染设置面板（renderReaderPanels 打开抽屉时调用）：模板只建一次，数据每次
// 打开都重新装载（与 options 页打开即 loadSettings 的语义一致）。
// 首建分支等设置分区表 onload 就绪再渲染（arch-slim-4/04 门控：避免内容先于
// 样式一帧闪变；后续打开命中已挂载即同步渲染）。
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

// ===== 装载与保存（逻辑与 options 页逐条对应） =====

async function loadAiPresets(): Promise<void> {
  try {
    // 响应形状由消息类型经 ResponseOf 推断（arch-slim-2/02），下同
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
  // ADR-0007：下载格式下拉的显示从原生 select 现值派生——initCustomSelect 建壳时
  // 读一次，此后每次外部写值经 setCustomSelectValue 重新派生（与组件内选项点击
  // 同一条路径）。挂载点因此不再有「必须在写值之后」的约束：
  // setCustomSelectValue 对未初始化的 select 只写值，先挂壳后水合也显示现值。
  // 口径与 provider-editor-modal 一致（那份模板先用 selected 把值定死，再
  // initCustomSelect）。初始化标记（dataset.customSelectInitialized）使重复装载幂等。
  setCustomSelectValue(elements.downloadFormat, normalizeDownloadFormat(settings.downloadFormat));
  initCustomSelect(elements.downloadFormat, "custom-select-wrapper");
  // 外观色板（与 downloadFormat 同款 custom-select 壳）：装载时归一存量值（非法/
  // 缺失回落 flyme）再水合显示。
  setCustomSelectValue(elements.readerPalette, normalizeReaderPalette(settings.readerPalette));
  initCustomSelect(elements.readerPalette, "custom-select-wrapper");

  elements.readerFontSizeScale.value = String(normalizeReaderFontSizeScale(settings.readerFontSizeScale));
  elements.readerFontSizeScaleValue.textContent = `${elements.readerFontSizeScale.value}%`;
  elements.readerFontSizeScaleResetBtn.disabled = Number(elements.readerFontSizeScale.value) === DEFAULT_SETTINGS.readerFontSizeScale;
  initRangeSlider(elements.readerFontSizeScale);
  elements.includeDateInFilename.checked = settings.includeDateInFilename !== false;
  elements.enablePlayerAiQuickAction.checked = Boolean(settings.enablePlayerAiQuickAction);
  elements.playerAiQuickPrompt.value = String(settings.playerAiQuickPrompt || "");
  elements.includeTimestampInBody.checked = Boolean(settings.includeTimestampInBody);
  elements.enableDebugLogs.checked = Boolean(settings.enableDebugLogs);
  elements.customPanelWidth.value = String(normalizeCustomPanelWidth(settings.customPanelWidth));
  elements.customPanelWidthValue.textContent = `${elements.customPanelWidth.value}px`;
  elements.customPanelWidthResetBtn.disabled = Number(elements.customPanelWidth.value) === DEFAULT_SETTINGS.customPanelWidth;
  initRangeSlider(elements.customPanelWidth);
  elements.autoOpenReader.checked = settings.autoOpenReader === true;
  elements.chatInputGlow.checked = normalizeChatInputGlow(settings.chatInputGlow);
  // 自绘开关（ADR-0019）：水合直接写 .checked（值源语义不变，零事件），视觉经
  // syncToggleSwitch 吸附到现值——与 custom-select 的「显示 = 现值」同口径。
  [elements.includeDateInFilename, elements.enablePlayerAiQuickAction, elements.includeTimestampInBody, elements.enableDebugLogs, elements.allowPaidSearchProviders, elements.autoOpenReader, elements.chatInputGlow]
    .forEach(syncToggleSwitch);
  elements.aiSystemPrompt.value = settings.aiSystemPrompt || "";
  renderInitialQuickPromptInputs(elements, settings.aiInitialQuickPrompts);

  // AI 配置（渲染预设缺省回落内置 PRESETS，原 renderAiProviders 默认参数语义）
  const providers = await loadAiProviders();
  familyRows.ai.render(elements.aiProvidersList, elements.aiProvidersEmpty, providers, { presets: PRESETS });

  // ASR 配置
  elements.asrAutoFallback.checked = settings.asrAutoFallback !== false;
  syncToggleSwitch(elements.asrAutoFallback);
  const asrProviders = await loadAsrProviders();
  familyRows.asr.render(elements.asrProvidersList, elements.asrProvidersEmpty, asrProviders, {
    presets: asrPresets,
    activeId: settings.activeAsrProviderId || ""
  });

  // 搜索平台配置（预设是纯数据常量，直接 import，不设 presets-list 消息）
  elements.allowPaidSearchProviders.checked = settings.allowPaidSearchProviders === true;
  elements.webSearchMaxToolCalls.value = String(normalizeWebSearchMaxToolCalls(settings.webSearchMaxToolCalls));
  elements.webSearchMaxToolCallsValue.textContent = elements.webSearchMaxToolCalls.value;
  elements.webSearchMaxToolCallsResetBtn.disabled = Number(elements.webSearchMaxToolCalls.value) === DEFAULT_SETTINGS.webSearchMaxToolCalls;
  initRangeSlider(elements.webSearchMaxToolCalls);
  const searchProviders = await loadSearchProviders();
  // 列表顺序 = 链序（spec §12.2 / §12.5 第 15 行）：先取用户拖拽序（归一后），
  // 再按「order 下标 > 内置默认序」排序渲染。DeepSeek 行副行 = 凭据引用三态文案
  //（AI 族列表在同一份 loadSettings 里已取到）。
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
  // 悬空链首提示（spec §6.8）：链首指向已不存在的记录时露条件提示行；用户改选
  // （或链首本就为空 / 指向在场记录）即隐藏。判据只读当前设置与列表，无新存储位。
  syncSearchDanglingHint(elements, String(settings.activeSearchProviderId || ""), searchProviders);
}

// 面板当前生效的用户拖拽顺序（记录 id 数组；空 = 无自定义顺序，按内置默认序
// 渲染）。searchProviderOrder 与列表同侧（chrome.storage.sync，spec §12.3）：面板
// 直读直写，读失败 / 脏值按无自定义顺序，写失败静默——顺序是偏好不是数据。
let searchProviderOrder: string[] = [];

async function loadSearchProviderOrder(providers: ProviderRowItem[]): Promise<string[]> {
  try {
    const stored = await chrome.storage.sync.get([SEARCH_PROVIDER_ORDER_STORAGE]);
    // 归一判据依赖当前记录集合（未知 id / 重复 id → 整体作废，§12.2）
    return normalizeSearchProviderOrder(
      stored?.[SEARCH_PROVIDER_ORDER_STORAGE],
      providers.map((provider) => String(provider?.id || ""))
    );
  } catch {
    return [];
  }
}

// 列表渲染顺序 = 链序（spec §12.2）：在 order 中的按数组下标排在先，不在数组中的
// 排到其后、相互之间按内置默认序（sort 稳定 → 键相同的记录保持输入序）。键算法
// 单源在 search-order.js 的 providerOrderRank（链解析侧同调），此处只做单趟装饰。
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

// 「恢复默认顺序」按钮态（spec §6.10 / §12.3）：无自定义顺序就无可恢复的目标，
// 取更保守的禁用态（spec 未明说，见验收第 77 行）。
function syncResetSearchOrderButton(elements: SettingsElements): void {
  elements.resetSearchProviderOrderBtn.disabled = searchProviderOrder.length === 0;
}

// DeepSeek 行凭据引用三态文案（GLOSSARY「凭据引用」）：搜索侧 DeepSeek 记录没有
// 自有 Key，副行状态由 AI 族记录 + 官方端点判定得出（判定单点在
// deepseek-credential 叶，与链装配同源）；无 DeepSeek 行时零开销原样返回。
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

// 列表重渲（保存 / 编辑 / 恢复默认顺序后）：顺序按当前生效的拖拽序，选中态仍从
// 行内 radio 现读（与既有 rerender 语义一致）。DeepSeek 行副行 = 凭据引用三态
// 文案（现查 AI 族列表，随保存后的最新状态走）。
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

// 悬空链首提示行的显隐（spec §6.8）：activeSearchProviderId 指向不存在记录才出现。
// 哨兵不算悬空（spec §12.1 / §10 第 82 行）：选中「智能」不得误露「原选用平台已不可用」。
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

// 族无关的整列表现查：失败 / 形状坏一律回空数组（编辑 Modal 打开前用）。消息 type 仍
// 逐族写在下面三处的箭头体内——单字面量约束见 PROVIDER_FAMILY_UI 的说明。
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

// 三族 list/save/delete 响应的形状一致（条目按行渲染的宽松形状，见
// shared/messaging-protocol 的 Ai/Asr/SearchProviders*Response）。
type ProviderListResponse = {
  ok: boolean;
  providers?: ProviderRowItem[];
  error?: string;
};

// 族 → 设置面板分派表。AI/ASR/搜索三族在本面板的分派点（整列表消息、新平台 id
// 生成、现查列表、预设装载、列表重渲、optional host 权限策略）完全同构，差异
// 只在这张表里，调用点收敛为一次查表（对齐 core/settings-snapshot.ts 的
// FAMILY_STORES 先例：Record 全键覆盖，新增族漏配即编译报错）。
// 各族的消息 type 写在本族箭头函数体内、保持单字面量（联合 type 会让
// ResponseOf 推断塌成 never，见 provider-transaction 的事务入口说明），故本表是
// 回调表而非 type 字段表。
interface ProviderFamilyUi {
  // 整列表现查（upsert 前的权威列表，失败由调用方兜底）
  list: () => Promise<ProviderListResponse>;
  // 现查列表并兜底成空数组（编辑 Modal 打开前用）
  loadProviders: () => Promise<ProviderRowItem[]>;
  // 整列表替换保存（回最新列表，含 hasSavedKey）
  save: (providers: ProviderRowItem[]) => Promise<ProviderListResponse>;
  // 单条删除（回删除后存活列表）
  remove: (providerId: string) => Promise<ProviderListResponse>;
  // 新平台 id 生成（沿用各行 id 前缀）
  generateId: () => string;
  // 编辑 Modal 的预设来源（AI/ASR 为后端动态装载的模块态，搜索为纯数据常量）
  presets: () => readonly ProviderRowPreset[];
  // 列表重渲（选用态从当前 DOM radio 读取）
  rerender: (elements: SettingsElements, providers: ProviderRowItem[]) => void;
  // 域名是否走 optional host 权限（content 语境经 background 代申请）。
  // 搜索是 manifest 静态 host 权限（spec §2.4），不代申请、也不参与 orphan 回收
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

// orphan origin 回收的存活并集：问分派表里所有 optionalHostPermission 的族
// （当前 ai+asr；搜索是 manifest 静态 host 权限不参与）。单平台删除事务与行删除
// 路径（revokeOriginOnDelete）共用同一推导（provider-transaction 的
// loadOriginSharingProviders），新增一族只改表，调用点自动跟随——不再在函数体里
// 点名牌。

// 三族行控制器（候选 3 片 1）：组合点创建，行「编辑」回调直注进工厂 deps，
// 原三 rows 文件的模块级 setter 单例随收敛退役。删除/回收回调经 controller
// 方法在 bindSettingsEvents 里注入（闭包态，可后设）。
const familyRows = createProviderFamilyRows({
  onRowEdit: (kind, providerId) => void openProviderEditorById(kind, providerId)
});

// 选用态读取（ASR / 搜索；AI 无 radio）：原 options-asr/search-rows 的
// getActiveXxxProviderId 导出收敛为绑定上的 getActiveId
function getActiveAsrProviderId(listNode: HTMLElement): string {
  return familyRows.asr.getActiveId?.(listNode) || "";
}
function getActiveSearchProviderId(listNode: HTMLElement): string {
  return familyRows.search.getActiveId?.(listNode) || "";
}

// ===== 单平台保存与删除（一次保存 / 删除事务，owner 3） =====

// 单平台 upsert / 删除的全部宿主侧动作收进 provider-transaction 的单点事务
//（权限代申请 → 现查权威列表 → 按 id 合并/追加或回收 orphan origin → 落盘/删除
// → 用响应存活列表重渲）。本模块只注入三样：族分派表、列表重渲、抽屉状态条；
// Modal 的 onSave / onDelete 拿到的事务实现只回 {ok, error?}（保存成功与否由
// Modal 的结算原语自证，不再横跨两个 module）。
const providerTransactions = createProviderTransactions({
  families: PROVIDER_FAMILY_UI,
  // 手势不变式：事务入口直接以 upsert.baseUrl 代申请，无需先查列表
  requestOrigins: requestProviderOriginsViaBackground,
  rerender: rerenderProviderList,
  // 回收失败不阻断删除（与列表行同语义），错误文案落抽屉状态条
  reportOriginRevokeFailure: (message) => {
    const host = settingsHostRef;
    if (host) {
      setStatus(collectElements(host), message, true);
    }
  }
});

// 单平台保存/删除后用响应最新列表（含 hasSavedKey）重渲对应列表（与整表保存后的
// 重渲同源语义；ASR 选用态从当前 DOM radio 读取）。
function rerenderProviderList(kind: ProviderEditorKind, providers: ProviderRowItem[]): void {
  const host = settingsHostRef;
  if (!host) {
    return;
  }
  const elements = collectElements(host);
  PROVIDER_FAMILY_UI[kind].rerender(elements, providers);
}

// 打开编辑 Modal：编辑按 id 现查后端权威列表项（API Key 不在行 DOM 上，平铺行
// dataset 只有占位信息）；找不到（已被并发删除等竞态）静默不打开。新增传空 id。
// openProviderEditor 按需动态装载（provider-editor 连同其探针链整体进动态
// chunk），装载失败落抽屉状态条，不静默。
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

function collectFormPayload(elements: SettingsElements): SettingsFormPayload {
  return {
    downloadFormat: normalizeDownloadFormat(elements.downloadFormat.value),
    readerPalette: normalizeReaderPalette(elements.readerPalette.value),
    readerFontSizeScale: normalizeReaderFontSizeScale(elements.readerFontSizeScale.value),
    includeDateInFilename: elements.includeDateInFilename.checked,
    enablePlayerAiQuickAction: elements.enablePlayerAiQuickAction.checked,
    playerAiQuickPrompt: normalizePlayerAiQuickPrompt(elements.playerAiQuickPrompt.value),
    includeTimestampInBody: elements.includeTimestampInBody.checked,
    enableDebugLogs: elements.enableDebugLogs.checked,
    aiSystemPrompt: String(elements.aiSystemPrompt?.value || "").trim(),
    aiInitialQuickPrompts: collectInitialQuickPrompts(elements),
    customPanelWidth: normalizeCustomPanelWidth(elements.customPanelWidth.value),
    autoOpenReader: elements.autoOpenReader.checked,
    chatInputGlow: elements.chatInputGlow.checked
  };
}

function renderInitialQuickPromptInputs(elements: SettingsElements, value: unknown): void {
  // 留空 = 按视频内容自动生成（见 chat/quick-prompts.ts 的三档取用）：空数组
  // 是合法值，输入位就留空——不再把固定文案铺进去假装用户配置过。
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

// 偏好重置的默认值载荷：本面板管理的偏好键面（与 collectFormPayload 同一形状
// —— save-settings 按键面白名单落盘，aiProviders/asrProviders/密钥不在 settings
// 键面，天然不受影响）。defaultModel 与 ASR 标量（activeAsrProviderId /
// asrAutoFallback / asrLanguage）是平台域配置，不参与重置（拍板：偏好类）。
// aiBtnDefaultOnMigrated 是安装/更新迁移旗标，重置为 false 会重触发一次迁移
// 翻转，同样不参与。readerThemeUserSet 不参与：它是一次性哨兵（用户经 header
// 按钮手动改过主题才置位，见 reader/lifecycle.ts 的 updateReaderPreferences），
// 重置成 false 会让 presentation 的水合重新按 prefers-color-scheme 定主题，
// 把刚重置的 readerTheme 覆盖掉。webSearchMaxToolCalls 不参与：它是即时保存键
//（change 事件直发 save-settings，见 bindSettingsEvents），与 asrAutoFallback
// 同口径，不进表单收集也不进重置载荷。
function buildDefaultPreferencePayload() {
  return {
    downloadFormat: DEFAULT_SETTINGS.downloadFormat,
    includeDateInFilename: DEFAULT_SETTINGS.includeDateInFilename,
    enablePlayerAiQuickAction: DEFAULT_SETTINGS.enablePlayerAiQuickAction,
    // prompt 默认文本在 default-prompts.ts（DEFAULT_SETTINGS 里是空占位）：
    // 恢复默认直接写当前默认文本。
    playerAiQuickPrompt: DEFAULT_PLAYER_AI_QUICK_PROMPT,
    includeTimestampInBody: DEFAULT_SETTINGS.includeTimestampInBody,
    enableDebugLogs: DEFAULT_SETTINGS.enableDebugLogs,
    readerTheme: DEFAULT_SETTINGS.readerTheme,
    readerPalette: DEFAULT_SETTINGS.readerPalette,
    readerFontSizeScale: DEFAULT_SETTINGS.readerFontSizeScale,
    chatLineHeight: DEFAULT_SETTINGS.chatLineHeight,
    chatParagraphSpacing: DEFAULT_SETTINGS.chatParagraphSpacing,
    aiSystemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
    // 初始问题的默认态 = 留空（按视频内容自动生成），不写固定文案。
    aiInitialQuickPrompts: [],
    bilingualSubtitles: DEFAULT_SETTINGS.bilingualSubtitles,
    secondarySubtitleLang: DEFAULT_SETTINGS.secondarySubtitleLang,
    customPanelWidthEnabled: DEFAULT_SETTINGS.customPanelWidthEnabled,
    customPanelWidth: DEFAULT_SETTINGS.customPanelWidth,
    autoOpenReader: DEFAULT_SETTINGS.autoOpenReader,
    chatInputGlow: DEFAULT_SETTINGS.chatInputGlow
  };
}

// 恢复默认偏好：面板内确认弹层（ui/confirm-dialog.js，惯用法同删除平台的二次
// 确认，不用原生 confirm）通过后，把本面板的偏好键面一次性写回默认值（平台/
// 密钥/模型选择/ASR 配置不动），随后重载表单让 UI 反映默认值。
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

function bindSettingsNav(host: HTMLElement): void {
  const nav = host.querySelector<HTMLElement>(`#${SETTINGS_PANEL_DOM_IDS.settingsNav}`);
  if (!nav) return;

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

function bindSettingsEvents(host: HTMLElement): void {
  const elements = collectElements(host);
  bindSettingsNav(host);

  // 自绘开关接线（ADR-0019）：6 个持久布尔开关换 iOS 风格开关壳（轨道 + 滑块
  // 装饰、原生 input 视觉隐藏留作值源与键盘/读屏目标）。id / .checked / change
  // 语义全不变——即时保存监听（asrAutoFallback / allowPaidSearchProviders）与
  // collectFormPayload 照原样工作。
  [elements.asrAutoFallback, elements.enablePlayerAiQuickAction, elements.includeDateInFilename, elements.includeTimestampInBody, elements.enableDebugLogs, elements.allowPaidSearchProviders, elements.autoOpenReader, elements.chatInputGlow]
    .forEach(initToggleSwitch);

  elements.readerFontSizeScale.addEventListener("input", () => {
    const val = normalizeReaderFontSizeScale(elements.readerFontSizeScale.value);
    elements.readerFontSizeScaleValue.textContent = `${val}%`;
    elements.readerFontSizeScaleResetBtn.disabled = val === DEFAULT_SETTINGS.readerFontSizeScale;
    state.patchSettings({ readerFontSizeScale: val });
    applyReadingViewTypography();
  });
  elements.readerFontSizeScale.addEventListener("change", () => {
    const val = normalizeReaderFontSizeScale(elements.readerFontSizeScale.value);
    void saveSettingField(elements, { readerFontSizeScale: val });
  });
  elements.readerFontSizeScaleResetBtn.addEventListener("click", () => {
    const defaultVal = DEFAULT_SETTINGS.readerFontSizeScale;
    elements.readerFontSizeScale.value = String(defaultVal);
    elements.readerFontSizeScaleValue.textContent = `${defaultVal}%`;
    elements.readerFontSizeScaleResetBtn.disabled = true;
    state.patchSettings({ readerFontSizeScale: defaultVal });
    applyReadingViewTypography();
    void saveSettingField(elements, { readerFontSizeScale: defaultVal });
  });

  elements.customPanelWidth.addEventListener("input", () => {
    const width = normalizeCustomPanelWidth(elements.customPanelWidth.value);
    elements.customPanelWidthValue.textContent = `${width}px`;
    elements.customPanelWidthResetBtn.disabled = width === DEFAULT_SETTINGS.customPanelWidth;
    state.patchSettings({ customPanelWidth: width });
    relayoutScriptHost();
  });
  elements.customPanelWidth.addEventListener("change", () => {
    const width = normalizeCustomPanelWidth(elements.customPanelWidth.value);
    void saveSettingField(elements, { customPanelWidth: width });
  });
  elements.customPanelWidthResetBtn.addEventListener("click", () => {
    const defaultVal = DEFAULT_SETTINGS.customPanelWidth;
    elements.customPanelWidth.value = String(defaultVal);
    elements.customPanelWidthValue.textContent = `${defaultVal}px`;
    elements.customPanelWidthResetBtn.disabled = true;
    state.patchSettings({ customPanelWidth: defaultVal });
    relayoutScriptHost();
    void saveSettingField(elements, { customPanelWidth: defaultVal });
  });

  elements.chatInputGlow.addEventListener("change", () => {
    const val = elements.chatInputGlow.checked;
    state.patchSettings({ chatInputGlow: val });
    applyChatInputGlow();
    void saveSettingField(elements, { chatInputGlow: val });
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
  // 搜索平台列表拖拽排序（spec §6.10 / §12.3 / §12.5 第 14–15 行）：落定即直写
  // sync（与列表同侧；content 有完整 storage 权限）。写失败静默——顺序是偏好不是
  // 数据；列表本身已在 DOM 上反映新顺序，不回滚。
  wireProviderRowDrag(elements.searchProvidersList, {
    onCommit: async (ids) => {
      searchProviderOrder = ids;
      syncResetSearchOrderButton(elements);
      try {
        await chrome.storage.sync.set({ [SEARCH_PROVIDER_ORDER_STORAGE]: ids });
      } catch {}
    }
  });
  // 「恢复默认顺序」= 删除该 storage key（不写 []，否则 initializeSettingsStorage 会把
  // 「删除」重建成空数组）+ 按内置默认序重渲染；非破坏性动作，无二次确认。
  elements.resetSearchProviderOrderBtn.addEventListener("click", async () => {
    try {
      await chrome.storage.sync.remove(SEARCH_PROVIDER_ORDER_STORAGE);
    } catch {}
    searchProviderOrder = [];
    rerenderSearchProviders(elements, await loadSearchProviders());
  });
  // 悬空链首提示随用户改选消失（spec §6.8）：选中任一在场记录即不再悬空。
  // 只读行内 radio 选中态，不写设置——持久化仍由 radio 自身的 save-settings 承担。
  elements.searchProvidersList?.addEventListener("change", () => {
    if (getActiveSearchProviderId(elements.searchProvidersList)) {
      elements.searchProvidersDanglingHint.hidden = true;
    }
  });
  // 删除平台时回收 host 权限：判定是「origin 不再被任何参与族（分派表里
  // optionalHostPermission 的并集，当前 ai+asr）的存活平台使用才 remove」。
  // 存活列表从后端现查（紧凑行不再承载 baseUrl 输入框，被删行的 baseUrl 由行
  // dataset 传入钩子）。回收失败不阻断删除，状态条给出可操作文案。
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

  elements.downloadFormat.addEventListener("change", () => {
    const val = normalizeDownloadFormat(elements.downloadFormat.value);
    state.patchSettings({ downloadFormat: val });
    void saveSettingField(elements, { downloadFormat: val });
  });

  elements.readerPalette.addEventListener("change", () => {
    const val = normalizeReaderPalette(elements.readerPalette.value);
    state.patchSettings({ readerPalette: val });
    state.reader?.setPalette?.(val);
    applyReadingViewPresentation();
    void saveSettingField(elements, { readerPalette: val });
  });

  elements.includeDateInFilename.addEventListener("change", () => {
    const val = elements.includeDateInFilename.checked;
    state.patchSettings({ includeDateInFilename: val });
    void saveSettingField(elements, { includeDateInFilename: val });
  });

  elements.enablePlayerAiQuickAction.addEventListener("change", () => {
    const val = elements.enablePlayerAiQuickAction.checked;
    state.patchSettings({ enablePlayerAiQuickAction: val });
    void saveSettingField(elements, { enablePlayerAiQuickAction: val });
  });

  const savePlayerAiQuickPrompt = () => {
    const val = normalizePlayerAiQuickPrompt(elements.playerAiQuickPrompt.value);
    state.patchSettings({ playerAiQuickPrompt: val });
    void saveSettingField(elements, { playerAiQuickPrompt: val });
  };
  const debouncedSavePlayerAiQuickPrompt = debounce(savePlayerAiQuickPrompt, 400);
  elements.playerAiQuickPrompt.addEventListener("input", debouncedSavePlayerAiQuickPrompt);
  elements.playerAiQuickPrompt.addEventListener("blur", () => debouncedSavePlayerAiQuickPrompt.flush());

  elements.includeTimestampInBody.addEventListener("change", () => {
    const val = elements.includeTimestampInBody.checked;
    state.patchSettings({ includeTimestampInBody: val });
    void saveSettingField(elements, { includeTimestampInBody: val });
  });

  elements.enableDebugLogs.addEventListener("change", () => {
    const val = elements.enableDebugLogs.checked;
    state.patchSettings({ enableDebugLogs: val });
    void saveSettingField(elements, { enableDebugLogs: val });
  });

  elements.autoOpenReader.addEventListener("change", () => {
    const val = elements.autoOpenReader.checked;
    state.patchSettings({ autoOpenReader: val });
    void saveSettingField(elements, { autoOpenReader: val });
  });

  const saveAiSystemPrompt = () => {
    const val = String(elements.aiSystemPrompt.value || "").trim();
    state.patchSettings({ aiSystemPrompt: val });
    void saveSettingField(elements, { aiSystemPrompt: val });
  };
  const debouncedSaveAiSystemPrompt = debounce(saveAiSystemPrompt, 400);
  elements.aiSystemPrompt.addEventListener("input", debouncedSaveAiSystemPrompt);
  elements.aiSystemPrompt.addEventListener("blur", () => debouncedSaveAiSystemPrompt.flush());

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
  // 添加平台：直接进空白编辑 Modal（拍板 Q4，预设下拉是编辑页第一项）；
  // 平铺行「编辑」按钮：现查权威列表项后打开预填 Modal（拍板 Q3）
  elements.addAiProviderBtn.addEventListener("click", () => void openProviderEditorById("ai", ""));
  elements.addAsrProviderBtn.addEventListener("click", () => void openProviderEditorById("asr", ""));
  elements.addSearchProviderBtn.addEventListener("click", () => void openProviderEditorById("search", ""));
  // 行「编辑」回调已在 familyRows 工厂 deps 里注入（候选 3 片 1），此处不再注册
  // 外点关闭委托。快速通道（M15 INP）：监听器挂在 document 上，宿主页每一次
  // 点击都会进来，常态是两类弹层全关——此时旧实现无条件做两轮扫描（Modal
  // 模型下拉 + 自定义下拉，均全文档）。先做一次合并存在性检查，全关即返回；
  // 有开着的弹层才逐族收拢（写操作对已关弹层本就是 no-op，行为零变化）。两类
  // 弹层都只在设置抽屉/编辑 Modal 打开期间存在。
  document.addEventListener("click", (event) => {
    if (
      !document.querySelector(
        '.ai-provider-model-dropdown:not([hidden]), .custom-select-dropdown:not([hidden])'
      )
    ) {
      return;
    }
    if (!(event.target instanceof Element) || !event.target.closest(".ai-provider-model-wrapper")) {
      document.querySelectorAll<HTMLElement>(".ai-provider-model-dropdown").forEach((dropdown) => {
        dropdown.hidden = true;
      });
    }
    if (!(event.target instanceof Element) || !event.target.closest(".custom-select-wrapper")) {
      closeAllCustomSelects();
    }
  });
  // ASR：总开关即时持久化
  elements.asrAutoFallback?.addEventListener("change", async () => {
    await saveSettingField(elements, { asrAutoFallback: elements.asrAutoFallback.checked });
  });
  // 搜索平台：单轮搜索上限即时持久化
  elements.webSearchMaxToolCalls?.addEventListener("input", () => {
    const val = normalizeWebSearchMaxToolCalls(elements.webSearchMaxToolCalls.value);
    elements.webSearchMaxToolCallsValue.textContent = String(val);
    elements.webSearchMaxToolCallsResetBtn.disabled = val === DEFAULT_SETTINGS.webSearchMaxToolCalls;
  });
  elements.webSearchMaxToolCalls?.addEventListener("change", async () => {
    const val = normalizeWebSearchMaxToolCalls(elements.webSearchMaxToolCalls.value);
    elements.webSearchMaxToolCallsValue.textContent = String(val);
    elements.webSearchMaxToolCallsResetBtn.disabled = val === DEFAULT_SETTINGS.webSearchMaxToolCalls;
    await saveSettingField(elements, { webSearchMaxToolCalls: val });
  });
  elements.webSearchMaxToolCallsResetBtn?.addEventListener("click", async () => {
    const defaultVal = DEFAULT_SETTINGS.webSearchMaxToolCalls;
    elements.webSearchMaxToolCalls.value = String(defaultVal);
    elements.webSearchMaxToolCallsValue.textContent = String(defaultVal);
    elements.webSearchMaxToolCallsResetBtn.disabled = true;
    syncRangeProgress(elements.webSearchMaxToolCalls);
    await saveSettingField(elements, { webSearchMaxToolCalls: defaultVal });
  });
  // 付费平台准入即时持久化（GLOSSARY「付费平台」）：开关即花钱授权，改动立即生效。
  elements.allowPaidSearchProviders?.addEventListener("change", async () => {
    await saveSettingField(elements, { allowPaidSearchProviders: elements.allowPaidSearchProviders.checked });
  });
  // onChanged 回读他端改动（区/键过滤走 shared/watch-storage-keys seam，R3 收口）。
  watchStorageKeys((changes) => {
    elements.asrAutoFallback.checked = changes.asrAutoFallback.newValue !== false;
    syncToggleSwitch(elements.asrAutoFallback);
    if (changes.webSearchMaxToolCalls) {
      const val = normalizeWebSearchMaxToolCalls(changes.webSearchMaxToolCalls.newValue);
      elements.webSearchMaxToolCalls.value = String(val);
      elements.webSearchMaxToolCallsValue.textContent = String(val);
      elements.webSearchMaxToolCallsResetBtn.disabled = val === DEFAULT_SETTINGS.webSearchMaxToolCalls;
      syncRangeProgress(elements.webSearchMaxToolCalls);
    }
    if (changes.allowPaidSearchProviders) {
      elements.allowPaidSearchProviders.checked = changes.allowPaidSearchProviders.newValue === true;
      syncToggleSwitch(elements.allowPaidSearchProviders);
    }
  }, { sync: ["asrAutoFallback", "webSearchMaxToolCalls", "allowPaidSearchProviders"] });
}

// ===== host 权限申请 =====

// 代申请走 core/host-permissions 的单一实现 requestProviderOriginsViaBackground：
// content script 语境没有 chrome.permissions API（Chromium 该 API 仅扩展自有
// 页面/SW 可用），经 request-provider-origins 消息由 SW 代为申请；手势经一次
// runtime 消息传导，SW 监听器在调用 chrome.permissions.request 前零 await（见
// entry/background.ts handleRequestProviderOrigins，手势不变式测试
// tests/ui/options-save-gesture.test.ts 扫描全部调用方与 SW 处理器）。
