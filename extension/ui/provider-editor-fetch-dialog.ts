import { resolveNodeDocument } from "../shared/cross-doc.js";
import { escapeHtml } from "../shared/string-utils.js";
import { fetchProviderModels, resolveAiModelListTarget } from "../ai/provider-models.js";
import { normalizeDraftModels, captureSession, runIfCurrent, state, getDialog } from "./provider-editor-state.js";
import { isSavedKeyReconfirmRequired } from "./provider-editor-projection.js";
import { addModelRow, refreshModelCatalogMeta, showCatalogError } from "./provider-editor-catalog.js";
import { isConfirmDialogOpen } from "./confirm-dialog.js";
import { createFocusScope, type FocusScope } from "./focus-scope.js";
import {
  animateTriggerEnter,
  animateTriggerExit,
  cancelTriggerExit
} from "./trigger-motion.js";
import { PROVIDER_FAMILY_ROWS } from "./provider-family.js";

export type FetchDialogState = "loading" | "ready" | "empty-server" | "error";

let fetchModelsCache: string[] = [];
const fetchSelected = new Set<string>();
let fetchFilter = "";
let fetchGeneration = 0;
let fetchInFlight = false;
let fetchFocusScope: FocusScope | null = null;
let fetchTrigger: HTMLElement | null = null;

function setUnderlyingEditorIsolated(isolated: boolean): void {
  const dialog = getDialog();
  if (!dialog) return;
  const targets = dialog.querySelectorAll<HTMLElement>(":scope > .provider-editor-head, :scope > .provider-editor-form");
  targets.forEach((el) => {
    el.inert = isolated;
    if (isolated) {
      el.setAttribute("aria-hidden", "true");
    } else {
      el.removeAttribute("aria-hidden");
    }
  });
}

function setFetchState(subview: HTMLElement, nextState: FetchDialogState): void {
  subview.dataset.fetchState = nextState;
  const loading = subview.querySelector<HTMLElement>(".provider-editor-fetch-loading");
  const search = subview.querySelector<HTMLElement>(".provider-editor-fetch-search");
  const allRow = subview.querySelector<HTMLElement>(".provider-editor-fetch-all-row");
  const list = subview.querySelector<HTMLElement>(".provider-editor-fetch-list");
  const emptyServer = subview.querySelector<HTMLElement>(".provider-editor-fetch-empty-server");
  const error = subview.querySelector<HTMLElement>(".provider-editor-fetch-error");
  const note = subview.querySelector<HTMLElement>(".provider-editor-fetch-note");

  if (loading) loading.hidden = nextState !== "loading";
  if (search) search.hidden = nextState !== "ready";
  if (allRow) allRow.hidden = nextState !== "ready";
  if (list) list.hidden = nextState !== "ready";
  if (emptyServer) emptyServer.hidden = nextState !== "empty-server";
  if (error) error.hidden = nextState !== "error";
  if (note && nextState !== "ready") note.hidden = true;
}

export function getFetchDialog(): HTMLElement | null {
  return state.host?.querySelector<HTMLElement>('.provider-editor-fetch-dialog:not([data-biliscript-closing="1"])') || null;
}

export function closeFetchDialog(restoreFocus = true): void {
  fetchGeneration += 1;
  fetchInFlight = false;
  const closingSubview = getFetchDialog();
  const trigger = fetchTrigger;
  fetchTrigger = null;
  fetchModelsCache = [];
  fetchSelected.clear();
  fetchFilter = "";
  setUnderlyingEditorIsolated(false);
  fetchFocusScope?.dispose(restoreFocus && state.open);
  fetchFocusScope = null;
  if (closingSubview) {
    animateTriggerExit({
      target: closingSubview,
      trigger,
      fallbackOrigin: "bottom right",
      toScale: 0.94,
      durationMs: 130,
      onFinish: () => closingSubview.remove()
    });
  }
}

