import { escapeHtml } from "../shared/string-utils.js";
import { usesAiCredentialReference } from "../core/ai-credential-reference.js";
import { requestProviderOriginsViaBackground } from "../core/host-permissions.js";
import type { AiProtocol } from "../ai/protocol-vocab.js";
import { listLiveVoices } from "../live/live-provider-probe.js";
import type { LiveVoice } from "../live/live-provider-store.js";
import { confirmDialog } from "./confirm-dialog.js";
import {
  KEY_RECONFIRM_MESSAGE,
  applyFieldIssueDom,
  applyFieldProjection,
  focusEditorField,
  isMossLivePreset,
  issueForEditorField,
  normalizeProtocolValue,
  presetBaseUrlForProtocol,
  presetProtocol,
  renderEditorFieldIssues,
  validateEditorFields,
  type EditorFieldIssue,
  type EditorFieldKey,
  type ProjectionContext
} from "./provider-editor-projection.js";
import { modelRowHtml, refreshModelCatalogMeta, showCatalogError } from "./provider-editor-model-rows.js";
import { PROVIDER_FAMILY_ROWS } from "./provider-family.js";
import type { ProviderRowItem, ProviderRowPreset } from "./provider-row.js";
import { animateTriggerExit } from "./trigger-motion.js";

export type ProviderEditorKind = "ai" | "asr" | "search" | "live";

export interface EditorDraft {
  presetId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol: AiProtocol | "";
  models: string[];
  model: string;
  liveGeminiNativeSearch?: boolean;
  voiceId?: string;
}

export type EditorDraftView = Readonly<Omit<EditorDraft, "models">> & { readonly models: readonly string[] };

export type ProviderEditorSave = (
  kind: ProviderEditorKind,
  upsert: ProviderRowItem
) => Promise<{ ok: boolean; error?: string; permissionDenied?: boolean }>;

export type ProviderEditorDelete = (
  kind: ProviderEditorKind,
  target: { id: string; baseUrl: string }
) => Promise<{ ok: boolean; error?: string }>;

export interface LinkedCredentialAction {
  statusText: string;
  actionLabel?: string;
  onAction?: () => void;
}

export interface ProviderEditorOpenOptions {
  kind: ProviderEditorKind;
  item?: ProviderRowItem | null;
  presetId?: string;
  presets: readonly ProviderRowPreset[];
  mountHost?: HTMLElement;
  onSave: ProviderEditorSave;
  onDelete?: ProviderEditorDelete;
  submitLabel?: string;
  firstSetup?: boolean;
  onAfterSave?: (() => void) | null;
  onSessionEnd?: (() => void) | null;
  cancelLabel?: string;
  initialDraft?: EditorDraft;
  baselineDraft?: EditorDraftView;
  linkedCredential?: LinkedCredentialAction | null;
  resolveLinkedCredential?: ((draft: EditorDraftView) => LinkedCredentialAction | null) | null;
  setupContextBanner?: string | null;
  initialStatus?: { message: string; isError?: boolean } | null;
  initialFocusField?: "apiKey" | "models";
}

export interface ProviderEditorDraftStash {
  editingId: string;
  draft: EditorDraft;
  baseline: EditorDraft;
}

export type { EditorFieldIssue, EditorFieldKey };

export interface DraftChangeSyncOptions {
  project?: boolean;
  linkedCredential?: boolean;
  catalogMeta?: boolean;
  voices?: boolean;
  revalidate?: "all" | EditorFieldKey | null;
  clearStatusWhenIdle?: boolean;
  reconfirm?: boolean;
}

