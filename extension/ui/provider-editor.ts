import { activeById, onActiveHostChange } from "../shared/active-host.js";
import { isNode, resolveNodeDocument, safeRemoveListener } from "../shared/cross-doc.js";
import { logWarn } from "../shared/logging.js";
import { escapeHtml } from "../shared/string-utils.js";

import { ids } from "../reader/state.js";
import { hasReaderSettingsDropdownOpen } from "../reader/settings-dropdown-open.js";

import { isConfirmDialogOpen } from "./confirm-dialog.js";
import { initCustomSelect } from "./custom-select.js";
import { createFocusScope, isolateHostSiblings, observeSettingsPanelHidden, type FocusScope } from "./focus-scope.js";
import { wireModelPicker } from "./model-picker.js";
import {
  PLATFORM_PROBE_IO,
  deleteSessionProvider,
  saveSession,
  testSessionPlatform
} from "./provider-editor-actions.js";
import { FetchModelsController } from "./provider-editor-fetch-dialog.js";
import { modelRowHtml, primeModelCatalogMeta, runModelTest } from "./provider-editor-model-rows.js";
import {
  DRAFT_INPUT_FIELDS,
  normalizeProtocolValue,
  presetBaseUrlForProtocol,
  presetProtocol,
  projectionBlocks
} from "./provider-editor-projection.js";
import {
  ProviderEditorSession,
  linkedCredentialInnerHtml,
  type EditorDraft,
  type EditorDraftView,
  type LinkedCredentialAction,
  type ProviderEditorDelete,
  type ProviderEditorDraftStash,
  type ProviderEditorKind,
  type ProviderEditorOpenOptions,
  type ProviderEditorSave
} from "./provider-editor-session.js";
import { PROVIDER_FAMILY_ROWS } from "./provider-family.js";
import { initToggleSwitch } from "./toggle-switch.js";
import { animateTriggerEnter, cancelTriggerExit, resolveTriggerElement } from "./trigger-motion.js";

export type {
  EditorDraft,
  EditorDraftView,
  LinkedCredentialAction,
  ProviderEditorDelete,
  ProviderEditorDraftStash,
  ProviderEditorKind,
  ProviderEditorOpenOptions,
  ProviderEditorSave
};

function editorTitle(kind: ProviderEditorKind, editing: boolean): string {
  const label = PROVIDER_FAMILY_ROWS[kind].editor.title;
  return editing ? `编辑${label}` : `添加${label}`;
}

function linkedCredentialHtml(linkedCredential: LinkedCredentialAction | null): string {
  return `
        <div class="provider-editor-linked-credential"${linkedCredential ? "" : " hidden"}>
          ${linkedCredentialInnerHtml(linkedCredential)}
        </div>`;
}

function buildDialogHtml(session: ProviderEditorSession): string {
  const item = session.options.item || null;
  const blocks = projectionBlocks(session.draft, session.projectionContext());
  const isAi = session.kind === "ai";
  const isSearch = session.kind === "search";
  const title = editorTitle(session.kind, Boolean(item?.id));
  const linkedCredential = session.currentLinkedCredential();

  return `
    <div class="provider-editor-mask" data-provider-editor-action="close"></div>
    <section class="provider-editor-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" tabindex="-1">
      <header class="provider-editor-head">
        <span class="provider-editor-title">${escapeHtml(title)}</span>
        ${item?.id && session.onDelete ? `<button type="button" class="provider-editor-delete" data-provider-editor-action="delete" title="删除该平台">删除</button>` : ""}
      </header>
      <form class="provider-editor-form" novalidate>
        <div class="provider-editor-body">
          <p class="provider-editor-context-banner"${session.setupContextBanner ? "" : " hidden"}>${escapeHtml(session.setupContextBanner || "")}</p>
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
            ${session.draft.models.map((m) => modelRowHtml(m)).join("")}
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
          <button type="button" class="provider-editor-cancel" data-provider-editor-action="close">${escapeHtml(session.options.cancelLabel?.trim() || "取消")}</button>
          <button type="submit" class="provider-editor-save" data-provider-editor-action="save">${escapeHtml(session.options.submitLabel?.trim() || "保存")}</button>
        </footer>
      </form>
    </section>
  `;
}

