// extension/ui/provider-editor-projection.ts — 平台编辑 Modal 的字段投影（owner 1）。
//
// 一个编辑会话的 DOM 只有一处定义：本模块的字段表。每个可投影字段一行，行内
// 同时给出三件事——
//   project：draft → 该字段的 DOM 目标态（唯一的值投影规则）；
//   html   ：该字段的 DOM 形态（模板片段，buildDialogHtml 只做布局拼装）；
//   apply  ：把目标态写回已渲染节点（预设切换 / 协议切换 / 目录行增删的重投影）。
// 外加 read：DOM → 同一形态的反向读取，供「重投影后 DOM == 目标态」的逐字段
// 不变式核验（字段表新增一行即自动纳入核验，投影漏字段不再靠人眼）。
//
// 由此消掉「模板 / 预设切换 / 协议切换 / input 回写」四类抄写点：加一个编辑器
// 字段只需在这里加一行（外加模板布局里引用一次）。联动**规则**（何时跟随上一
// 预设/协议）仍留在 wireDialog 的处理器里，投影只负责「draft 是什么，DOM 就是
// 什么」。
//
// 每族字段的在场性由族声明的能力位决定（usesProtocol / modelSource），与模板
// 布局判据同源：非 AI 族不投影协议与限制点小字，非目录族不投影目录空态。
//
// 协议/预设的投影口径也收在这里（协议词表收敛 / 预设协议默认 / 限制点文案）；
// 协议端点查表是 multi-protocol-ai 的共享叶，单源在 core/presets.ts，本模块只
// re-export（上方）保持调用方路径不变：它们既是模板与联动的共用口径，也是本模块
// project 的输入。

import { escapeHtml } from "../shared/string-utils.js";
import { presetBaseUrlForProtocol } from "../core/presets.js";
import { PROTOCOL_ADAPTERS, PROTOCOL_OPTIONS, resolveAdapter, type AiProtocol } from "../ai/protocol-adapter.js";
import { buildModelPickerField } from "./model-picker.js";
import { setCustomSelectValue } from "./custom-select.js";
import { PROVIDER_FAMILY_ROWS, type FamilyEditorDeclaration } from "./provider-family.js";
import { getDialog, state, type EditorDraftView, type ProviderEditorKind } from "./provider-editor-state.js";
import type { ProviderRowPreset } from "./provider-row.js";

// 协议端点查表的单源在 core/presets.ts（multi-protocol-ai 叶）；此处原样 re-export，
// 调用方（Modal / 获取模型弹窗 / 目录片）路径不变。
export { presetBaseUrlForProtocol };

// ===== 协议/预设投影口径 =====

// 任意来源的协议值收敛到注册表词表；缺省/未知值兜底 openai（与 resolveAdapter
// 同口径——存量记录缺 protocol 字段时编辑 Modal 直接显示「OpenAI」，无提示，
// 事实即如此）。
export function normalizeProtocolValue(value: unknown): AiProtocol {
  return typeof value === "string" && value in PROTOCOL_ADAPTERS ? (value as AiProtocol) : "openai";
}

// 预设的协议默认归属：词表内值原样返回，缺省 openai（15 个预设现状全部
// OpenAI compatible；逐平台多协议归属实测后由 preset 词表显式填写）。
export function presetProtocol(preset: ProviderRowPreset | null): AiProtocol {
  return normalizeProtocolValue(preset?.protocol);
}

// 限制点文案（capabilities.unsupported 的说明串）：表单底部小字，仅非空时
// 露出（openai 为空自然隐藏）。稳定键不进文案，只给人读的说明。
export function protocolNotes(protocol: unknown): string {
  const unsupported = resolveAdapter(protocol).capabilities.unsupported;
  const text = Object.values(unsupported).join("；");
  return text ? `该协议限制：${text}` : "";
}

// ===== 字段投影表 =====

export interface ProjectionContext {
  kind: ProviderEditorKind;
  presets: readonly ProviderRowPreset[];
  hasSavedKey: boolean;
}

export interface FieldProjection {
  value?: string;
  placeholder?: string;
  required?: boolean;
  hidden?: boolean;
  text?: string;
}

