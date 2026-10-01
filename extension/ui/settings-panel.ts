// settings-panel.ts — 侧边栏设置面板（script-only-ui）。
//
// 原独立 options 页（pages/options.{html,css,ts}）的全部设置项搬入 文摘面板
// 的设置抽屉（ui-renderer 模板内的 #biliscript-reading-settings-host 容器，分节、
// 随抽屉滚动），行为与 options 页逐条对应：
//   - 装载（get-settings）→ 渲染平台行（AI/ASR / 搜索平台）与标量设置项；
//   - 保存（同步收集后分路落盘：settings 经 save-settings，平台经
//     provider-editor Modal 的单平台 upsert）。平台行构建与验证本体复用
//     ../ui/provider-family.ts、../core/validators.ts。
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
// 绑定与保存流程」两半：collectFormPayload 读取本模块状态，且
// options-save-gesture.test.js 的调用方闭包与
// 手势链扫描把 saveProviderSingle / saveSettings / saveBtn 绑定钉在本文件，
// 再拆需改签名/外移共享状态，收益不抵扰动。

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
  normalizeReaderThemeFamily,
  normalizeWebSearchMaxToolCalls
} from "../core/validators.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
// 02 复制粘贴收口：设置读取（消息 + 软超时 + 回落默认值）单源在 core/runtime，
// 本模块不再手抄一份；代价是此处读取也带上了 5s 软超时与超时 warn——超时仍
// 回落默认值，与原先无超时版本的可见行为一致（无网络往返挂死）。
import { getSettings } from "../core/runtime.js";
// 抽屉 HTML 模板（2026-09 拆分）：纯字符串零逻辑，见 settings-panel-html.ts
// 头注（id 契约、分节顺序）。
import { buildSettingsHtml } from "./settings-panel-html.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { confirmDialog } from "./confirm-dialog.js";
import { closeAllCustomSelects, initCustomSelect } from "./custom-select.js";
import { createProviderFamilyRows } from "./provider-family.js";
import type { ProviderRowItem, ProviderRowPreset } from "./provider-row.js";
import { SEARCH_PROVIDER_PRESETS, type SearchProviderPreset } from "../core/presets.js";
import type { ProviderEditorKind } from "./provider-editor.js";
import {
  requestProviderOriginsViaBackground,
  revokeOrphanOrigin,
  permissionRevokeErrorMessage
} from "../core/host-permissions.js";
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
  readerThemeFamily: string;
  downloadFormat: string;
  includeDateInFilename: boolean;
  enablePlayerAiQuickAction: boolean;
  playerAiQuickPrompt: string;
  includeTimestampInBody: boolean;
  enableDebugLogs: boolean;
  aiSystemPrompt: string;
  aiInitialQuickPrompts: string[];
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

