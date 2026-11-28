import { resolveCreationDocument } from "../shared/cross-doc.js";
import { escapeHtml } from "../shared/string-utils.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { confirmDialog } from "./confirm-dialog.js";
import { renderUiIcon } from "./icon-registry.js";
import type { SearchProviderAccess } from "../core/presets.js";
import type { AiCredentialStatus } from "../core/ai-credential-reference.js";

export type ProviderRowElement = HTMLElement;

export interface ProviderRowItem {
  id?: string;
  presetId?: string;
  name?: string;
  baseUrl?: string;
  model?: string;
  models?: string[];
  type?: string;
  requiresKey?: boolean;
  enabled?: boolean;
  apiKey?: string;
  hasSavedKey?: boolean;
  statusNote?: string;
  credentialStatus?: AiCredentialStatus;
  credentialSource?: string;
  protocol?: string;
  liveGeminiNativeSearch?: boolean;
  voiceId?: string;
}

export interface ProviderRowPreset {
  id: string;
  name: string;
  baseUrl: string;
  model?: string;
  type?: string;
  requiresKey?: boolean;
  access?: SearchProviderAccess;
  protocol?: string;
  protocolBaseUrls?: Record<string, string>;
}

export type ProviderRowShowStatus = (
  node: HTMLElement | null | undefined,
  text: string,
  isError?: boolean
) => void;

export interface ProviderRowVirtualRow {
  id: string;
  label: string;
  hint?: string;
  title?: string;
}

export interface CreateProviderRowConfig {
  rowClass: string;
  editClass: string;
  removeClass: string;
  idPrefix: string;
  resolvePreset: (presets: readonly ProviderRowPreset[], presetId: string) => ProviderRowPreset | null;
  displayName: (item: ProviderRowItem, preset: ProviderRowPreset | null) => string;
  displayModel: (item: ProviderRowItem, preset: ProviderRowPreset | null) => string;
  resolveBadge?: (preset: ProviderRowPreset | null, hasSavedKey: boolean) => string;
  dragHandleClass?: string;
  virtualRow?: ProviderRowVirtualRow;
  buildTailFields?: (ctx: { id: string; isActive: boolean }) => string;
  wireTailExtras?: (row: ProviderRowElement, ctx: { listNode: HTMLElement }) => void;
  onRowEdit: (row: ProviderRowElement) => void;
  onRowDelete: (target: { id: string; baseUrl: string }) => Promise<{ ok: boolean; error?: string }>;
  getConfirmMountHost?: () => HTMLElement | null;
}

export type ActiveRadioChangeHandler = (
  activeId: string,
  meta: { pending: boolean; rolledBack: boolean }
) => void;

export type ProviderRowErrorHandler = (message: string) => void;

export interface ProviderRowController {
  generateId: () => string;
  render: (
    listNode: HTMLElement,
    emptyNode: HTMLElement,
    items: unknown,
    addOptions?: { presets?: readonly ProviderRowPreset[]; activeId?: string }
  ) => ProviderRowItem[];
  updateEmptyState: (listNode: HTMLElement, emptyNode: HTMLElement) => void;
  setErrorHandler: (handler: ProviderRowErrorHandler) => void;
}

export interface ActiveRadioTailConfig {
  classPrefix: string;
  title: string;
  settingsKey: string;
}

export interface ActiveRadioTail {
  buildTailFields: (ctx: { id: string; isActive: boolean }) => string;
  wireTailExtras: (row: ProviderRowElement, ctx: { listNode: HTMLElement }) => void;
  setActive: (listNode: HTMLElement, activeId: string) => void;
  getActiveId: (listNode: HTMLElement) => string;
  syncRendered: (listNode: HTMLElement) => void;
  setErrorHandler: (handler: ProviderRowErrorHandler) => void;
  setActiveChangeHandler: (handler: ActiveRadioChangeHandler) => void;
}

