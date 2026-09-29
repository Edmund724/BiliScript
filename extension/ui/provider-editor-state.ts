// extension/ui/provider-editor-state.ts — 平台编辑 Modal 的状态袋 + 字段/DOM 原语
//（provider-editor 拆分片，工单 12）。
//
// 为什么单独成片：Modal 的编辑态（open / kind / editingId / openBaseUrl /
// hasSavedKey / presets / onSave / onDelete / draft / baselineDraft / generation /
// host / observer）与「按类名读字段 / 写状态行 / 置忙」原语被 Modal 本体与另两片
//（模型目录、拉取弹窗）共用。把它们放在最底层，三片之间才没有环：
//
//   provider-editor-state ← provider-editor-catalog
//                         ← provider-editor-fetch-dialog
//   provider-editor-modal（含模板与动作） → 上面三片
//   provider-editor（对外导出壳） → modal
//
// 片内只有单例状态与纯读取/写入原语，零运行时 import（类型除外）——沿用
// analysis-validate.ts「纯片」先例。函数体自原 provider-editor.ts 逐字节搬移。
//
// 片 2 起预设回落 / Key 占位符 / 序列化等每族知识收进 provider-family.ts 声明
// 的 editor 段（行/编辑器同源合一），本片不再承载。

import type { AiProtocol } from "../ai/protocol-vocab.js";
import type { ProviderRowItem, ProviderRowPreset } from "./provider-row.js";

export type ProviderEditorKind = "ai" | "asr" | "search";

// 编辑草稿（候选 4 片 3）：Modal 的唯一真源。DOM 是它的投影——输入/change
// 事件写 draft，模板与联动读 draft 后重投影；保存 / 测试连接 / 拉取弹窗 /
// dirty 对比全部只读 draft，不读 DOM。
export interface EditorDraft {
  presetId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol: AiProtocol | "";
  models: string[];
  model: string;
}

export function cloneDraft(draft: EditorDraft): EditorDraft {
  return { ...draft, models: [...draft.models] };
}

export function draftsEqual(a: EditorDraft, b: EditorDraft): boolean {
  return (
    a.presetId === b.presetId &&
    a.name === b.name &&
    a.baseUrl === b.baseUrl &&
    a.apiKey === b.apiKey &&
    a.protocol === b.protocol &&
    a.model === b.model &&
    a.models.length === b.models.length &&
    a.models.every((model, index) => model === b.models[index])
  );
}

// 收集层口径（拍板 Q7）：trim / 去空行 / 静默去重（保序）。原 readModelIds
// 从 DOM 抓取，候选 4 片 3 起 draft 为真源，归一直接作用于 draft.models
export function normalizeDraftModels(models: readonly string[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const model of models) {
    const value = model.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      ids.push(value);
    }
  }
  return ids;
}

// 保存回调（settings-panel 注入）：权限申请与整列表落盘收口在
// settings-panel.saveProviderSingle，本模块不触碰权限。返回 error 时 Modal
// 内状态行显示、不关。
export type ProviderEditorSave = (
  kind: ProviderEditorKind,
  upsert: ProviderRowItem
) => Promise<{ ok: boolean; error?: string }>;

// 删除回调（settings-panel 注入，仅编辑态提供）：回收 orphan origin + 删除
// 消息 + 列表重渲都收口在 settings-panel，本模块只传目标（id + 已存列表项
// baseUrl——锚定打开时的权威项，不收 DOM 里的未保存输入改动）。
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
  // 打开时锚定的已存列表项 baseUrl（删除回收 orphan origin 的目标地址）
  openBaseUrl: string;
  // 打开参数直达（collectUpsert / runTest / 预设切换读取）
  presets: readonly ProviderRowPreset[];
  onSave: ProviderEditorSave;
  onDelete: ProviderEditorDelete | null;
  // 编辑草稿与打开时的基线（dirty = 逐字段对比，见 draftsEqual）
  draft: EditorDraft | null;
  baselineDraft: EditorDraft | null;
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
  openBaseUrl: "",
  presets: [],
  onSave: async () => ({ ok: false, error: "保存回调未注入" }),
  onDelete: null,
  draft: null,
  baselineDraft: null,
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