export type ProjectionFieldKey =
  | "preset"
  | "protocol"
  | "name"
  | "baseUrl"
  | "apiKey"
  | "model"
  | "protocolNotes"
  | "catalogEmpty";

export type DraftInputKey = "name" | "baseUrl" | "apiKey" | "model";

interface ProjectionScope {
  ctx: ProjectionContext;
  family: FamilyEditorDeclaration;
  preset: ProviderRowPreset | null;
}

interface FieldSpec {
  project(scope: ProjectionScope, draft: EditorDraftView): FieldProjection;
  html(projection: FieldProjection, scope: ProjectionScope): string;
  apply(dialog: HTMLElement, projection: FieldProjection, scope: ProjectionScope): void;
  read(dialog: HTMLElement): FieldProjection;
  // 文本字段的 input 回写声明（DOM → draft 的唯一通道；缺省 = 无输入控件）
  input?: { draftKey: DraftInputKey; selector: string; clearStatus: boolean };
}

function scopeOf(draft: EditorDraftView, ctx: ProjectionContext): ProjectionScope {
  const family = PROVIDER_FAMILY_ROWS[ctx.kind];
  return { ctx, family: family.editor, preset: family.resolvePreset(ctx.presets, draft.presetId) };
}

function fieldBlock(label: string, control: string): string {
  return `<div class="provider-editor-field">
          <label class="provider-editor-label">${label}</label>
          ${control}
        </div>`;
}

function inputValue(projection: FieldProjection): string {
  return escapeHtml(projection.value ?? "");
}

