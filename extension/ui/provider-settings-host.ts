// extension/ui/provider-settings-host.ts — 四族平台列表与编辑器协调宿主。
//
// 统一承接 ai / asr / live / search 四族的列表装载、事务保存/删除、orphan host 权限
// 回收、单选激活回退、跨族凭据引用动态核验与编辑器同层往返。按 mountedFamilies
// 挂载实际存在的 DOM 分区，不静态依赖 provider-editor / reader / chat / subtitle /
// agent-bridge，确保伴看独立宿主 chunk 不引入阅读侧依赖。

import {
  annotateAiCredentialRows,
  queryAiCredentialKey,
  type AiCredentialStatus
} from "../core/ai-credential-reference.js";
import type { Settings } from "../core/defaults.js";
import {
  permissionRevokeErrorMessage,
  requestProviderOriginsViaBackground,
  revokeOrphanOrigin
} from "../core/host-permissions.js";
import {
  ASR_PROVIDER_PRESETS,
  PRESETS,
  SEARCH_PROVIDER_PRESETS,
  type AiProviderPreset,
  type AsrProviderPreset
} from "../core/presets.js";
import { getSettings } from "../core/runtime.js";
import { isSmartSearchActive } from "../core/search-mode.js";
import { state } from "../core/state.js";
import { resolveActiveAsrProviderId } from "../asr/asr-provider-normalize.js";
import type { LiveSettingsTarget } from "../live/fullscreen-live-overlay.js";
import { LIVE_PROVIDER_PRESETS, resolveActiveLiveProviderId } from "../live/live-provider-store.js";
import { normalizeSearchProviderOrder, providerOrderRank } from "../search/search-order.js";
import { SEARCH_PROVIDER_ORDER_STORAGE } from "../search/search-provider-store.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import {
  enterAiCredentialEditor,
  linkedCredentialFor,
  linkedCredentialTargetForDraft,
  resolveAiCredentialPlan,
  type AiCredentialLinkTarget
} from "./ai-credential-link.js";
import { closeConfirmDialog } from "./confirm-dialog.js";
import type {
  EditorDraft,
  EditorDraftView,
  ProviderEditorDelete,
  ProviderEditorDraftStash,
  ProviderEditorKind,
  ProviderEditorSave
} from "./provider-editor.js";
import { createProviderFamilyRows, PROVIDER_FAMILY_ROWS } from "./provider-family.js";
import type { ProviderRowItem, ProviderRowPreset } from "./provider-row.js";
import { wireProviderRowDrag } from "./provider-row-drag.js";
import {
  createProviderTransactions,
  loadOriginSharingProviders,
  type ProviderFamilyTable
} from "./provider-transaction.js";
import { SETTINGS_PANEL_DOM_IDS, type SettingsPanelDomId } from "./settings-panel-html.js";

type EditorModule = typeof import("./provider-editor.js");
type ActiveRadioFamilyKind = "live" | "asr";
type MutationResult = Awaited<ReturnType<ReturnType<typeof createProviderTransactions>["upsertProvider"]>>;

export interface OpenProviderEditorSession {
  onAfterSave(): void;
  onSessionEnd(): void;
}

export interface OpenProviderEditorRequest {
  kind: ProviderEditorKind;
  providerId: string;
  presetId?: string;
  setupSession?: OpenProviderEditorSession;
  restore?: {
    initialDraft: EditorDraft;
    baselineDraft: EditorDraftView | null;
  };
  setupContextBanner?: string | null;
  initialStatus?: { message: string; isError?: boolean } | null;
  initialFocusField?: "apiKey" | "models";
  firstSetup?: boolean;
  submitLabel?: string;
}

export interface ProviderSummarySnapshot {
  aiProviders: readonly ProviderRowItem[];
  liveProviders: readonly ProviderRowItem[];
  activeLiveId: string;
  asrProviders: readonly ProviderRowItem[];
  activeAsrId: string;
  searchProviders: readonly ProviderRowItem[];
  activeSearchProviderId: string;
}

export interface ProviderSettingsHostOptions {
  host: HTMLElement;
  mountedFamilies: readonly ProviderEditorKind[];
  getEditorMountHost?: () => HTMLElement | null;
  onStatus: (message: string, isError?: boolean) => void;
  onGeminiCredentialStatus?: (status: AiCredentialStatus | null) => void;
  canRestoreConsumerEditor?: () => boolean;
  onAiChanged?: (providers: ProviderRowItem[], context: { settings?: Partial<Settings> }) => void;
  onSummaryChange?: (snapshot: ProviderSummarySnapshot) => void;
  onMutated?: (event: { kind: ProviderEditorKind; action: "save" | "delete"; providerId: string }) => void;
  reportMutationStatus?: boolean;
}

export interface ProviderSettingsHost {
  load(knownSettings?: Partial<Settings>): Promise<void>;
  loadRows(kind: ProviderEditorKind): Promise<ProviderRowItem[]>;
  ensurePresetsLoaded(): Promise<void>;
  getAiPresets(): readonly AiProviderPreset[];
  openEditor(request: OpenProviderEditorRequest): Promise<void>;
  openLinkedCredentialEditor(target: AiCredentialLinkTarget): Promise<void>;
  openLiveTarget(target: LiveSettingsTarget): Promise<void>;
  upsertProvider(kind: ProviderEditorKind, upsert: ProviderRowItem): Promise<MutationResult>;
  deleteProvider(kind: ProviderEditorKind, target: { id: string; baseUrl: string }): Promise<MutationResult>;
  dispose(): void;
}

interface FamilyDomNodes {
  listNode: HTMLElement;
  emptyNode: HTMLElement;
  addButton: HTMLButtonElement;
}