function collectElements(host: HTMLElement) {
  const byIdIn = <T extends HTMLElement>(id: string): T =>
    host.querySelector(`#${id}`) as T;
  return {
    readerThemeFamily: byIdIn<HTMLSelectElement>("readerThemeFamily"),
    downloadFormat: byIdIn<HTMLSelectElement>("downloadFormat"),
    includeDateInFilename: byIdIn<HTMLInputElement>("includeDateInFilename"),
    enablePlayerAiQuickAction: byIdIn<HTMLInputElement>("enablePlayerAiQuickAction"),
    playerAiQuickPrompt: byIdIn<HTMLTextAreaElement>("playerAiQuickPrompt"),
    includeTimestampInBody: byIdIn<HTMLInputElement>("includeTimestampInBody"),
    enableDebugLogs: byIdIn<HTMLInputElement>("enableDebugLogs"),
    aiProvidersList: byIdIn<HTMLElement>("aiProvidersList"),
    aiProvidersEmpty: byIdIn<HTMLElement>("aiProvidersEmpty"),
    addAiProviderBtn: byIdIn<HTMLButtonElement>("addAiProviderBtn"),
    asrProvidersList: byIdIn<HTMLElement>("asrProvidersList"),
    asrProvidersEmpty: byIdIn<HTMLElement>("asrProvidersEmpty"),
    addAsrProviderBtn: byIdIn<HTMLButtonElement>("addAsrProviderBtn"),
    asrAutoFallback: byIdIn<HTMLInputElement>("asrAutoFallback"),
    searchProvidersList: byIdIn<HTMLElement>("searchProvidersList"),
    searchProvidersEmpty: byIdIn<HTMLElement>("searchProvidersEmpty"),
    searchProvidersDanglingHint: byIdIn<HTMLElement>("searchProvidersDanglingHint"),
    addSearchProviderBtn: byIdIn<HTMLButtonElement>("addSearchProviderBtn"),
    webSearchMaxToolCalls: byIdIn<HTMLInputElement>("webSearchMaxToolCalls"),
    aiSystemPrompt: byIdIn<HTMLTextAreaElement>("aiSystemPrompt"),
    aiInitialQuickPrompts: host.querySelectorAll<HTMLInputElement>(".ai-initial-quick-prompt"),
    saveBtn: byIdIn<HTMLButtonElement>("biliscriptSettingsSaveBtn"),
    resetBtn: byIdIn<HTMLButtonElement>("biliscriptSettingsResetBtn"),
    status: byIdIn<HTMLElement>("biliscriptSettingsStatus")
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
  elements.readerThemeFamily.value = normalizeReaderThemeFamily(settings.readerThemeFamily);
  elements.downloadFormat.value = normalizeDownloadFormat(settings.downloadFormat);
  elements.includeDateInFilename.checked = settings.includeDateInFilename !== false;
  elements.enablePlayerAiQuickAction.checked = Boolean(settings.enablePlayerAiQuickAction);
  elements.playerAiQuickPrompt.value = String(settings.playerAiQuickPrompt || "");
  elements.includeTimestampInBody.checked = Boolean(settings.includeTimestampInBody);
  elements.enableDebugLogs.checked = Boolean(settings.enableDebugLogs);
  elements.aiSystemPrompt.value = settings.aiSystemPrompt || "";
  renderInitialQuickPromptInputs(elements, settings.aiInitialQuickPrompts);

  // AI 配置（渲染预设缺省回落内置 PRESETS，原 renderAiProviders 默认参数语义）
  const providers = await loadAiProviders();
  familyRows.ai.render(elements.aiProvidersList, elements.aiProvidersEmpty, providers, { presets: PRESETS });

  // ASR 配置
  elements.asrAutoFallback.checked = settings.asrAutoFallback !== false;
  const asrProviders = await loadAsrProviders();
  familyRows.asr.render(elements.asrProvidersList, elements.asrProvidersEmpty, asrProviders, {
    presets: asrPresets,
    activeId: settings.activeAsrProviderId || ""
  });

  // 搜索平台配置（预设是纯数据常量，直接 import，不设 presets-list 消息）
  elements.webSearchMaxToolCalls.value = String(normalizeWebSearchMaxToolCalls(settings.webSearchMaxToolCalls));
  const searchProviders = await loadSearchProviders();
  familyRows.search.render(elements.searchProvidersList, elements.searchProvidersEmpty, searchProviders, {
    presets: SEARCH_PROVIDER_PRESETS,
    activeId: settings.activeSearchProviderId || ""
  });
  // 悬空链首提示（spec §6.8）：链首指向已不存在的记录时露条件提示行；用户改选
  // （或链首本就为空 / 指向在场记录）即隐藏。判据只读当前设置与列表，无新存储位。
  syncSearchDanglingHint(elements, String(settings.activeSearchProviderId || ""), searchProviders);
}

// 悬空链首提示行的显隐（spec §6.8）：activeSearchProviderId 指向不存在记录才出现。
function syncSearchDanglingHint(
  elements: SettingsElements,
  activeSearchProviderId: string,
  providers: ProviderRowItem[]
): void {
  const hint = elements.searchProvidersDanglingHint;
  if (!hint) return;
  const activeId = activeSearchProviderId.trim();
  hint.hidden = !activeId || providers.some((provider) => String(provider?.id || "") === activeId);
}

async function loadAiProviders(): Promise<ProviderRowItem[]> {
  try {
    const resp = await sendRuntimeMessage({ type: "ai-providers-list" });
    if (!resp?.ok) return [];
    return Array.isArray(resp.providers) ? resp.providers : [];
  } catch {
    return [];
  }
}

async function loadAsrProviders(): Promise<ProviderRowItem[]> {
  try {
    const resp = await sendRuntimeMessage({ type: "asr-providers-list" });
    if (!resp?.ok) return [];
    return Array.isArray(resp.providers) ? resp.providers : [];
  } catch {
    return [];
  }
}

async function loadSearchProviders(): Promise<ProviderRowItem[]> {
  try {
    const resp = await sendRuntimeMessage({ type: "search-providers-list" });
    if (!resp?.ok) return [];
    return Array.isArray(resp.providers) ? resp.providers : [];
  } catch {
    return [];
  }
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
// ResponseOf 推断塌成 never，见 saveProviderSingle 处的说明），故本表是回调表
// 而非 type 字段表。
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
    rerender: (elements, providers) => familyRows.search.render(elements.searchProvidersList, elements.searchProvidersEmpty, providers, {
      presets: SEARCH_PROVIDER_PRESETS,
      activeId: getActiveSearchProviderId(elements.searchProvidersList)
    }),
    optionalHostPermission: false
  }
};

