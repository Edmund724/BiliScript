// extension/ui/focus-scope.ts
// 面板内弹层的共享外壳、键盘焦点约束与归还、同级节点 inert 隔离与设置抽屉收起观察：
// Tab / Shift+Tab 在当前容器内环绕，容器打开期间焦点被拉回容器，关闭 / 取消后
// 把焦点还给打开前仍有效的触发控件。
//
// 叠层的让位规则由调用方经 isActive / isTopLayer 注入：下层弹层在确认框等上层
// 弹层打开时整体停手，一次键盘或外点输入只结算最上层。

import { ids } from "../shared/dom-ids.js";
import {
  animateTriggerEnter,
  animateTriggerExit,
  cancelTriggerExit,
  resolveTriggerElement
} from "./trigger-motion.js";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export interface FocusScopeOptions {
  // 打开时先聚焦的节点（缺省为容器自身；容器需 tabindex=-1）
  initialFocus?: HTMLElement | null;
  // 关闭后归还焦点的目标（缺省 = 打开前的 document.activeElement）
  returnFocus?: HTMLElement | null;
  // 上层弹层打开时返回 false：本层暂停约束与归还
  isActive?: () => boolean;
}

export interface FocusScope {
  dispose(restoreFocus?: boolean): void;
}

function isVisible(element: HTMLElement): boolean {
  if (element.hidden || element.closest("[hidden]")) return false;
  if (element.closest('[aria-hidden="true"]')) return false;
  for (let cur: HTMLElement | null = element; cur; cur = cur.parentElement) {
    if (cur.inert || cur.hasAttribute("inert")) return false;
  }
  const view = element.ownerDocument.defaultView;
  if (!view) return true;
  const style = view.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0 && isVisible(element)
  );
}

// 打开前焦点在 body / document 上时不算有效触发控件：关闭后不归还到这些节点。
function captureReturnTarget(explicit: HTMLElement | null | undefined): HTMLElement | null {
  if (explicit) return explicit;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  if (active === document.body || active === document.documentElement) return null;
  return active;
}

// 隔离同级容器：把宿主父容器下除本宿主外、尚未处于 inert 态的同级节点置为 inert，
// 返回幂等恢复函数（支持多层弹层叠加时逐层隔离与恢复，不误解开底层隔离）。
export function isolateHostSiblings(host: HTMLElement): () => void {
  const parent = host.parentElement;
  if (!parent) return () => {};
  const isolated: HTMLElement[] = [];
  for (const child of Array.from(parent.children)) {
    if (!(child instanceof HTMLElement) || child === host) continue;
    if (child.inert || child.hasAttribute("inert")) continue;
    child.inert = true;
    isolated.push(child);
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const sibling of isolated) {
      sibling.inert = false;
    }
  };
}

export function createFocusScope(container: HTMLElement, options: FocusScopeOptions = {}): FocusScope {
  const isActive = options.isActive ?? (() => true);
  const returnTarget = captureReturnTarget(options.returnFocus);
  let disposed = false;

  const restore = (): void => {
    if (!isActive()) return;
    if (!returnTarget || !returnTarget.isConnected || !isVisible(returnTarget)) return;
    if (returnTarget instanceof HTMLButtonElement || returnTarget instanceof HTMLInputElement) {
      if (returnTarget.disabled) return;
    }
    returnTarget.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isActive() || event.key !== "Tab") return;
    const items = focusableWithin(container);
    if (items.length === 0) {
      event.preventDefault();
      container.focus({ preventScroll: true });
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !container.contains(active)) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      }
      return;
    }
    if (active === last || !container.contains(active)) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  const onFocusIn = (event: Event): void => {
    if (!isActive()) return;
    const target = event.target;
    if (target instanceof Node && container.contains(target)) return;
    container.focus({ preventScroll: true });
  };

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("focusin", onFocusIn, true);
  (options.initialFocus ?? container).focus({ preventScroll: true });

  return {
    dispose(restoreFocus = true): void {
      if (disposed) return;
      disposed = true;
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      if (restoreFocus) {
        restore();
      }
    }
  };
}

export type PanelModalDismissReason = "escape" | "outside-click";

