// extension/ui/options-rows.ts
// 选项页 AI 平台行构建器。AI 平台行的构建本体由 ui/provider-row.js 的
// createProviderRow 承担（与 ASR 行共用，provider-master-detail/02 起为紧凑形态：
// 行是纯展示 + 编辑/删除入口，编辑字段与连通性测试全部在 ui/provider-editor.js
// 的 Modal 里，保存走单平台 upsert）。本文件只提供 AI 侧真实差异：显示名/模型名
// 解析与既有导出签名。行构建器只依赖参数与回调，不直接访问 DOM 全局；验证函数
// 不触碰 DOM。（笔记导出的固定属性 / 笔记段落行构建器与校验随功能删除。）

import { PRESETS, type AiProviderPreset } from "../core/presets.js";
import {
  createProviderRow,
  type ProviderRowItem
} from "./provider-row.js";

// 行「编辑」按钮回调（provider-master-detail/01）：由 settings-panel 注入
// （打开 provider-editor Modal 并现查权威列表项），本模块只转发 providerId。
let onAiRowEdit: (providerId: string) => void = () => {};

export function setAiRowEditHandler(handler: (providerId: string) => void): void {
  onAiRowEdit = handler;
}

// ===== AI 模型平台（紧凑行，provider-master-detail/02） =====
// 行构建本体由 ui/provider-row.js 的 createProviderRow 承担（与 ASR 行共用），
// 此处只提供 AI 侧差异：显示名（自定义名回落预设名，拍板 Q7）/ 模型名解析 /
// 删除报文。编辑、连通性测试、模型目录拉取全在 ui/provider-editor.js 的 Modal。

const aiProviderRow = createProviderRow({
  rowClass: "ai-provider-row",
  editClass: "provider-row-edit",
  removeClass: "provider-row-remove",
  idPrefix: "p_",
  resolvePreset: (presets, presetId) => presets.find((p) => p.id === presetId) || presets[presets.length - 1],
  displayName: (item, preset) => String(item.name || preset?.name || "自定义"),
  displayModel: (item) => {
    const models = Array.isArray(item.models)
      ? item.models.map((m) => String(m).trim()).filter(Boolean)
      : [];
    if (models.length > 1) return `${models[0]} 等 ${models.length} 个`;
    if (models.length === 1) return models[0];
    return String(item.model || "");
  },
  onRowEdit: (row) => onAiRowEdit(row.dataset.providerId || ""),
  buildDeleteMessage: (providerId) => ({ type: "ai-providers-delete", providerId })
});

export function renderAiProviders(
  listNode: HTMLElement,
  emptyNode: HTMLElement,
  items: ProviderRowItem[] | null | undefined,
  { presets = PRESETS }: {
    presets?: readonly AiProviderPreset[];
  } = {}
): void {
  aiProviderRow.render(listNode, emptyNode, items, { presets });
}

// 新平台 id 生成（provider-master-detail/01：provider-editor Modal 保存新增时
// 由 settings-panel.saveProviderSingle 调用，沿用平铺行的 id 格式 p_*）
export function generateAiProviderId(): string {
  return aiProviderRow.generateId();
}

// 删除动作前先执行的钩子（回收 host 权限），由 options.js 注入
export function setAiBeforeDeleteHandler(handler: Parameters<typeof aiProviderRow.setBeforeDeleteHandler>[0]): void {
  aiProviderRow.setBeforeDeleteHandler(handler);
}
