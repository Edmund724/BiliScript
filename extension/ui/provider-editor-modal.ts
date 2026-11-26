import { activeById, onActiveHostChange } from "../shared/active-host.js";
import { isNode, resolveNodeDocument, safeRemoveListener } from "../shared/cross-doc.js";
import { logWarn } from "../shared/logging.js";
import { escapeHtml } from "../shared/string-utils.js";

import { testAsrConnection } from "../asr/provider-test.js";
import { listAsrModels } from "../asr/provider-models.js";
import { listLiveModels, listLiveVoices, testLiveConnection } from "../live/live-provider-probe.js";
import { testSearchConnection } from "../search/provider-test.js";

import { wireModelPicker, type ModelPickerFetchResult } from "./model-picker.js";
import { initCustomSelect } from "./custom-select.js";
import { initToggleSwitch } from "./toggle-switch.js";
import { confirmDialog, isConfirmDialogOpen } from "./confirm-dialog.js";
import { ids } from "../reader/state.js";
import { hasReaderSettingsDropdownOpen } from "../reader/settings-mode.js";
import type { ProviderRowItem } from "./provider-row.js";
import { PROVIDER_FAMILY_ROWS } from "./provider-family.js";
import {
  beginEditorSession,
  applyEditorVoices,
  captureSession,
  cloneDraft,
  draftsEqual,
  editDraft,
  endEditorSession,
  getDialog,
  markEditorVoicesLoaded,
  normalizeDraftModels,
  runIfCurrent,
  state,
  type EditorDraft,
  type EditorDraftView,
  type LinkedCredentialAction,
  type ProviderEditorKind,
  type ProviderEditorOpenOptions
} from "./provider-editor-state.js";
import {
  DRAFT_INPUTS,
  isSavedKeyReconfirmRequired,
  normalizeProtocolValue,
  presetBaseUrlForProtocol,
  presetProtocol,
  projectEditorFields,
  projectionBlocks,
  renderProjection,
  sessionProjectionContext
} from "./provider-editor-projection.js";
import {
  addModelRow,
  modelRowHtml,
  primeModelCatalogMeta,
  refreshModelCatalogMeta,
  removeModelRow,
  runModelTest,
  showCatalogError
} from "./provider-editor-catalog.js";
import {
  closeFetchDialog,
  confirmFetchSelection,
  getFetchDialog,
  openFetchDialog
} from "./provider-editor-fetch-dialog.js";
import {
  createFocusScope,
  isolateHostSiblings,
  observeSettingsPanelHidden,
  type FocusScope
} from "./focus-scope.js";
import {
  animateTriggerEnter,
  cancelTriggerExit,
  resolveTriggerElement
} from "./trigger-motion.js";

interface PlatformProbeIo {
  readonly preflightOrigin: boolean;
  readonly fetchModels?: (params: {
    baseUrl: string;
    apiKey?: string;
    providerId?: string;
    type?: string;
  }) => Promise<ModelPickerFetchResult | null>;
  readonly probePlatform: (params: {
    id: string;
    presetId: string;
    name: string;
    type: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
    requiresKey: boolean;
  }) => Promise<{ ok?: boolean; message?: string; error?: string }>;
  readonly formatFailure: (error?: string) => string;
}

const PLATFORM_PROBE_IO: Partial<Record<ProviderEditorKind, PlatformProbeIo>> = {
  asr: {
    preflightOrigin: true,
    fetchModels: listAsrModels,
    probePlatform: ({ id, name, type, baseUrl, model, apiKey }) =>
      testAsrConnection({
        id,
        name,
        type: type || "openai-transcriptions",
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {})
      }),
    formatFailure: (error) => `失败：${error || "未知错误"}`
  },
  live: {
    preflightOrigin: true,
    fetchModels: listLiveModels,
    probePlatform: ({ id, presetId, name, type, baseUrl, model, apiKey }) =>
      testLiveConnection({
        id,
        presetId,
        name,
        type: type || "moss-live",
        baseUrl,
        model,
        ...(apiKey ? { apiKey } : {})
      }),
    formatFailure: (error) => `失败：${error || "未知错误"}`
  },
  search: {
    preflightOrigin: false,
    probePlatform: ({ id, presetId, type, baseUrl, apiKey, requiresKey }) =>
      testSearchConnection({
        id,
        presetId,
        type,
        baseUrl,
        apiKey,
        requiresKey
      }),
    formatFailure: (error) => error || "连接失败：未知错误"
  }
};

let focusScope: FocusScope | null = null;
let restoreSiblings: (() => void) | null = null;
let stopObservingSettingsHidden: (() => void) | null = null;
let boundDoc: Document | null = null;
let stopHostWatch: (() => void) | null = null;

function bindCaptureListeners(doc: Document): void {
  boundDoc = doc;
  boundDoc.addEventListener("click", onDocumentClickCapture, true);
  boundDoc.addEventListener("keydown", onDocumentKeyDownCapture, true);
}

function unbindCaptureListeners(): void {
  safeRemoveListener(boundDoc, "click", onDocumentClickCapture, true);
  safeRemoveListener(boundDoc, "keydown", onDocumentKeyDownCapture, true);
  boundDoc = null;
}
let saveInFlight = false;
let deleteInFlight = false;
let testInFlight = false;
let validationAttempted = false;
let validationStatusActive = false;
let reconfirmStatusActive = false;

type EditorFieldKey = "baseUrl" | "apiKey" | "model" | "models";

