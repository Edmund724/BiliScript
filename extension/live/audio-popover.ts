import { getFullscreenHost } from "../bilibili/fullscreen.js";
import {
  animateTriggerEnter,
  animateTriggerExit,
  applyElementTriggerOrigin,
  cancelTriggerExit
} from "../ui/trigger-motion.js";

export interface AudioPopoverHandle {
  syncHost(): void;
  reposition(): void;
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

  function syncFallbackHost(): void {
    if (!open || nativeOpen) return;
    const fallbackHost = getFullscreenHost() || (getMountHost().contains(button) ? document.body : getMountHost());
    if (popover.parentElement !== fallbackHost) fallbackHost.appendChild(popover);
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
    applyElementTriggerOrigin(popover, anchorRect, placeBelow ? "top right" : "bottom right");
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
    open = false;
    button.setAttribute("aria-expanded", "false");
    if (restoreFocus && button.isConnected) {
      button.focus({ preventScroll: true });
    }
    const fallbackOrigin = popover.dataset.placement === "top" ? "bottom right" : "top right";
    animateTriggerExit({
      target: popover,
      trigger: button,
      fallbackOrigin,
      toScale: 0.94,
      durationMs: 120,
      onFinish: () => {
        if (nativeOpen && typeof popoverEl.hidePopover === "function" && !popover.hidden) {
          try {
            popoverEl.hidePopover();
          } catch {}
        }
        finalizeClose(false);
      }
    });
  }

  function focusFirstControl(): void {
    const firstInteractive = popover.querySelector<HTMLElement>(
      'input:not([disabled]), button:not([disabled]), [role="switch"]:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    firstInteractive?.focus({ preventScroll: true });
  }

  function show(showOptions?: { focusFirst?: boolean }): void {
    if (disposed || open) return;
    cancelTriggerExit(popover);
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
    syncFallbackHost();
    position();
    animateTriggerEnter({
      target: popover,
      trigger: button,
      fallbackOrigin: popover.dataset.placement === "top" ? "bottom right" : "top right",
      fromScale: 0.93,
      durationMs: 160
    });
    if (showOptions?.focusFirst) {
      focusFirstControl();
    }
  }

  function onButtonClick(event: MouseEvent): void {
    event.stopPropagation();
    if (open) {
      close(true);
    } else {
      show({ focusFirst: event.detail === 0 });
    }
  }

  function onPopoverClick(event: MouseEvent): void {
    event.stopPropagation();
  }

  function onDocumentPointerDown(event: PointerEvent): void {
    if (!open) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (popover.contains(target) || button.contains(target)) return;
    close(false);
  }

  function onDocumentKeyDown(event: KeyboardEvent): void {
    if (!open || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }

  function onViewportChange(): void {
    syncFallbackHost();
    position();
  }

  button.addEventListener("click", onButtonClick);
  popover.addEventListener("click", onPopoverClick);
  document.addEventListener("pointerdown", onDocumentPointerDown);
  document.addEventListener("keydown", onDocumentKeyDown, true);
  window.addEventListener("resize", onViewportChange);
  document.addEventListener("fullscreenchange", onViewportChange);

  return {
    syncHost: syncFallbackHost,
    reposition: onViewportChange,
    close,
    dispose() {
      disposed = true;
      cancelTriggerExit(popover);
      if (nativeOpen && typeof popoverEl.hidePopover === "function" && !popover.hidden) {
        try {
          popoverEl.hidePopover();
        } catch {}
      }
      finalizeClose(false);
      button.removeEventListener("click", onButtonClick);
      popover.removeEventListener("click", onPopoverClick);
      document.removeEventListener("pointerdown", onDocumentPointerDown);
      document.removeEventListener("keydown", onDocumentKeyDown, true);
      window.removeEventListener("resize", onViewportChange);
      document.removeEventListener("fullscreenchange", onViewportChange);
      popover.remove();
    }
  };
}