export function renderFetchSkeleton(): void {
  const dialog = getDialog();
  if (!dialog) return;
  closeFetchDialog(false);
  dialog.querySelectorAll<HTMLElement>('.provider-editor-fetch-dialog[data-biliscript-closing="1"]').forEach((el) => {
    cancelTriggerExit(el);
  });
  const triggerBtn = dialog.querySelector<HTMLElement>(".provider-editor-fetch");
  fetchTrigger = triggerBtn;
  dialog.insertAdjacentHTML("beforeend", `
    <section class="provider-editor-fetch-dialog" role="group" aria-label="获取可用模型" tabindex="-1" data-fetch-state="loading">
      <header class="provider-editor-fetch-head">
        <button type="button" class="provider-editor-fetch-back" data-provider-editor-action="close-fetch" aria-label="返回平台编辑器">← 返回</button>
        <span class="provider-editor-fetch-title">获取可用模型</span>
      </header>
      <p class="provider-editor-fetch-loading">
        <span class="provider-editor-fetch-spinner" aria-hidden="true"></span>
        <span>正在拉取模型列表...</span>
      </p>
      <input class="provider-editor-fetch-search" type="text" placeholder="搜索模型" hidden />
      <label class="provider-editor-fetch-all-row" hidden>
        <input type="checkbox" class="provider-editor-fetch-all" />
        <span>全选</span>
      </label>
      <ul class="provider-editor-fetch-list" hidden></ul>
      <p class="provider-editor-fetch-empty-server" hidden>该平台未返回可用模型，可返回手动添加</p>
      <p class="provider-editor-fetch-error" hidden></p>
      <p class="provider-editor-fetch-note" hidden></p>
      <footer class="provider-editor-fetch-foot">
        <button type="button" class="provider-editor-fetch-cancel" data-provider-editor-action="close-fetch">取消</button>
        <button type="button" class="provider-editor-fetch-confirm" data-provider-editor-action="confirm-fetch" disabled>添加所选</button>
      </footer>
    </section>`);
  const subview = getFetchDialog();
  if (!subview) return;
  animateTriggerEnter({
    target: subview,
    trigger: triggerBtn,
    fallbackOrigin: "bottom right",
    fromScale: 0.93,
    durationMs: 180
  });
  setUnderlyingEditorIsolated(true);
  const backBtn = subview.querySelector<HTMLElement>(".provider-editor-fetch-back");
  fetchFocusScope = createFocusScope(subview, {
    initialFocus: backBtn ?? subview,
    returnFocus: triggerBtn,
    isActive: () => !isConfirmDialogOpen()
  });

  const searchInput = subview.querySelector<HTMLInputElement>(".provider-editor-fetch-search");
  searchInput?.addEventListener("input", (event) => {
    renderFetchItems(String((event.target as HTMLInputElement).value || ""));
  });
  searchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const firstEnabled = subview.querySelector<HTMLInputElement>(".provider-editor-fetch-check:not(:disabled)");
      if (firstEnabled) {
        firstEnabled.checked = !firstEnabled.checked;
        setFetchSelected(firstEnabled.value, firstEnabled.checked);
        syncFetchSelectionState();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      const target =
        subview.querySelector<HTMLInputElement>(".provider-editor-fetch-check:not(:disabled)") ??
        subview.querySelector<HTMLInputElement>(".provider-editor-fetch-check");
      if (target) {
        event.preventDefault();
        target.focus({ preventScroll: true });
      }
    }
  });

  const list = subview.querySelector<HTMLElement>(".provider-editor-fetch-list");
  list?.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("provider-editor-fetch-check")) return;
    const checks = Array.from(list.querySelectorAll<HTMLInputElement>(".provider-editor-fetch-check"));
    const index = checks.indexOf(target as HTMLInputElement);
    if (index < 0) return;
    if (event.key === "ArrowDown") {
      const next = checks[index + 1];
      if (next) {
        event.preventDefault();
        next.focus({ preventScroll: true });
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index === 0) {
        searchInput?.focus({ preventScroll: true });
      } else {
        checks[index - 1]?.focus({ preventScroll: true });
      }
    } else if (event.key === "Enter") {
      const check = target as HTMLInputElement;
      if (!check.disabled) {
        event.preventDefault();
        check.checked = !check.checked;
        setFetchSelected(check.value, check.checked);
        syncFetchSelectionState();
      }
    }
  });

  subview.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const all = target.closest<HTMLInputElement>(".provider-editor-fetch-all");
    if (all) {
      getFetchDialog()
        ?.querySelectorAll<HTMLInputElement>(".provider-editor-fetch-check:not(:disabled)")
        .forEach((check) => {
          check.checked = all.checked;
          setFetchSelected(check.value, all.checked);
        });
    } else {
      const check = target.closest<HTMLInputElement>(".provider-editor-fetch-check");
      if (check && !check.disabled) {
        setFetchSelected(check.value, check.checked);
      }
    }
    syncFetchSelectionState();
  });
}

