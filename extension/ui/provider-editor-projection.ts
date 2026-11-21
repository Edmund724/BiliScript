import { escapeHtml } from "../shared/string-utils.js";
import { usesAiCredentialReference } from "../core/ai-credential-reference.js";
import { presetBaseUrlForProtocol } from "../core/presets.js";
import { PROTOCOL_ADAPTERS, PROTOCOL_OPTIONS, resolveAdapter, type AiProtocol } from "../ai/protocol-adapter.js";
import { buildModelPickerField } from "./model-picker.js";
import { rebuildCustomSelectOptions, setCustomSelectValue } from "./custom-select.js";
import { syncToggleSwitch } from "./toggle-switch.js";
import { PROVIDER_FAMILY_ROWS, type FamilyEditorDeclaration } from "./provider-family.js";
import { getDialog, state, type EditorDraftView, type ProviderEditorKind } from "./provider-editor-state.js";
import type { ProviderRowPreset } from "./provider-row.js";
import type { LiveVoice } from "../live/live-provider-store.js";

export { presetBaseUrlForProtocol };

export function normalizeProtocolValue(value: unknown): AiProtocol {
  return typeof value === "string" && value in PROTOCOL_ADAPTERS ? (value as AiProtocol) : "openai";
}

export function presetProtocol(preset: ProviderRowPreset | null): AiProtocol {
  return normalizeProtocolValue(preset?.protocol);
}

export function protocolNotes(protocol: unknown): string {
  const unsupported = resolveAdapter(protocol).capabilities.unsupported;
  const text = Object.values(unsupported).join("；");
  return text ? `该协议限制：${text}` : "";
}

export interface ProjectionContext {
  kind: ProviderEditorKind;
  presets: readonly ProviderRowPreset[];
  hasSavedKey: boolean;
  reconfirmKey?: boolean;
  voices?: readonly LiveVoice[];
}

export interface FieldProjection {
  value?: string;
  placeholder?: string;
  required?: boolean;
  hidden?: boolean;
  text?: string;
  checked?: boolean;
}

export type ProjectionFieldKey =
  | "preset"
  | "protocol"
  | "name"
  | "baseUrl"
  | "apiKey"
  | "model"
  | "voice"
  | "protocolNotes"
  | "catalogEmpty"
  | "liveGeminiNativeSearch";

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
  input?: { draftKey: DraftInputKey; selector: string; clearStatus: boolean };
}

function scopeOf(draft: EditorDraftView, ctx: ProjectionContext): ProjectionScope {
  const family = PROVIDER_FAMILY_ROWS[ctx.kind];
  return { ctx, family: family.editor, preset: family.resolvePreset(ctx.presets, draft.presetId) };
}

function fieldBlock(label: string, control: string, controlId?: string, errorId?: string): string {
  return `<div class="provider-editor-field">
          <label class="provider-editor-label"${controlId ? ` for="${controlId}"` : ""}>${label}</label>
          ${control}
          ${errorId ? `<p class="provider-editor-field-error" id="${errorId}" hidden></p>` : ""}
        </div>`;
}

function inputValue(projection: FieldProjection): string {
  return escapeHtml(projection.value ?? "");
}

function isMossLiveScope(scope: ProjectionScope): boolean {
  if (scope.ctx.kind !== "live") return false;
  const preset = scope.preset;
  return preset?.type === "moss-live" || preset?.id === "moss-live";
}

