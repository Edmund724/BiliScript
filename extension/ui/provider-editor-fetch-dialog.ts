import { resolveNodeDocument } from "../shared/cross-doc.js";
import { escapeHtml } from "../shared/string-utils.js";
import { fetchProviderModels, resolveAiModelListTarget } from "../ai/provider-models.js";
import { isConfirmDialogOpen } from "./confirm-dialog.js";
import { createFocusScope, type FocusScope } from "./focus-scope.js";
import { refreshModelCatalogMeta, showCatalogError } from "./provider-editor-model-rows.js";
import { normalizeDraftModels, type ProviderEditorSession } from "./provider-editor-session.js";
import { PROVIDER_FAMILY_ROWS } from "./provider-family.js";
import { animateTriggerEnter, animateTriggerExit, cancelTriggerExit } from "./trigger-motion.js";

type FetchDialogState = "loading" | "ready" | "empty-server" | "error";

export class FetchModelsController {
  private readonly session: ProviderEditorSession;
  private modelsCache: string[] = [];
  private readonly selected = new Set<string>();
  private filter = "";
  private generation = 0;
  private inFlight = false;
  private focusScope: FocusScope | null = null;
  private trigger: HTMLElement | null = null;

  constructor(session: ProviderEditorSession) {
    this.session = session;
  }

  getDialog(): HTMLElement | null {
    return (
      this.session.host.querySelector<HTMLElement>(
        '.provider-editor-fetch-dialog:not([data-biliscript-closing="1"])'
      ) || null
    );
  }

  isOpen(): boolean {
    return this.getDialog() !== null;
  }