function setFetchSelected(model: string, selected: boolean): void {
  const value = model.trim();
  if (!value) return;
  if (selected) {
    fetchSelected.add(value);
  } else {
    fetchSelected.delete(value);
  }
}

export function renderFetchList(models: string[]): void {
  const dialog = getFetchDialog();
  if (!dialog) return;
  fetchModelsCache = models.map(String);
  for (const model of Array.from(fetchSelected)) {
    if (!fetchModelsCache.includes(model)) {
      fetchSelected.delete(model);
    }
  }
  const error = dialog.querySelector<HTMLElement>(".provider-editor-fetch-error");
  if (error) {
    error.hidden = true;
    error.textContent = "";
  }
  if (fetchModelsCache.length === 0) {
    fetchFilter = "";
    const list = dialog.querySelector<HTMLElement>(".provider-editor-fetch-list");
    if (list) list.innerHTML = "";
    setFetchState(dialog, "empty-server");
    syncFetchSelectionState();
    return;
  }
  setFetchState(dialog, "ready");
  renderFetchItems("");
}

export function renderFetchItems(filter: string): void {
  const dialog = getFetchDialog();
  const list = dialog?.querySelector<HTMLElement>(".provider-editor-fetch-list");
  if (!dialog || !list) return;
  fetchFilter = filter;
  const existing = new Set(normalizeDraftModels(state.draft?.models ?? []));
  const kw = filter.trim().toLowerCase();
  const visible = fetchModelsCache.filter((m) => !kw || m.toLowerCase().includes(kw));
  list.innerHTML = visible.length
    ? visible.map((m) => {
        const added = existing.has(m);
        if (added) {
          fetchSelected.delete(m);
        }
        return `
          <li class="provider-editor-fetch-item" data-model-id="${escapeHtml(m)}">
            <label class="provider-editor-fetch-item-label">
              <input type="checkbox" class="provider-editor-fetch-check" value="${escapeHtml(m)}" ${added ? "disabled" : ""} ${!added && fetchSelected.has(m) ? "checked" : ""} />
              <span class="provider-editor-fetch-name">${escapeHtml(m)}</span>
            </label>
            <span class="provider-editor-fetch-meta" data-model-meta hidden></span>
            ${added ? '<span class="provider-editor-fetch-added">已添加</span>' : ""}
          </li>`;
      }).join("")
    : `<li class="provider-editor-fetch-message">无匹配模型</li>`;
  refreshModelCatalogMeta();
  syncFetchSelectionState();
}

export function syncFetchSelectionState(): void {
  const dialog = getFetchDialog();
  if (!dialog) return;
  const checks = Array.from(dialog.querySelectorAll<HTMLInputElement>(".provider-editor-fetch-check:not(:disabled)"));
  const checkedCount = checks.filter((check) => check.checked).length;
  const all = dialog.querySelector<HTMLInputElement>(".provider-editor-fetch-all");
  if (all) {
    all.checked = checks.length > 0 && checkedCount === checks.length;
    all.indeterminate = checkedCount > 0 && checkedCount < checks.length;
  }
  const total = fetchSelected.size;
  const confirm = dialog.querySelector<HTMLButtonElement>(".provider-editor-fetch-confirm");
  if (confirm) {
    confirm.disabled = total === 0 || dialog.dataset.fetchState !== "ready";
    confirm.textContent = total > 0 ? `添加所选 (${total})` : "添加所选";
  }
  const kw = fetchFilter.trim().toLowerCase();
  const hidden =
    dialog.dataset.fetchState === "ready" && kw
      ? Array.from(fetchSelected).filter((m) => !m.toLowerCase().includes(kw)).length
      : 0;
  const note = dialog.querySelector<HTMLElement>(".provider-editor-fetch-note");
  if (note) {
    note.hidden = hidden === 0;
    note.textContent = hidden > 0 ? `另有 ${hidden} 项已选不在当前筛选结果中` : "";
  }
}

