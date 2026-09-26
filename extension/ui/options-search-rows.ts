// extension/ui/options-search-rows.ts
// 设置页"搜索平台"区块行构建器：与 ASR 平台行（options-asr-rows.js）共用
// ui/provider-row.js 的 createProviderRow（紧凑形态：行是纯展示 + 编辑/删除
// 入口，编辑字段全部在 ui/provider-editor.js 的 Modal 里，保存走单平台
// upsert）。本文件只提供搜索侧真实差异：显示名解析、预设 note 副行（如 Brave
// 免费计划提示）、search-providers-delete 报文；选用 radio（即时持久化
// activeSearchProviderId）用 provider-row 的共享实现。行构建器只依赖参数与
// 回调，不直接访问 DOM 全局。

import { SEARCH_PROVIDER_PRESETS, type SearchProviderPreset } from "../core/presets.js";
import { buildActiveRadioTail, createProviderRow, type ProviderRowItem, type ProviderRowPreset } from "./provider-row.js";

// 行「编辑」按钮回调：由 settings-panel 注入（打开 provider-editor Modal 并现查
// 权威列表项），本模块只转发 providerId。
let onSearchRowEdit: (providerId: string) => void = () => {};

export function setSearchRowEditHandler(handler: (providerId: string) => void): void {
  onSearchRowEdit = handler;
}

// 选用 radio：共享实现（与 ASR 行同款），本文件只给搜索的类名前缀与设置键
const searchActiveRadio = buildActiveRadioTail({
  classPrefix: "search",
  title: "选用该平台联网搜索",
  settingsKey: "activeSearchProviderId"
});

const searchProviderRow = createProviderRow({
  rowClass: "search-provider-row",
  editClass: "provider-row-edit",
  removeClass: "provider-row-remove",
  idPrefix: "search_",
  resolvePreset: (presets, presetId) => presets.find((p) => p.id === presetId) || null,
  displayName: (item, preset) => String(item.name || preset?.name || "自定义"),
  // 副行显示预设 note（如 Brave「免费计划需绑信用卡」），无 note 不渲染
  displayModel: (item, preset) => String((preset as SearchProviderPreset | null)?.note ?? ""),
  buildTailFields: searchActiveRadio.buildTailFields,
  wireTailExtras: searchActiveRadio.wireTailExtras,
  onRowEdit: (row) => onSearchRowEdit(row.dataset.providerId || ""),
  buildDeleteMessage: (providerId) => ({ type: "search-providers-delete", providerId })
});

export function renderSearchProviders(
  listNode: HTMLElement,
  emptyNode: HTMLElement,
  items: ProviderRowItem[] | null | undefined,
  { presets = SEARCH_PROVIDER_PRESETS, activeId = "" }: { presets?: readonly SearchProviderPreset[]; activeId?: string } = {}
): void {
  searchProviderRow.render(listNode, emptyNode, items, { presets, activeId });
}

// 新平台 id 生成：provider-editor Modal 保存新增时由 settings-panel 调用，
// 沿用列表行的 id 格式 search_*
export function generateSearchProviderId(): string {
  return searchProviderRow.generateId();
}

// 把列表里 radio 选中态同步到指定平台 id（传空串则全部取消）
export function setActiveSearchProvider(listNode: HTMLElement, activeId: string): void {
  searchActiveRadio.setActive(listNode, activeId);
}

// 当前列表选中的平台 id（无则空串）
export function getActiveSearchProviderId(listNode: HTMLElement): string {
  return searchActiveRadio.getActiveId(listNode);
}

// 删除后的回调（删当前选用平台时清 activeSearchProviderId），由 settings-panel 注入
export function setSearchDeleteHandler(handler: Parameters<typeof searchProviderRow.setDeleteHandler>[0]): void {
  searchProviderRow.setDeleteHandler(handler);
}