// orphan origin 回收的存活并集：问分派表里所有 optionalHostPermission 的族
// （当前 ai+asr；搜索是 manifest 静态 host 权限不参与）。两条删除路径
// （deleteFromEditor / revokeOriginOnDelete）共用，新增一族只改表，这里自动
// 跟随——不再在函数体里点名牌。
async function loadOriginSharingProviders(): Promise<ProviderRowItem[]> {
  const eligible = Object.values(PROVIDER_FAMILY_UI).filter((family) => family.optionalHostPermission);
  const lists = await Promise.all(eligible.map((family) => family.loadProviders()));
  return lists.flat();
}

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

// ===== 单平台保存与编辑 Modal（provider-master-detail/01） =====

// 单平台 upsert 保存（provider-editor Modal 的保存回调）。与整表 saveSettings
// 的区别：只保存这一个平台——列表从后端现查（权威数据），平铺行未保存的行内
// 编辑不混入；upsert 按 id 替换 / 追加后发整列表消息（ai-providers-save /
// asr-providers-save 本就是整列表替换语义，SW 协议零改动）。API Key 仍单独落
// chrome.storage.local（saveProviders 后台语义：空输入沿用已存 Key 不清除）。
// 手势不变式：权限申请前零先行 await——baseUrl 由 upsert 参数直供，无需先
// 查列表（tests/ui/options-save-gesture.test.ts 锁定）。
async function saveProviderSingle(
  kind: ProviderEditorKind,
  upsert: ProviderRowItem
): Promise<{ ok: boolean; error?: string; providers?: ProviderRowItem[] }> {
  const family = PROVIDER_FAMILY_UI[kind];
  // 搜索平台域名是静态 host 权限（manifest host_permissions，spec §2.4），不走
  // optional 权限代申请
  if (family.optionalHostPermission && upsert.baseUrl) {
    const permission = await requestProviderOriginsViaBackground([String(upsert.baseUrl)]);
    if (!permission.ok) {
      return { ok: false, error: permission.error };
    }
  }
  try {
    // 消息 type 由分派表各族保持单字面量直发（联合 type 会让 ResponseOf 推断
    // 塌成 never）
    const listResp = await family.list();
    const list: ProviderRowItem[] =
      listResp?.ok && Array.isArray(listResp.providers) ? listResp.providers : [];
    const providerId = String(upsert.id || "") || family.generateId();
    const next = list.some((p) => String(p?.id || "") === providerId)
      ? list.map((p) => (String(p?.id || "") === providerId ? { ...p, ...upsert, id: providerId } : p))
      : [...list, { ...upsert, id: providerId }];
    const saveResp = await family.save(next);
    if (!saveResp?.ok) {
      return { ok: false, error: saveResp?.error || "保存失败" };
    }
    return { ok: true, providers: saveResp.providers || [] };
  } catch (error) {
    return { ok: false, error: (error as Error).message || "保存失败" };
  }
}