export interface KeyReconfirmState {
  changed: boolean;
  required: boolean;
  effectiveHasSavedKey: boolean;
  remoteProviderId: string;
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

export function cloneDraft(draft: EditorDraftView): EditorDraft {
  return { ...draft, models: [...draft.models] };
}

export function draftsEqual(a: EditorDraftView, b: EditorDraftView): boolean {
  return (
    a.presetId === b.presetId &&
    a.name === b.name &&
    a.baseUrl === b.baseUrl &&
    a.apiKey === b.apiKey &&
    a.protocol === b.protocol &&
    a.model === b.model &&
    a.models.length === b.models.length &&
    a.models.every((model, index) => model === b.models[index]) &&
    Boolean(a.liveGeminiNativeSearch) === Boolean(b.liveGeminiNativeSearch) &&
    String(a.voiceId || "") === String(b.voiceId || "")
  );
}

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

export function buildInitialDraft(options: ProviderEditorOpenOptions): EditorDraft {
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

export function linkedCredentialInnerHtml(linkedCredential: LinkedCredentialAction | null): string {
  if (!linkedCredential) return "";
  return `<span class="provider-editor-linked-credential-text">${escapeHtml(linkedCredential.statusText || "")}</span>${
    linkedCredential.actionLabel
      ? `\n          <button type="button" class="provider-editor-linked-credential-btn" data-provider-editor-action="linked-credential">${escapeHtml(linkedCredential.actionLabel)}</button>`
      : ""
  }`;
}

export class ProviderEditorSession {
  readonly kind: ProviderEditorKind;
  readonly host: HTMLElement;
  readonly trigger: Element | null;
  readonly presets: readonly ProviderRowPreset[];
  readonly onSave: ProviderEditorSave;
  readonly onDelete: ProviderEditorDelete | null;
  readonly editingId: string;
  readonly openBaseUrl: string;
  readonly openPresetId: string;
  readonly hasSavedKey: boolean;
  readonly firstSetup: boolean;
  readonly onAfterSave: (() => void) | null;
  readonly onSessionEnd: (() => void) | null;
  readonly linkedCredential: LinkedCredentialAction | null;
  readonly resolveLinkedCredential: ((draft: EditorDraftView) => LinkedCredentialAction | null) | null;
  readonly setupContextBanner: string | null;
  readonly baselineDraft: EditorDraft;
  readonly draft: EditorDraft;
  readonly options: ProviderEditorOpenOptions;

  saveInFlight = false;
  deleteInFlight = false;
  testInFlight = false;

  private readonly onDisposeSelf: () => void;
  private readonly cleanups: Array<() => void> = [];
  private closed = false;
  private voices: LiveVoice[] = [];
  private voicesLoaded = false;
  private validationAttempted = false;
  private validationStatusActive = false;
  private reconfirmStatusActive = false;

  constructor(
    options: ProviderEditorOpenOptions,
    host: HTMLElement,
    trigger: Element | null,
    onDisposeSelf: () => void
  ) {
    this.options = options;
    this.onDisposeSelf = onDisposeSelf;
    this.kind = options.kind;
    this.host = host;
    this.trigger = trigger;
    this.presets = options.presets;
    this.onSave = options.onSave;
    this.onDelete = options.onDelete || null;
    this.editingId = String(options.item?.id || "");
    this.openBaseUrl = String(options.item?.baseUrl || "");
    this.draft = options.initialDraft ? cloneDraft(options.initialDraft) : buildInitialDraft(options);
    this.openPresetId = String(options.item?.presetId || this.draft.presetId || "");
    this.hasSavedKey = Boolean(options.item?.hasSavedKey);
    this.firstSetup = options.firstSetup === true;
    this.onAfterSave = options.onAfterSave ?? null;
    this.onSessionEnd = options.onSessionEnd ?? null;
    this.linkedCredential = options.linkedCredential ?? null;
    this.resolveLinkedCredential = options.resolveLinkedCredential ?? null;
    this.setupContextBanner = options.setupContextBanner?.trim() || null;
    this.baselineDraft = cloneDraft(options.baselineDraft ?? this.draft);
  }

  registerCleanup(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }

  isOpen(): boolean {
    return !this.closed;
  }

  isActionBusy(): boolean {
    return this.saveInFlight || this.deleteInFlight || this.testInFlight;
  }

  isDirty(): boolean {
    return !this.closed && !draftsEqual(this.draft, this.baselineDraft);
  }

  getDialog(): HTMLElement | null {
    return this.host.querySelector<HTMLElement>(".provider-editor-dialog");
  }

  stashDraft(kind: "live" | "search"): ProviderEditorDraftStash | null {
    if (this.closed || this.kind !== kind) return null;
    return {
      editingId: this.editingId,
      draft: cloneDraft(this.draft),
      baseline: cloneDraft(this.baselineDraft)
    };
  }

  requestClose(force: boolean): void {
    if (this.closed) return;
    if (!force && this.isDirty()) {
      void this.confirmDiscardChanges();
      return;
    }
    this.dispose();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onDisposeSelf();
    try {
      for (const cleanup of this.cleanups.splice(0).reverse()) {
        try {
          cleanup();
        } catch {}
      }
    } finally {
      this.saveInFlight = false;
      this.deleteInFlight = false;
      this.testInFlight = false;
      this.validationStatusActive = false;
      this.reconfirmStatusActive = false;
      this.resetValidation();
      this.removeHost();
      if (this.onSessionEnd) {
        try {
          this.onSessionEnd();
        } catch {}
      }
    }
  }

  async runIfCurrent<T>(
    work: () => Promise<T> | T,
    branches: { ok: (value: T) => void; fail?: (error: unknown) => void },
    alive?: () => boolean
  ): Promise<void> {
    const isAlive = (): boolean => !this.closed && (alive ? alive() : true);
    let value: T;
    try {
      value = await work();
    } catch (error) {
      if (!isAlive()) return;
      if (!branches.fail) throw error;
      branches.fail(error);
      return;
    }
    if (!isAlive()) return;
    branches.ok(value);
  }

  runWithOriginPreflight<T>(
    urls: readonly string[],
    work: () => Promise<T> | T,
    branches: {
      ok: (value: T) => void;
      fail?: (error: unknown) => void;
      denied?: (error: string) => void;
      alive?: () => boolean;
      workAlive?: () => boolean;
    }
  ): Promise<void> {
    const permissionPromise = requestProviderOriginsViaBackground([...urls]);
    const isAlive = (): boolean => !this.closed && (branches.alive ? branches.alive() : true);
    const isWorkAlive = (): boolean => isAlive() && (branches.workAlive ? branches.workAlive() : true);
    return (async () => {
      let permission: { ok: boolean; error?: string };
      try {
        permission = await permissionPromise;
      } catch (error) {
        if (!isAlive()) return;
        if (branches.fail) {
          branches.fail(error);
        } else {
          throw error;
        }
        return;
      }
      if (!isAlive()) return;
      if (!permission.ok) {
        if (!isWorkAlive()) return;
        if (branches.denied) {
          branches.denied(permission.error || "未取得该平台域名权限，无法继续");
        } else if (branches.fail) {
          branches.fail(new Error(permission.error || "未取得该平台域名权限，无法继续"));
        }
        return;
      }
      let value: T;
      try {
        value = await work();
      } catch (error) {
        if (!isWorkAlive()) return;
        if (!branches.fail) throw error;
        branches.fail(error);
        return;
      }
      if (!isWorkAlive()) return;
      branches.ok(value);
    })();
  }

  resolveKeyReconfirm(): KeyReconfirmState {
    const family = PROVIDER_FAMILY_ROWS[this.kind];
    const preset = family.resolvePreset(this.presets, this.draft.presetId);
    const keyRequired = family.editor.isKeyRequired(preset);
    let changed = false;
    if (
      this.hasSavedKey &&
      this.editingId &&
      !this.draft.apiKey.trim() &&
      !usesAiCredentialReference(this.kind, this.draft.presetId)
    ) {
      const presetChanged = Boolean(this.openPresetId && this.draft.presetId !== this.openPresetId);
      let openOrigin = "";
      let currentOrigin = "";
      try {
        openOrigin = this.openBaseUrl ? new URL(this.openBaseUrl).origin : "";
      } catch {}
      try {
        currentOrigin = this.draft.baseUrl.trim() ? new URL(this.draft.baseUrl.trim()).origin : "";
      } catch {}
      const originChanged = Boolean(openOrigin && currentOrigin && currentOrigin !== openOrigin);
      changed = presetChanged || originChanged;
    }
    return {
      changed,
      required: changed && keyRequired,
      effectiveHasSavedKey: this.hasSavedKey && !changed,
      remoteProviderId: changed ? "" : this.editingId
    };
  }

  projectionContext(): ProjectionContext {
    const reconfirm = this.resolveKeyReconfirm();
    return {
      kind: this.kind,
      presets: this.presets,
      hasSavedKey: reconfirm.effectiveHasSavedKey,
      reconfirmKey: reconfirm.changed,
      voices: this.voices
    };
  }

  renderProjection(): void {
    const dialog = this.getDialog();
    if (!dialog) return;
    applyFieldProjection(dialog, this.draft, this.projectionContext());
  }

  applyDraft(mutate: (draft: EditorDraft) => void, sync?: DraftChangeSyncOptions): void {
    mutate(this.draft);
    if (sync) {
      this.syncAfterDraftChange(sync);
    }
  }

  appendModels(values: readonly string[], options?: { clearCatalogError?: boolean }): void {
    if (options?.clearCatalogError) {
      showCatalogError(this, "");
    }
    if (values.length === 0) {
      this.syncAfterDraftChange({ revalidate: "models" });
      return;
    }
    const list = this.getDialog()?.querySelector<HTMLElement>(".provider-editor-model-list");
    if (!list) return;
    this.draft.models.push(...values);
    list.insertAdjacentHTML("beforeend", values.map((value) => modelRowHtml(value)).join(""));
    this.syncAfterDraftChange({
      project: true,
      catalogMeta: true,
      revalidate: "models"
    });
  }

  removeModelRow(row: HTMLElement | null): void {
    const list = row?.closest<HTMLElement>(".provider-editor-model-list");
    if (row && list) {
      const index = Array.from(list.children).indexOf(row);
      if (index >= 0) {
        this.draft.models.splice(index, 1);
      }
    }
    row?.remove();
    this.syncAfterDraftChange({
      project: true,
      revalidate: "models"
    });
  }

  validateForSave(): EditorFieldIssue[] {
    this.validationAttempted = true;
    const issues = this.validateFields();
    this.renderFieldIssues(issues);
    if (issues.length > 0) {
      this.showValidationStatus(issues[0].message);
      this.focusField(issues[0].field);
    }
    return issues;
  }

  validateBeforeFetchModels(): boolean {
    this.validationAttempted = true;
    const issues = this.revalidateFields(["baseUrl", "apiKey"]);
    if (issues.length > 0) {
      const missingBoth =
        !this.draft.baseUrl.trim() &&
        !this.draft.apiKey.trim() &&
        issues.some((issue) => issue.field === "baseUrl") &&
        issues.some((issue) => issue.field === "apiKey");
      showCatalogError(this, missingBoth ? "请先填写 API 地址和 Key" : issues[0].message);
      this.focusField(issues[0].field);
      return false;
    }
    showCatalogError(this, "");
    return true;
  }

  resetValidation(): void {
    this.validationAttempted = false;
    this.renderFieldIssues([]);
  }

  currentLinkedCredential(): LinkedCredentialAction | null {
    if (this.resolveLinkedCredential) {
      return this.resolveLinkedCredential(this.draft);
    }
    return this.linkedCredential;
  }

  primeVoices(): void {
    if (this.kind !== "live" || this.voicesLoaded) return;
    const preset = PROVIDER_FAMILY_ROWS.live.resolvePreset(this.presets, this.draft.presetId);
    if (!isMossLivePreset(preset)) return;
    const baseUrl = this.draft.baseUrl.trim();
    const apiKey = this.draft.apiKey.trim();
    const reconfirm = this.resolveKeyReconfirm();
    if (!baseUrl || (!apiKey && !reconfirm.effectiveHasSavedKey)) return;
    void this.runIfCurrent(
      () => listLiveVoices({ baseUrl, apiKey, providerId: reconfirm.remoteProviderId }),
      {
        ok: (result) => {
          this.voicesLoaded = true;
          if (!result.ok) return;
          this.voices = result.voices.map((voice) => ({ id: voice.id, name: voice.name || voice.id }));
          this.renderProjection();
        },
        fail: () => {
          this.voicesLoaded = true;
        }
      }
    );
  }

  showStatus(text: string, isError = false): void {
    this.validationStatusActive = false;
    this.reconfirmStatusActive = false;
    const statusNode = this.getDialog()?.querySelector<HTMLElement>(".provider-editor-status");
    if (!statusNode) return;
    statusNode.hidden = false;
    statusNode.textContent = text;
    statusNode.dataset.error = isError ? "true" : "false";
  }

  showReconfirmStatus(): void {
    this.showStatus(KEY_RECONFIRM_MESSAGE, true);
    this.reconfirmStatusActive = true;
  }

  clearStatus(): void {
    this.validationStatusActive = false;
    this.reconfirmStatusActive = false;
    const statusNode = this.getDialog()?.querySelector<HTMLElement>(".provider-editor-status");
    if (!statusNode) return;
    statusNode.hidden = true;
    statusNode.textContent = "";
    statusNode.dataset.error = "false";
  }

  setBusy(isBusy: boolean): void {
    this.getDialog()
      ?.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(BUSY_CONTROL_SELECTOR)
      .forEach((control) => {
        control.disabled = isBusy;
      });
  }

  collectUpsert(): { upsert: ProviderRowItem; validationError?: string } {
    const family = PROVIDER_FAMILY_ROWS[this.kind];
    const preset = family.resolvePreset(this.presets, this.draft.presetId);
    const reconfirm = this.resolveKeyReconfirm();
    return family.editor.serializeUpsert({
      id: this.editingId,
      preset,
      name: this.draft.name.trim() || preset?.name || "自定义",
      baseUrl: this.draft.baseUrl.trim().replace(/\/+$/, ""),
      apiKey: this.draft.apiKey.trim(),
      hasSavedKey: reconfirm.effectiveHasSavedKey,
      models: normalizeDraftModels(this.draft.models),
      model: this.draft.model.trim(),
      liveGeminiNativeSearch: this.draft.liveGeminiNativeSearch === true,
      voiceId: String(this.draft.voiceId || "").trim(),
      protocol: normalizeProtocolValue(this.draft.protocol)
    });
  }

  private removeHost(): void {
    try {
      const dialog = this.host.querySelector<HTMLElement>(".provider-editor-dialog");
      const mask = this.host.querySelector<HTMLElement>(".provider-editor-mask");
      if (dialog) {
        animateTriggerExit({
          target: dialog,
          host: this.host,
          mask,
          trigger: this.trigger,
          fallbackOrigin: "top right",
          toScale: 0.94,
          durationMs: 140,
          onFinish: () => {
            try {
              this.host.remove();
            } catch {}
          }
        });
      } else {
        this.host.remove();
      }
    } catch {}
  }

  private async confirmDiscardChanges(): Promise<void> {
    const ok = await confirmDialog({
      title: "放弃更改",
      message: "未保存的更改将丢失，确定关闭？",
      confirmText: "放弃更改",
      danger: true,
      mountHost: this.host.parentElement || undefined
    });
    if (ok && !this.closed) {
      this.dispose();
    }
  }

  private syncAfterDraftChange(options: DraftChangeSyncOptions): void {
    if (options.project) this.renderProjection();
    if (options.linkedCredential) this.syncLinkedCredentialDom();
    if (options.catalogMeta) refreshModelCatalogMeta(this);
    if (options.revalidate === "all") {
      if (this.validationAttempted) {
        this.applyValidationState();
      } else if (options.clearStatusWhenIdle) {
        this.clearStatus();
      }
    } else if (options.revalidate) {
      this.revalidateField(options.revalidate);
    }
    if (options.reconfirm) {
      this.syncReconfirmFeedback();
    }
    if (options.revalidate !== "all") {
      this.syncValidationStatus();
    }
    if (options.voices) this.primeVoices();
  }

  private syncLinkedCredentialDom(): void {
    const container = this.getDialog()?.querySelector<HTMLElement>(".provider-editor-linked-credential");
    if (!container) return;
    const linked = this.currentLinkedCredential();
    if (!linked) {
      container.hidden = true;
      container.innerHTML = "";
      return;
    }
    container.hidden = false;
    container.innerHTML = linkedCredentialInnerHtml(linked);
  }

  private showValidationStatus(text: string): void {
    this.showStatus(text, true);
    this.validationStatusActive = true;
  }

  private syncReconfirmFeedback(): void {
    if (this.validationAttempted) return;
    if (this.resolveKeyReconfirm().required) {
      this.showReconfirmStatus();
    } else if (this.reconfirmStatusActive) {
      this.clearStatus();
    }
  }

  private syncValidationStatus(): void {
    if (!this.validationStatusActive) return;
    const issues = this.validateFields();
    if (issues.length > 0) {
      this.showValidationStatus(issues[0].message);
      return;
    }
    this.clearStatus();
  }

  private applyValidationState(): void {
    if (!this.validationAttempted) return;
    const issues = this.validateFields();
    this.renderFieldIssues(issues);
    if (issues.length > 0) {
      this.showValidationStatus(issues[0].message);
      return;
    }
    this.clearStatus();
  }

  private validationOptions(): { firstSetup: boolean; reconfirmRequired: boolean } {
    return { firstSetup: this.firstSetup, reconfirmRequired: this.resolveKeyReconfirm().required };
  }

  private validateFields(fields?: readonly EditorFieldKey[]): EditorFieldIssue[] {
    return validateEditorFields(this.draft, this.projectionContext(), this.validationOptions(), fields);
  }

  private renderFieldIssues(issues: readonly EditorFieldIssue[], fields?: readonly EditorFieldKey[]): void {
    const dialog = this.getDialog();
    if (dialog) renderEditorFieldIssues(dialog, issues, fields);
  }

  private revalidateField(field: EditorFieldKey): void {
    if (!this.validationAttempted) return;
    const dialog = this.getDialog();
    if (!dialog) return;
    applyFieldIssueDom(dialog, field, issueForEditorField(field, this.draft, this.projectionContext(), this.validationOptions()));
  }

  private revalidateFields(fields: readonly EditorFieldKey[]): EditorFieldIssue[] {
    const issues = this.validateFields(fields);
    this.renderFieldIssues(issues, fields);
    return issues;
  }

  private focusField(field: EditorFieldKey): void {
    const dialog = this.getDialog();
    if (dialog) focusEditorField(dialog, field);
  }
}