  close(restoreFocus = true): void {
    this.generation += 1;
    this.inFlight = false;
    const closingSubview = this.getDialog();
    const trigger = this.trigger;
    this.trigger = null;
    this.modelsCache = [];
    this.selected.clear();
    this.filter = "";
    this.setUnderlyingEditorIsolated(false);
    this.focusScope?.dispose(restoreFocus && this.session.isOpen());
    this.focusScope = null;
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

  async open(): Promise<void> {
    if (this.inFlight) return;
    if (!this.session.validateBeforeFetchModels()) {
      return;
    }
    const baseUrl = this.session.draft.baseUrl.trim();
    const apiKey = this.session.draft.apiKey.trim();
    const family = PROVIDER_FAMILY_ROWS[this.session.kind];
    const preset = family.resolvePreset(this.session.presets, this.session.draft.presetId);
    showCatalogError(this.session, "");
    const providerId = this.session.resolveKeyReconfirm().remoteProviderId;
    const target = resolveAiModelListTarget({
      baseUrl,
      protocol: this.session.draft.protocol,
      preset
    });
    this.renderSkeleton();
    const generation = ++this.generation;
    this.inFlight = true;
    await this.session.runWithOriginPreflight(
      target.permissionBaseUrls,
      () =>
        fetchProviderModels({
          baseUrl: target.baseUrl,
          apiKey,
          providerId,
          protocol: this.session.draft.protocol
        }),
      {
        alive: () => this.isOpen() && generation === this.generation,
        denied: (error) => {
          this.inFlight = false;
          this.renderError(
            `未拉取：${error || "未取得该平台域名权限，无法拉取模型列表"}。请重新授权后重试`
          );
        },
        ok: (resp) => {
          this.inFlight = false;
          if (resp?.ok && Array.isArray(resp.models)) {
            this.renderList(resp.models);
          } else {
            this.renderError(String(resp?.error || "拉取失败"));
          }
        },
        fail: (error) => {
          this.inFlight = false;
          this.renderError((error as Error | undefined)?.message || "拉取失败");
        }
      }
    );
  }

  confirmSelection(): void {
    if (!this.isOpen()) return;
    const existing = new Set(normalizeDraftModels(this.session.draft.models));
    const toAdd: string[] = [];
    for (const raw of this.selected) {
      const model = raw.trim();
      if (model && !existing.has(model)) {
        existing.add(model);
        toAdd.push(model);
      }
    }
    this.close();
    this.session.appendModels(toAdd, { clearCatalogError: true });
  }

  private setUnderlyingEditorIsolated(isolated: boolean): void {
    const dialog = this.session.getDialog();
    if (!dialog) return;
    dialog
      .querySelectorAll<HTMLElement>(":scope > .provider-editor-head, :scope > .provider-editor-form")
      .forEach((el) => {
        el.inert = isolated;
        if (isolated) {
          el.setAttribute("aria-hidden", "true");
        } else {
          el.removeAttribute("aria-hidden");
        }
      });
  }

  private setFetchState(subview: HTMLElement, nextState: FetchDialogState): void {
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

  private setSelected(model: string, selected: boolean): void {
    const value = model.trim();
    if (!value) return;
    if (selected) {
      this.selected.add(value);
    } else {
      this.selected.delete(value);
    }
  }

  private renderSkeleton(): void {
    const dialog = this.session.getDialog();
    if (!dialog) return;
    this.close(false);
    dialog.querySelectorAll<HTMLElement>('.provider-editor-fetch-dialog[data-biliscript-closing="1"]').forEach((el) => {
      cancelTriggerExit(el);
    });
    const triggerBtn = dialog.querySelector<HTMLElement>(".provider-editor-fetch");
    this.trigger = triggerBtn;
    dialog.insertAdjacentHTML(
      "beforeend",
      `
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
    </section>`
    );
    const subview = this.getDialog();
    if (!subview) return;
    animateTriggerEnter({
      target: subview,
      trigger: triggerBtn,
      fallbackOrigin: "bottom right",
      fromScale: 0.93,
      durationMs: 180
    });
    this.setUnderlyingEditorIsolated(true);
    const backBtn = subview.querySelector<HTMLElement>(".provider-editor-fetch-back");
    this.focusScope = createFocusScope(subview, {
      initialFocus: backBtn ?? subview,
      returnFocus: triggerBtn,
      isActive: () => !isConfirmDialogOpen()
    });
    this.wireSubviewEvents(subview);
  }

  private wireSubviewEvents(subview: HTMLElement): void {
    const searchInput = subview.querySelector<HTMLInputElement>(".provider-editor-fetch-search");
    searchInput?.addEventListener("input", (event) => {
      this.renderItems(String((event.target as HTMLInputElement).value || ""));
    });
    searchInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const firstEnabled = subview.querySelector<HTMLInputElement>(".provider-editor-fetch-check:not(:disabled)");
        if (firstEnabled) {
          firstEnabled.checked = !firstEnabled.checked;
          this.setSelected(firstEnabled.value, firstEnabled.checked);
          this.syncSelectionState();
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
          this.setSelected(check.value, check.checked);
          this.syncSelectionState();
        }
      }
    });

