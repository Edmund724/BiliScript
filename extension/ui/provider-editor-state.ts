// extension/ui/provider-editor-state.ts — 平台编辑 Modal 的状态袋 + 字段/DOM 原语
//（provider-editor 拆分片，工单 12）。
//
// 为什么单独成片：Modal 的编辑态（open / kind / editingId / hasSavedKey /
// presets / onSave / onDelete / dirtySnapshot / generation / host / observer）
// 与「按类名读字段 / 写状态行 / 置忙」原语被 Modal 本体与另两片（模型目录、拉取
// 弹窗）共用。把它们放在最底层，三片之间才没有环：
//
//   provider-editor-state ← provider-editor-catalog
//                         ← provider-editor-fetch-dialog
//   provider-editor-modal（含模板与动作） → 上面三片
//   provider-editor（对外导出壳） → modal
//
// 片内只有单例状态与纯读取/写入原语，零运行时 import（类型除外）——沿用
// analysis-validate.ts「纯片」先例。函数体自原 provider-editor.ts 逐字节搬移。

import type { ProviderRowItem, ProviderRowPreset } from "./provider-row.js";

export type ProviderEditorKind = "ai" | "asr";

// 保存回调（settings-panel 注入）：权限申请与整列表落盘收口在
// settings-panel.saveProviderSingle，本模块不触碰权限。返回 error 时 Modal
// 内状态行显示、不关。
export type ProviderEditorSave = (
  kind: ProviderEditorKind,
  upsert: ProviderRowItem
) => Promise<{ ok: boolean; error?: string }>;

// 删除回调（settings-panel 注入，仅编辑态提供）：回收 orphan origin + 删除
// 消息 + 列表重渲都收口在 settings-panel，本模块只传目标（id + 行内 baseUrl）。
export type ProviderEditorDelete = (
  kind: ProviderEditorKind,
  target: { id: string; baseUrl: string }
) => Promise<{ ok: boolean; error?: string }>;

export interface ProviderEditorOpenOptions {
  kind: ProviderEditorKind;
  // 编辑目标（后端权威列表项，含 hasSavedKey）；缺省 = 新增空白
  item?: ProviderRowItem | null;
  presets: readonly ProviderRowPreset[];
  onSave: ProviderEditorSave;
  // 编辑态的删除入口（Modal 头部警示按钮）；缺省 = 不渲染删除按钮
  onDelete?: ProviderEditorDelete;
}

interface EditorState {
  open: boolean;
  kind: ProviderEditorKind;
  editingId: string;
  hasSavedKey: boolean;
  // 打开参数直达（collectUpsert / runTest / 预设切换读取）
  presets: readonly ProviderRowPreset[];
  onSave: ProviderEditorSave;
  onDelete: ProviderEditorDelete | null;
  // 打开时的字段快照（dirty 对比用）
  dirtySnapshot: string;
  // 代际号：测试探针/保存回执落定前比对，Modal 已关/已重开则丢弃过期回执
  generation: number;
  host: HTMLElement | null;
  observer: MutationObserver | null;
}

export const state: EditorState = {
  open: false,
  kind: "ai",
  editingId: "",
  hasSavedKey: false,
  presets: [],
  onSave: async () => ({ ok: false, error: "保存回调未注入" }),
  onDelete: null,
  dirtySnapshot: "",
  generation: 0,
  host: null,
  observer: null
};

// ===== DOM 读取（host 直下的 dialog 内按类名取，open 时接线） =====

export function getDialog(): HTMLElement | null {
  if (!state.host) return null;
  return state.host.querySelector<HTMLElement>(".provider-editor-dialog");
}

export function readField(selector: string): string {
  const input = getDialog()?.querySelector<HTMLInputElement>(selector);
  return String(input?.value || "").trim();
}

// AI 行历史语义：未知 presetId 回落最后一个预设（自定义）；ASR 回落 null
export function resolvePreset(presets: readonly ProviderRowPreset[], presetId: string, kind: ProviderEditorKind): ProviderRowPreset | null {
  const found = presets.find((p) => p.id === presetId) || null;
  if (found) return found;
  return kind === "ai" ? presets[presets.length - 1] || null : null;
}

export function apiKeyPlaceholder(kind: ProviderEditorKind, preset: ProviderRowPreset | null, hasSavedKey: boolean): string {
  if (kind === "asr") {
    return hasSavedKey ? "已保存" : "API Key";
  }
  const requiresKey = preset?.requiresKey !== false;
  return hasSavedKey ? "已保存" : (requiresKey ? "API Key" : "API Key（可选）");
}