function voiceOptionsHtml(scope: ProjectionScope, selected: string): string {
  const current = selected.trim();
  const voices = scope.ctx.voices ?? [];
  const options = voices.map((voice) => ({ id: voice.id, name: voice.name || voice.id }));
  if (current && !options.some((voice) => voice.id === current)) {
    options.unshift({ id: current, name: current });
  }
  return [
    `<option value="" ${current ? "" : "selected"}>默认音色</option>`,
    ...options.map(
      (voice) =>
        `<option value="${escapeHtml(voice.id)}" ${voice.id === current ? "selected" : ""}>${escapeHtml(voice.name)}</option>`
    )
  ].join("");
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
      setCustomSelectValue(select, projection.value);
    },
    read: (dialog) => ({ value: dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol")?.value ?? "" })
  },

  name: {
    input: { draftKey: "name", selector: ".provider-editor-name", clearStatus: true },
    project: (scope, draft) => ({
      value: draft.name,
      placeholder: scope.ctx.kind === "ai" ? scope.preset?.name || "" : "平台名称"
    }),
    html: (projection) =>
      fieldBlock(
        "名称",
        `<input class="provider-editor-name" id="provider-editor-name" type="text" placeholder="${escapeHtml(projection.placeholder ?? "")}" value="${inputValue(projection)}" />`,
        "provider-editor-name"
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
        `<input class="provider-editor-baseurl" id="provider-editor-baseurl" type="text" required pattern="https?://.+" placeholder="如 https://api.openai.com/v1" value="${inputValue(projection)}" />`,
        "provider-editor-baseurl",
        "provider-editor-error-baseurl"
      ),
    apply: (dialog, projection) => {
      const input = dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl");
      const nextValue = projection.value ?? "";
      if (input && input.value !== nextValue) input.value = nextValue;
    },
    read: (dialog) => ({ value: dialog.querySelector<HTMLInputElement>(".provider-editor-baseurl")?.value ?? "" })
  },

  apiKey: {
    input: { draftKey: "apiKey", selector: ".provider-editor-apikey", clearStatus: true },
    project: (scope, draft) => {
      if (usesAiCredentialReference(scope.ctx.kind, scope.preset?.id)) {
        return { hidden: true, required: false };
      }
      const keyRequired = scope.family.isKeyRequired(scope.preset);
      const placeholder =
        scope.ctx.reconfirmKey && keyRequired
          ? "已切换平台或地址，请重新确认 API Key"
          : scope.family.apiKeyPlaceholder(scope.preset, scope.ctx.hasSavedKey);
      const projection: FieldProjection = {
        placeholder,
        required: keyRequired && !scope.ctx.hasSavedKey
      };
      if (scope.ctx.kind !== "ai") projection.value = draft.apiKey;
      return projection;
    },
    html: (projection) =>
      `<div class="provider-editor-field" ${projection.hidden ? "hidden" : ""}>
          <label class="provider-editor-label" for="provider-editor-apikey">API Key</label>
          <input class="provider-editor-apikey" id="provider-editor-apikey" type="password" placeholder="${escapeHtml(projection.placeholder ?? "")}" autocomplete="off" ${projection.required ? "required" : ""} />
          <p class="provider-editor-field-error" id="provider-editor-error-apikey" hidden></p>
        </div>`,
    apply: (dialog, projection) => {
      const input = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey");
      if (!input) return;
      const field = input.closest<HTMLElement>(".provider-editor-field");
      if (field) field.hidden = projection.hidden === true;
      input.placeholder = projection.placeholder ?? "";
      input.required = projection.required === true;
      if (projection.value !== undefined && input.value !== projection.value) input.value = projection.value;
    },
    read: (dialog) => {
      const input = dialog.querySelector<HTMLInputElement>(".provider-editor-apikey");
      return {
        value: input?.value ?? "",
        placeholder: input?.placeholder ?? "",
        required: input?.required ?? false,
        hidden: input?.closest<HTMLElement>(".provider-editor-field")?.hidden === true
      };
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
          inputId: "provider-editor-model",
          placeholder: "模型名",
          value: projection.value ?? ""
        }),
        "provider-editor-model",
        "provider-editor-error-model"
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

  voice: {
    project: (scope, draft) => {
      if (!isMossLiveScope(scope)) return { hidden: true };
      return { hidden: false, value: String(draft.voiceId || "") };
    },
    html: (projection, scope) =>
      `<div class="provider-editor-field provider-editor-field-voice" ${projection.hidden ? "hidden" : ""}>
          <label class="provider-editor-label">音色</label>
          <select class="provider-editor-voice">${voiceOptionsHtml(scope, projection.value ?? "")}</select>
        </div>`,
    apply: (dialog, projection, scope) => {
      const field = dialog.querySelector<HTMLElement>(".provider-editor-field-voice");
      if (field) field.hidden = projection.hidden === true;
      const select = dialog.querySelector<HTMLSelectElement>(".provider-editor-voice");
      if (select) {
        select.innerHTML = voiceOptionsHtml(scope, projection.value ?? "");
        if (projection.value !== undefined) {
          setCustomSelectValue(select, projection.value);
        }
        rebuildCustomSelectOptions(select);
      }
    },
    read: (dialog) => {
      const field = dialog.querySelector<HTMLElement>(".provider-editor-field-voice");
      return {
        value: dialog.querySelector<HTMLSelectElement>(".provider-editor-voice")?.value ?? "",
        hidden: field ? field.hidden === true : true
      };
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
  },

  liveGeminiNativeSearch: {
    project: (scope, draft) => {
      const isGeminiLive = scope.ctx.kind === "live" && scope.preset?.id === "gemini-live";
      return {
        hidden: !isGeminiLive,
        checked: isGeminiLive && draft.liveGeminiNativeSearch === true
      };
    },
    html: (projection) =>
      `<div class="provider-editor-field provider-editor-field-gemini-search" ${projection.hidden ? "hidden" : ""}>
        <div class="biliscript-toggle-row">
          <span class="biliscript-toggle-text">Gemini 伴看使用原生 Google 搜索</span>
          <label class="biliscript-toggle-switch">
            <input class="provider-editor-gemini-search biliscript-toggle-input" type="checkbox" ${projection.checked ? "checked" : ""} aria-label="Gemini 伴看使用原生 Google 搜索" />
            <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
          </label>
        </div>
      </div>`,
    apply: (dialog, projection) => {
      const container = dialog.querySelector<HTMLElement>(".provider-editor-field-gemini-search");
      if (container) container.hidden = projection.hidden === true;
      const input = dialog.querySelector<HTMLInputElement>(".provider-editor-gemini-search");
      if (input && projection.checked !== undefined) {
        input.checked = projection.checked;
      }
    },
    read: (dialog) => {
      const container = dialog.querySelector<HTMLElement>(".provider-editor-field-gemini-search");
      const input = dialog.querySelector<HTMLInputElement>(".provider-editor-gemini-search");
      return {
        hidden: container ? container.hidden === true : true,
        checked: input ? input.checked : false
      };
    }
  }
};

export function isSavedKeyReconfirmRequired(draft: EditorDraftView | null = state.draft): boolean {
  if (!state.hasSavedKey || !state.editingId || !draft) return false;
  if (draft.apiKey.trim()) return false;
  if (usesAiCredentialReference(state.kind, draft.presetId)) return false;
  const presetChanged = Boolean(state.openPresetId && draft.presetId !== state.openPresetId);
  let openOrigin = "";
  let currentOrigin = "";
  try {
    openOrigin = state.openBaseUrl ? new URL(state.openBaseUrl).origin : "";
  } catch {}
  try {
    currentOrigin = draft.baseUrl.trim() ? new URL(draft.baseUrl.trim()).origin : "";
  } catch {}
  const originChanged = Boolean(openOrigin && currentOrigin && currentOrigin !== openOrigin);
  return presetChanged || originChanged;
}

export function sessionProjectionContext(): ProjectionContext {
  const reconfirmKey = isSavedKeyReconfirmRequired();
  return {
    kind: state.kind,
    presets: state.presets,
    hasSavedKey: state.hasSavedKey && !reconfirmKey,
    reconfirmKey,
    voices: state.voices
  };
}

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

export const DRAFT_INPUTS: readonly { key: DraftInputKey; selector: string; clearStatus: boolean }[] = (
  Object.values(FIELDS) as FieldSpec[]
).flatMap((spec) =>
  spec.input ? [{ key: spec.input.draftKey, selector: spec.input.selector, clearStatus: spec.input.clearStatus }] : []
);