export function renderFetchError(message: string): void {
  const dialog = getFetchDialog();
  const list = dialog?.querySelector<HTMLElement>(".provider-editor-fetch-list");
  const error = dialog?.querySelector<HTMLElement>(".provider-editor-fetch-error");
  if (!dialog || !error) return;
  if (list) {
    list.innerHTML = "";
  }
  setFetchState(dialog, "error");
  error.hidden = false;
  error.textContent = `${message} `;
  const retry = resolveNodeDocument(dialog).createElement("button");
  retry.type = "button";
  retry.className = "provider-editor-fetch-retry";
  retry.dataset.providerEditorAction = "retry-fetch";
  retry.textContent = "重试";
  error.appendChild(retry);
  syncFetchSelectionState();
}

export async function loadFetchModels(
  baseUrl: string,
  apiKey: string,
  protocol: string,
  generation?: number,
  providerId?: string
): Promise<void> {
  await runIfCurrent(
    async (): Promise<{ ok?: boolean; models?: string[]; error?: string }> => {
      try {
        return await fetchProviderModels({
          baseUrl,
          apiKey,
          providerId: providerId ?? (isSavedKeyReconfirmRequired() ? "" : state.editingId),
          protocol
        });
      } catch (error) {
        return { ok: false, error: (error as Error | undefined)?.message || "拉取失败" };
      }
    },
    {
      ok: (resp) => {
        if (generation === undefined || generation === fetchGeneration) {
          fetchInFlight = false;
        }
        if (resp?.ok && Array.isArray(resp.models)) {
          renderFetchList(resp.models);
        } else {
          renderFetchError(String(resp?.error || "拉取失败"));
        }
      },
      fail: (error) => {
        if (generation === undefined || generation === fetchGeneration) {
          fetchInFlight = false;
        }
        renderFetchError((error as Error | undefined)?.message || "拉取失败");
      }
    },
    () => getFetchDialog() !== null && (generation === undefined || generation === fetchGeneration)
  );
}

export async function openFetchDialog(validateBeforeFetch?: () => boolean): Promise<void> {
  if (fetchInFlight) return;
  const draft = state.draft;
  if (!draft) return;
  if (validateBeforeFetch && !validateBeforeFetch()) {
    return;
  }
  const baseUrl = draft.baseUrl.trim();
  const apiKey = draft.apiKey.trim();
  const family = PROVIDER_FAMILY_ROWS[state.kind];
  const preset = family.resolvePreset(state.presets, draft.presetId);
  showCatalogError("");
  const reconfirmKey = isSavedKeyReconfirmRequired(draft);
  const providerId = reconfirmKey ? "" : state.editingId;
  const target = resolveAiModelListTarget({
    baseUrl,
    protocol: draft.protocol,
    preset
  });
  renderFetchSkeleton();
  const generation = ++fetchGeneration;
  fetchInFlight = true;
  const session = captureSession(
    () => getFetchDialog() !== null && generation === fetchGeneration
  );
  await session.runWithOriginPreflight(
    target.permissionBaseUrls,
    () => loadFetchModels(target.baseUrl, apiKey, draft.protocol, generation, providerId),
    {
      ok: () => {
        if (generation === fetchGeneration) {
          fetchInFlight = false;
        }
      },
      denied: (error) => {
        if (generation === fetchGeneration) {
          fetchInFlight = false;
        }
        renderFetchError(
          `未拉取：${error || "未取得该平台域名权限，无法拉取模型列表"}。请重新授权后重试`
        );
      },
      fail: (error) => {
        if (generation === fetchGeneration) {
          fetchInFlight = false;
        }
        renderFetchError((error as Error | undefined)?.message || "拉取失败");
      }
    }
  );
}

export function confirmFetchSelection(): void {
  if (!getFetchDialog()) return;
  const existing = new Set(normalizeDraftModels(state.draft?.models ?? []));
  Array.from(fetchSelected)
    .map((model) => model.trim())
    .filter((model) => model && !existing.has(model))
    .forEach((model) => addModelRow(model));
  showCatalogError("");
  closeFetchDialog();
}