function wireDialog(session: ProviderEditorSession, fetchDialog: FetchModelsController): void {
  const dialog = session.getDialog();
  if (!dialog) return;
  const family = PROVIDER_FAMILY_ROWS[session.kind];

  session.host.addEventListener("click", (event) => {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>("[data-provider-editor-action]")?.dataset.providerEditorAction;
    if (action === "close") session.requestClose(false);
    else if (action === "save") {
      event.preventDefault();
      void saveSession(session);
    } else if (action === "test") void testSessionPlatform(session);
    else if (action === "delete") void deleteSessionProvider(session);
    else if (action === "linked-credential") {
      try {
        session.currentLinkedCredential()?.onAction?.();
      } catch (error) {
        logWarn("[BILISCRIPT] linked credential action failed", error);
        session.showStatus(error instanceof Error && error.message ? error.message : "打开关联凭据设置失败", true);
      }
    } else if (action === "add-model") {
      session.appendModels([""]);
    } else if (action === "remove-model") {
      session.removeModelRow(target.closest<HTMLElement>(".provider-editor-model-row"));
    } else if (action === "test-model") {
      void runModelTest(session, target.closest<HTMLElement>(".provider-editor-model-row"));
    } else if (action === "fetch-models" || action === "retry-fetch") {
      void fetchDialog.open();
    } else if (action === "close-fetch") {
      fetchDialog.close();
    } else if (action === "confirm-fetch") {
      fetchDialog.confirmSelection();
    }
  });

  dialog.querySelector<HTMLFormElement>(".provider-editor-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveSession(session);
  });

  const presetSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-preset");
  presetSelect?.addEventListener("change", () => {
    const next = family.resolvePreset(session.presets, presetSelect.value);
    if (!next) return;
    const previous = family.resolvePreset(session.presets, session.draft.presetId);
    const currentBaseUrl = session.draft.baseUrl.trim();
    session.applyDraft(
      (current) => {
        current.presetId = next.id;
        if (session.kind === "ai") {
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
      },
      {
        project: true,
        linkedCredential: true,
        catalogMeta: true,
        voices: true,
        revalidate: "all",
        clearStatusWhenIdle: true,
        reconfirm: true
      }
    );
  });
  if (presetSelect) {
    initCustomSelect(presetSelect, "custom-select-wrapper provider-editor-preset-wrapper");
  }

  const protocolSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-protocol");
  if (protocolSelect) {
    initCustomSelect(protocolSelect, "custom-select-wrapper provider-editor-protocol-wrapper");
    protocolSelect.addEventListener("change", () => {
      session.applyDraft(
        (current) => {
          if (session.kind !== "ai") return;
          const previous = normalizeProtocolValue(current.protocol);
          const next = normalizeProtocolValue(protocolSelect.value);
          current.protocol = next;
          const preset = family.resolvePreset(session.presets, current.presetId);
          const currentBaseUrl = current.baseUrl.trim();
          if (preset && (!currentBaseUrl || currentBaseUrl === presetBaseUrlForProtocol(preset, previous))) {
            current.baseUrl = presetBaseUrlForProtocol(preset, next);
          }
        },
        {
          project: true,
          linkedCredential: true,
          catalogMeta: true,
          revalidate: "all",
          reconfirm: true
        }
      );
    });
  }

  const geminiSearchInput = dialog.querySelector<HTMLInputElement>(".provider-editor-gemini-search");
  if (geminiSearchInput) {
    initToggleSwitch(geminiSearchInput);
    geminiSearchInput.addEventListener("change", () => {
      session.applyDraft((draft) => {
        draft.liveGeminiNativeSearch = geminiSearchInput.checked;
      });
    });
  }

  const voiceSelect = dialog.querySelector<HTMLSelectElement>(".provider-editor-voice");
  if (voiceSelect) {
    initCustomSelect(voiceSelect, "custom-select-wrapper provider-editor-voice-wrapper");
    voiceSelect.addEventListener("change", () => {
      session.applyDraft((draft) => {
        draft.voiceId = voiceSelect.value;
      });
      session.clearStatus();
    });
  }

  for (const field of DRAFT_INPUT_FIELDS) {
    const input = dialog.querySelector<HTMLInputElement>(field.selector);
    input?.addEventListener("input", () => {
      session.applyDraft(
        (draft) => {
          draft[field.key] = input.value;
        },
        {
          project: field.key === "baseUrl" || field.key === "apiKey",
          linkedCredential: field.key === "baseUrl",
          catalogMeta: field.key === "baseUrl",
          revalidate: field.key !== "name" ? field.key : null,
          reconfirm: field.key === "baseUrl" || field.key === "apiKey"
        }
      );
    });
  }

  dialog.querySelector<HTMLElement>(".provider-editor-model-list")?.addEventListener("input", (event) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("provider-editor-model-id")) return;
    const list = target.closest<HTMLElement>(".provider-editor-model-list");
    if (!list) return;
    session.applyDraft(
      (draft) => {
        draft.models = Array.from(list.querySelectorAll<HTMLInputElement>(".provider-editor-model-id")).map(
          (input) => input.value
        );
      },
      {
        catalogMeta: true,
        revalidate: "models"
      }
    );
  });

  const fetchModels = PLATFORM_PROBE_IO[session.kind]?.fetchModels;
  if (family.editor.modelSource === "input" && fetchModels) {
    wireModelPicker(dialog, {
      inputClass: "provider-editor-model",
      baseUrlClass: "provider-editor-baseurl",
      apiKeyClass: "provider-editor-apikey",
      statusClass: "provider-editor-status",
      showStatus: (_node, text, isError) => session.showStatus(text, isError),
      fetchModels: ({ baseUrl, apiKey, providerId }) => {
        const preset = family.resolvePreset(session.presets, session.draft.presetId);
        const reconfirm = session.resolveKeyReconfirm();
        return fetchModels({
          baseUrl,
          apiKey,
          providerId: reconfirm.changed ? "" : providerId || session.editingId,
          type: preset?.type
        });
      },
      isKeyRequired: () => {
        const preset = family.resolvePreset(session.presets, session.draft.presetId);
        if (preset?.requiresKey === false) return false;
        try {
          const url = new URL(session.draft.baseUrl || "");
          if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return false;
        } catch {}
        return family.editor.isKeyRequired(preset);
      },
      hasSavedKey: () => session.resolveKeyReconfirm().effectiveHasSavedKey
    });
  }
}