export function buildActiveRadioTail({ classPrefix, title, settingsKey }: ActiveRadioTailConfig): ActiveRadioTail {
  const radioClass = `${classPrefix}-provider-active-radio`;
  const rowClass = `${classPrefix}-provider-row`;
  let onError: ProviderRowErrorHandler = () => {};
  let onActiveChange: ActiveRadioChangeHandler = () => {};
  const lastActiveByList = new WeakMap<HTMLElement, string>();
  const requestSeqByList = new WeakMap<HTMLElement, number>();

  function buildTailFields({ isActive }: { id: string; isActive: boolean }): string {
    return `
    <label class="${classPrefix}-provider-active" title="${title}">
      <input class="${radioClass}" type="radio" name="${classPrefix}ActiveProvider" ${isActive ? "checked" : ""} />
      选用
    </label>`;
  }

  function wireTailExtras(row: ProviderRowElement, { listNode }: { listNode: HTMLElement }): void {
    const radio = row.querySelector<HTMLInputElement>(`.${radioClass}`);
    radio?.addEventListener("change", async () => {
      if (!radio.checked) return;
      const providerId = row.dataset.providerId || "";
      const prevActiveId = lastActiveByList.get(listNode) ?? "";
      const reqId = (requestSeqByList.get(listNode) ?? 0) + 1;
      requestSeqByList.set(listNode, reqId);
      onActiveChange(providerId, { pending: true, rolledBack: false });
      try {
        const resp = await sendRuntimeMessage({ type: "save-settings", settings: { [settingsKey]: providerId } });
        if (requestSeqByList.get(listNode) !== reqId) return;
        if (!resp?.ok) {
          throw new Error((resp as { error?: string } | undefined)?.error || "保存选用平台失败");
        }
        setActive(listNode, providerId);
        onActiveChange(providerId, { pending: false, rolledBack: false });
      } catch (error) {
        if (requestSeqByList.get(listNode) !== reqId) return;
        setActive(listNode, prevActiveId);
        onError((error as Error)?.message || "保存选用平台失败");
        onActiveChange(prevActiveId, { pending: false, rolledBack: true });
      }
    });
  }

  function setActive(listNode: HTMLElement, activeId: string): void {
    const target = String(activeId || "");
    listNode.querySelectorAll<HTMLInputElement>(`.${radioClass}`).forEach((radio) => {
      const row = radio.closest(`.${rowClass}`) as HTMLElement | null;
      radio.checked = Boolean(row && row.dataset.providerId === target);
    });
    lastActiveByList.set(listNode, getActiveId(listNode));
  }

  function getActiveId(listNode: HTMLElement): string {
    const checked = listNode.querySelector<HTMLInputElement>(`.${radioClass}:checked`);
    const row = checked?.closest(`.${rowClass}`) as HTMLElement | null;
    return row?.dataset.providerId || "";
  }

  function syncRendered(listNode: HTMLElement): void {
    lastActiveByList.set(listNode, getActiveId(listNode));
  }

  return {
    buildTailFields,
    wireTailExtras,
    setActive,
    getActiveId,
    syncRendered,
    setErrorHandler(handler) {
      onError = handler;
    },
    setActiveChangeHandler(handler) {
      onActiveChange = handler;
    }
  };
}