interface EditorFieldIssue {
  field: EditorFieldKey;
  message: string;
}

const VALIDATION_FIELD_DOM: Record<EditorFieldKey, { control: string; error: string }> = {
  baseUrl: { control: ".provider-editor-baseurl", error: "provider-editor-error-baseurl" },
  apiKey: { control: ".provider-editor-apikey", error: "provider-editor-error-apikey" },
  model: { control: ".provider-editor-model", error: "provider-editor-error-model" },
  models: { control: '[data-provider-editor-action="add-model"]', error: "provider-editor-error-models" }
};

const VALIDATION_FIELD_ORDER: readonly EditorFieldKey[] = ["baseUrl", "apiKey", "model", "models"];
const HTTP_URL_RE = /^https?:\/\/.+/i;

function issueForField(field: EditorFieldKey, draft: EditorDraftView): EditorFieldIssue | null {
  const family = PROVIDER_FAMILY_ROWS[state.kind];
  const preset = family.resolvePreset(state.presets, draft.presetId);
  if (field === "baseUrl") {
    const baseUrl = draft.baseUrl.trim();
    if (!baseUrl) return { field, message: "请填写 API 地址" };
    if (!HTTP_URL_RE.test(baseUrl)) return { field, message: "API 地址需以 http:// 或 https:// 开头" };
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
      if (isSavedKeyReconfirmRequired(draft)) {
        return { field, message: "已切换平台或地址，请重新确认 API Key" };
      }
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
  if (state.firstSetup && state.kind === "ai" && normalizeDraftModels(draft.models).length === 0) {
    return { field, message: "请至少添加一个模型后再保存" };
  }
  return null;
}

function validateEditorFields(): EditorFieldIssue[] {
  const draft = state.draft;
  if (!draft) return [];
  return VALIDATION_FIELD_ORDER.flatMap((field) => {
    const issue = issueForField(field, draft);
    return issue ? [issue] : [];
  });
}

function controlOfField(field: EditorFieldKey): HTMLElement | null {
  const dialog = getDialog();
  if (!dialog) return null;
  if (field === "models") {
    const emptyModelInput = Array.from(dialog.querySelectorAll<HTMLInputElement>(".provider-editor-model-id")).find(
      (input) => !input.value.trim()
    );
    if (emptyModelInput) return emptyModelInput;
  }
  return dialog.querySelector<HTMLElement>(VALIDATION_FIELD_DOM[field].control) ?? null;
}

function allControlsOfField(field: EditorFieldKey): HTMLElement[] {
  const dialog = getDialog();
  if (!dialog) return [];
  if (field === "models") {
    const inputs = Array.from(dialog.querySelectorAll<HTMLElement>(".provider-editor-model-id"));
    const addBtn = dialog.querySelector<HTMLElement>(VALIDATION_FIELD_DOM.models.control);
    return addBtn ? [...inputs, addBtn] : inputs;
  }
  const control = dialog.querySelector<HTMLElement>(VALIDATION_FIELD_DOM[field].control);
  return control ? [control] : [];
}

function errorNodeOfField(field: EditorFieldKey): HTMLElement | null {
  return getDialog()?.querySelector<HTMLElement>(`#${VALIDATION_FIELD_DOM[field].error}`) ?? null;
}

function clearFieldControlAttributes(field: EditorFieldKey): void {
  const errorId = VALIDATION_FIELD_DOM[field].error;
  for (const control of allControlsOfField(field)) {
    control.removeAttribute("aria-invalid");
    if (control.getAttribute("aria-describedby") === errorId) {
      control.removeAttribute("aria-describedby");
    }
  }
}

function showFieldIssue(issue: EditorFieldIssue): void {
  clearFieldControlAttributes(issue.field);
  const control = controlOfField(issue.field);
  const error = errorNodeOfField(issue.field);
  if (error) {
    error.hidden = false;
    error.textContent = issue.message;
  }
  if (control) {
    control.setAttribute("aria-invalid", "true");
    control.setAttribute("aria-describedby", VALIDATION_FIELD_DOM[issue.field].error);
  }
}

function clearFieldIssue(field: EditorFieldKey): void {
  const error = errorNodeOfField(field);
  if (error) {
    error.hidden = true;
    error.textContent = "";
  }
  clearFieldControlAttributes(field);
}

function renderEditorFieldIssues(issues: readonly EditorFieldIssue[]): void {
  for (const field of VALIDATION_FIELD_ORDER) {
    const issue = issues.find((entry) => entry.field === field);
    if (issue) showFieldIssue(issue);
    else clearFieldIssue(field);
  }
}

function revalidateEditorField(field: EditorFieldKey): void {
  if (!validationAttempted) return;
  const draft = state.draft;
  if (!draft) return;
  const issue = issueForField(field, draft);
  if (issue) showFieldIssue(issue);
  else clearFieldIssue(field);
}

function revalidateEditorFields(fields: readonly EditorFieldKey[]): EditorFieldIssue[] {
  const draft = state.draft;
  if (!draft) return [];
  const issues: EditorFieldIssue[] = [];
  for (const field of fields) {
    const issue = issueForField(field, draft);
    if (issue) {
      showFieldIssue(issue);
      issues.push(issue);
    } else {
      clearFieldIssue(field);
    }
  }
  return issues;
}

function focusEditorField(field: EditorFieldKey): void {
  const control = controlOfField(field);
  const error = errorNodeOfField(field);
  control?.focus();
  control?.scrollIntoView?.({ block: "nearest" });
  error?.scrollIntoView?.({ block: "nearest" });
}

function resetEditorValidation(): void {
  validationAttempted = false;
  renderEditorFieldIssues([]);
}

function validateBeforeFetchModels(): boolean {
  const draft = state.draft;
  if (!draft) return false;
  validationAttempted = true;
  const issues = revalidateEditorFields(["baseUrl", "apiKey"]);
  if (issues.length > 0) {
    const missingBoth =
      !draft.baseUrl.trim() &&
      !draft.apiKey.trim() &&
      issues.some((issue) => issue.field === "baseUrl") &&
      issues.some((issue) => issue.field === "apiKey");
    showCatalogError(missingBoth ? "请先填写 API 地址和 Key" : issues[0].message);
    focusEditorField(issues[0].field);
    return false;
  }
  showCatalogError("");
  return true;
}

function currentLinkedCredential(draft = state.draft): LinkedCredentialAction | null {
  if (state.resolveLinkedCredential && draft) {
    return state.resolveLinkedCredential(draft);
  }
  return state.linkedCredential;
}

function linkedCredentialInnerHtml(linkedCredential: LinkedCredentialAction | null): string {
  if (!linkedCredential) return "";
  return `<span class="provider-editor-linked-credential-text">${escapeHtml(linkedCredential.statusText || "")}</span>${
    linkedCredential.actionLabel
      ? `\n          <button type="button" class="provider-editor-linked-credential-btn" data-provider-editor-action="linked-credential">${escapeHtml(linkedCredential.actionLabel)}</button>`
      : ""
  }`;
}

function syncLinkedCredentialDom(): void {
  const container = getDialog()?.querySelector<HTMLElement>(".provider-editor-linked-credential");
  if (!container) return;
  const linked = currentLinkedCredential();
  if (!linked) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  container.hidden = false;
  container.innerHTML = linkedCredentialInnerHtml(linked);
}

function isMossLivePreset(preset: { id?: string; type?: string } | null | undefined): boolean {
  return preset?.type === "moss-live" || preset?.id === "moss-live";
}

function primeEditorVoices(): void {
  if (state.kind !== "live" || state.voicesLoaded) return;
  const draft = state.draft;
  if (!draft) return;
  const preset = PROVIDER_FAMILY_ROWS.live.resolvePreset(state.presets, draft.presetId);
  if (!isMossLivePreset(preset)) return;
  const baseUrl = draft.baseUrl.trim();
  const apiKey = draft.apiKey.trim();
  const reconfirmKey = isSavedKeyReconfirmRequired(draft);
  if (!baseUrl || (!apiKey && (!state.hasSavedKey || reconfirmKey))) return;
  void runIfCurrent(
    () => listLiveVoices({ baseUrl, apiKey, providerId: reconfirmKey ? "" : state.editingId }),
    {
      ok: (result) => {
        if (!result.ok) {
          markEditorVoicesLoaded();
          return;
        }
        applyEditorVoices(result.voices);
        renderProjection();
      },
      fail: () => {
        markEditorVoicesLoaded();
      }
    }
  );
}

function showStatus(text: string, isError = false): void {
  validationStatusActive = false;
  reconfirmStatusActive = false;
  const statusNode = getDialog()?.querySelector<HTMLElement>(".provider-editor-status");
  if (!statusNode) return;
  statusNode.hidden = false;
  statusNode.textContent = text;
  statusNode.dataset.error = isError ? "true" : "false";
}

function showValidationStatus(text: string): void {
  showStatus(text, true);
  validationStatusActive = true;
}

function showReconfirmStatus(): void {
  showStatus("已切换平台或地址，请重新确认 API Key", true);
  reconfirmStatusActive = true;
}

function syncReconfirmFeedback(): void {
  const draft = state.draft;
  if (!draft) return;
  const preset = PROVIDER_FAMILY_ROWS[state.kind].resolvePreset(state.presets, draft.presetId);
  const needsReconfirm = isSavedKeyReconfirmRequired(draft) && PROVIDER_FAMILY_ROWS[state.kind].editor.isKeyRequired(preset);
  if (validationAttempted) {
    return;
  }
  if (needsReconfirm) {
    showReconfirmStatus();
  } else if (reconfirmStatusActive) {
    clearStatus();
  }
}

function syncValidationStatus(): void {
  if (!validationStatusActive) return;
  const issues = validateEditorFields();
  if (issues.length > 0) {
    showValidationStatus(issues[0].message);
    return;
  }
  clearStatus();
}

function applyValidationState(): void {
  if (!validationAttempted) return;
  const issues = validateEditorFields();
  renderEditorFieldIssues(issues);
  if (issues.length > 0) {
    showValidationStatus(issues[0].message);
    return;
  }
  clearStatus();
}

function clearStatus(): void {
  validationStatusActive = false;
  reconfirmStatusActive = false;
  const statusNode = getDialog()?.querySelector<HTMLElement>(".provider-editor-status");
  if (!statusNode) return;
  statusNode.hidden = true;
  statusNode.textContent = "";
  statusNode.dataset.error = "false";
}

interface DraftChangeSyncOptions {
  project?: boolean;
  linkedCredential?: boolean;
  catalogMeta?: boolean;
  voices?: boolean;
  revalidate?: "all" | EditorFieldKey | null;
  clearStatusWhenIdle?: boolean;
  reconfirm?: boolean;
}

function syncAfterDraftChange(options: DraftChangeSyncOptions): void {
  if (options.project) renderProjection();
  if (options.linkedCredential) syncLinkedCredentialDom();
  if (options.catalogMeta) refreshModelCatalogMeta();
  if (options.revalidate === "all") {
    if (validationAttempted) {
      applyValidationState();
    } else if (options.clearStatusWhenIdle) {
      clearStatus();
    }
  } else if (options.revalidate) {
    revalidateEditorField(options.revalidate);
  }
  if (options.reconfirm) {
    syncReconfirmFeedback();
  }
  if (options.revalidate !== "all") {
    syncValidationStatus();
  }
  if (options.voices) primeEditorVoices();
}

const BUSY_CONTROL_SELECTOR = [
  ".provider-editor-test",
  ".provider-editor-save",
  ".provider-editor-delete",
  ".provider-editor-linked-credential-btn",
  ".provider-editor-fetch",
  ".provider-editor-model-add",
  ".provider-editor-model-remove",
  ".provider-editor-model-test",
  ".ai-provider-model-toggle",
  ".custom-select-trigger",
  ".provider-editor-preset",
  ".provider-editor-protocol",
  ".provider-editor-name",
  ".provider-editor-baseurl",
  ".provider-editor-apikey",
  ".provider-editor-model",
  ".provider-editor-model-id",
  ".provider-editor-voice",
  ".provider-editor-gemini-search"
].join(", ");

function setBusy(isBusy: boolean): void {
  getDialog()
    ?.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(BUSY_CONTROL_SELECTOR)
    .forEach((control) => {
      control.disabled = isBusy;
    });
}

function isDirty(): boolean {
  return (
    state.open &&
    state.draft !== null &&
    state.baselineDraft !== null &&
    !draftsEqual(state.draft, state.baselineDraft)
  );
}

export function closeProviderEditor(force = false): void {
  if (!state.open && !state.host) {
    if (force) {
      try {
        closeFetchDialog(false);
      } catch {
      }
      resetEditorValidation();
    }
    return;
  }
  if (state.open && !force && isDirty()) {
    void confirmDiscardChanges();
    return;
  }
  stopObservingSettingsHidden?.();
  stopObservingSettingsHidden = null;
  stopHostWatch?.();
  stopHostWatch = null;
  unbindCaptureListeners();
  try {
    try {
      closeFetchDialog(false);
    } catch {
    }
    try {
      restoreSiblings?.();
    } catch {
    }
    restoreSiblings = null;
    try {
      focusScope?.dispose();
    } catch {
    }
    focusScope = null;
  } finally {
    saveInFlight = false;
    deleteInFlight = false;
    testInFlight = false;
    validationStatusActive = false;
    reconfirmStatusActive = false;
    resetEditorValidation();
    endEditorSession();
  }
}

function requestClose(): void {
  if (!isDirty()) {
    closeProviderEditor(true);
    return;
  }
  void confirmDiscardChanges();
}

async function confirmDiscardChanges(): Promise<void> {
  const ok = await confirmDialog({
    title: "放弃更改",
    message: "未保存的更改将丢失，确定关闭？",
    confirmText: "放弃更改",
    danger: true,
    mountHost: state.host?.parentElement || undefined
  });
  if (ok) {
    closeProviderEditor(true);
  }
}

function collectUpsert(): { upsert: ProviderRowItem; validationError?: string } {
  const family = PROVIDER_FAMILY_ROWS[state.kind];
  const draft = state.draft!;
  const preset = family.resolvePreset(state.presets, draft.presetId);
  const reconfirmKey = isSavedKeyReconfirmRequired(draft);
  return family.editor.serializeUpsert({
    id: state.editingId,
    preset,
    name: draft.name.trim() || preset?.name || "自定义",
    baseUrl: draft.baseUrl.trim().replace(/\/+$/, ""),
    apiKey: draft.apiKey.trim(),
    hasSavedKey: state.hasSavedKey && !reconfirmKey,
    models: normalizeDraftModels(draft.models),
    model: draft.model.trim(),
    liveGeminiNativeSearch: draft.liveGeminiNativeSearch === true,
    voiceId: String(draft.voiceId || "").trim(),
    protocol: normalizeProtocolValue(draft.protocol)
  });
}

async function save(): Promise<void> {
  if (saveInFlight || deleteInFlight || testInFlight || isConfirmDialogOpen()) return;
  validationAttempted = true;
  const issues = validateEditorFields();
  renderEditorFieldIssues(issues);
  if (issues.length > 0) {
    showValidationStatus(issues[0].message);
    focusEditorField(issues[0].field);
    return;
  }
  const { upsert, validationError } = collectUpsert();
  if (validationError) {
    showStatus(validationError, true);
    return;
  }
  saveInFlight = true;
  setBusy(true);
  showStatus("正在保存...");
  await runIfCurrent(
    () => state.onSave(state.kind, upsert),
    {
      ok: (result) => {
        if (result.ok) {
          const afterSave = state.onAfterSave;
          if (afterSave) {
            try {
              afterSave();
            } catch {
            }
          }
          closeProviderEditor(true);
          return;
        }
        saveInFlight = false;
        setBusy(false);
        showStatus(
          result.permissionDenied
            ? `未保存：${result.error || "未取得该平台域名权限，保存已中止"}。请重新授权后重试`
            : result.error || "保存失败",
          true
        );
      },
      fail: (error) => {
        saveInFlight = false;
        setBusy(false);
        showStatus(`保存失败：${(error as Error).message || "未知错误"}`, true);
      }
    }
  );
}

async function deleteActive(): Promise<void> {
  if (saveInFlight || deleteInFlight || testInFlight || isConfirmDialogOpen()) return;
  const onDelete = state.onDelete;
  if (!state.editingId || !onDelete) return;
  const session = captureSession();
  const confirmed = await confirmDialog({
    title: "删除平台",
    message: "确定要删除这个平台吗？删除后需要重新配置。",
    confirmText: "删除",
    danger: true,
    mountHost: state.host?.parentElement || undefined
  });
  if (!confirmed || !session.isCurrent() || saveInFlight || deleteInFlight || testInFlight) {
    return;
  }
  deleteInFlight = true;
  setBusy(true);
  showStatus("正在删除...");
  await session.run(
    () =>
      onDelete(state.kind, {
        id: state.editingId,
        baseUrl: state.openBaseUrl
      }),
    {
      ok: (result) => {
        if (result.ok) {
          closeProviderEditor(true);
          return;
        }
        deleteInFlight = false;
        setBusy(false);
        showStatus(result.error || "删除失败", true);
      },
      fail: (error) => {
        deleteInFlight = false;
        setBusy(false);
        showStatus(`删除失败：${(error as Error).message || "未知错误"}`, true);
      }
    }
  );
}

async function runTest(): Promise<void> {
  if (saveInFlight || deleteInFlight || testInFlight || isConfirmDialogOpen()) return;
  const family = PROVIDER_FAMILY_ROWS[state.kind];
  const probeIo = PLATFORM_PROBE_IO[state.kind];
  const draft = state.draft;
  if (!family.editor.supportsPlatformTest || !probeIo || !draft) return;
  const baseUrl = draft.baseUrl.trim();
  const model = draft.model.trim();
  if (!baseUrl) {
    showStatus("请填写 API 地址", true);
    return;
  }
  if (family.editor.modelSource === "input" && !model) {
    showStatus("请填写模型名", true);
    return;
  }
  const preset = family.resolvePreset(state.presets, draft.presetId);
  const apiKey = draft.apiKey.trim();
  const reconfirmKey = isSavedKeyReconfirmRequired(draft);
  const requiresKey = family.editor.isKeyRequired(preset);
  if (!apiKey && reconfirmKey && requiresKey) {
    showReconfirmStatus();
    return;
  }
  testInFlight = true;
  setBusy(true);
  showStatus("正在测试...");
  const session = captureSession();
  const probeParams = {
    id: reconfirmKey ? "" : state.editingId,
    presetId: draft.presetId,
    name: draft.name.trim() || preset?.name || "自定义",
    type: preset?.type || "",
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
    requiresKey
  };
  const onOk = (resp: { ok?: boolean; message?: string; error?: string }): void => {
    testInFlight = false;
    setBusy(false);
    if (!resp?.ok) {
      showStatus(probeIo.formatFailure(resp?.error), true);
      return;
    }
    showStatus(resp.message || "连接成功");
  };
  const onFail = (error: unknown): void => {
    testInFlight = false;
    setBusy(false);
    showStatus(probeIo.formatFailure((error as Error)?.message), true);
  };
  if (probeIo.preflightOrigin) {
    await session.runWithOriginPreflight(
      family.editor.resolvePermissionOrigins(baseUrl, model),
      () => probeIo.probePlatform(probeParams),
      {
        denied: (error) => {
          testInFlight = false;
          setBusy(false);
          showStatus(
            `未测试：${error || "未取得该平台域名权限，无法测试连接"}。请重新授权后重试`,
            true
          );
        },
        ok: onOk,
        fail: onFail
      }
    );
    return;
  }
  await session.run(() => probeIo.probePlatform(probeParams), {
    ok: onOk,
    fail: onFail
  });
}

function editorTitle(kind: ProviderEditorKind, editing: boolean): string {
  const label = PROVIDER_FAMILY_ROWS[kind].editor.title;
  return editing ? `编辑${label}` : `添加${label}`;
}
function buildInitialDraft(options: ProviderEditorOpenOptions): EditorDraft {
  const item = options.item || null;
  const family = PROVIDER_FAMILY_ROWS[options.kind];
  const presetId = String(item?.presetId || options.presetId || family.editor.defaultPresetId(options.presets));
  const preset = family.resolvePreset(options.presets, presetId);
  const isAi = options.kind === "ai";
  const protocol = normalizeProtocolValue(item ? item.protocol : presetProtocol(preset));
  const presetName = preset?.name || "";
  const rawName = String(item?.name || "");
  return {
    presetId,
    name: isAi ? (rawName && rawName !== presetName ? rawName : "") : rawName || presetName,
    baseUrl: String(item?.baseUrl ?? (isAi ? presetBaseUrlForProtocol(preset, protocol) : preset?.baseUrl) ?? ""),
    apiKey: "",
    protocol: isAi ? protocol : "",
    models: isAi && Array.isArray(item?.models) ? item.models.map(String) : [],
    model: isAi ? "" : String(item?.model ?? preset?.model ?? ""),
    liveGeminiNativeSearch: options.kind === "live" ? item?.liveGeminiNativeSearch === true : false,
    voiceId: options.kind === "live" ? String(item?.voiceId || "") : ""
  };
}

function linkedCredentialHtml(linkedCredential: LinkedCredentialAction | null): string {
  return `
        <div class="provider-editor-linked-credential"${linkedCredential ? "" : " hidden"}>
          ${linkedCredentialInnerHtml(linkedCredential)}
        </div>`;
}

function buildDialogHtml(options: ProviderEditorOpenOptions): string {
  const item = options.item || null;
  const draft = state.draft;
  if (!draft) return "";
  const blocks = projectionBlocks(draft, sessionProjectionContext());
  const isAi = options.kind === "ai";
  const isSearch = options.kind === "search";
  const models = draft.models;
  const title = editorTitle(options.kind, Boolean(item?.id));
  const linkedCredential = currentLinkedCredential(draft);

  return `
    <div class="provider-editor-mask" data-provider-editor-action="close"></div>
    <section class="provider-editor-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" tabindex="-1">
      <header class="provider-editor-head">
        <span class="provider-editor-title">${escapeHtml(title)}</span>
        ${item?.id && options.onDelete ? `<button type="button" class="provider-editor-delete" data-provider-editor-action="delete" title="删除该平台">删除</button>` : ""}
      </header>
      <form class="provider-editor-form" novalidate>
        <div class="provider-editor-body">
          <p class="provider-editor-context-banner"${state.setupContextBanner ? "" : " hidden"}>${escapeHtml(state.setupContextBanner || "")}</p>
          ${blocks.preset}
          ${isAi ? `\n        ${blocks.protocol}` : ""}
          ${blocks.name}
          ${blocks.baseUrl}
          ${blocks.apiKey}
          ${isAi
            ? `
        <div class="provider-editor-field provider-editor-catalog">
          <div class="provider-editor-catalog-head">
            <label class="provider-editor-label">模型</label>
            <button type="button" class="provider-editor-fetch" data-provider-editor-action="fetch-models">获取可用模型</button>
          </div>
          <div class="provider-editor-model-list">
            ${models.map((m) => modelRowHtml(m)).join("")}
          </div>
          ${blocks.catalogEmpty}
          <p class="provider-editor-catalog-error" hidden></p>
          <button type="button" class="provider-editor-model-add" data-provider-editor-action="add-model">+ 添加模型</button>
          <p class="provider-editor-field-error" id="provider-editor-error-models" hidden></p>
        </div>
        ${blocks.protocolNotes}`
            : isSearch
              ? `
        ${linkedCredentialHtml(linkedCredential)}
        <div class="provider-editor-testrow">
          <button type="button" class="provider-editor-test" data-provider-editor-action="test" title="会真实发起一次搜索，占用一次平台额度" aria-describedby="provider-editor-test-hint">测试</button>
          <p class="provider-editor-test-hint" id="provider-editor-test-hint">会真实发起一次搜索，占用一次平台额度</p>
        </div>`
              : `
        ${blocks.model}
        ${blocks.voice}
        ${blocks.liveGeminiNativeSearch}
        ${linkedCredentialHtml(linkedCredential)}
        <div class="provider-editor-testrow">
          <button type="button" class="provider-editor-test" data-provider-editor-action="test">测试</button>
        </div>`}
        </div>
        <p class="provider-editor-status" role="status" aria-live="polite" hidden></p>
        <footer class="provider-editor-foot">
          <button type="button" class="provider-editor-cancel" data-provider-editor-action="close">${escapeHtml(options.cancelLabel?.trim() || "取消")}</button>
          <button type="submit" class="provider-editor-save" data-provider-editor-action="save">${escapeHtml(options.submitLabel?.trim() || "保存")}</button>
        </footer>
      </form>
    </section>
  `;
}

function ensureHost(mountHost?: HTMLElement): HTMLElement | null {
  const view = mountHost || activeById(ids.readingView);
  if (!view) {
    return null;
  }
  view.querySelectorAll<HTMLElement>('.provider-editor-host[data-biliscript-closing="1"]').forEach((el) => {
    cancelTriggerExit(el);
  });
  const host = resolveNodeDocument(view).createElement("div");
  host.className = "provider-editor-host";
  view.appendChild(host);
  return host;
}

function onDocumentClickCapture(event: MouseEvent): void {
  if (!state.open) return;
  if (isConfirmDialogOpen() || hasReaderSettingsDropdownOpen()) return;
  const view = state.host?.parentElement || activeById(ids.readingView);
  if (view && isNode(event.target) && view.contains(event.target)) {
    return;
  }
  event.stopPropagation();
  requestClose();
}

function onDocumentKeyDownCapture(event: KeyboardEvent): void {
  if (!state.open || event.key !== "Escape") return;
  if (isConfirmDialogOpen() || hasReaderSettingsDropdownOpen()) return;
  event.preventDefault();
  event.stopPropagation();
  if (getFetchDialog()) {
    closeFetchDialog();
    return;
  }
  requestClose();
}

function wireDialog(): void {
  const dialog = getDialog();
  const host = state.host;
  if (!dialog || !host) return;
  const family = PROVIDER_FAMILY_ROWS[state.kind];

  host.addEventListener("click", (event) => {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>("[data-provider-editor-action]")?.dataset.providerEditorAction;
    if (action === "close") requestClose();
    else if (action === "save") {
      event.preventDefault();
      void save();
    }
    else if (action === "test") void runTest();
    else if (action === "delete") void deleteActive();
    else if (action === "linked-credential") {
      try {
        currentLinkedCredential()?.onAction?.();
      } catch (error) {
        logWarn("[BILISCRIPT] linked credential action failed", error);
        showStatus(error instanceof Error && error.message ? error.message : "打开关联凭据设置失败", true);
      }
    }
    else if (action === "add-model") {
      addModelRow();
      syncAfterDraftChange({ revalidate: "models" });
    }
    else if (action === "remove-model") {
      removeModelRow(target.closest<HTMLElement>(".provider-editor-model-row"));
      syncAfterDraftChange({ revalidate: "models" });
    }
    else if (action === "test-model") void runModelTest(target.closest<HTMLElement>(".provider-editor-model-row"), isDirty());
    else if (action === "fetch-models") void openFetchDialog(validateBeforeFetchModels);
    else if (action === "close-fetch") closeFetchDialog();
    else if (action === "confirm-fetch") {
      confirmFetchSelection();
      syncAfterDraftChange({ revalidate: "models" });
    }
    else if (action === "retry-fetch") void openFetchDialog(validateBeforeFetchModels);
  });

  dialog.querySelector<HTMLFormElement>(".provider-editor-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void save();
  });

  const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset");

  presetSelect?.addEventListener("change", () => {
    const next = family.resolvePreset(state.presets, presetSelect.value);
    const draft = state.draft;
    if (!next || !draft) return;
    const previous = family.resolvePreset(state.presets, draft.presetId);
    const currentBaseUrl = draft.baseUrl.trim();
    editDraft((current) => {
      current.presetId = next.id;
      if (state.kind === "ai") {
        if (!current.protocol || current.protocol === presetProtocol(previous)) {
          current.protocol = presetProtocol(next);
        }
        const previousBaseUrl = previous ? presetBaseUrlForProtocol(previous, current.protocol) : "";
        if (!currentBaseUrl || currentBaseUrl === previousBaseUrl) {
          current.baseUrl = presetBaseUrlForProtocol(next, current.protocol);
        }
        const currentName = current.name.trim();
        if (!currentName || (previous && currentName === previous.name)) {
          current.name = "";
        }
      } else {
        if (!currentBaseUrl || (previous && currentBaseUrl === String(previous.baseUrl || ""))) {
          current.baseUrl = next.baseUrl || "";
        }
        if (family.editor.modelSource === "input") {
          current.model = next.model || "";
        }
        const currentName = current.name.trim();
        if (!currentName || (previous && currentName === previous.name)) {
          current.name = next.name || "";
        }
        if (next.requiresKey === false) {
          current.apiKey = "";
        }
      }
    });
    syncAfterDraftChange({
      project: true,
      linkedCredential: true,
      catalogMeta: true,
      voices: true,
      revalidate: "all",
      clearStatusWhenIdle: true,
      reconfirm: true
    });
  });
  if (presetSelect) {
    initCustomSelect(presetSelect, "custom-select-wrapper provider-editor-preset-wrapper");
  }

  const protocolSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol");
  if (protocolSelect) {
    initCustomSelect(protocolSelect, "custom-select-wrapper provider-editor-protocol-wrapper");
    protocolSelect.addEventListener("change", () => {
      const draft = state.draft;
      if (!draft) return;
      if (state.kind === "ai") {
        const previous = normalizeProtocolValue(draft.protocol);
        const next = normalizeProtocolValue(protocolSelect.value);
        editDraft((current) => {
          current.protocol = next;
          const preset = family.resolvePreset(state.presets, current.presetId);
          const currentBaseUrl = current.baseUrl.trim();
          if (preset && (!currentBaseUrl || currentBaseUrl === presetBaseUrlForProtocol(preset, previous))) {
            current.baseUrl = presetBaseUrlForProtocol(preset, next);
          }
        });
      }
      syncAfterDraftChange({
        project: true,
        linkedCredential: true,
        catalogMeta: true,
        revalidate: "all",
        reconfirm: true
      });
    });
  }

  const geminiSearchInput = dialog.querySelector<HTMLInputElement>(".provider-editor-gemini-search");
  if (geminiSearchInput) {
    initToggleSwitch(geminiSearchInput);
    geminiSearchInput.addEventListener("change", () => {
      editDraft((draft) => {
        draft.liveGeminiNativeSearch = geminiSearchInput.checked;
      });
    });
  }

  const voiceSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-voice");
  if (voiceSelect) {
    initCustomSelect(voiceSelect, "custom-select-wrapper provider-editor-voice-wrapper");
    voiceSelect.addEventListener("change", () => {
      editDraft((draft) => {
        draft.voiceId = voiceSelect.value;
      });
      clearStatus();
    });
  }

  for (const field of DRAFT_INPUTS) {
    const input = dialog.querySelector<HTMLInputElement>(field.selector);
    input?.addEventListener("input", () => {
      editDraft((draft) => {
        draft[field.key] = input.value;
      });
      syncAfterDraftChange({
        project: field.key === "baseUrl" || field.key === "apiKey",
        linkedCredential: field.key === "baseUrl",
        catalogMeta: field.key === "baseUrl",
        revalidate: field.key !== "name" ? field.key : null,
        reconfirm: field.key === "baseUrl" || field.key === "apiKey"
      });
    });
  }
  dialog.querySelector<HTMLElement>(".provider-editor-model-list")?.addEventListener("input", (event) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("provider-editor-model-id")) return;
    const list = target.closest<HTMLElement>(".provider-editor-model-list");
    if (!list) return;
    editDraft((draft) => {
      draft.models = Array.from(list.querySelectorAll<HTMLInputElement>(".provider-editor-model-id")).map(
        (input) => input.value
      );
    });
    syncAfterDraftChange({
      catalogMeta: true,
      revalidate: "models"
    });
  });

  const probeIo = PLATFORM_PROBE_IO[state.kind];
  const fetchModels = probeIo?.fetchModels;
  if (family.editor.modelSource === "input" && fetchModels) {
    wireModelPicker(dialog, {
      inputClass: "provider-editor-model",
      baseUrlClass: "provider-editor-baseurl",
      apiKeyClass: "provider-editor-apikey",
      statusClass: "provider-editor-status",
      showStatus: (_node, text, isError) => showStatus(text, isError),
      fetchModels: ({ baseUrl, apiKey, providerId }) => {
        const preset = family.resolvePreset(state.presets, state.draft?.presetId || "");
        const reconfirmKey = isSavedKeyReconfirmRequired();
        return fetchModels({
          baseUrl,
          apiKey,
          providerId: reconfirmKey ? "" : (providerId || state.editingId),
          type: preset?.type
        });
      },
      isKeyRequired: () => {
        const draft = state.draft;
        const preset = family.resolvePreset(state.presets, draft?.presetId || "");
        if (preset?.requiresKey === false) return false;
        try {
          const url = new URL(draft?.baseUrl || "");
          if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return false;
        } catch {
        }
        return family.editor.isKeyRequired(preset);
      },
      hasSavedKey: () => Boolean(state.hasSavedKey && !isSavedKeyReconfirmRequired())
    });
  }
}