// 单平台保存后用响应最新列表（含 hasSavedKey）重渲对应列表（与整表保存后的
// 重渲同源语义；ASR 选用态从当前 DOM radio 读取）。
function rerenderProviderList(kind: ProviderEditorKind, providers: ProviderRowItem[]): void {
  const host = settingsHostRef;
  if (!host) {
    return;
  }
  const elements = collectElements(host);
  PROVIDER_FAMILY_UI[kind].rerender(elements, providers);
}

// provider-editor 的 onSave：单平台落盘 + 成功后重渲列表。错误由 Modal 状态行
// 显示（不走抽屉状态条——保存的是单个平台，Modal 自身就是错误语境）。
async function saveFromEditor(
  kind: ProviderEditorKind,
  upsert: ProviderRowItem
): Promise<{ ok: boolean; error?: string }> {
  const result = await saveProviderSingle(kind, upsert);
  if (result.ok && result.providers) {
    rerenderProviderList(kind, result.providers);
  }
  return result;
}

// provider-editor 的 onDelete（编辑态头部删除按钮）：回收 orphan origin（与
// 列表行删除共用判定，存活列表现查）→ 删除消息 → 用响应存活列表重渲。回收
// 失败不阻断删除（与列表行同语义），错误文案落抽屉状态条。
async function deleteFromEditor(
  kind: ProviderEditorKind,
  target: { id: string; baseUrl: string }
): Promise<{ ok: boolean; error?: string }> {
  const family = PROVIDER_FAMILY_UI[kind];
  try {
    if (family.optionalHostPermission) {
      // 搜索平台域名是静态 host 权限（无 optional 授权可回收），跳过 orphan
      // origin 判定；参与判定的存活并集由分派表推导（见 loadOriginSharingProviders）
      const providers = await loadOriginSharingProviders();
      const { origins, revoked } = await revokeOrphanOrigin(
        { id: target.id, baseUrl: target.baseUrl },
        providers
      );
      const host = settingsHostRef;
      if (origins.length > 0 && !revoked && host) {
        setStatus(collectElements(host), permissionRevokeErrorMessage(origins), true);
      }
    }
    const resp = await family.remove(target.id);
    if (!resp?.ok) {
      return { ok: false, error: resp?.error || "删除失败" };
    }
    if (Array.isArray(resp.providers)) {
      rerenderProviderList(kind, resp.providers);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message || "删除失败" };
  }
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
      onSave: saveFromEditor,
      onDelete: deleteFromEditor
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
    readerThemeFamily: normalizeReaderThemeFamily(elements.readerThemeFamily.value),
    downloadFormat: normalizeDownloadFormat(elements.downloadFormat.value),
    includeDateInFilename: elements.includeDateInFilename.checked,
    enablePlayerAiQuickAction: elements.enablePlayerAiQuickAction.checked,
    playerAiQuickPrompt: normalizePlayerAiQuickPrompt(elements.playerAiQuickPrompt.value),
    includeTimestampInBody: elements.includeTimestampInBody.checked,
    enableDebugLogs: elements.enableDebugLogs.checked,
    aiSystemPrompt: String(elements.aiSystemPrompt?.value || "").trim(),
    aiInitialQuickPrompts: collectInitialQuickPrompts(elements)
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
  elements.saveBtn.disabled = isBusy;
  elements.saveBtn.textContent = isBusy ? "处理中..." : "保存设置";
}

