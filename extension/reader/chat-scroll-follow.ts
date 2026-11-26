import { getActiveReaderWindow } from "../shared/active-host.js";
import { isEditableTarget, isNode, scheduleMigratingFrame } from "../shared/cross-doc.js";

export const DEFAULT_FOLLOW_THRESHOLD_PX = 40;
export const DEFAULT_BUTTON_THRESHOLD_PX = 120;

export interface ChatScrollFollowDeps {
  messages: Pick<HTMLElement, "addEventListener" | "removeEventListener" | "scrollTop" | "scrollHeight" | "clientHeight">;
  scrollBottomBtn: Pick<HTMLElement, "hidden"> & Partial<Pick<HTMLElement, "addEventListener">>;
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

  const scheduleCustomFrame: ((cb: () => void) => () => void) | null = deps.requestFrame
    ? (cb) => {
        const handle = deps.requestFrame!(cb);
        return () => {
          const activeWin = getActiveReaderWindow();
          if (deps.cancelFrame) {
            deps.cancelFrame(handle);
          } else if (typeof activeWin?.cancelAnimationFrame === "function") {
            try {
              activeWin.cancelAnimationFrame(handle);
            } catch {
            }
          } else if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
            window.cancelAnimationFrame(handle);
          } else if (typeof window !== "undefined") {
            window.clearTimeout(handle);
          } else {
            clearTimeout(handle);
          }
        };
      }
    : null;

  let cancelScheduledFrame: (() => void) | null = null;
  let scrollBottomHold = false;

  function computeDistances(): { nearBottom: boolean; showButton: boolean } {
    const { scrollTop, scrollHeight, clientHeight } = deps.messages;
    const offset = Math.max(0, scrollHeight - (scrollTop + clientHeight));
    return {
      nearBottom: offset <= followThreshold,
      showButton: offset > buttonThreshold
    };
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
    if (cancelScheduledFrame !== null) {
      const cancel = cancelScheduledFrame;
      cancelScheduledFrame = null;
      try {
        cancel();
      } catch {
      }
    }
  }

  function flushScrollAutoScrollSync(): void {
    cancelScheduledFrame = null;
    const { nearBottom, showButton } = computeDistances();
    if (!nearBottom && scrollBottomHold) {
      deps.setAutoScroll(true);
      return;
    }
    releaseScrollBottomHold();
    deps.setAutoScroll(nearBottom);
    setScrollBottomVisible(showButton);
  }

  function schedulePendingFrame(): void {
    let fired = false;
    const onFrame = () => {
      fired = true;
      flushScrollAutoScrollSync();
    };
    const cancel = scheduleCustomFrame
      ? scheduleCustomFrame(onFrame)
      : (() => {
          const handle = scheduleMigratingFrame(onFrame, {
            targetNode: isNode(deps.messages) ? deps.messages : null
          });
          return () => handle.cancel();
        })();
    if (!fired) {
      cancelScheduledFrame = cancel;
    }
  }

  function notifyScrolled(): void {
    if (cancelScheduledFrame !== null) {
      return;
    }
    schedulePendingFrame();
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
    if (isEditableTarget(target)) {
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
