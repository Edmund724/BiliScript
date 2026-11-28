import { describe, expect, it } from "vitest";
import {
  createScrollFollowController,
  DEFAULT_FOLLOW_THRESHOLD_PX,
  DEFAULT_BUTTON_THRESHOLD_PX,
  type ChatScrollFollowDeps
} from "../../extension/reader/chat-scroll-follow.js";

function makeHarness(initialNearBottom = true, initialOffset?: number) {
  let bottomOffset = initialOffset ?? (initialNearBottom ? 0 : DEFAULT_BUTTON_THRESHOLD_PX + 80);
  let autoScrollState: boolean | null = null;
  let scrollToBottomCalledWith: boolean | null = null;
  const buttonListeners = new Map<string, Set<(e: Event) => void>>();
  const listeners = new Map<string, Set<(e: Event) => void>>();
  let scrollHeight = 1000;
  const clientHeight = 400;

  const scrollBottomBtn = {
    hidden: true,
    addEventListener: (type: string, listener: (e: Event) => void) => {
      if (!buttonListeners.has(type)) {
        buttonListeners.set(type, new Set());
      }
      buttonListeners.get(type)!.add(listener);
    },
    click: () => {
      const set = buttonListeners.get("click");
      if (set) {
        for (const fn of Array.from(set)) {
          fn(new Event("click"));
        }
      }
    }
  };

  const messages = {
    get scrollTop() {
      return Math.max(0, scrollHeight - clientHeight - bottomOffset);
    },
    get scrollHeight() {
      return scrollHeight;
    },
    clientHeight,
    addEventListener: (type: string, listener: (e: Event) => void) => {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: (e: Event) => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (eventOrType: Event | string) => {
      const type = typeof eventOrType === "string" ? eventOrType : eventOrType.type;
      const set = listeners.get(type);
      if (set) {
        const ev = typeof eventOrType === "string" ? new Event(type) : eventOrType;
        for (const fn of Array.from(set)) {
          fn(ev);
        }
      }
    },
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0
  };

  let scheduledFrames: Array<{ id: number; cb: () => void }> = [];
  let nextFrameId = 1;
  const cancelledFrames: number[] = [];

  const requestFrame = (cb: () => void) => {
    const id = nextFrameId++;
    scheduledFrames.push({ id, cb });
    return id;
  };

  const cancelFrame = (handle: number) => {
    cancelledFrames.push(handle);
    scheduledFrames = scheduledFrames.filter((f) => f.id !== handle);
  };

  const flushFrames = () => {
    const current = scheduledFrames;
    scheduledFrames = [];
    for (const frame of current) {
      frame.cb();
    }
  };

  const deps: ChatScrollFollowDeps = {
    messages,
    scrollBottomBtn,
    setAutoScroll: (val) => {
      autoScrollState = val;
    },
    scrollToBottom: (smooth) => {
      scrollToBottomCalledWith = smooth ?? false;
    },
    requestFrame,
    cancelFrame
  };

  const controller = createScrollFollowController(deps);

  return {
    controller,
    setNearBottom: (val: boolean) => {
      bottomOffset = val ? DEFAULT_FOLLOW_THRESHOLD_PX : DEFAULT_BUTTON_THRESHOLD_PX + 80;
    },
    setBottomOffset: (offset: number) => {
      bottomOffset = offset;
    },
    setScrollHeight: (height: number) => {
      scrollHeight = height;
    },
    getAutoScroll: () => autoScrollState,
    getScrollToBottomCalledWith: () => scrollToBottomCalledWith,
    button: scrollBottomBtn,
    messages,
    flushFrames,
    hasScheduledFrames: () => scheduledFrames.length > 0,
    cancelledFrames
  };
}

describe("chat-scroll-follow：按帧合批与自然滚动判定", () => {
  it("同帧多次 notifyScrolled 只请求一次 frame，flush 后可再次调度", () => {
    const h = makeHarness(true);

    expect(h.hasScheduledFrames()).toBe(false);
    h.controller.notifyScrolled();
    expect(h.hasScheduledFrames()).toBe(true);

    h.controller.notifyScrolled();
    h.controller.notifyScrolled();

    h.flushFrames();
    expect(h.hasScheduledFrames()).toBe(false);

    h.controller.notifyScrolled();
    expect(h.hasScheduledFrames()).toBe(true);
  });

  it("双阈值迟滞：<=40px 开启跟随且隐藏按钮；40px~120px 间关闭跟随但保持隐藏；>120px 浮现按钮", () => {
    const h = makeHarness(true, 20);

    h.controller.notifyScrolled();
    h.flushFrames();
    expect(h.getAutoScroll()).toBe(true);
    expect(h.button.hidden).toBe(true);

    h.setBottomOffset(80);
    h.controller.notifyScrolled();
    h.flushFrames();
    expect(h.getAutoScroll()).toBe(false);
    expect(h.button.hidden).toBe(true);

    h.setBottomOffset(150);
    h.controller.notifyScrolled();
    h.flushFrames();
    expect(h.getAutoScroll()).toBe(false);
    expect(h.button.hidden).toBe(false);

    h.setBottomOffset(30);
    h.controller.notifyScrolled();
    h.flushFrames();
    expect(h.getAutoScroll()).toBe(true);
    expect(h.button.hidden).toBe(true);
  });

  it("离屏消息还原高度导致 scrollHeight 动态变化时，贴底距离阈值与回底闸保持稳定", () => {
    const h = makeHarness(false, 260);
    h.controller.scrollBottomClicked();
    expect(h.controller.isHolding()).toBe(true);

    h.setScrollHeight(2400);
    h.setBottomOffset(180);
    h.controller.notifyScrolled();
    h.flushFrames();
    expect(h.controller.isHolding()).toBe(true);
    expect(h.getAutoScroll()).toBe(true);
    expect(h.button.hidden).toBe(true);

    h.setScrollHeight(2520);
    h.setBottomOffset(DEFAULT_FOLLOW_THRESHOLD_PX);
    h.controller.notifyScrolled();
    h.flushFrames();
    expect(h.controller.isHolding()).toBe(false);
    expect(h.getAutoScroll()).toBe(true);
    expect(h.button.hidden).toBe(true);
  });
});

describe("chat-scroll-follow：物理手势即时断跟", () => {
  it("wheel 向上（deltaY < 0）立即停止跟随并调度合批", () => {
    const h = makeHarness(true, 10);
    h.controller.bind();
    h.flushFrames();
    expect(h.getAutoScroll()).toBe(null);

    const wheelUp = new Event("wheel") as WheelEvent;
    Object.defineProperty(wheelUp, "deltaY", { value: -50 });
    h.messages.dispatchEvent(wheelUp);

    expect(h.getAutoScroll()).toBe(false);
    expect(h.hasScheduledFrames()).toBe(true);
  });

  it("wheel 向下（deltaY > 0）不立即打断跟随", () => {
    const h = makeHarness(true, 10);
    h.controller.bind();

    const wheelDown = new Event("wheel") as WheelEvent;
    Object.defineProperty(wheelDown, "deltaY", { value: 50 });
    h.messages.dispatchEvent(wheelDown);

    expect(h.getAutoScroll()).toBe(null);
  });

  it("touchmove 立即停止跟随并调度合批", () => {
    const h = makeHarness(true, 10);
    h.controller.bind();

    h.messages.dispatchEvent(new Event("touchmove"));
    expect(h.getAutoScroll()).toBe(false);
    expect(h.hasScheduledFrames()).toBe(true);
  });

  it("键盘 ArrowUp / PageUp / Home 立即切断跟随并放闸，输入控件内按键忽略", () => {
    for (const key of ["ArrowUp", "PageUp", "Home"]) {
      const h = makeHarness(false, 10);
      h.controller.bind();
      h.controller.scrollBottomClicked();
      expect(h.controller.isHolding()).toBe(true);

      h.messages.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      expect(h.controller.isHolding()).toBe(false);
      expect(h.getAutoScroll()).toBe(false);
      expect(h.hasScheduledFrames()).toBe(true);
    }

    const hInput = makeHarness(true, 10);
    hInput.controller.bind();
    const textarea = document.createElement("textarea");
    const evt = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true });
    Object.defineProperty(evt, "target", { value: textarea });
    hInput.messages.dispatchEvent(evt);
    expect(hInput.getAutoScroll()).toBeNull();
    expect(hInput.hasScheduledFrames()).toBe(false);
  });
});

