// extension/ui/provider-family.ts
// 平台三族（AI / ASR / 搜索）的行渲染声明与组合点工厂。
//
// 架构评审候选 3 片 1：原 options-rows / options-asr-rows / options-search-rows
// 三文件按族平铺同构配置（行类名 / id 前缀 / 预设回落 / 显示名 / 模型名 /
// 删除报文 + ASR/搜索的选用 radio 尾），本模块收为 Record<ProviderEditorKind, ...>
// 每族一份声明（全键覆盖：新增族漏配编译报错，对齐 core/settings-panel.ts
// PROVIDER_FAMILY_UI 与 core/settings-snapshot.ts FAMILY_STORES 先例）。
//
// 行「编辑」回调不再走模块级 setter 单例：createProviderFamilyRows(deps) 在
// 组合点（settings-panel）创建三族控制器，deps 只含 onRowEdit(kind, id)。
// 删除/回收回调走 controller 既有方法（闭包态、可后设）。本模块零 DOM 全局
// 访问、零模块态；预设列表由调用方按族传入（AI 可走后端动态预设）。

import type { SearchProviderPreset } from "../core/presets.js";
import type { ProviderEditorKind } from "./provider-editor-state.js";
import {
  buildActiveRadioTail,
  createProviderRow,
  type ActiveRadioTailConfig,
  type ProviderRowController,
  type ProviderRowItem,
  type ProviderRowPreset
} from "./provider-row.js";
import type { BackgroundMessage, ContentScriptMessage } from "../shared/messaging-protocol.js";

// ===== 每族行声明（createProviderRow 配置中除 onRowEdit 外的全部每族差异） =====

interface FamilyRowDeclaration {
  rowClass: string;
  editClass: string;
  removeClass: string;
  idPrefix: string;
  resolvePreset: (presets: readonly ProviderRowPreset[], presetId: string) => ProviderRowPreset | null;
  // 显示名（AI：自定义名回落预设名，拍板 Q7；三族同规则）
  displayName: (item: ProviderRowItem, preset: ProviderRowPreset | null) => string;
  // 副行模型名：AI=models 多值「首项 等 N 个」（拍板 Q15）/历史单模型；
  // ASR=model 回落预设；搜索=预设 note（如 Brave「免费计划需绑信用卡」），空不渲染
  displayModel: (item: ProviderRowItem, preset: ProviderRowPreset | null) => string;
  // 选用 radio 尾（ASR / 搜索；AI 无）：类名前缀 / 提示文案 / 即时持久化设置键
  activeRadio?: ActiveRadioTailConfig;
  buildDeleteMessage: (providerId: string) => BackgroundMessage | ContentScriptMessage;
}

// AI 模型平台：resolvePreset 历史语义为未知 presetId 回落末位预设（自定义），
// 与编辑 Modal 的 resolvePreset（provider-editor-state）同源规则的行侧副本
const AI_FAMILY: FamilyRowDeclaration = {
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
  buildDeleteMessage: (providerId) => ({ type: "ai-providers-delete", providerId })
};

// 语音转写平台：未知 presetId 不回落（与 ASR Modal 的 resolvePreset 一致）
const ASR_FAMILY: FamilyRowDeclaration = {
  rowClass: "asr-provider-row",
  editClass: "provider-row-edit",
  removeClass: "provider-row-remove",
  idPrefix: "asr_",
  resolvePreset: (presets, presetId) => presets.find((p) => p.id === presetId) || null,
  displayName: (item, preset) => String(item.name || preset?.name || "自定义"),
  displayModel: (item, preset) => String(item.model ?? preset?.model ?? ""),
  activeRadio: {
    classPrefix: "asr",
    title: "选用该平台自动生成字幕",
    settingsKey: "activeAsrProviderId"
  },
  buildDeleteMessage: (providerId) => ({ type: "asr-providers-delete", providerId })
};

// 搜索平台
const SEARCH_FAMILY: FamilyRowDeclaration = {
  rowClass: "search-provider-row",
  editClass: "provider-row-edit",
  removeClass: "provider-row-remove",
  idPrefix: "search_",
  resolvePreset: (presets, presetId) => presets.find((p) => p.id === presetId) || null,
  displayName: (item, preset) => String(item.name || preset?.name || "自定义"),
  displayModel: (item, preset) => String((preset as SearchProviderPreset | null)?.note ?? ""),
  activeRadio: {
    classPrefix: "search",
    title: "选用该平台联网搜索",
    settingsKey: "activeSearchProviderId"
  },
  buildDeleteMessage: (providerId) => ({ type: "search-providers-delete", providerId })
};

export const PROVIDER_FAMILY_ROWS: Record<ProviderEditorKind, FamilyRowDeclaration> = {
  ai: AI_FAMILY,
  asr: ASR_FAMILY,
  search: SEARCH_FAMILY
};

// ===== 组合点工厂 =====

// 一族的产物：行控制器（删除/回收回调经其方法注入）+ 统一渲染签名 +
// 选用态读取（无 radio 的 AI 族为 null；setActive 只被行内 change 回调与
// 历史遗留 setter 使用，组合点不再外暴露——按片 1 裁决死导出不搬运）
export interface FamilyRowsBinding {
  controller: ProviderRowController;
  render: (
    listNode: HTMLElement,
    emptyNode: HTMLElement,
    items: ProviderRowItem[] | null | undefined,
    options?: { presets?: readonly ProviderRowPreset[]; activeId?: string }
  ) => ProviderRowItem[];
  getActiveId: ((listNode: HTMLElement) => string) | null;
}

export interface CreateFamilyRowsDeps {
  // 行「编辑」按钮回调（settings-panel 注入：打开 provider-editor Modal）
  onRowEdit: (kind: ProviderEditorKind, providerId: string) => void;
}

export type ProviderFamilyRows = Record<ProviderEditorKind, FamilyRowsBinding>;

export function createProviderFamilyRows(deps: CreateFamilyRowsDeps): ProviderFamilyRows {
  const entries = (Object.entries(PROVIDER_FAMILY_ROWS) as [ProviderEditorKind, FamilyRowDeclaration][]).map(
    ([kind, decl]) => {
      const activeRadio = decl.activeRadio ? buildActiveRadioTail(decl.activeRadio) : null;
      const controller = createProviderRow({
        rowClass: decl.rowClass,
        editClass: decl.editClass,
        removeClass: decl.removeClass,
        idPrefix: decl.idPrefix,
        resolvePreset: decl.resolvePreset,
        displayName: decl.displayName,
        displayModel: decl.displayModel,
        buildTailFields: activeRadio?.buildTailFields,
        wireTailExtras: activeRadio?.wireTailExtras,
        onRowEdit: (row) => deps.onRowEdit(kind, row.dataset.providerId || ""),
        buildDeleteMessage: decl.buildDeleteMessage
      });
      const render: FamilyRowsBinding["render"] = (listNode, emptyNode, items, options) =>
        controller.render(listNode, emptyNode, items, options);
      return [kind, { controller, render, getActiveId: activeRadio?.getActiveId ?? null }] as const;
    }
  );
  return Object.fromEntries(entries) as ProviderFamilyRows;
}
