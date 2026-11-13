// extension/ui/provider-editor-validation.ts
// 平台编辑 Modal 的字段级校验：提交时把错误定位到具体控件（错误文案 +
// aria-invalid / aria-describedby + 聚焦首个无效字段），交互修正后只清掉
// 已解决字段的错误。
//
// 校验读 draft（真源），DOM 形态来自投影片的字段表：required / hidden 与模板
// 同源，不另写一份判据。首配 AI 至少一个模型的门槛也只在这里与保存动作各引用
// 一次（同一份状态判据）。

import { PROVIDER_FAMILY_ROWS } from "./provider-family.js";
import { getDialog, state, type EditorDraftView } from "./provider-editor-state.js";
import { projectEditorFields, sessionProjectionContext } from "./provider-editor-projection.js";

export type EditorFieldKey = "baseUrl" | "apiKey" | "model" | "models";

export interface EditorFieldIssue {
  field: EditorFieldKey;
  message: string;
}

interface FieldDom {
  control: string;
  error: string;
}

const FIELD_DOM: Record<EditorFieldKey, FieldDom> = {
  baseUrl: { control: ".provider-editor-baseurl", error: "provider-editor-error-baseurl" },
  apiKey: { control: ".provider-editor-apikey", error: "provider-editor-error-apikey" },
  model: { control: ".provider-editor-model", error: "provider-editor-error-model" },
  models: { control: '[data-provider-editor-action="add-model"]', error: "provider-editor-error-models" }
};

// 提交过校验之后才在输入修正时重算（保留「交互后校验」：未提交前不因打字报错）
let attempted = false;

const HTTP_URL = /^https?:\/\/.+/i;

function issueFor(field: EditorFieldKey, draft: EditorDraftView): EditorFieldIssue | null {
  const family = PROVIDER_FAMILY_ROWS[state.kind];
  const preset = family.resolvePreset(state.presets, draft.presetId);
  if (field === "baseUrl") {
    const baseUrl = draft.baseUrl.trim();
    if (!baseUrl) return { field, message: "请填写 API 地址" };
    if (!HTTP_URL.test(baseUrl)) return { field, message: "API 地址需以 http:// 或 https:// 开头" };
    try {
      new URL(baseUrl);
    } catch {
      return { field, message: "请输入合法的 API 地址" };
    }
    return null;
  }
  if (field === "apiKey") {
    const projection = projectEditorFields(draft, sessionProjectionContext()).apiKey;
    if (projection.hidden) return null;
    if (projection.required && !draft.apiKey.trim()) {
      const name = draft.name.trim() || preset?.name || "自定义";
      return { field, message: `平台「${name}」需要填写 API Key` };
    }
    return null;
  }
  if (field === "model") {
    if (family.editor.modelSource !== "input") return null;
    if (!draft.model.trim()) return { field, message: "请填写模型名" };
    return null;
  }
  // 首配模式（票 01）：首个 AI 平台至少一个模型才可续跑；普通编辑仍允许空目录
  //（multi-model-catalog Q13）
  if (state.firstSetup && state.kind === "ai" && draft.models.length === 0) {
    return { field, message: "请至少添加一个模型后再保存" };
  }
  return null;
}

// 当前 draft 的全部字段问题（按表单内控件顺序，供聚焦首个无效字段）。
export function validateEditorFields(): EditorFieldIssue[] {
  const draft = state.draft;
  if (!draft) return [];
  const order: EditorFieldKey[] = ["baseUrl", "apiKey", "model", "models"];
  return order.flatMap((field) => {
    const issue = issueFor(field, draft);
    return issue ? [issue] : [];
  });
}

function controlOf(field: EditorFieldKey): HTMLElement | null {
  return getDialog()?.querySelector<HTMLElement>(FIELD_DOM[field].control) ?? null;
}

function errorOf(field: EditorFieldKey): HTMLElement | null {
  return getDialog()?.querySelector<HTMLElement>(`#${FIELD_DOM[field].error}`) ?? null;
}

function showIssue(issue: EditorFieldIssue): void {
  const control = controlOf(issue.field);
  const error = errorOf(issue.field);
  if (error) {
    error.hidden = false;
    error.textContent = issue.message;
  }
  if (control) {
    control.setAttribute("aria-invalid", "true");
    control.setAttribute("aria-describedby", FIELD_DOM[issue.field].error);
  }
}

function clearIssue(field: EditorFieldKey): void {
  const control = controlOf(field);
  const error = errorOf(field);
  if (error) {
    error.hidden = true;
    error.textContent = "";
  }
  if (control) {
    control.removeAttribute("aria-invalid");
    if (control.getAttribute("aria-describedby") === FIELD_DOM[field].error) {
      control.removeAttribute("aria-describedby");
    }
  }
}

// 把一次校验结果落到 DOM：未出现在结果里的字段清空错误（已解决）。
export function renderEditorFieldIssues(issues: readonly EditorFieldIssue[]): void {
  const keys = Object.keys(FIELD_DOM) as EditorFieldKey[];
  for (const field of keys) {
    const issue = issues.find((entry) => entry.field === field);
    if (issue) showIssue(issue);
    else clearIssue(field);
  }
}

// 提交时进入校验态，并给出首个无效字段的聚焦目标。
export function beginEditorValidation(): void {
  attempted = true;
}

// 输入修正：只重算被修正字段的错误；未提交过校验时不动 DOM。
export function revalidateEditorField(field: EditorFieldKey): void {
  if (!attempted) return;
  const draft = state.draft;
  if (!draft) return;
  const issue = issueFor(field, draft);
  if (issue) showIssue(issue);
  else clearIssue(field);
}

// 预设 / 协议切换可能改变 required 与联动值：由 Modal 取 validateEditorFields
// 后统一 renderEditorFieldIssues，不另设入口。

export function focusEditorField(field: EditorFieldKey): void {
  controlOf(field)?.focus();
}

export function isEditorValidationAttempted(): boolean {
  return attempted;
}

// 会话打开时归零：新会话的首次提交前不展示任何字段错误。
export function resetEditorValidation(): void {
  attempted = false;
  renderEditorFieldIssues([]);
}
