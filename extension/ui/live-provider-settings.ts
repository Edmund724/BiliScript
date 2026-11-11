import { PRESETS } from "../core/presets.js";
import { annotateAiCredentialRows, resolveAiCredentialReference } from "../core/ai-credential-reference.js";
import {
  requestProviderOriginsViaBackground,
  permissionRevokeErrorMessage,
  revokeOrphanOrigin
} from "../core/host-permissions.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { state } from "../core/state.js";
import { LIVE_PROVIDER_PRESETS, resolveActiveLiveProviderId } from "../live/live-provider-store.js";
import type { LiveSettingsTarget } from "../live/fullscreen-live-overlay.js";
import { closeConfirmDialog } from "./confirm-dialog.js";
import { createProviderFamilyRows } from "./provider-family.js";
import { SETTINGS_PANEL_DOM_IDS } from "./settings-panel-html.js";
import type { ProviderEditorKind } from "./provider-editor-state.js";
import type { ProviderRowItem } from "./provider-row.js";
import {
  createProviderTransactions,
  loadOriginSharingProviders,
  type ProviderFamilyTable
} from "./provider-transaction.js";

export interface LiveProviderSettingsOptions {
  host: HTMLElement;
  getEditorMountHost?: () => HTMLElement | null;
  onStatus: (message: string, isError?: boolean) => void;
  onSaved?: (kind: "live" | "ai", providerId: string) => void;
}

export interface LiveProviderSettings {
  load(): Promise<void>;
  open(target: LiveSettingsTarget): Promise<void>;
  dispose(): void;
}

type EditorModule = typeof import("./provider-editor.js");

