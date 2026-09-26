// extension/ui/options-asr-rows.ts
// 设置页"语音转写平台"区块行构建器：与 AI 平台行（options-rows.js）共用
// ui/provider-row.js 的 createProviderRow（provider-master-detail/02 起为紧凑
// 形态：行是纯展示 + 编辑/删除入口，编辑字段与连通性测试全部在
// ui/provider-editor.js 的 Modal 里，保存走单平台 upsert）。本文件只提供 ASR
// 侧真实差异：显示名/模型名解析、asr-providers-delete 报文；选用 radio
// （即时持久化 activeAsrProviderId）用 provider-row 的共享实现。
//
// 历史耦合收口：平铺形态下 ASR 行复用 ai-provider-remove / ai-provider-status
// 类名（DOM 契约），紧凑行的删除按钮统一 provider-row-remove、行内状态行随
// Modal 迁移退役，耦合消除。行构建器只依赖参数与回调，不直接访问 DOM 全局。

import { ASR_PROVIDER_PRESETS, type AsrProviderPreset } from "../core/presets.js";
import { buildActiveRadioTail, createProviderRow, type ProviderRowItem, type ProviderRowPreset } from "./provider-row.js";

// 行「编辑」按钮回调（provider-master-detail/01）：由 settings-panel 注入
// （打开 provider-editor Modal 并现查权威列表项），本模块只转发 providerId。
let onAsrRowEdit: (providerId: string) => void = () => {};

export function setAsrRowEditHandler(handler: (providerId: string) => void): void {
  onAsrRowEdit = handler;
}

// 选用 radio：共享实现（与搜索行同款），本文件只给 ASR 的类名前缀与设置键
const asrActiveRadio = buildActiveRadioTail({
  classPrefix: "asr",
  title: "选用该平台自动生成字幕",
  settingsKey: "activeAsrProviderId"
});

const asrProviderRow = createProviderRow({
  rowClass: "asr-provider-row",
  editClass: "provider-row-edit",
  removeClass: "provider-row-remove",
  idPrefix: "asr_",
  resolvePreset: (presets, presetId) => presets.find((p) => p.id === presetId) || null,
  displayName: (item, preset) => String(item.name || preset?.name || "自定义"),
  displayModel: (item, preset) => String(item.model ?? preset?.model ?? ""),
  buildTailFields: asrActiveRadio.buildTailFields,
  wireTailExtras: asrActiveRadio.wireTailExtras,
  onRowEdit: (row) => onAsrRowEdit(row.dataset.providerId || ""),
  buildDeleteMessage: (providerId) => ({ type: "asr-providers-delete", providerId })
});

export function renderAsrProviders(
  listNode: HTMLElement,
  emptyNode: HTMLElement,
  items: ProviderRowItem[] | null | undefined,
  { presets = ASR_PROVIDER_PRESETS, activeId = "" }: { presets?: readonly AsrProviderPreset[]; activeId?: string } = {}
): void {
  asrProviderRow.render(listNode, emptyNode, items, { presets, activeId });
}

// 新平台 id 生成（provider-master-detail/01：provider-editor Modal 保存新增时
// 由 settings-panel.saveProviderSingle 调用，沿用平铺行的 id 格式 asr_*）
export function generateAsrProviderId(): string {
  return asrProviderRow.generateId();
}

// 把列表里 radio 选中态同步到指定平台 id（传空串则全部取消）
export function setActiveAsrProvider(listNode: HTMLElement, activeId: string): void {
  asrActiveRadio.setActive(listNode, activeId);
}

// 当前列表选中的平台 id（无则空串）
export function getActiveAsrProviderId(listNode: HTMLElement): string {
  return asrActiveRadio.getActiveId(listNode);
}

// 删除后的回调（删当前选用平台时清 activeAsrProviderId），由 options.js 注入
export function setAsrDeleteHandler(handler: Parameters<typeof asrProviderRow.setDeleteHandler>[0]): void {
  asrProviderRow.setDeleteHandler(handler);
}

// 删除动作前先执行的钩子（回收 host 权限），由 options.js 注入
export function setAsrBeforeDeleteHandler(handler: Parameters<typeof asrProviderRow.setBeforeDeleteHandler>[0]): void {
  asrProviderRow.setBeforeDeleteHandler(handler);
}