    subview.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const all = target.closest<HTMLInputElement>(".provider-editor-fetch-all");
      if (all) {
        this.getDialog()
          ?.querySelectorAll<HTMLInputElement>(".provider-editor-fetch-check:not(:disabled)")
          .forEach((check) => {
            check.checked = all.checked;
            this.setSelected(check.value, all.checked);
          });
      } else {
        const check = target.closest<HTMLInputElement>(".provider-editor-fetch-check");
        if (check && !check.disabled) {
          this.setSelected(check.value, check.checked);
        }
      }
      this.syncSelectionState();
    });
  }

  private renderList(models: string[]): void {
    const dialog = this.getDialog();
    if (!dialog) return;
    this.modelsCache = models.map(String);
    for (const model of Array.from(this.selected)) {
      if (!this.modelsCache.includes(model)) {
        this.selected.delete(model);
      }
    }
    const error = dialog.querySelector<HTMLElement>(".provider-editor-fetch-error");
    if (error) {
      error.hidden = true;
      error.textContent = "";
    }
    if (this.modelsCache.length === 0) {
      this.filter = "";
      const list = dialog.querySelector<HTMLElement>(".provider-editor-fetch-list");
      if (list) list.innerHTML = "";
      this.setFetchState(dialog, "empty-server");
      this.syncSelectionState();
      return;
    }
    this.setFetchState(dialog, "ready");
    this.renderItems("");
  }

  private renderItems(filter: string): void {
    const dialog = this.getDialog();
    const list = dialog?.querySelector<HTMLElement>(".provider-editor-fetch-list");
    if (!dialog || !list) return;
    this.filter = filter;
    const existing = new Set(normalizeDraftModels(this.session.draft.models));
    const kw = filter.trim().toLowerCase();
    const visible = this.modelsCache.filter((m) => !kw || m.toLowerCase().includes(kw));
    list.innerHTML = visible.length
      ? visible
          .map((m) => {
            const added = existing.has(m);
            if (added) {
              this.selected.delete(m);
            }
            return `
          <li class="provider-editor-fetch-item" data-model-id="${escapeHtml(m)}">
            <label class="provider-editor-fetch-item-label">
              <input type="checkbox" class="provider-editor-fetch-check" value="${escapeHtml(m)}" ${added ? "disabled" : ""} ${!added && this.selected.has(m) ? "checked" : ""} />
              <span class="provider-editor-fetch-name">${escapeHtml(m)}</span>
            </label>
            <span class="provider-editor-fetch-meta" data-model-meta hidden></span>
            ${added ? '<span class="provider-editor-fetch-added">已添加</span>' : ""}
          </li>`;
          })
          .join("")
      : `<li class="provider-editor-fetch-message">无匹配模型</li>`;
    refreshModelCatalogMeta(this.session);
    this.syncSelectionState();
  }

  private syncSelectionState(): void {
    const dialog = this.getDialog();
    if (!dialog) return;
    const checks = Array.from(dialog.querySelectorAll<HTMLInputElement>(".provider-editor-fetch-check:not(:disabled)"));
    const checkedCount = checks.filter((check) => check.checked).length;
    const all = dialog.querySelector<HTMLInputElement>(".provider-editor-fetch-all");
    if (all) {
      all.checked = checks.length > 0 && checkedCount === checks.length;
      all.indeterminate = checkedCount > 0 && checkedCount < checks.length;
    }
    const total = this.selected.size;
    const confirm = dialog.querySelector<HTMLButtonElement>(".provider-editor-fetch-confirm");
    if (confirm) {
      confirm.disabled = total === 0 || dialog.dataset.fetchState !== "ready";
      confirm.textContent = total > 0 ? `添加所选 (${total})` : "添加所选";
    }
    const kw = this.filter.trim().toLowerCase();
    const hidden =
      dialog.dataset.fetchState === "ready" && kw
        ? Array.from(this.selected).filter((m) => !m.toLowerCase().includes(kw)).length
        : 0;
    const note = dialog.querySelector<HTMLElement>(".provider-editor-fetch-note");
    if (note) {
      note.hidden = hidden === 0;
      note.textContent = hidden > 0 ? `另有 ${hidden} 项已选不在当前筛选结果中` : "";
    }
  }

  private renderError(message: string): void {
    const dialog = this.getDialog();
    const list = dialog?.querySelector<HTMLElement>(".provider-editor-fetch-list");
    const error = dialog?.querySelector<HTMLElement>(".provider-editor-fetch-error");
    if (!dialog || !error) return;
    if (list) {
      list.innerHTML = "";
    }
    this.setFetchState(dialog, "error");
    error.hidden = false;
    error.textContent = `${message} `;
    const retry = resolveNodeDocument(dialog).createElement("button");
    retry.type = "button";
    retry.className = "provider-editor-fetch-retry";
    retry.dataset.providerEditorAction = "retry-fetch";
    retry.textContent = "重试";
    error.appendChild(retry);
    this.syncSelectionState();
  }
}