export interface PanelModalShellOptions {
  hostClassName: string;
  html: string;
  dialogSelector: string;
  maskSelector?: string;
  mountHost?: HTMLElement | null;
  initialFocusSelector?: string;
  returnFocus?: HTMLElement | null;
  isTopLayer?: () => boolean;
  onRequestDismiss: (reason: PanelModalDismissReason) => void;
  onForceDismiss: () => void;
}

export interface PanelModalShell {
  host: HTMLElement;
  dialog: HTMLElement | null;
  dispose(restoreFocus?: boolean): void;
}

// 盯 #biliscript-reading-settings-panel 的 hidden 属性，设置抽屉收起时联动结算上层弹层。
export function observeSettingsPanelHidden(onHidden: () => void): () => void {
  const panel = document.getElementById(ids.readingSettingsPanel);
  if (!panel || typeof MutationObserver === "undefined") {
    return () => {};
  }
  const observer = new MutationObserver(() => {
    if (panel.hidden) {
      onHidden();
    }
  });
  observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  return () => observer.disconnect();
}

export function mountPanelModalShell(options: PanelModalShellOptions): PanelModalShell {
  const mountHost = options.mountHost || document.getElementById(ids.readingView);
  if (!mountHost) {
    throw new Error("Panel modal mount host not found");
  }
  const trigger = resolveTriggerElement(options.returnFocus);
  mountHost.querySelectorAll<HTMLElement>('[data-panel-modal-host="1"][data-biliscript-closing="1"]').forEach((el) => {
    if (el.querySelector(options.dialogSelector)) {
      cancelTriggerExit(el);
    }
  });
  const host = document.createElement("div");
  host.className = options.hostClassName;
  host.dataset.panelModalHost = "1";
  host.innerHTML = options.html;
  mountHost.appendChild(host);

  const restoreSiblings = isolateHostSiblings(host);
  const isTopLayer = options.isTopLayer ?? (() => true);
  let disposed = false;

  host.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  const onDocumentClickCapture = (event: MouseEvent): void => {
    if (disposed || !isTopLayer()) return;
    const view = host.parentElement || document.getElementById(ids.readingView);
    if (view && event.target instanceof Node && view.contains(event.target)) {
      return;
    }
    event.stopPropagation();
    options.onRequestDismiss("outside-click");
  };

  const onDocumentKeyDownCapture = (event: KeyboardEvent): void => {
    if (disposed || event.key !== "Escape" || !isTopLayer()) return;
    event.preventDefault();
    event.stopPropagation();
    options.onRequestDismiss("escape");
  };

  const mask = host.querySelector<HTMLElement>(options.maskSelector ?? ".confirm-dialog-mask");
  const dialog = host.querySelector<HTMLElement>(options.dialogSelector);
  const initialFocus =
    (options.initialFocusSelector ? host.querySelector<HTMLElement>(options.initialFocusSelector) : null) ??
    dialog;
  const focusScope = dialog
    ? createFocusScope(dialog, {
        initialFocus,
        returnFocus: options.returnFocus,
        isActive: isTopLayer
      })
    : null;

  if (dialog) {
    animateTriggerEnter({
      target: dialog,
      mask,
      trigger,
      fallbackOrigin: "top right",
      fromScale: 0.93,
      durationMs: 190
    });
  }

  document.addEventListener("click", onDocumentClickCapture, true);
  document.addEventListener("keydown", onDocumentKeyDownCapture, true);
  const stopObservingHidden = observeSettingsPanelHidden(() => {
    if (!disposed) {
      options.onForceDismiss();
    }
  });

  return {
    host,
    dialog,
    dispose(restoreFocus = true): void {
      if (disposed) return;
      disposed = true;
      stopObservingHidden();
      document.removeEventListener("click", onDocumentClickCapture, true);
      document.removeEventListener("keydown", onDocumentKeyDownCapture, true);
      // 先解除同级 inert 再归还焦点，避免 returnTarget 仍处于 inert 无法接收焦点。
      restoreSiblings();
      focusScope?.dispose(restoreFocus);
      if (dialog) {
        animateTriggerExit({
          target: dialog,
          host,
          mask,
          trigger,
          fallbackOrigin: "top right",
          toScale: 0.94,
          durationMs: 130,
          onFinish: () => host.remove()
        });
      } else {
        host.remove();
      }
    }
  };
}
