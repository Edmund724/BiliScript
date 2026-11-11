// extension/live/audio-popover.ts
// 伴看音频设置弹层：原生 Popover 提供 top layer 与 light dismiss；不支持时
// 移到当前全屏宿主或 body，以 fixed 定位避开浮窗圆角和播放器 overflow 裁切。

export interface AudioPopoverHandle {
  isOpen(): boolean;
  toggle(): void;
  close(restoreFocus?: boolean): void;
  dispose(): void;
}

interface AudioPopoverOptions {
  button: HTMLButtonElement;
  popover: HTMLElement;
  getOverlayRoot: () => HTMLElement | null;
  getMountHost: () => HTMLElement;
  onOpen: () => void;
}

type PopoverElement = HTMLElement & {
  showPopover?: () => void;
  hidePopover?: () => void;
};

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;

export function bindAudioPopover(options: AudioPopoverOptions): AudioPopoverHandle {
  const { button, popover, getOverlayRoot, getMountHost, onOpen } = options;
  const popoverEl = popover as PopoverElement;
  let open = false;
  let nativeOpen = false;
  let disposed = false;

  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", popover.id);

  function syncOpenState(nextOpen: boolean): void {
    open = nextOpen;
    button.setAttribute("aria-expanded", String(nextOpen));
    popover.classList.toggle("is-open", nextOpen);
    const root = getOverlayRoot();
    if (root) {
      if (nextOpen) {
        root.dataset.popoverOpen = "1";
      } else {
        delete root.dataset.popoverOpen;
      }
    }
  }

  function getFullscreenHost(): HTMLElement | null {
    const fullscreenElement =
      document.fullscreenElement ||
      (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement;
    return fullscreenElement instanceof HTMLElement ? fullscreenElement : null;
  }

  function position(): void {
    if (!open) return;
    const anchorRect = button.getBoundingClientRect();
    popover.style.maxHeight = "";
    const rect = popover.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const below = Math.max(0, viewportHeight - anchorRect.bottom - ANCHOR_GAP - VIEWPORT_MARGIN);
    const above = Math.max(0, anchorRect.top - ANCHOR_GAP - VIEWPORT_MARGIN);
    const placeBelow = rect.height <= below || below >= above;
    const availableHeight = placeBelow ? below : above;
    const height = Math.min(rect.height, availableHeight);
    const width = rect.width;

    popover.dataset.placement = placeBelow ? "bottom" : "top";
    popover.style.maxHeight = `${availableHeight}px`;
    const preferredLeft = anchorRect.right - width;
    const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN);
    const left = Math.min(maxLeft, Math.max(VIEWPORT_MARGIN, preferredLeft));
    const preferredTop = placeBelow ? anchorRect.bottom + ANCHOR_GAP : anchorRect.top - ANCHOR_GAP - height;
    const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - height - VIEWPORT_MARGIN);
    const top = Math.min(maxTop, Math.max(VIEWPORT_MARGIN, preferredTop));
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    popover.style.right = "auto";
    popover.style.bottom = "auto";
  }

  function finalizeClose(restoreFocus: boolean): void {
    if (!open && popover.hidden) return;
    nativeOpen = false;
    syncOpenState(false);
    popover.hidden = true;
    if (restoreFocus && button.isConnected) {
      button.focus({ preventScroll: true });
    }
  }

  function close(restoreFocus = true): void {
    if (!open) return;
    if (nativeOpen && typeof popoverEl.hidePopover === "function" && !popover.hidden) {
      try {
        popoverEl.hidePopover();
      } catch {}
    }
    finalizeClose(restoreFocus);
  }

  function show(): void {
    if (disposed || open) return;
    onOpen();
    popover.hidden = false;
    syncOpenState(true);

    let nativeShown = false;
    if (typeof popoverEl.showPopover === "function") {
      try {
        popoverEl.showPopover();
        nativeShown = true;
      } catch {}
    }
    nativeOpen = nativeShown;
    if (!nativeShown) {
      const fallbackHost = getFullscreenHost() || (getMountHost().contains(button) ? document.body : getMountHost());
      if (popover.parentElement !== fallbackHost) fallbackHost.appendChild(popover);
    }
    position();
  }

  function toggle(): void {
    if (open) {
      close();
    } else {
      show();
    }
  }

  function onButtonClick(event: MouseEvent): void {
    event.stopPropagation();
    toggle();
  }

  function onPopoverClick(event: MouseEvent): void {
    event.stopPropagation();
  }

  function onPopoverToggle(event: Event): void {
    if ((event as ToggleEvent).newState === "closed") finalizeClose(true);
  }

  function onDocumentPointerDown(event: PointerEvent): void {
    if (!open || nativeOpen) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (popover.contains(target) || button.contains(target)) return;
    event.preventDefault();
    close();
  }

  function onDocumentKeyDown(event: KeyboardEvent): void {
    if (!open || nativeOpen || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  function onViewportChange(): void {
    position();
  }

  button.addEventListener("click", onButtonClick);
  popover.addEventListener("click", onPopoverClick);
  popover.addEventListener("toggle", onPopoverToggle);
  document.addEventListener("pointerdown", onDocumentPointerDown);
  document.addEventListener("keydown", onDocumentKeyDown, true);
  window.addEventListener("resize", onViewportChange);
  document.addEventListener("fullscreenchange", onViewportChange);

  return {
    isOpen: () => open,
    toggle,
    close,
    dispose() {
      disposed = true;
      close(false);
      button.removeEventListener("click", onButtonClick);
      popover.removeEventListener("click", onPopoverClick);
      popover.removeEventListener("toggle", onPopoverToggle);
      document.removeEventListener("pointerdown", onDocumentPointerDown);
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      window.removeEventListener("resize", onViewportChange);
      document.removeEventListener("fullscreenchange", onViewportChange);
      popover.remove();
    }
  };
}