export function openProviderEditor(options: ProviderEditorOpenOptions): void {
  const trigger = resolveTriggerElement();
  closeProviderEditor(true);
  const host = ensureHost(options.mountHost);
  if (!host) {
    return;
  }
  const initialDraft = options.initialDraft ? cloneDraft(options.initialDraft) : buildInitialDraft(options);
  beginEditorSession({
    kind: options.kind,
    host,
    trigger,
    presets: options.presets,
    onSave: options.onSave,
    onDelete: options.onDelete || null,
    editingId: String(options.item?.id || ""),
    openBaseUrl: String(options.item?.baseUrl || ""),
    openPresetId: String(options.item?.presetId || initialDraft.presetId || ""),
    hasSavedKey: Boolean(options.item?.hasSavedKey),
    firstSetup: options.firstSetup === true,
    onAfterSave: options.onAfterSave ?? null,
    onSessionEnd: options.onSessionEnd ?? null,
    linkedCredential: options.linkedCredential ?? null,
    resolveLinkedCredential: options.resolveLinkedCredential ?? null,
    setupContextBanner: options.setupContextBanner ?? null,
    draft: initialDraft,
    ...(options.baselineDraft !== undefined ? { baselineDraft: options.baselineDraft } : {})
  });
  host.innerHTML = buildDialogHtml(options);
  restoreSiblings = isolateHostSiblings(host);
  renderProjection();
  wireDialog();
  resetEditorValidation();
  if (options.initialStatus?.message) {
    showStatus(options.initialStatus.message, options.initialStatus.isError === true);
  }
  const dialog = getDialog();
  if (dialog) {
    animateTriggerEnter({
      target: dialog,
      mask: host.querySelector<HTMLElement>(".provider-editor-mask"),
      trigger,
      fallbackOrigin: "top right",
      fromScale: 0.94,
      durationMs: 200
    });
    focusScope = createFocusScope(dialog, {
      initialFocus: dialog,
      isActive: () => !isConfirmDialogOpen() && !getFetchDialog()
    });
  }
  primeEditorVoices();
  bindCaptureListeners(resolveNodeDocument(host));
  stopHostWatch?.();
  stopHostWatch = onActiveHostChange((ctx) => {
    if (!state.open) return;
    unbindCaptureListeners();
    let sameHost = false;
    try {
      sameHost = Boolean(state.host?.isConnected && state.host.ownerDocument === ctx.doc);
    } catch {
      sameHost = false;
    }
    if (sameHost) {
      bindCaptureListeners(ctx.doc);
      return;
    }
    closeProviderEditor(true);
  });
  stopObservingSettingsHidden = observeSettingsPanelHidden(() => closeProviderEditor(true));
  if (PROVIDER_FAMILY_ROWS[options.kind].editor.modelSource === "catalog") {
    void primeModelCatalogMeta();
  }
  if (dialog && options.initialFocusField === "apiKey") {
    dialog.querySelector<HTMLElement>(".provider-editor-apikey")?.focus({ preventScroll: true });
  } else if (dialog && options.initialFocusField === "models") {
    dialog
      .querySelector<HTMLElement>(
        '[data-provider-editor-action="add-model"], .provider-editor-model-input, .provider-editor-model'
      )
      ?.focus({ preventScroll: true });
  }
}

export interface ProviderEditorDraftStash {
  editingId: string;
  draft: EditorDraft;
  baseline: EditorDraft;
}

export function stashProviderEditorDraft(kind: "live" | "search"): ProviderEditorDraftStash | null {
  if (!state.open || state.kind !== kind || !state.draft || !state.baselineDraft || !state.host) {
    return null;
  }
  return {
    editingId: state.editingId,
    draft: cloneDraft(state.draft),
    baseline: cloneDraft(state.baselineDraft)
  };
}

export function isProviderEditorOpen(): boolean {
  return state.open;
}