interface SearchExtraDomNodes {
  danglingHint: HTMLElement | null;
  resetOrderBtn: HTMLButtonElement | null;
  toggleChainBtn: HTMLElement | null;
  chainContainer: HTMLElement | null;
  chainActiveSummary: HTMLElement | null;
  allowPaidToggle: HTMLInputElement | null;
}

const SMART_SUMMARY_BASE = "智能搜索 · 失败自动回退";
const SINGLE_MODE_NOTE = "已单选平台：只使用选中的平台搜索，失败不会切换到其他平台。";
const SMART_MODE_NOTE = "智能搜索：按下方列表顺序依次尝试，失败自动回退到下一个平台；拖动行可调整顺序。";

function isGeminiLiveProvider(
  provider: Pick<ProviderRowItem, "type" | "presetId"> | null | undefined
): boolean {
  return provider?.type === "gemini-live" || provider?.presetId === "gemini-live";
}

export function createProviderSettingsHost(options: ProviderSettingsHostOptions): ProviderSettingsHost {
  const ids = SETTINGS_PANEL_DOM_IDS;
  const mountedSet = new Set<ProviderEditorKind>(options.mountedFamilies);
  const hasFamily = (kind: ProviderEditorKind): boolean => mountedSet.has(kind);
  const byId = <T extends HTMLElement>(id: SettingsPanelDomId): T | null =>
    options.host.querySelector<T>(`#${id}`);

  function resolveFamilyNodes(
    kind: ProviderEditorKind,
    listId: SettingsPanelDomId,
    emptyId: SettingsPanelDomId,
    addBtnId: SettingsPanelDomId
  ): FamilyDomNodes | null {
    if (!hasFamily(kind)) return null;
    const listNode = byId<HTMLElement>(listId);
    const emptyNode = byId<HTMLElement>(emptyId);
    const addButton = byId<HTMLButtonElement>(addBtnId);
    if (!listNode || !emptyNode || !addButton) {
      if (kind === "live") {
        throw new Error("伴看设置宿主缺少平台列表节点");
      }
      throw new Error(`设置宿主缺少 ${kind} 平台列表节点`);
    }
    return { listNode, emptyNode, addButton };
  }

  const aiNodes = resolveFamilyNodes("ai", ids.aiProvidersList, ids.aiProvidersEmpty, ids.addAiProviderBtn);
  const asrNodes = resolveFamilyNodes("asr", ids.asrProvidersList, ids.asrProvidersEmpty, ids.addAsrProviderBtn);
  const liveNodes = resolveFamilyNodes("live", ids.liveProvidersList, ids.liveProvidersEmpty, ids.addLiveProviderBtn);
  const searchNodes = resolveFamilyNodes(
    "search",
    ids.searchProvidersList,
    ids.searchProvidersEmpty,
    ids.addSearchProviderBtn
  );
  const searchExtra: SearchExtraDomNodes | null = searchNodes
    ? {
        danglingHint: byId<HTMLElement>(ids.searchProvidersDanglingHint),
        resetOrderBtn: byId<HTMLButtonElement>(ids.resetSearchProviderOrderBtn),
        toggleChainBtn: byId<HTMLElement>(ids.toggleSearchChainBtn),
        chainContainer: byId<HTMLElement>(ids.searchChainContainer),
        chainActiveSummary: byId<HTMLElement>(ids.searchChainActiveSummary),
        allowPaidToggle: byId<HTMLInputElement>(ids.allowPaidSearchProviders)
      }
    : null;

  let disposed = false;
  let generation = 0;
  let aiPresets: AiProviderPreset[] = PRESETS.slice();
  let asrPresets: AsrProviderPreset[] = ASR_PROVIDER_PRESETS.slice();
  let presetsLoaded = false;

  let aiProviders: ProviderRowItem[] = [];
  let aiProvidersLoaded = false;
  let liveProviders: ProviderRowItem[] = [];
  let activeLiveId = "";
  let asrProviders: ProviderRowItem[] = [];
  let activeAsrId = "";
  let searchProviders: ProviderRowItem[] = [];
  let activeSearchProviderId = "";
  let searchProviderOrder: string[] = [];

  let geminiCredentialStatus: AiCredentialStatus | null = null;
  let credentialRequest = 0;
  let linkedCredentialInFlight = false;
  let deleteRevokeFailureInFlight = false;
  let statusErrorMarked = false;
  let editorModule: EditorModule | null = null;
  let pendingAiConsumerSync: Promise<void> | null = null;

  const reportStatus = (message: string, isError = false): void => {
    if (disposed) return;
    statusErrorMarked = isError;
    options.onStatus(message, isError);
  };

  const reportMutationText = (message: string): void => {
    if (options.reportMutationStatus !== false) {
      reportStatus(message);
    }
  };

  const emitSummarySnapshot = (): void => {
    if (disposed || !options.onSummaryChange) return;
    options.onSummaryChange({
      aiProviders,
      liveProviders,
      activeLiveId,
      asrProviders,
      activeAsrId,
      searchProviders,
      activeSearchProviderId
    });
  };

  async function loadRows(kind: ProviderEditorKind): Promise<ProviderRowItem[]> {
    try {
      const response =
        kind === "live"
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

  async function ensurePresetsLoaded(): Promise<void> {
    if (presetsLoaded) return;
    if (!hasFamily("ai") && !hasFamily("asr")) {
      presetsLoaded = true;
      return;
    }
    await Promise.all([
      hasFamily("ai")
        ? sendRuntimeMessage({ type: "ai-presets-list" })
            .then((resp) => {
              if (resp?.ok && Array.isArray(resp.presets)) aiPresets = resp.presets;
            })
            .catch(() => {})
        : Promise.resolve(),
      hasFamily("asr")
        ? sendRuntimeMessage({ type: "asr-presets-list" })
            .then((resp) => {
              if (resp?.ok && Array.isArray(resp.presets)) asrPresets = resp.presets;
            })
            .catch(() => {})
        : Promise.resolve()
    ]);
    presetsLoaded = true;
  }

  const familyRows = createProviderFamilyRows({
    getConfirmMountHost: options.getEditorMountHost,
    onRowEdit: (kind, providerId) => void openEditor({ kind, providerId })
  });

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

  function presetsForKind(kind: ProviderEditorKind): readonly ProviderRowPreset[] {
    if (kind === "live") return LIVE_PROVIDER_PRESETS;
    if (kind === "asr") return asrPresets;
    if (kind === "search") return SEARCH_PROVIDER_PRESETS;
    return aiPresets.length ? aiPresets : PRESETS;
  }

  function getActiveRadioNodes(kind: ActiveRadioFamilyKind): FamilyDomNodes | null {
    return kind === "live" ? liveNodes : asrNodes;
  }

  function resolveActiveIdFor(
    kind: ActiveRadioFamilyKind,
    items: ReadonlyArray<{ id?: string | null }>,
    candidate?: string | null
  ): string {
    return kind === "live"
      ? resolveActiveLiveProviderId(items, candidate)
      : resolveActiveAsrProviderId(items, candidate);
  }

  function getStoredActiveId(kind: ActiveRadioFamilyKind): string {
    return kind === "live" ? activeLiveId : activeAsrId;
  }

  function setStoredActiveId(kind: ActiveRadioFamilyKind, nextId: string): void {
    const key = kind === "live" ? "activeLiveProviderId" : "activeAsrProviderId";
    if (kind === "live") {
      activeLiveId = nextId;
    } else {
      activeAsrId = nextId;
    }
    state.patchSettings({ [key]: nextId });
  }

  function activeSettingsKey(kind: ActiveRadioFamilyKind): "activeLiveProviderId" | "activeAsrProviderId" {
    return kind === "live" ? "activeLiveProviderId" : "activeAsrProviderId";
  }

  function renderLiveProviders(): void {
    if (disposed || !liveNodes) return;
    const nextActiveId = resolveActiveLiveProviderId(liveProviders, activeLiveId);
    const active = liveProviders.find((provider) => String(provider.id || "") === nextActiveId);
    const geminiActive = isGeminiLiveProvider(active);
    const statusOverrides = geminiCredentialStatus ? { "gemini-live": geminiCredentialStatus } : {};
    familyRows.live.render(
      liveNodes.listNode,
      liveNodes.emptyNode,
      annotateAiCredentialRows("live", liveProviders, aiProviders, PRESETS, statusOverrides),
      { presets: LIVE_PROVIDER_PRESETS, activeId: nextActiveId }
    );
    options.onGeminiCredentialStatus?.(geminiActive ? geminiCredentialStatus : null);
    if (nextActiveId !== activeLiveId) {
      setStoredActiveId("live", nextActiveId);
      void sendRuntimeMessage({ type: "save-settings", settings: { activeLiveProviderId: nextActiveId } })
        .then((response) => {
          if (!disposed && !response?.ok) {
            reportStatus((response as { error?: string } | undefined)?.error || "激活平台保存失败", true);
          }
        })
        .catch((error) => {
          reportStatus((error as Error)?.message || "激活平台保存失败", true);
        });
    }
    emitSummarySnapshot();
  }

  function renderAsrProviders(providers: ProviderRowItem[], rawActiveId?: string): void {
    if (disposed || !asrNodes) return;
    asrProviders = providers;
    const prevActiveId =
      rawActiveId !== undefined
        ? String(rawActiveId || "").trim()
        : familyRows.asr.getActiveId?.(asrNodes.listNode) || activeAsrId;
    const nextActiveId = resolveActiveAsrProviderId(providers, prevActiveId);
    familyRows.asr.render(asrNodes.listNode, asrNodes.emptyNode, providers, {
      presets: asrPresets,
      activeId: nextActiveId
    });
    activeAsrId = nextActiveId;
    if (nextActiveId !== prevActiveId) {
      setStoredActiveId("asr", nextActiveId);
      void sendRuntimeMessage({ type: "save-settings", settings: { activeAsrProviderId: nextActiveId } })
        .then((response) => {
          if (!disposed && !response?.ok) {
            reportStatus((response as { error?: string } | undefined)?.error || "保存默认平台失败", true);
          }
        })
        .catch((error) => {
          reportStatus((error as Error)?.message || "保存默认平台失败", true);
        });
    }
    emitSummarySnapshot();
  }

  async function refreshGeminiCredentialStatus(): Promise<void> {
    if (disposed || !liveNodes) return;
    const sessionGeneration = generation;
    const hasGeminiLive = liveProviders.some((provider) => isGeminiLiveProvider(provider));
    if (!hasGeminiLive) {
      credentialRequest += 1;
      geminiCredentialStatus = null;
      renderLiveProviders();
      return;
    }
    const request = ++credentialRequest;
    const { status } = await queryAiCredentialKey("gemini-live");
    if (disposed || sessionGeneration !== generation || request !== credentialRequest) return;
    geminiCredentialStatus = status;
    renderLiveProviders();
  }

  async function loadSearchProviderOrder(providers: ProviderRowItem[]): Promise<string[]> {
    try {
      const stored = await chrome.storage.sync.get([SEARCH_PROVIDER_ORDER_STORAGE]);
      return normalizeSearchProviderOrder(
        stored?.[SEARCH_PROVIDER_ORDER_STORAGE],
        providers.map((provider) => String(provider?.id || ""))
      );
    } catch {
      return [];
    }
  }

  function sortSearchProviders(providers: ProviderRowItem[]): ProviderRowItem[] {
    return providers
      .map((provider) => ({
        provider,
        rank: providerOrderRank(
          String(provider?.id || ""),
          String(provider?.presetId || ""),
          searchProviderOrder
        )
      }))
      .sort((left, right) =>
        left.rank[0] !== right.rank[0] ? left.rank[0] - right.rank[0] : left.rank[1] - right.rank[1]
      )
      .map((entry) => entry.provider);
  }

  function syncResetSearchOrderButton(): void {
    if (searchExtra?.resetOrderBtn) {
      searchExtra.resetOrderBtn.disabled = searchProviderOrder.length === 0;
    }
  }

  function setSearchChainExpanded(expanded: boolean): void {
    if (searchExtra?.chainContainer) {
      searchExtra.chainContainer.hidden = !expanded;
    }
    if (searchExtra?.toggleChainBtn) {
      searchExtra.toggleChainBtn.setAttribute("aria-expanded", String(expanded));
      searchExtra.toggleChainBtn.setAttribute(
        "aria-label",
        expanded ? "收起搜索平台与回退链" : "展开搜索平台与回退链"
      );
    }
  }

  function restoreSearchRowDomOrder(order: string[]): void {
    const listNode = searchNodes?.listNode;
    if (!listNode) return;
    const smartRow = listNode.querySelector<HTMLElement>('.search-provider-row[data-provider-id="__smart__"]');
    const recordRows = Array.from(listNode.querySelectorAll<HTMLElement>(".search-provider-row")).filter(
      (row) => !smartRow || row !== smartRow
    );
    recordRows.sort((left, right) => {
      const rankA = providerOrderRank(
        left.dataset.providerId || "",
        left.dataset.currentPresetId || "",
        order
      );
      const rankB = providerOrderRank(
        right.dataset.providerId || "",
        right.dataset.currentPresetId || "",
        order
      );
      return rankA[0] !== rankB[0] ? rankA[0] - rankB[0] : rankA[1] - rankB[1];
    });
    for (const row of recordRows) {
      listNode.appendChild(row);
    }
  }

  function resolveSelectedSearchRow(): HTMLElement | null {
    const checked = searchNodes?.listNode.querySelector<HTMLInputElement>(
      ".search-provider-active-radio:checked"
    );
    const row = checked?.closest(".search-provider-row") as HTMLElement | null;
    if (!row || isSmartSearchActive(row.dataset.providerId || "")) return null;
    return row;
  }

  function isPaidSearchRow(row: HTMLElement): boolean {
    const presetId = row.dataset.currentPresetId || "";
    return SEARCH_PROVIDER_PRESETS.some((preset) => preset.id === presetId && preset.access === "paid");
  }

  function syncSearchChainActiveSummary(): void {
    const summaryEl = searchExtra?.chainActiveSummary;
    if (!summaryEl) return;
    const row = resolveSelectedSearchRow();
    if (!row) {
      const paidAdmitted = searchExtra?.allowPaidToggle?.checked === true;
      summaryEl.textContent = paidAdmitted ? `${SMART_SUMMARY_BASE} · 可能使用付费平台` : SMART_SUMMARY_BASE;
      return;
    }
    const name = row.querySelector(".provider-row-name")?.textContent?.trim() || "所选平台";
    summaryEl.textContent = `仅使用 ${name} · 失败不回退${isPaidSearchRow(row) ? " · 可能付费" : ""}`;
  }

  function syncSearchModeControls(): void {
    const single = resolveSelectedSearchRow() !== null;
    const note = searchExtra?.chainContainer?.querySelector<HTMLElement>(".search-chain-mode-note");
    if (note) note.textContent = single ? SINGLE_MODE_NOTE : SMART_MODE_NOTE;
    const footer = searchExtra?.chainContainer?.querySelector<HTMLElement>(".search-chain-footer-bar");
    if (footer) footer.hidden = single;
    const paidRow = searchExtra?.allowPaidToggle?.closest<HTMLElement>(".biliscript-toggle-row");
    if (paidRow) paidRow.hidden = single;
    searchNodes?.listNode.classList.toggle("search-chain-single-mode", single);
  }

  function syncSearchDanglingHint(activeIdValue: string, providers: ProviderRowItem[]): void {
    const hint = searchExtra?.danglingHint;
    if (!hint) return;
    const activeIdTrimmed = activeIdValue.trim();
    hint.hidden =
      !activeIdTrimmed ||
      isSmartSearchActive(activeIdTrimmed) ||
      providers.some((provider) => String(provider?.id || "") === activeIdTrimmed);
  }

  function renderSearchProvidersSync(providers: ProviderRowItem[], knownAiProviders: readonly ProviderRowItem[]): void {
    if (disposed || !searchNodes) return;
    searchProviders = providers;
    if (providers.length === 0) {
      setSearchChainExpanded(true);
    }
    familyRows.search.render(
      searchNodes.listNode,
      searchNodes.emptyNode,
      annotateAiCredentialRows("search", sortSearchProviders(providers), knownAiProviders),
      { presets: SEARCH_PROVIDER_PRESETS, activeId: activeSearchProviderId }
    );
    syncResetSearchOrderButton();
    syncSearchDanglingHint(activeSearchProviderId, providers);
    syncSearchModeControls();
    syncSearchChainActiveSummary();
    emitSummarySnapshot();
  }

  function rerenderSearchProviders(providers: ProviderRowItem[], knownAiProviders?: readonly ProviderRowItem[]): void {
    searchProviders = providers;
    if (knownAiProviders) {
      renderSearchProvidersSync(providers, knownAiProviders);
      return;
    }
    const sessionGeneration = generation;
    void loadRows("ai").then((latestAi) => {
      if (disposed || sessionGeneration !== generation) return;
      aiProviders = latestAi;
      aiProvidersLoaded = true;
      renderSearchProvidersSync(providers, latestAi);
    });
  }

  async function clearDeletedActiveSearchProvider(): Promise<void> {
    activeSearchProviderId = "";
    state.patchSettings({ activeSearchProviderId: "" });
    syncSearchDanglingHint("", searchProviders);
    syncSearchModeControls();
    syncSearchChainActiveSummary();
    emitSummarySnapshot();
    try {
      const resp = await sendRuntimeMessage({
        type: "save-settings",
        settings: { activeSearchProviderId: "" }
      });
      if (!resp?.ok) {
        throw new Error((resp as { error?: string } | undefined)?.error || "清除默认搜索平台失败");
      }
    } catch (error) {
      reportStatus((error as Error)?.message || "清除默认搜索平台失败", true);
    }
  }

  function renderAiProviders(providers: ProviderRowItem[]): void {
    if (disposed || !aiNodes) return;
    aiProviders = providers;
    aiProvidersLoaded = true;
    familyRows.ai.render(aiNodes.listNode, aiNodes.emptyNode, providers, {
      presets: presetsForKind("ai")
    });
    emitSummarySnapshot();
  }

  async function syncConsumerFamiliesAfterAiChange(
    aiSnapshot: readonly ProviderRowItem[],
    optionsArg: { refreshSettingsForAi?: boolean } = {}
  ): Promise<void> {
    const sessionGeneration = generation;
    const [nextLive, nextSearch, settings] = await Promise.all([
      hasFamily("live") ? loadRows("live") : Promise.resolve<ProviderRowItem[] | null>(null),
      hasFamily("search") ? loadRows("search") : Promise.resolve<ProviderRowItem[] | null>(null),
      optionsArg.refreshSettingsForAi && hasFamily("ai") ? getSettings() : Promise.resolve<Partial<Settings> | null>(null)
    ]);
    if (disposed || sessionGeneration !== generation) return;
    if (settings && aiNodes) {
      options.onAiChanged?.(aiProviders, { settings });
    }
    if (nextLive !== null) {
      liveProviders = nextLive;
      await refreshGeminiCredentialStatus();
    }
    if (nextSearch !== null && !disposed && sessionGeneration === generation) {
      renderSearchProvidersSync(nextSearch, aiSnapshot);
    }
  }

  const transactions = createProviderTransactions({
    families,
    requestOrigins: requestProviderOriginsViaBackground,
    rerender: (kind, providers) => {
      if (disposed) return;
      if (kind === "ai") {
        renderAiProviders(providers);
        options.onAiChanged?.(providers, {});
        pendingAiConsumerSync = syncConsumerFamiliesAfterAiChange(providers, {
          refreshSettingsForAi: hasFamily("ai")
        }).finally(() => {
          pendingAiConsumerSync = null;
        });
        return;
      }
      if (kind === "live") {
        liveProviders = providers;
        renderLiveProviders();
        return;
      }
      if (kind === "asr") {
        renderAsrProviders(providers);
        return;
      }
      if (kind === "search") {
        rerenderSearchProviders(providers);
      }
    },
    reportOriginRevokeFailure: (message) => {
      deleteRevokeFailureInFlight = true;
      reportStatus(message, true);
    }
  });

  async function upsertProvider(kind: ProviderEditorKind, upsert: ProviderRowItem): Promise<MutationResult> {
    const result = await transactions.upsertProvider(kind, upsert);
    if (!disposed && result.ok) {
      if (pendingAiConsumerSync) {
        await pendingAiConsumerSync;
      } else if (kind === "live") {
        await refreshGeminiCredentialStatus();
      }
      if (!disposed) {
        options.onMutated?.({ kind, action: "save", providerId: String(upsert.id || "") });
      }
    }
    return result;
  }

  async function deleteProvider(
    kind: ProviderEditorKind,
    target: { id: string; baseUrl: string }
  ): Promise<MutationResult> {
    deleteRevokeFailureInFlight = false;
    statusErrorMarked = false;
    const result = await transactions.deleteProvider(kind, target);
    if (!disposed && result.ok) {
      if (pendingAiConsumerSync) {
        await pendingAiConsumerSync;
      } else if (kind === "live") {
        await refreshGeminiCredentialStatus();
      }
      if (!disposed && kind === "search" && target.id && target.id === activeSearchProviderId) {
        await clearDeletedActiveSearchProvider();
      }
      if (!disposed) {
        options.onMutated?.({ kind, action: "delete", providerId: target.id });
      }
    }
    return result;
  }

  const modalOnSave: ProviderEditorSave = async (saveKind, upsert) => {
    const result = await upsertProvider(saveKind, upsert);
    if (!disposed && result.ok) {
      if (saveKind === "search" && searchNodes) {
        setSearchChainExpanded(true);
      }
      reportMutationText("平台已保存");
    }
    return result;
  };

  const modalOnDelete: ProviderEditorDelete = async (deleteKind, target) => {
    const result = await deleteProvider(deleteKind, target);
    if (!disposed && result.ok && !deleteRevokeFailureInFlight && !statusErrorMarked) {
      reportMutationText("平台已删除");
    }
    return result;
  };

  async function openEditor(request: OpenProviderEditorRequest): Promise<void> {
    if (disposed) return;
    const sessionGeneration = generation;
    await ensurePresetsLoaded();
    if (disposed || sessionGeneration !== generation) return;
    const providers = await loadRows(request.kind);
    if (disposed || sessionGeneration !== generation) return;
    const item = request.providerId
      ? providers.find((provider) => String(provider?.id || "") === request.providerId) || null
      : null;
    if (request.providerId && !item) {
      request.setupSession?.onSessionEnd?.();
      reportStatus("未找到要编辑的平台记录，可能已被删除", true);
      return;
    }
    if ((request.kind === "live" || request.kind === "search") && !aiProvidersLoaded) {
      aiProviders = await loadRows("ai");
      aiProvidersLoaded = true;
      if (disposed || sessionGeneration !== generation) return;
    }
    const resolveLinkedCredential =
      request.kind === "live" || request.kind === "search"
        ? (draft: EditorDraftView) => {
            const target = linkedCredentialTargetForDraft(request.kind as "live" | "search", draft);
            if (!target) return null;
            return linkedCredentialFor(target, resolveAiCredentialPlan(target, aiProviders), () => {
              void enterLinkedCredentialEditor(target);
            });
          }
        : null;
    const mountHost = options.getEditorMountHost?.() ?? undefined;
    try {
      const editor = editorModule || (await import("./provider-editor.js"));
      if (disposed || sessionGeneration !== generation) return;
      editorModule = editor;
      editor.openProviderEditor({
        kind: request.kind,
        item,
        presetId: request.presetId,
        presets: presetsForKind(request.kind),
        ...(mountHost ? { mountHost } : {}),
        onSave: modalOnSave,
        onDelete: modalOnDelete,
        ...(request.setupSession
          ? {
              submitLabel: request.submitLabel ?? "保存并继续",
              firstSetup: request.firstSetup ?? true,
              onAfterSave: request.setupSession.onAfterSave,
              onSessionEnd: request.setupSession.onSessionEnd
            }
          : {}),
        ...(resolveLinkedCredential ? { resolveLinkedCredential } : {}),
        ...(request.setupContextBanner ? { setupContextBanner: request.setupContextBanner } : {}),
        ...(request.initialStatus ? { initialStatus: request.initialStatus } : {}),
        ...(request.initialFocusField ? { initialFocusField: request.initialFocusField } : {}),
        ...(request.restore
          ? {
              initialDraft: request.restore.initialDraft,
              baselineDraft: request.restore.baselineDraft
            }
          : {})
      });
    } catch (error) {
      request.setupSession?.onSessionEnd?.();
      reportStatus((error as Error)?.message || "编辑器加载失败", true);
    }
  }

  async function enterLinkedCredentialEditor(target: AiCredentialLinkTarget): Promise<void> {
    if (disposed || linkedCredentialInFlight) return;
    const kind = target === "deepseek" ? "search" : "live";
    const stash = editorModule?.stashProviderEditorDraft(kind) ?? null;
    if (!stash) return;
    linkedCredentialInFlight = true;
    const mountHost = options.getEditorMountHost?.() ?? null;
    const actionButtons = Array.from(
      (mountHost ?? document).querySelectorAll<HTMLButtonElement>(".provider-editor-linked-credential-btn")
    );
    for (const btn of actionButtons) {
      btn.disabled = true;
    }
    try {
      await ensurePresetsLoaded();
      const latestAiProviders = await loadRows("ai");
      if (disposed) return;
      aiProviders = latestAiProviders;
      aiProvidersLoaded = true;
      editorModule = await enterAiCredentialEditor({
        target,
        plan: resolveAiCredentialPlan(target, latestAiProviders),
        mountHost,
        aiPresets: presetsForKind("ai"),
        onSave: modalOnSave,
        onDelete: modalOnDelete,
        stash,
        reopenConsumerEditor: (stashed, hint) => {
          void restoreConsumerEditor(kind, stashed, hint);
        }
      });
    } finally {
      linkedCredentialInFlight = false;
      for (const btn of actionButtons) {
        if (btn.isConnected) btn.disabled = false;
      }
    }
  }

  async function restoreConsumerEditor(
    kind: "live" | "search",
    stash: ProviderEditorDraftStash,
    hint: string | null
  ): Promise<void> {
    if (disposed) return;
    const defaultCanRestore = Boolean((options.getEditorMountHost?.() ?? options.host)?.isConnected);
    const canRestore = options.canRestoreConsumerEditor ? options.canRestoreConsumerEditor() : defaultCanRestore;
    if (!canRestore) return;
    const sessionGeneration = generation;
    const [consumerProviders, latestAiProviders] = await Promise.all([loadRows(kind), loadRows("ai")]);
    if (disposed || sessionGeneration !== generation) return;
    aiProviders = latestAiProviders;
    aiProvidersLoaded = true;
    if (kind === "live") {
      liveProviders = consumerProviders;
      await refreshGeminiCredentialStatus();
      if (disposed || sessionGeneration !== generation) return;
    } else {
      renderSearchProvidersSync(consumerProviders, latestAiProviders);
    }
    await openEditor({
      kind,
      providerId: stash.editingId,
      restore: {
        initialDraft: stash.draft,
        baselineDraft: stash.baseline
      },
      ...(hint ? { initialStatus: { message: hint, isError: false } } : {})
    });
  }

  async function openLinkedCredentialEditor(target: AiCredentialLinkTarget): Promise<void> {
    if (disposed) return;
    await ensurePresetsLoaded();
    const providers = aiProvidersLoaded ? aiProviders : await loadRows("ai");
    if (disposed) return;
    aiProviders = providers;
    aiProvidersLoaded = true;
    editorModule = await enterAiCredentialEditor({
      target,
      plan: resolveAiCredentialPlan(target, providers),
      mountHost: options.getEditorMountHost?.() ?? null,
      aiPresets: presetsForKind("ai"),
      onSave: modalOnSave,
      onDelete: modalOnDelete
    });
  }

  async function openLiveTarget(target: LiveSettingsTarget): Promise<void> {
    if (target === "live") {
      options.host
        .querySelector<HTMLElement>(`#${ids.liveSettingsHeader}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    await openLinkedCredentialEditor("gemini-live");
  }

  // ===== 列表行 / 事件绑定 =====

  const revokeOriginOnDelete = async (providerId: string, baseUrl: string): Promise<void> => {
    deleteRevokeFailureInFlight = false;
    statusErrorMarked = false;
    const providers = await loadOriginSharingProviders(families);
    const { origins, revoked } = await revokeOrphanOrigin({ id: providerId, baseUrl }, providers);
    if (origins.length > 0 && !revoked && !disposed) {
      deleteRevokeFailureInFlight = true;
      reportStatus(permissionRevokeErrorMessage(origins), true);
    }
  };

  function bindActiveRadioFamily(kind: ActiveRadioFamilyKind, nodes: FamilyDomNodes): void {
    const decl = PROVIDER_FAMILY_ROWS[kind];
    const radioClass = `${decl.activeRadio!.classPrefix}-provider-active-radio`;
    const key = activeSettingsKey(kind);

    familyRows[kind].controller.setErrorHandler((msg) => reportStatus(msg, true));
    familyRows[kind].controller.setBeforeDeleteHandler(revokeOriginOnDelete);
    familyRows[kind].setActiveChangeHandler?.((nextId, meta) => {
      if (disposed) return;
      setStoredActiveId(kind, nextId);
      if (kind === "live" && (!meta.pending || meta.rolledBack)) {
        void refreshGeminiCredentialStatus();
      }
      emitSummarySnapshot();
    });
    familyRows[kind].controller.setDeleteHandler(async (providerId) => {
      if (disposed) return;
      const remainingRows = Array.from(nodes.listNode.querySelectorAll<HTMLElement>(`.${decl.rowClass}`));
      const prevCheckedId = familyRows[kind].getActiveId?.(nodes.listNode) || "";
      const prevStoredId = getStoredActiveId(kind);
      const nextActiveId = resolveActiveIdFor(
        kind,
        remainingRows.map((row) => ({ id: row.dataset.providerId || "" })),
        prevCheckedId
      );
      if (nextActiveId && nextActiveId !== prevCheckedId) {
        const targetRadio = remainingRows
          .find((row) => row.dataset.providerId === nextActiveId)
          ?.querySelector<HTMLInputElement>(`.${radioClass}`);
        if (targetRadio) targetRadio.checked = true;
      }
      familyRows[kind].syncActiveRendered?.(nodes.listNode);
      if (nextActiveId !== prevCheckedId || nextActiveId !== prevStoredId || remainingRows.length === 0) {
        setStoredActiveId(kind, nextActiveId);
        try {
          const resp = await sendRuntimeMessage({ type: "save-settings", settings: { [key]: nextActiveId } });
          if (!resp?.ok) {
            throw new Error((resp as { error?: string } | undefined)?.error || "保存默认平台失败");
          }
        } catch (error) {
          reportStatus((error as Error)?.message || "保存默认平台失败", true);
          return;
        }
      }
      if (kind === "live") {
        liveProviders = liveProviders.filter((provider) => provider.id !== providerId);
        await refreshGeminiCredentialStatus();
      } else {
        asrProviders = asrProviders.filter((provider) => provider.id !== providerId);
      }
      emitSummarySnapshot();
      options.onMutated?.({ kind, action: "delete", providerId });
      if (!deleteRevokeFailureInFlight) {
        reportMutationText("平台已删除");
      }
    });
    nodes.addButton.addEventListener("click", () => void openEditor({ kind, providerId: "" }));
  }

  if (liveNodes) {
    bindActiveRadioFamily("live", liveNodes);
  }
  if (asrNodes) {
    bindActiveRadioFamily("asr", asrNodes);
  }
  if (aiNodes) {
    familyRows.ai.controller.setErrorHandler((msg) => reportStatus(msg, true));
    familyRows.ai.controller.setBeforeDeleteHandler(revokeOriginOnDelete);
    familyRows.ai.controller.setDeleteHandler(async (providerId) => {
      if (disposed) return;
      const [latestAi, latestLive, latestSearch, settings] = await Promise.all([
        loadRows("ai"),
        hasFamily("live") ? loadRows("live") : Promise.resolve<ProviderRowItem[] | null>(null),
        hasFamily("search") ? loadRows("search") : Promise.resolve<ProviderRowItem[] | null>(null),
        getSettings()
      ]);
      if (disposed) return;
      aiProviders = latestAi;
      aiProvidersLoaded = true;
      options.onAiChanged?.(latestAi, { settings });
      if (latestLive !== null) {
        liveProviders = latestLive;
        await refreshGeminiCredentialStatus();
      }
      if (latestSearch !== null && !disposed) {
        renderSearchProvidersSync(latestSearch, latestAi);
      }
      options.onMutated?.({ kind: "ai", action: "delete", providerId });
      if (!deleteRevokeFailureInFlight) {
        reportMutationText("平台已删除");
      }
    });
    aiNodes.addButton.addEventListener("click", () => void openEditor({ kind: "ai", providerId: "" }));
  }
  if (searchNodes) {
    familyRows.search.controller.setErrorHandler((msg) => reportStatus(msg, true));
    familyRows.search.setActiveChangeHandler?.((providerId) => {
      if (disposed) return;
      activeSearchProviderId = providerId;
      state.patchSettings({ activeSearchProviderId: providerId });
      if (providerId && searchExtra?.danglingHint) {
        searchExtra.danglingHint.hidden = true;
      } else {
        syncSearchDanglingHint("", searchProviders);
      }
      syncSearchModeControls();
      syncSearchChainActiveSummary();
      emitSummarySnapshot();
    });
    familyRows.search.controller.setDeleteHandler(async (providerId) => {
      if (disposed) return;
      searchProviders = searchProviders.filter((item) => String(item?.id || "") !== providerId);
      if (searchProviders.length === 0) {
        setSearchChainExpanded(true);
      }
      if (providerId && providerId === activeSearchProviderId) {
        await clearDeletedActiveSearchProvider();
        if (statusErrorMarked) return;
      }
      emitSummarySnapshot();
      options.onMutated?.({ kind: "search", action: "delete", providerId });
      reportMutationText("平台已删除");
    });
    wireProviderRowDrag(searchNodes.listNode, {
      onCommit: async (orderedIds) => {
        const prevOrder = [...searchProviderOrder];
        searchProviderOrder = orderedIds;
        syncResetSearchOrderButton();
        try {
          await chrome.storage.sync.set({ [SEARCH_PROVIDER_ORDER_STORAGE]: orderedIds });
        } catch (error) {
          searchProviderOrder = prevOrder;
          syncResetSearchOrderButton();
          restoreSearchRowDomOrder(prevOrder);
          reportStatus((error as Error)?.message || "保存搜索顺序失败", true);
        }
      }
    });
    searchExtra?.resetOrderBtn?.addEventListener("click", async () => {
      try {
        await chrome.storage.sync.remove(SEARCH_PROVIDER_ORDER_STORAGE);
        searchProviderOrder = [];
        rerenderSearchProviders(await loadRows("search"));
        reportStatus("已恢复默认搜索顺序");
      } catch (error) {
        reportStatus((error as Error)?.message || "恢复默认搜索顺序失败", true);
      }
    });
    searchExtra?.toggleChainBtn?.addEventListener("click", () => {
      setSearchChainExpanded(Boolean(searchExtra.chainContainer?.hidden));
    });
    searchExtra?.allowPaidToggle?.addEventListener("change", () => {
      syncSearchChainActiveSummary();
    });
    searchNodes.addButton.addEventListener("click", () => void openEditor({ kind: "search", providerId: "" }));
  }

  async function load(knownSettings?: Partial<Settings>): Promise<void> {
    const sessionGeneration = generation;
    const onlyLive =
      hasFamily("live") && !hasFamily("ai") && !hasFamily("asr") && !hasFamily("search");
    try {
      const settingsPromise: Promise<Partial<Settings>> = knownSettings
        ? Promise.resolve(knownSettings)
        : onlyLive
          ? chrome.storage.sync.get(["activeLiveProviderId"]) as Promise<Partial<Settings>>
          : getSettings();
      const [settings, nextAi, nextLive, nextAsr, nextSearch] = await Promise.all([
        settingsPromise,
        hasFamily("ai") || hasFamily("live") || hasFamily("search") ? loadRows("ai") : Promise.resolve<ProviderRowItem[]>([]),
        hasFamily("live") ? loadRows("live") : Promise.resolve<ProviderRowItem[]>([]),
        hasFamily("asr") ? loadRows("asr") : Promise.resolve<ProviderRowItem[]>([]),
        hasFamily("search") ? loadRows("search") : Promise.resolve<ProviderRowItem[]>([]),
        ensurePresetsLoaded()
      ]);
      if (disposed || sessionGeneration !== generation) return;

      if (hasFamily("ai") || hasFamily("live") || hasFamily("search")) {
        aiProviders = nextAi;
        aiProvidersLoaded = true;
      }
      if (hasFamily("ai")) {
        renderAiProviders(nextAi);
        options.onAiChanged?.(nextAi, { settings });
      }
      if (hasFamily("live")) {
        liveProviders = nextLive;
        activeLiveId = typeof settings.activeLiveProviderId === "string" ? settings.activeLiveProviderId.trim() : "";
        await refreshGeminiCredentialStatus();
        if (disposed || sessionGeneration !== generation) return;
      }
      if (hasFamily("asr")) {
        activeAsrId = typeof settings.activeAsrProviderId === "string" ? settings.activeAsrProviderId.trim() : "";
        renderAsrProviders(nextAsr, activeAsrId);
      }
      if (hasFamily("search")) {
        activeSearchProviderId =
          typeof settings.activeSearchProviderId === "string" ? settings.activeSearchProviderId.trim() : "";
        searchProviders = nextSearch;
        searchProviderOrder = await loadSearchProviderOrder(nextSearch);
        if (disposed || sessionGeneration !== generation) return;
        renderSearchProvidersSync(nextSearch, nextAi);
      }
      emitSummarySnapshot();
    } catch (error) {
      if (!disposed) {
        reportStatus(
          (error as Error)?.message || (onlyLive ? "伴看平台加载失败" : "平台加载失败"),
          true
        );
      }
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    generation += 1;
    credentialRequest += 1;
    closeConfirmDialog();
    editorModule?.closeProviderEditor(true);
    editorModule = null;
  }

  return {
    load,
    loadRows,
    ensurePresetsLoaded,
    getAiPresets: () => (aiPresets.length ? aiPresets : PRESETS),
    openEditor,
    openLinkedCredentialEditor,
    openLiveTarget,
    upsertProvider,
    deleteProvider,
    dispose
  };
}