describe("chat-scroll-follow：回底途中闸与放闸矩阵", () => {
  it("点击滚底按钮：立闸、保持跟随、隐藏按钮并调用平滑滚动", () => {
    const h = makeHarness(false);
    expect(h.controller.isHolding()).toBe(false);

    h.controller.scrollBottomClicked();

    expect(h.controller.isHolding()).toBe(true);
    expect(h.getAutoScroll()).toBe(true);
    expect(h.button.hidden).toBe(true);
    expect(h.getScrollToBottomCalledWith()).toBe(true);
    expect(h.messages.listenerCount("wheel")).toBe(1);
    expect(h.messages.listenerCount("touchstart")).toBe(1);
    expect(h.messages.listenerCount("keydown")).toBe(1);
  });

  it("动画途中远离底部：闸保持、跟随保持、按钮不重新亮起", () => {
    const h = makeHarness(false);
    h.controller.scrollBottomClicked();

    h.setNearBottom(false);
    h.controller.notifyScrolled();
    h.flushFrames();

    expect(h.controller.isHolding()).toBe(true);
    expect(h.getAutoScroll()).toBe(true);
    expect(h.button.hidden).toBe(true);
  });

  it("动画完成落底：自动放闸并清理监听", () => {
    const h = makeHarness(false);
    h.controller.scrollBottomClicked();

    h.setNearBottom(true);
    h.controller.notifyScrolled();
    h.flushFrames();

    expect(h.controller.isHolding()).toBe(false);
    expect(h.getAutoScroll()).toBe(true);
    expect(h.button.hidden).toBe(true);
    expect(h.messages.listenerCount("wheel")).toBe(0);
    expect(h.messages.listenerCount("touchstart")).toBe(0);
    expect(h.messages.listenerCount("keydown")).toBe(0);
  });

  it("用户主动干预放闸（wheel）：立即可放闸，随后远离底部能正确关闭跟随", () => {
    const h = makeHarness(false);
    h.controller.scrollBottomClicked();
    expect(h.controller.isHolding()).toBe(true);

    h.messages.dispatchEvent(new Event("wheel"));
    expect(h.controller.isHolding()).toBe(false);
    expect(h.messages.listenerCount("wheel")).toBe(0);

    h.setNearBottom(false);
    h.controller.notifyScrolled();
    h.flushFrames();

    expect(h.getAutoScroll()).toBe(false);
    expect(h.button.hidden).toBe(false);
  });

  it("用户主动干预放闸（touchstart 与 keydown）", () => {
    const h1 = makeHarness(false);
    h1.controller.scrollBottomClicked();
    h1.messages.dispatchEvent(new Event("touchstart"));
    expect(h1.controller.isHolding()).toBe(false);

    const h2 = makeHarness(false);
    h2.controller.scrollBottomClicked();
    h2.messages.dispatchEvent(new Event("keydown"));
    expect(h2.controller.isHolding()).toBe(false);
  });
});

describe("chat-scroll-follow：清场 reset 与 bind 挂载", () => {
  it("reset：取消待排队帧、放闸、隐藏按钮", () => {
    const h = makeHarness(false);
    h.controller.scrollBottomClicked();
    h.controller.notifyScrolled();
    expect(h.hasScheduledFrames()).toBe(true);
    expect(h.controller.isHolding()).toBe(true);

    h.controller.reset();

    expect(h.hasScheduledFrames()).toBe(false);
    expect(h.cancelledFrames.length).toBe(1);
    expect(h.controller.isHolding()).toBe(false);
    expect(h.button.hidden).toBe(true);
    expect(h.messages.listenerCount("wheel")).toBe(0);
  });

  it("bind：挂载 scroll 事件与 click 事件", () => {
    const h = makeHarness(false);
    h.controller.bind();

    h.messages.dispatchEvent(new Event("scroll"));
    expect(h.hasScheduledFrames()).toBe(true);
    h.flushFrames();
    expect(h.getAutoScroll()).toBe(false);

    h.button.click();
    expect(h.controller.isHolding()).toBe(true);
    expect(h.getAutoScroll()).toBe(true);
  });
});
