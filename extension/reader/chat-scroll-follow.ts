// extension/reader/chat-scroll-follow.ts — 阅读模式 AI 对话滚动跟随与回底闸状态机。
//
// 职责：
// 1. 滚动跟随与按帧合批：滚动事件经 rAF 合批，同帧多次 scroll 只判定/通知一次，
//    避免 scrollHeight/scrollTop 重复读写（强制布局）。
// 2. 状态判据单源：滚底按钮显隐与自动滚动（autoScroll）共享同一条近底判定布尔，
//    近底时自动滚动保持开启且按钮隐藏；远离底部时关闭自动滚动且按钮显示。
// 3. 回底途中闸（scrollBottomHold）：解决 CSS smooth 动画回底途中，中间帧几何判定
//    仍远离底部导致动画首帧误判脱离跟随的问题。
// 4. 用户主动干预放闸矩阵：闸期内若用户主动发生滚动（wheel / touchstart / keydown），
//    判定为用户干预，立即放闸并恢复自然判定；落底与清场（reset）亦放闸。

export interface ChatScrollFollowDeps {
  messages: Pick<HTMLElement, "addEventListener" | "removeEventListener">;
  scrollBottomBtn: Pick<HTMLElement, "hidden"> & Partial<Pick<HTMLElement, "addEventListener">>;
  isNearBottom: () => boolean;
  setAutoScroll: (autoScroll: boolean) => void;
  scrollToBottom: (smooth?: boolean) => void;
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

export interface ChatScrollFollowController {
  notifyScrolled: () => void;
  scrollBottomClicked: () => void;
  reset: () => void;
  bind: () => void;
  isHolding: () => boolean;
}

export function createScrollFollowController(deps: ChatScrollFollowDeps): ChatScrollFollowController {
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
    const nearBottom = deps.isNearBottom();
    if (!nearBottom && scrollBottomHold) {
      // 动画途中：跟住、按钮不重新亮起（几何判定此刻还判不出「快到底了」）。
      deps.setAutoScroll(true);
      return;
    }
    releaseScrollBottomHold();
    deps.setAutoScroll(nearBottom);
    setScrollBottomVisible(!nearBottom);
  }

  function notifyScrolled(): void {
    if (scrollSyncFrame !== 0) {
      return;
    }
    scrollSyncFrame = requestFrame(flushScrollAutoScrollSync);
  }

  function scrollBottomClicked(): void {
    holdScrollBottom();
    deps.setAutoScroll(true);
    setScrollBottomVisible(false);
    // 非 instant：走 .chat-messages 的 scroll-behavior: smooth（DeepSeek Harness
    // 那边是 instant——窄栏里一段长距离平滑动画比瞬移更易读，代价由回底闸兜住）。
    deps.scrollToBottom(true);
  }

  function reset(): void {
    cancelPendingFrame();
    releaseScrollBottomHold();
    setScrollBottomVisible(false);
  }

  function bind(): void {
    deps.messages.addEventListener("scroll", notifyScrolled);
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