export function createProviderRow({
  rowClass,
  editClass,
  removeClass,
  idPrefix,
  resolvePreset,
  displayName,
  displayModel,
  resolveBadge,
  dragHandleClass,
  virtualRow,
  buildTailFields,
  wireTailExtras,
  onRowEdit,
  onRowDelete,
  getConfirmMountHost
}: CreateProviderRowConfig): ProviderRowController {
  let onError: ProviderRowErrorHandler = () => {};

  function generateId(): string {
    return `${idPrefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function updateEmptyState(listNode: HTMLElement, emptyNode: HTMLElement): void {
    const virtualId = virtualRow?.id;
    const hasRows = Array.from(listNode.children).some(
      (child) => (child as HTMLElement).dataset?.["providerId"] !== virtualId
    );
    emptyNode.hidden = hasRows;
  }

  function renderVirtualRow(listNode: HTMLElement, activeId: string): void {
    if (!virtualRow) return;
    const hint = String(virtualRow.hint || "");
    const row = resolveCreationDocument(listNode).createElement("div");
    row.className = rowClass;
    row.dataset.providerId = virtualRow.id;
    row.title = String(virtualRow.title || hint || "");
    const isActive = activeId === virtualRow.id;
    row.innerHTML = `
      <div class="provider-row-line">
        <span class="provider-row-name">${escapeHtml(virtualRow.label)}</span>
        ${buildTailFields ? buildTailFields({ id: virtualRow.id, isActive }) : ""}
      </div>
      ${hint ? `<div class="provider-row-model" title="${escapeHtml(hint)}">${escapeHtml(hint)}</div>` : ""}
    `;
    wireTailExtras?.(row, { listNode });
    listNode.appendChild(row);
  }

  function render(
    listNode: HTMLElement,
    emptyNode: HTMLElement,
    items: unknown,
    addOptions: { presets?: readonly ProviderRowPreset[]; activeId?: string } = {}
  ): ProviderRowItem[] {
    listNode.innerHTML = "";
    const activeId = String(addOptions.activeId || "");
    renderVirtualRow(listNode, activeId);
    const list: ProviderRowItem[] = Array.isArray(items) ? (items as ProviderRowItem[]) : [];
    list.forEach((item) => {
      const id = String(item.id || generateId());
      const presetId = String(item.presetId || "custom");
      const preset = resolvePreset(addOptions.presets || [], presetId);
      const baseUrl = String(item.baseUrl ?? preset?.baseUrl ?? "");
      const hasSavedKey = Boolean(item.hasSavedKey);
      const isActive = activeId === id;

      const row = resolveCreationDocument(listNode).createElement("div");
      row.className = rowClass;
      row.dataset.providerId = id;
      row.dataset.hasSavedKey = hasSavedKey ? "1" : "0";
      row.dataset.currentPresetId = presetId;
      row.dataset.baseUrl = baseUrl;

      const nameText = displayName(item, preset);
      const model = displayModel(item, preset);
      const credentialStatus = item.credentialStatus;
      const keyState = credentialStatus
        ? credentialStatus === "ok" ? "saved" : "missing"
        : hasSavedKey
          ? "saved"
          : preset?.access === "keyless"
            ? "keyless"
            : "missing";
      const keyStateTitle = credentialStatus
        ? credentialStatus === "ok" ? "已复用 AI 平台 Key" : "AI 平台 Key 不可用"
        : keyState === "saved"
          ? "已保存 API Key"
          : keyState === "keyless"
            ? "免 Key 可用"
            : "未保存 API Key";
      const badge = String(resolveBadge?.(preset, hasSavedKey) || "");
      const dragHandle = dragHandleClass
        ? `<button type="button" class="${dragHandleClass}" title="拖拽或按上下方向键调整搜索顺序" aria-label="调整 ${escapeHtml(nameText)} 搜索顺序">${renderUiIcon("gripVertical")}</button>`
        : "";
      row.innerHTML = `
        <div class="provider-row-line">
          <span class="provider-row-dot" data-state="${keyState}" title="${keyStateTitle}"></span>
          <span class="provider-row-name">${escapeHtml(nameText)}</span>
          ${badge ? `<span class="provider-row-badge">${escapeHtml(badge)}</span>` : ""}
          ${buildTailFields ? buildTailFields({ id, isActive }) : ""}
          <button type="button" class="${editClass}">编辑</button>
          <button type="button" class="${removeClass}" aria-label="删除" title="删除">
            ${renderUiIcon("trash")}
          </button>
          ${dragHandle}
        </div>
        ${model ? `<div class="provider-row-model" title="${escapeHtml(model)}">${escapeHtml(model)}</div>` : ""}
      `;

      row.querySelector(`.${editClass}`)?.addEventListener("click", () => {
        onRowEdit?.(row);
      });

      let deleting = false;
      row.querySelector(`.${removeClass}`)?.addEventListener("click", async () => {
        if (deleting) return;
        deleting = true;
        const removeBtn = row.querySelector<HTMLButtonElement>(`.${removeClass}`);
        const editBtn = row.querySelector<HTMLButtonElement>(`.${editClass}`);
        try {
          if (!(await confirmDialog({
            title: "删除平台",
            message: "确定要删除这个平台吗？",
            confirmText: "删除",
            danger: true,
            mountHost: getConfirmMountHost?.() || undefined
          }))) {
            return;
          }
          if (removeBtn) removeBtn.disabled = true;
          if (editBtn) editBtn.disabled = true;
          const providerId = row.dataset.providerId || "";
          const baseUrl = row.dataset.baseUrl || "";
          const resp = await onRowDelete({ id: providerId, baseUrl });
          if (!resp?.ok) {
            throw new Error(resp?.error || "删除平台失败");
          }
          if (row.isConnected) {
            row.remove();
            updateEmptyState(listNode, emptyNode);
          }
        } catch (error) {
          onError((error as Error)?.message || "删除平台失败");
        } finally {
          deleting = false;
          if (row.isConnected) {
            if (removeBtn) removeBtn.disabled = false;
            if (editBtn) editBtn.disabled = false;
          }
        }
      });

      wireTailExtras?.(row, { listNode });

      listNode.appendChild(row);
    });
    updateEmptyState(listNode, emptyNode);
    return list;
  }

  return {
    generateId,
    render,
    updateEmptyState,
    setErrorHandler(handler) {
      onError = handler;
    }
  };
}