export function createLiveProviderSettings(options: LiveProviderSettingsOptions): LiveProviderSettings {
  const ids = SETTINGS_PANEL_DOM_IDS;
  const listNode = options.host.querySelector<HTMLElement>(`#${ids.liveProvidersList}`)!;
  const emptyNode = options.host.querySelector<HTMLElement>(`#${ids.liveProvidersEmpty}`)!;
  const addButton = options.host.querySelector<HTMLButtonElement>(`#${ids.addLiveProviderBtn}`);
  if (!listNode || !emptyNode || !addButton) {
    throw new Error("伴看设置宿主缺少平台列表节点");
  }

  let disposed = false;
  let generation = 0;
  let liveProviders: ProviderRowItem[] = [];
  let aiProviders: ProviderRowItem[] = [];
  let activeId = "";
  let editorModule: EditorModule | null = null;

  const familyRows = createProviderFamilyRows({
    getConfirmMountHost: options.getEditorMountHost,
    onRowEdit: (kind, providerId) => void openProviderEditorById(kind, providerId)
  });

  async function loadRows(kind: ProviderEditorKind): Promise<ProviderRowItem[]> {
    try {
      const response = kind === "live"
        ? await sendRuntimeMessage({ type: "live-providers-list" })
        : kind === "ai"
          ? await sendRuntimeMessage({ type: "ai-providers-list" })
          : kind === "asr"
            ? await sendRuntimeMessage({ type: "asr-providers-list" })
            : await sendRuntimeMessage({ type: "search-providers-list" });
      return response?.ok && Array.isArray(response.providers) ? response.providers : [];
    } catch {
      return [];
    }
  }

  const families: ProviderFamilyTable = {
    live: {
      list: () => sendRuntimeMessage({ type: "live-providers-list" }),
      loadProviders: () => loadRows("live"),
      save: (providers) => sendRuntimeMessage({ type: "live-providers-save", providers }),
      remove: (providerId) => sendRuntimeMessage({ type: "live-providers-delete", providerId }),
      generateId: () => familyRows.live.controller.generateId(),
      optionalHostPermission: true
    },
    ai: {
      list: () => sendRuntimeMessage({ type: "ai-providers-list" }),
      loadProviders: () => loadRows("ai"),
      save: (providers) => sendRuntimeMessage({ type: "ai-providers-save", providers }),
      remove: (providerId) => sendRuntimeMessage({ type: "ai-providers-delete", providerId }),
      generateId: () => familyRows.ai.controller.generateId(),
      optionalHostPermission: true
    },
    asr: {
      list: () => sendRuntimeMessage({ type: "asr-providers-list" }),
      loadProviders: () => loadRows("asr"),
      save: (providers) => sendRuntimeMessage({ type: "asr-providers-save", providers }),
      remove: (providerId) => sendRuntimeMessage({ type: "asr-providers-delete", providerId }),
      generateId: () => familyRows.asr.controller.generateId(),
      optionalHostPermission: true
    },
    search: {
      list: () => sendRuntimeMessage({ type: "search-providers-list" }),
      loadProviders: () => loadRows("search"),
      save: (providers) => sendRuntimeMessage({ type: "search-providers-save", providers }),
      remove: (providerId) => sendRuntimeMessage({ type: "search-providers-delete", providerId }),
      generateId: () => familyRows.search.controller.generateId(),
      optionalHostPermission: false
    }
  };

  function renderLiveProviders(): void {
    if (disposed) return;
    const nextActiveId = resolveActiveLiveProviderId(liveProviders, activeId);
    familyRows.live.render(listNode, emptyNode, annotateAiCredentialRows("live", liveProviders, aiProviders), {
      presets: LIVE_PROVIDER_PRESETS,
      activeId: nextActiveId
    });
    if (nextActiveId !== activeId) {
      activeId = nextActiveId;
      state.patchSettings({ activeLiveProviderId: nextActiveId });
      void sendRuntimeMessage({ type: "save-settings", settings: { activeLiveProviderId: nextActiveId } })
        .then((response) => {
          if (!disposed && !response?.ok) options.onStatus(response?.error || "激活平台保存失败", true);
        })
        .catch((error) => {
          if (!disposed) options.onStatus((error as Error).message || "激活平台保存失败", true);
        });
    }
  }

  const transactions = createProviderTransactions({
    families,
    requestOrigins: requestProviderOriginsViaBackground,
    rerender: (kind, providers) => {
      if (disposed) return;
      if (kind === "live") {
        liveProviders = providers;
        renderLiveProviders();
      } else if (kind === "ai") {
        aiProviders = providers;
        renderLiveProviders();
      }
    },
    reportOriginRevokeFailure: (message) => {
      if (!disposed) options.onStatus(message, true);
    }
  });

  async function saveProvider(kind: ProviderEditorKind, upsert: ProviderRowItem) {
    const result = await transactions.upsertProvider(kind, upsert);
    if (!disposed && result.ok && (kind === "live" || kind === "ai")) {
      options.onSaved?.(kind, String(upsert.id || ""));
      if (kind === "ai") {
        liveProviders = await loadRows("live");
        if (!disposed) renderLiveProviders();
      }
    }
    return result;
  }

  async function deleteProvider(
    kind: ProviderEditorKind,
    target: { id: string; baseUrl: string }
  ) {
    const result = await transactions.deleteProvider(kind, target);
    if (!disposed && result.ok && (kind === "live" || kind === "ai")) {
      options.onSaved?.(kind, target.id);
      if (kind === "ai") {
        liveProviders = await loadRows("live");
        if (!disposed) renderLiveProviders();
      }
    }
    return result;
  }

  async function openProviderEditorById(kind: ProviderEditorKind, providerId: string, presetId?: string): Promise<void> {
    const sessionGeneration = generation;
    const providers = await loadRows(kind);
    if (disposed || sessionGeneration !== generation) return;
    const item = providerId ? providers.find((provider) => String(provider.id || "") === providerId) || null : null;
    if (providerId && !item) return;
    try {
      const editor = editorModule || await import("./provider-editor.js");
      if (disposed || sessionGeneration !== generation) return;
      editorModule = editor;
      editor.openProviderEditor({
        kind,
        item,
        presetId,
        presets: kind === "live" ? LIVE_PROVIDER_PRESETS : PRESETS,
        mountHost: options.getEditorMountHost?.() || undefined,
        onSave: saveProvider,
        onDelete: deleteProvider
      });
    } catch (error) {
      if (!disposed) options.onStatus((error as Error).message || "编辑器加载失败", true);
    }
  }

  familyRows.live.controller.setBeforeDeleteHandler(async (providerId, baseUrl) => {
    const providers = await loadOriginSharingProviders(families);
    const { origins, revoked } = await revokeOrphanOrigin({ id: providerId, baseUrl }, providers);
    if (origins.length > 0 && !revoked && !disposed) {
      options.onStatus(permissionRevokeErrorMessage(origins), true);
    }
  });
  familyRows.live.controller.setDeleteHandler(async (providerId) => {
    if (disposed) return;
    const rows = Array.from(listNode.querySelectorAll<HTMLElement>(".live-provider-row"));
    const nextActiveId = resolveActiveLiveProviderId(
      rows.map((row) => ({ id: row.dataset.providerId || "" })),
      activeId
    );
    if (nextActiveId !== activeId || rows.length === 0) {
      activeId = nextActiveId;
      state.patchSettings({ activeLiveProviderId: nextActiveId });
      const response = await sendRuntimeMessage({
        type: "save-settings",
        settings: { activeLiveProviderId: nextActiveId }
      });
      if (!response?.ok) {
        options.onStatus(response?.error || "激活平台保存失败", true);
        return;
      }
    }
    liveProviders = liveProviders.filter((provider) => provider.id !== providerId);
    renderLiveProviders();
    options.onSaved?.("live", providerId);
  });

  addButton.addEventListener("click", () => void openProviderEditorById("live", ""));

  async function load(): Promise<void> {
    const sessionGeneration = generation;
    try {
      const [nextLiveProviders, nextAiProviders, syncSettings] = await Promise.all([
        loadRows("live"),
        loadRows("ai"),
        chrome.storage.sync.get(["activeLiveProviderId"])
      ]);
      if (disposed || sessionGeneration !== generation) return;
      liveProviders = nextLiveProviders;
      aiProviders = nextAiProviders;
      activeId = typeof syncSettings?.activeLiveProviderId === "string"
        ? syncSettings.activeLiveProviderId
        : "";
      renderLiveProviders();
    } catch (error) {
      if (!disposed) options.onStatus((error as Error).message || "伴看平台加载失败", true);
    }
  }

  async function open(target: LiveSettingsTarget): Promise<void> {
    if (target === "live") {
      options.host.querySelector<HTMLElement>(`#${ids.liveSettingsHeader}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const { record: gemini } = resolveAiCredentialReference("gemini-live", aiProviders);
    await openProviderEditorById("ai", String(gemini?.id || ""), gemini ? undefined : "gemini");
    if (!disposed) {
      options.getEditorMountHost?.()?.querySelector<HTMLInputElement>(".provider-editor-apikey")
        ?.focus({ preventScroll: true });
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    generation += 1;
    closeConfirmDialog();
    editorModule?.closeProviderEditor(true);
    editorModule = null;
  }

  return { load, open, dispose };
}