const FIELDS: Record<ProjectionFieldKey, FieldSpec> = {
  preset: {
    project: (_scope, draft) => ({ value: draft.presetId }),
    html: (projection, scope) => {
      const options = scope.ctx.presets
        .map(
          (preset) =>
            `<option value="${escapeHtml(preset.id)}" ${preset.id === projection.value ? "selected" : ""}>${escapeHtml(preset.name)}</option>`
        )
        .join("");
      return `<div class="provider-editor-field">
          <label class="provider-editor-label">平台预设</label>
          <select class="provider-editor-preset">
            ${options}
          </select>
        </div>`;
    },
    apply: (dialog, projection) => {
      const select = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset");
      if (!select || projection.value === undefined) return;
      // 只在值确有对应选项时写：未知 presetId 的存量记录保持模板的原生默认选中，
      // 不因一次重投影漂移到空值
      if (Array.from(select.options).some((option) => option.value === projection.value)) {
        setCustomSelectValue(select, projection.value);
      }
    },
    read: (dialog) => ({ value: dialog.querySelector<HTMLSelectElement>(".provider-editor-preset")?.value ?? "" })
  },

  protocol: {
    project: (scope, draft) => (scope.family.usesProtocol ? { value: normalizeProtocolValue(draft.protocol) } : {}),
    html: (projection) => {
      const options = PROTOCOL_OPTIONS.map(
        (option) =>
          `<option value="${option.value}" ${option.value === projection.value ? "selected" : ""}>${escapeHtml(option.label)}</option>`
      ).join("");
      return `<div class="provider-editor-field">
          <label class="provider-editor-label">协议</label>
          <select class="provider-editor-protocol">
            ${options}
          </select>
        </div>`;
    },
    apply: (dialog, projection) => {
      const select = dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol");
      if (!select || projection.value === undefined) return;
      // 经组件入口写值：裸写 select.value 不回流 trigger 显示（ADR-0007 修订）
      setCustomSelectValue(select, projection.value);
    },
    read: (dialog) => ({ value: dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol")?.value ?? "" })
  },

  name: {
    input: { draftKey: "name", selector: ".provider-editor-name", clearStatus: true },
    project: (scope, draft) => ({
      value: draft.name,
      // AI 名称留空 + 占位（≠预设名才回填，拍板 Q7）；ASR/搜索是实值语义
      placeholder: scope.ctx.kind === "ai" ? scope.preset?.name || "" : "平台名称"
    }),
    html: (projection) =>
      fieldBlock(
        "名称",
        `<input class="provider-editor-name" type="text" placeholder="${escapeHtml(projection.placeholder ?? "")}" value="${inputValue(projection)}" />`
      ),
    apply: (dialog, projection) => {
      const input = dialog.querySelector<HTMLInputElement>(".provider-editor-name");
      if (!input) return;
      input.value = projection.value ?? "";
      input.placeholder = projection.placeholder ?? "";
    },
    read: (dialog) => {
      const input = dialog.querySelector<HTMLInputElement>(".provider-editor-name");
      return { value: input?.value ?? "", placeholder: input?.placeholder ?? "" };
    }
  },

  baseUrl: {
    input: { draftKey: "baseUrl", selector: ".provider-editor-baseurl", clearStatus: true },
    project: (_scope, draft) => ({ value: draft.baseUrl }),
    html: (projection) =>
      fieldBlock(
        "API 地址",
        `<input class="provider-editor-baseurl" type="text" required pattern="https?://.+" placeholder="如 https://api.openai.com/v1" value="${inputValue(projection)}" />`
      ),
    apply: (dialog, projection) => {
      const input = dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl");
      if (input) input.value = projection.value ?? "";
    },
    read: (dialog) => ({ value: dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")?.value ?? "" })
  },

  apiKey: {
    input: { draftKey: "apiKey", selector: ".provider-editor-apikey", clearStatus: true },
    project: (scope, draft) => {
      // DeepSeek 搜索记录无自有 Key（凭据引用，GLOSSARY「凭据引用」）：字段整体隐藏，
      // 模板与重投影同源（projection.hidden），保存 / 测试都不读它。
      if (scope.ctx.kind === "search" && scope.preset?.id === "deepseek") {
        return { hidden: true };
      }
      const projection: FieldProjection = {
        // 占位符与 required 同源（族声明的 isKeyRequired）：防「占位符说可选、
        // required 仍卡住」
        placeholder: scope.family.apiKeyPlaceholder(scope.preset, scope.ctx.hasSavedKey),
        required: scope.family.isKeyRequired(scope.preset) && !scope.ctx.hasSavedKey
      };
      // AI 的 Key 输入是只写通道（模板也不回填 value）：除切预设清空（ASR/搜索）
      // 外不把 draft.apiKey 投影回 DOM
      if (scope.ctx.kind !== "ai") projection.value = draft.apiKey;
      return projection;
    },
    html: (projection) => {
      if (projection.hidden) return "";
      return fieldBlock(
        "API Key",
        `<input class="provider-editor-apikey" type="password" placeholder="${escapeHtml(projection.placeholder ?? "")}" autocomplete="off" ${projection.required ? "required" : ""} />`
      );
    },
    apply: (dialog, projection) => {
      const input = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey");
      if (!input) return;
      input.placeholder = projection.placeholder ?? "";
      input.required = projection.required === true;
      if (projection.value !== undefined) input.value = projection.value;
    },
    read: (dialog) => {
      const input = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey");
      return { value: input?.value ?? "", placeholder: input?.placeholder ?? "", required: input?.required ?? false };
    }
  },

  model: {
    input: { draftKey: "model", selector: ".provider-editor-model", clearStatus: false },
    project: (scope, draft) => (scope.family.modelSource === "input" ? { value: draft.model, required: true } : {}),
    html: (projection) =>
      fieldBlock(
        "模型",
        buildModelPickerField({
          inputClass: "provider-editor-model",
          placeholder: "模型名",
          value: projection.value ?? ""
        })
      ),
    apply: (dialog, projection) => {
      const input = dialog.querySelector<HTMLInputElement>(".provider-editor-model");
      if (!input) return;
      input.value = projection.value ?? "";
      input.required = projection.required === true;
    },
    read: (dialog) => {
      const input = dialog.querySelector<HTMLInputElement>(".provider-editor-model");
      return { value: input?.value ?? "", required: input?.required ?? false };
    }
  },

  protocolNotes: {
    project: (scope, draft) => {
      if (!scope.family.usesProtocol) return {};
      const text = protocolNotes(draft.protocol);
      return { hidden: !text, text };
    },
    html: (projection) =>
      `<p class="provider-editor-protocol-notes" ${projection.hidden ? "hidden" : ""}>${escapeHtml(projection.text ?? "")}</p>`,
    apply: (dialog, projection) => {
      const node = dialog.querySelector<HTMLElement>(".provider-editor-protocol-notes");
      if (!node) return;
      node.hidden = projection.hidden === true;
      node.textContent = projection.text ?? "";
    },
    read: (dialog) => {
      const node = dialog.querySelector<HTMLElement>(".provider-editor-protocol-notes");
      return { hidden: node?.hidden === true, text: node?.textContent ?? "" };
    }
  },

  catalogEmpty: {
    project: (scope, draft) => (scope.family.modelSource === "catalog" ? { hidden: draft.models.length > 0 } : {}),
    html: (projection) =>
      `<p class="provider-editor-catalog-empty" ${projection.hidden ? "hidden" : ""}>未添加模型</p>`,
    apply: (dialog, projection) => {
      const node = dialog.querySelector<HTMLElement>(".provider-editor-catalog-empty");
      if (node) node.hidden = projection.hidden === true;
    },
    read: (dialog) => ({ hidden: dialog.querySelector<HTMLElement>(".provider-editor-catalog-empty")?.hidden === true })
  }
};

// Modal 打开参数直达的投影上下文（state 的只读视图，会话打开时即就位）
export function sessionProjectionContext(): ProjectionContext {
  return { kind: state.kind, presets: state.presets, hasSavedKey: state.hasSavedKey };
}

// 每个字段的目标态（模板与重投影共用的唯一投影规则）
export function projectEditorFields(
  draft: EditorDraftView,
  ctx: ProjectionContext
): Record<ProjectionFieldKey, FieldProjection> {
  const scope = scopeOf(draft, ctx);
  return Object.fromEntries(
    (Object.entries(FIELDS) as [ProjectionFieldKey, FieldSpec][]).map(([key, spec]) => [
      key,
      spec.project(scope, draft)
    ])
  ) as Record<ProjectionFieldKey, FieldProjection>;
}

// 模板片段（每个字段的 DOM 形态各一份）：buildDialogHtml 只做布局拼装
export function projectionBlocks(
  draft: EditorDraftView,
  ctx: ProjectionContext
): Record<ProjectionFieldKey, string> {
  const scope = scopeOf(draft, ctx);
  return Object.fromEntries(
    (Object.entries(FIELDS) as [ProjectionFieldKey, FieldSpec][]).map(([key, spec]) => [
      key,
      spec.html(spec.project(scope, draft), scope)
    ])
  ) as Record<ProjectionFieldKey, string>;
}

// 重投影：把当前 draft 的目标态写回已渲染的字段节点（预设/协议切换与目录行
// 增删共用）。
export function renderProjection(
  draft: EditorDraftView | null = state.draft,
  ctx: ProjectionContext = sessionProjectionContext()
): void {
  const dialog = getDialog();
  if (!dialog || !draft) return;
  const scope = scopeOf(draft, ctx);
  for (const spec of Object.values(FIELDS)) {
    spec.apply(dialog, spec.project(scope, draft), scope);
  }
}

// 反向读取（核验用）：DOM 的可观察目标态，键集与 projectEditorFields 同形
export function readProjection(): Record<ProjectionFieldKey, FieldProjection> {
  const dialog = getDialog();
  if (!dialog) {
    return Object.fromEntries(
      (Object.keys(FIELDS) as ProjectionFieldKey[]).map((key) => [key, {}])
    ) as Record<ProjectionFieldKey, FieldProjection>;
  }
  return Object.fromEntries(
    (Object.entries(FIELDS) as [ProjectionFieldKey, FieldSpec][]).map(([key, spec]) => [key, spec.read(dialog)])
  ) as Record<ProjectionFieldKey, FieldProjection>;
}

// input 回写声明（DOM → draft）：文本字段的唯一写通道，模板与联动共用同一份表
export const DRAFT_INPUTS: readonly { key: DraftInputKey; selector: string; clearStatus: boolean }[] = (
  Object.values(FIELDS) as FieldSpec[]
).flatMap((spec) =>
  spec.input ? [{ key: spec.input.draftKey, selector: spec.input.selector, clearStatus: spec.input.clearStatus }] : []
);
