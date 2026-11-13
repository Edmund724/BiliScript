// extension/ui/focus-scope.ts
// 单层弹层的键盘焦点约束与归还：Tab / Shift+Tab 在当前容器内环绕，容器打开
// 期间焦点被拉回容器，关闭 / 取消后把焦点还给打开前仍有效的触发控件。
//
// 叠层的让位规则由调用方经 isActive 注入：下层弹层在确认框等上层弹层打开时
// 整体停手，一次键盘输入只结算最上层（与 provider-editor / confirm-dialog
// 既有的文档级监听让位同源）。

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
  dispose(): void;
}

function isVisible(element: HTMLElement): boolean {
  if (element.hidden || element.closest("[hidden]")) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
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
    dispose(): void {
      if (disposed) return;
      disposed = true;
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      restore();
    }
  };
}