function mountSession(session: ProviderEditorSession): void {
  const family = PROVIDER_FAMILY_ROWS[session.kind];
  const fetchDialog = new FetchModelsController(session);

  session.host.innerHTML = buildDialogHtml(session);
  const restoreSiblings = isolateHostSiblings(session.host);

  session.renderProjection();
  wireDialog(session, fetchDialog);
  session.resetValidation();
  if (session.options.initialStatus?.message) {
    session.showStatus(session.options.initialStatus.message, session.options.initialStatus.isError === true);
  }

  const dialog = session.getDialog();
  let focusScope: FocusScope | null = null;
  if (dialog) {
    animateTriggerEnter({
      target: dialog,
      mask: session.host.querySelector<HTMLElement>(".provider-editor-mask"),
      trigger: session.trigger,
      fallbackOrigin: "top right",
      fromScale: 0.94,
      durationMs: 200
    });
    focusScope = createFocusScope(dialog, {
      initialFocus: dialog,
      isActive: () => !isConfirmDialogOpen() && !fetchDialog.isOpen()
    });
  }

  session.registerCleanup(() => {
    try {
      fetchDialog.close(false);
    } catch {}
    try {
      restoreSiblings();
    } catch {}
    try {
      focusScope?.dispose();
    } catch {}
  });

  session.primeVoices();

  let boundDoc: Document | null = null;
  const onDocumentClickCapture = (event: MouseEvent): void => {
    if (!session.isOpen()) return;
    if (isConfirmDialogOpen() || hasReaderSettingsDropdownOpen()) return;
    const view = session.host.parentElement || activeById(ids.readingView);
    if (view && isNode(event.target) && view.contains(event.target)) return;
    event.stopPropagation();
    session.requestClose(false);
  };
  const onDocumentKeyDownCapture = (event: KeyboardEvent): void => {
    if (!session.isOpen() || event.key !== "Escape") return;
    if (isConfirmDialogOpen() || hasReaderSettingsDropdownOpen()) return;
    event.preventDefault();
    event.stopPropagation();
    if (fetchDialog.isOpen()) {
      fetchDialog.close();
      return;
    }
    session.requestClose(false);
  };
  const bindCaptureListeners = (doc: Document): void => {
    boundDoc = doc;
    boundDoc.addEventListener("click", onDocumentClickCapture, true);
    boundDoc.addEventListener("keydown", onDocumentKeyDownCapture, true);
  };
  const unbindCaptureListeners = (): void => {
    safeRemoveListener(boundDoc, "click", onDocumentClickCapture, true);
    safeRemoveListener(boundDoc, "keydown", onDocumentKeyDownCapture, true);
    boundDoc = null;
  };
  bindCaptureListeners(resolveNodeDocument(session.host));
  session.registerCleanup(unbindCaptureListeners);

  const stopHostWatch = onActiveHostChange((ctx) => {
    if (!session.isOpen()) return;
    unbindCaptureListeners();
    let sameHost = false;
    try {
      sameHost = Boolean(session.host.isConnected && session.host.ownerDocument === ctx.doc);
    } catch {
      sameHost = false;
    }
    if (sameHost) {
      bindCaptureListeners(ctx.doc);
      return;
    }
    session.dispose();
  });
  session.registerCleanup(stopHostWatch);

  const stopObservingSettingsHidden = observeSettingsPanelHidden(() => session.dispose());
  session.registerCleanup(stopObservingSettingsHidden);

  if (family.editor.modelSource === "catalog") {
    primeModelCatalogMeta(session);
  }
  if (dialog && session.options.initialFocusField === "apiKey") {
    dialog.querySelector<HTMLElement>(".provider-editor-apikey")?.focus({ preventScroll: true });
  } else if (dialog && session.options.initialFocusField === "models") {
    dialog
      .querySelector<HTMLElement>(
        '[data-provider-editor-action="add-model"], .provider-editor-model-input, .provider-editor-model'
      )
      ?.focus({ preventScroll: true });
  }
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

let activeSession: ProviderEditorSession | null = null;

export function openProviderEditor(options: ProviderEditorOpenOptions): void {
  const trigger = resolveTriggerElement();
  activeSession?.dispose();
  const host = ensureHost(options.mountHost);
  if (!host) {
    return;
  }
  const session = new ProviderEditorSession(options, host, trigger, () => {
    if (activeSession === session) {
      activeSession = null;
    }
  });
  activeSession = session;
  mountSession(session);
}

export function closeProviderEditor(force = false): void {
  if (!activeSession) return;
  activeSession.requestClose(force);
}

export function stashProviderEditorDraft(kind: "live" | "search"): ProviderEditorDraftStash | null {
  return activeSession?.stashDraft(kind) ?? null;
}

export function isProviderEditorOpen(): boolean {
  return activeSession !== null && activeSession.isOpen();
}
