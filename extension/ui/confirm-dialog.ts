import { activeById } from "../shared/active-host.js";
import { ids } from "../shared/dom-ids.js";
import { escapeHtml } from "../shared/string-utils.js";
import { mountPanelModalShell, type PanelModalShell } from "./focus-scope.js";

export interface ConfirmDialogOptions {
  message: string;
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  mountHost?: HTMLElement;
}

export type ConfirmDialogResult = "confirmed" | "cancelled" | "view-destroyed";

interface ConfirmState {
  open: boolean;
  shell: PanelModalShell | null;
  generation: number;
}

const state: ConfirmState = {
  open: false,
  shell: null,
  generation: 0
};

let nextDialogId = 0;
let viewGeneration = 0;
let resolvePending: (result: ConfirmDialogResult) => void = () => {};

export function isConfirmDialogOpen(): boolean {
  return state.open;
}

function settle(generation: number, result: ConfirmDialogResult): void {
  if (generation !== state.generation || !state.open) {
    return;
  }
  state.open = false;
  const shell = state.shell;
  state.shell = null;
  const cb = resolvePending;
  resolvePending = () => {};
  try {
    shell?.dispose();
  } catch {
  } finally {
    cb(result);
  }
}

export function closeConfirmDialog(): void {
  settle(state.generation, "cancelled");
}

export function getConfirmDialogViewGeneration(): number {
  return viewGeneration;
}

export function dismissConfirmDialog(): void {
  settle(state.generation, "view-destroyed");
  viewGeneration += 1;
}

export async function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return (await confirmDialogWithResult(options)) === "confirmed";
}

export function confirmDialogWithResult(options: ConfirmDialogOptions): Promise<ConfirmDialogResult> {
  settle(state.generation, "cancelled");
  const mountHost = options.mountHost || activeById(ids.readingView);
  if (!mountHost) {
    return Promise.resolve("cancelled");
  }
  const confirmText = options.confirmText || "确定";
  const cancelText = options.cancelText?.trim() || "取消";
  const title = options.title?.trim() || "请确认";
  const dialogId = `confirm-dialog-${++nextDialogId}`;
  const generation = state.generation + 1;
  state.generation = generation;
  state.open = true;

  const shell = mountPanelModalShell({
    mountHost,
    hostClassName: "confirm-dialog-host",
    dialogSelector: ".confirm-dialog",
    initialFocusSelector: ".confirm-dialog-cancel",
    html: `
    <div class="confirm-dialog-mask" data-confirm-dialog-action="cancel"></div>
    <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="${dialogId}-title" aria-describedby="${dialogId}-message" tabindex="-1">
      <h2 class="confirm-dialog-title" id="${dialogId}-title">${escapeHtml(title)}</h2>
      <p class="confirm-dialog-message" id="${dialogId}-message">${escapeHtml(options.message)}</p>
      <footer class="confirm-dialog-foot">
        <button type="button" class="confirm-dialog-cancel" data-confirm-dialog-action="cancel">${escapeHtml(cancelText)}</button>
        <button type="button" class="confirm-dialog-confirm${options.danger ? " confirm-dialog-confirm-danger" : ""}" data-confirm-dialog-action="confirm">${escapeHtml(confirmText)}</button>
      </footer>
    </section>`,
    isTopLayer: () => state.generation === generation,
    onRequestDismiss: () => settle(generation, "cancelled"),
    onForceDismiss: () => settle(generation, "cancelled")
  });
  state.shell = shell;

  shell.host.addEventListener("click", (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-confirm-dialog-action]")?.dataset.confirmDialogAction;
    if (action === "confirm") {
      settle(generation, "confirmed");
    } else if (action === "cancel") {
      settle(generation, "cancelled");
    }
  });

  return new Promise<ConfirmDialogResult>((resolve) => {
    resolvePending = resolve;
  });
}
