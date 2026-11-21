export const DEFAULT_FOLLOW_THRESHOLD_PX = 40;
export const DEFAULT_BUTTON_THRESHOLD_PX = 120;

export interface ChatScrollFollowDeps {
  messages: Pick<HTMLElement, "addEventListener" | "removeEventListener">;
  scrollBottomBtn: Pick<HTMLElement, "hidden"> & Partial<Pick<HTMLElement, "addEventListener">>;
  getBottomOffset?: () => number;
  isNearBottom?: (threshold?: number) => boolean;
  setAutoScroll: (autoScroll: boolean) => void;
  scrollToBottom: (smooth?: boolean) => void;
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (handle: number) => void;
  followThresholdPx?: number;
  buttonThresholdPx?: number;
}

export interface ChatScrollFollowController {
  notifyScrolled: () => void;
  scrollBottomClicked: () => void;
  reset: () => void;
  bind: () => void;
  isHolding: () => boolean;
}

export function createScrollFollowController(deps: ChatScrollFollowDeps): ChatScrollFollowController {
  const followThreshold = deps.followThresholdPx ?? DEFAULT_FOLLOW_THRESHOLD_PX;
  const buttonThreshold = deps.buttonThresholdPx ?? DEFAULT_BUTTON_THRESHOLD_PX;

  const requestFrame = deps.requestFrame ?? (
    typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
      ? (cb: () => void) => window.requestAnimationFrame(cb)
      : (cb: () => void) => (typeof window !== "undefined" ? window.setTimeout(cb, 16) : (setTimeout(cb, 16) as unknown as number))
  );

  const cancelFrame = deps.cancelFrame ?? (
    typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function"
      ? (handle: number) => window.cancelAnimationFrame(handle)
      : (handle: number) => {
          if (typeof window !== "undefined") {
            window.clearTimeout(handle);
          } else {
            clearTimeout(handle);
          }
        }
  );

  let scrollSyncFrame = 0;
  let scrollBottomHold = false;

  function computeDistances(): { nearBottom: boolean; showButton: boolean } {
    if (deps.getBottomOffset) {
      const offset = deps.getBottomOffset();
      return {
        nearBottom: offset <= followThreshold,
        showButton: offset > buttonThreshold
      };
    }
    if (deps.isNearBottom) {
      return {
        nearBottom: deps.isNearBottom(followThreshold),
        showButton: !deps.isNearBottom(buttonThreshold)
      };
    }
    return { nearBottom: true, showButton: false };
  }

  function setScrollBottomVisible(visible: boolean): void {
    deps.scrollBottomBtn.hidden = !visible;
  }

  function releaseScrollBottomHold(): void {
    if (!scrollBottomHold) {
      return;
    }
    scrollBottomHold = false;
    deps.messages.removeEventListener("wheel", releaseScrollBottomHold);
    deps.messages.removeEventListener("touchstart", releaseScrollBottomHold);
    deps.messages.removeEventListener("keydown", releaseScrollBottomHold);
  }

  function holdScrollBottom(): void {
    if (scrollBottomHold) {
      return;
    }
    scrollBottomHold = true;
    deps.messages.addEventListener("wheel", releaseScrollBottomHold, { passive: true });
    deps.messages.addEventListener("touchstart", releaseScrollBottomHold, { passive: true });
    deps.messages.addEventListener("keydown", releaseScrollBottomHold);
  }

  function cancelPendingFrame(): void {
    if (scrollSyncFrame !== 0) {
      cancelFrame(scrollSyncFrame);
      scrollSyncFrame = 0;
    }
  }

  function flushScrollAutoScrollSync(): void {
    scrollSyncFrame = 0;
    const { nearBottom, showButton } = computeDistances();
    if (!nearBottom && scrollBottomHold) {
      deps.setAutoScroll(true);
      return;
    }
    releaseScrollBottomHold();
    deps.setAutoScroll(nearBottom);
    setScrollBottomVisible(showButton);
  }

  function notifyScrolled(): void {
    if (scrollSyncFrame !== 0) {
      return;
    }
    scrollSyncFrame = requestFrame(flushScrollAutoScrollSync);
  }

  function onWheel(e: Event): void {
    const wheelEvent = e as WheelEvent;
    if (wheelEvent.deltaY < 0) {
      releaseScrollBottomHold();
      deps.setAutoScroll(false);
      notifyScrolled();
    }
  }

  function onTouchMove(): void {
    releaseScrollBottomHold();
    deps.setAutoScroll(false);
    notifyScrolled();
  }

  function onKeydown(e: KeyboardEvent): void {
    const target = e.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) {
      return;
    }
    if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") {
      releaseScrollBottomHold();
      deps.setAutoScroll(false);
      notifyScrolled();
    }
  }

  function scrollBottomClicked(): void {
    holdScrollBottom();
    deps.setAutoScroll(true);
    setScrollBottomVisible(false);
    deps.scrollToBottom(true);
  }

  function reset(): void {
    cancelPendingFrame();
    releaseScrollBottomHold();
    setScrollBottomVisible(false);
  }

  function bind(): void {
    deps.messages.addEventListener("scroll", notifyScrolled);
    deps.messages.addEventListener("wheel", onWheel, { passive: true });
    deps.messages.addEventListener("touchmove", onTouchMove, { passive: true });
    deps.messages.addEventListener("keydown", onKeydown);
    if ("addEventListener" in deps.scrollBottomBtn && typeof deps.scrollBottomBtn.addEventListener === "function") {
      deps.scrollBottomBtn.addEventListener("click", scrollBottomClicked);
    }
  }

  return {
    notifyScrolled,
    scrollBottomClicked,
    reset,
    bind,
    isHolding: () => scrollBottomHold
  };
}
