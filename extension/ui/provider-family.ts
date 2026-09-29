// extension/ui/provider-family.ts
// 平台三族（AI / ASR / 搜索）的行渲染声明 + 编辑器声明与组合点工厂。
//
// 架构评审候选 3 片 1：原 options-rows / options-asr-rows / options-search-rows
// 三文件按族平铺同构配置（行类名 / id 前缀 / 预设回落 / 显示名 / 模型名 /
// 删除报文 + ASR/搜索的选用 radio 尾），本模块收为 Record<ProviderEditorKind, ...>
// 每族一份声明（全键覆盖：新增族漏配编译报错，对齐 core/settings-panel.ts
// PROVIDER_FAMILY_UI 与 core/settings-snapshot.ts FAMILY_STORES 先例）。
//
// 片 2（候选 3 + 候选 4 重叠）：编辑 Modal 的每族知识（标题 / Key 占位符 /
// 预设回落 / 收集序列化 / 快照与接线的 kind 门）收进声明的 editor 段——
// Modal 退化为 kind 无感的壳。resolvePreset 行/编辑器同源两份从此合一
//（原 provider-editor-state 的行侧副本删除，消费方一律走本声明）。
//
// 行「编辑」回调不再走模块级 setter 单例：createProviderFamilyRows(deps) 在
// 组合点（settings-panel）创建三族控制器，deps 只含 onRowEdit(kind, id)。
// 删除/回收回调走 controller 既有方法（闭包态、可后设）。本模块零 DOM 全局
// 访问、零模块态；预设列表由调用方按族传入（AI 可走后端动态预设）。

import { DEFAULT_SEARCH_PROVIDER_PRESET, type SearchProviderPreset } from "../core/presets.js";
import { validateAiProviders } from "../core/validators.js";
import type { AiProtocol } from "../ai/protocol-vocab.js";
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

// ===== 每族编辑器声明（Modal 消费：模板元数据 + 能力位 + 收集后序列化） =====

// Modal 从 DOM 直收的草稿字段（片 3 草稿模型的前身）；各字段已含通用清洗
//（name 回落 / baseUrl 去尾斜杠 / protocol 词表收敛），序列化不再碰 DOM
export interface EditorUpsertFields {
  id: string;
  preset: ProviderRowPreset | null;
  name: string;
  baseUrl: string;
  apiKey: string;
  hasSavedKey: boolean;
  // 模型目录收集（AI catalog 族；他族对话框无该节点，调用方传 []）
  models: string[];
  // 单模型输入（ASR input 族；他族调用方传 ""）
  model: string;
  // 协议下拉收敛值（usesProtocol 族；他族忽略）
  protocol: AiProtocol;
}

export interface FamilyEditorDeclaration {
  // 模板元数据
  title: string;
  // 新增态预设下拉默认选中项
  defaultPresetId: (presets: readonly ProviderRowPreset[]) => string;
  apiKeyPlaceholder: (preset: ProviderRowPreset | null, hasSavedKey: boolean) => string;
  // 能力位：Modal 快照 / 接线的 kind 门（新族漏配由 Record 全键覆盖编译兜底）
  modelSource: "catalog" | "input" | "none";
  usesProtocol: boolean;
  supportsPlatformTest: boolean;
  // 收集后序列化（原 Modal collectUpsert 的每族分支）
  serializeUpsert: (fields: EditorUpsertFields) => { upsert: ProviderRowItem; validationError?: string };
}

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
  // 编辑器每族知识（片 2 收敛）
  editor: FamilyEditorDeclaration;
}

// AI 模型平台：resolvePreset 历史语义为未知 presetId 回落末位预设（自定义）；
// 行与编辑器共用此份（片 2 起同源合一）
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
  buildDeleteMessage: (providerId) => ({ type: "ai-providers-delete", providerId }),
  editor: {
    title: "AI 平台",
    defaultPresetId: () => "custom",
    // requiresKey=false（如 ollama）时占位符提示可省；ASR / 搜索无此变体
    apiKeyPlaceholder: (preset, hasSavedKey) => {
      const requiresKey = preset?.requiresKey !== false;
      return hasSavedKey ? "已保存" : (requiresKey ? "API Key" : "API Key（可选）");
    },
    modelSource: "catalog",
    usesProtocol: true,
    // 平台级测试按钮已退役（拍板 Q4：行级测试替代），目录行级测试在 catalog 片
    supportsPlatformTest: false,
    serializeUpsert: ({ id, preset, name, baseUrl, apiKey, hasSavedKey, models, protocol }) => {
      const upsert: ProviderRowItem = {
        id,
        presetId: preset?.id || "custom",
        name,
        baseUrl,
        // 收集时 trim / 去空行 / 去重（拍板 Q7）；空目录合法（拍板 Q13）
        models,
        requiresKey: preset?.requiresKey !== false,
        enabled: true,
        apiKey,
        hasSavedKey,
        // 协议显式落盘（multi-protocol-ai）：存量记录编辑保存即写入显式值
        protocol
      };
      // 单平台校验与整表保存共用 validateAiProviders（报文语义一致）；失败只报
      // 状态行，不关 Modal
      const validation = validateAiProviders([upsert]);
      return validation.ok ? { upsert } : { upsert, validationError: validation.message };
    }
  }
};

// 语音转写平台：未知 presetId 不回落（ASR 无自定义预设语义）
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
  buildDeleteMessage: (providerId) => ({ type: "asr-providers-delete", providerId }),
  editor: {
    title: "语音转写平台",
    defaultPresetId: () => "custom",
    apiKeyPlaceholder: (_preset, hasSavedKey) => (hasSavedKey ? "已保存" : "API Key"),
    modelSource: "input",
    usesProtocol: false,
    // 平台级连通测试仅 ASR 保留（AI 由目录行级测试替代，搜索无探针）
    supportsPlatformTest: true,
    serializeUpsert: ({ id, preset, name, baseUrl, apiKey, hasSavedKey, model }) => ({
      upsert: {
        id,
        presetId: preset?.id || "custom",
        name,
        type: preset?.type || "openai-transcriptions",
        baseUrl,
        model,
        apiKey,
        hasSavedKey
      }
    })
  }
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
  buildDeleteMessage: (providerId) => ({ type: "search-providers-delete", providerId }),
  editor: {
    title: "搜索平台",
    // 搜索平台无自定义预设（spec 非目标）：新增默认选第一个预设
    defaultPresetId: (presets) => presets[0]?.id || "custom",
    apiKeyPlaceholder: (_preset, hasSavedKey) => (hasSavedKey ? "已保存" : "API Key"),
    modelSource: "none",
    usesProtocol: false,
    supportsPlatformTest: false,
    serializeUpsert: ({ id, preset, name, baseUrl, apiKey, hasSavedKey }) => ({
      upsert: {
        id,
        presetId: preset?.id || DEFAULT_SEARCH_PROVIDER_PRESET.id,
        name,
        type: preset?.type || DEFAULT_SEARCH_PROVIDER_PRESET.type,
        baseUrl,
        apiKey,
        hasSavedKey
      }
    })
  }
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