// 偏好重置的默认值载荷：本面板管理的偏好键面（与 collectFormPayload 同一形状
// —— save-settings 按键面白名单落盘，aiProviders/asrProviders/密钥不在 settings
// 键面，天然不受影响）。defaultModel 与 ASR 标量（activeAsrProviderId /
// asrAutoFallback / asrLanguage）是平台域配置，不参与重置（拍板：偏好类）。
// aiBtnDefaultOnMigrated 是安装/更新迁移旗标，重置为 false 会重触发一次迁移
// 翻转，同样不参与。
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
    aiSystemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
    // 初始问题的默认态 = 留空（按视频内容自动生成），不写固定文案。
    aiInitialQuickPrompts: []
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

// 保存设置（provider-master-detail/02 起：只承载其余设置项）。AI/ASR 平台的
// 保存已整体移交 provider-editor Modal 的单平台 upsert（saveProviderSingle），
// 本函数不再收集/校验/落盘平台列表，也不再申请平台 host 权限（平台域名的
// 授权在 Modal 保存与探针/模型列表预检的链路上收口）。笔记导出字段删除后
// 本链只剩收集 → 单路落盘：面板已无条件必填项，故不再有校验/清错步骤。
async function saveSettings(elements: SettingsElements): Promise<void> {
  const payload = collectFormPayload(elements);

  setBusy(elements, true);
  try {
    const resp = await sendRuntimeMessage({ type: "save-settings", settings: payload });
    if (!resp?.ok) {
      setStatus(elements, resp?.error || "保存失败", true);
      return;
    }
    setStatus(elements, "保存成功");
  } catch (error) {
    setStatus(elements, (error as Error).message || "保存失败", true);
  } finally {
    setBusy(elements, false);
  }
}

// ===== 事件绑定（模板渲染后一次性接线） =====

function bindSettingsEvents(host: HTMLElement): void {
  const elements = collectElements(host);

  if (elements.downloadFormat) {
    initCustomSelect(elements.downloadFormat, "custom-select-wrapper");
  }

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
    const providers = await loadOriginSharingProviders();
    const { origins, revoked } = await revokeOrphanOrigin({ id: providerId, baseUrl }, providers);
    if (origins.length > 0 && !revoked) {
      setStatus(elements, permissionRevokeErrorMessage(origins), true);
    }
  };
  familyRows.ai.controller.setBeforeDeleteHandler(revokeOriginOnDelete);
  familyRows.asr.controller.setBeforeDeleteHandler(revokeOriginOnDelete);

  elements.saveBtn.addEventListener("click", () => saveSettings(elements));
  elements.resetBtn?.addEventListener("click", () => void resetPreferences(elements));
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
    await sendRuntimeMessage({ type: "save-settings", settings: { asrAutoFallback: elements.asrAutoFallback.checked } });
  });
  // 搜索平台：单轮搜索上限即时持久化
  elements.webSearchMaxToolCalls?.addEventListener("change", async () => {
    await sendRuntimeMessage({
      type: "save-settings",
      settings: { webSearchMaxToolCalls: elements.webSearchMaxToolCalls.value }
    });
  });
  // onChanged 回读他端改动（区/键过滤走 shared/watch-storage-keys seam，R3 收口）。
  watchStorageKeys((changes) => {
    elements.asrAutoFallback.checked = changes.asrAutoFallback.newValue !== false;
    if (changes.webSearchMaxToolCalls) {
      elements.webSearchMaxToolCalls.value = String(normalizeWebSearchMaxToolCalls(changes.webSearchMaxToolCalls.newValue));
    }
  }, { sync: ["asrAutoFallback", "webSearchMaxToolCalls"] });
}

// ===== host 权限申请 =====

// 代申请走 core/host-permissions 的单一实现 requestProviderOriginsViaBackground：
// content script 语境没有 chrome.permissions API（Chromium 该 API 仅扩展自有
// 页面/SW 可用），经 request-provider-origins 消息由 SW 代为申请；手势经一次
// runtime 消息传导，SW 监听器在调用 chrome.permissions.request 前零 await（见
// entry/background.ts handleRequestProviderOrigins，手势不变式测试
// tests/ui/options-save-gesture.test.ts 扫描全部调用方与 SW 处理器）。
