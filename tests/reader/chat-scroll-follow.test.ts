// tests/reader/chat-scroll-follow.test.ts
// createScrollFollowController（滚动跟随与回底闸状态机）行为契约测试：
// 1. 按帧合批与防抖（rAF 调度）
// 2. 状态判据单源（近底判定同时驱动 autoScroll 与按钮显隐）
// 3. 回底途中闸（动画期间远离底部不误判脱离跟随，落底自动放闸）
// 4. 用户主动干预放闸矩阵（wheel / touchstart / keydown 立即放闸）
// 5. 清场放闸（reset 取消在途帧、放闸并隐藏按钮）
// 6. bind 常驻绑定（scroll 与 click 监听挂载）

import { describe, expect, it } from "vitest";
import {
  createScrollFollowController,
  type ChatScrollFollowDeps
} from "../../extension/reader/chat-scroll-follow.js";

function makeHarness(initialNearBottom = true) {
  let nearBottom = initialNearBottom;
  let autoScrollState: boolean | null = null;
  let scrollToBottomCalledWith: boolean | null = null;
  const buttonListeners = new Map<string, Set<(e: Event) => void>>();
  const listeners = new Map<string, Set<(e: Event) => void>>();

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
    addEventListener: (type: string, listener: (e: Event) => void) => {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: (e: Event) => void) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (type: string) => {
      const set = listeners.get(type);
      if (set) {
        for (const fn of Array.from(set)) {
          fn(new Event(type));
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

  const controller = createScrollFollowController({
    messages,
    scrollBottomBtn,
    isNearBottom: () => nearBottom,
    setAutoScroll: (val) => {
      autoScrollState = val;
    },
    scrollToBottom: (smooth) => {
      scrollToBottomCalledWith = smooth ?? false;
    },
    requestFrame,
    cancelFrame
  });

  return {
    controller,
    setNearBottom: (val: boolean) => {
      nearBottom = val;
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

    // 同一帧再次触发被防抖吞掉
    h.controller.notifyScrolled();
    h.controller.notifyScrolled();

    h.flushFrames();
    expect(h.hasScheduledFrames()).toBe(false);

    // 下一轮 scroll 可再次调度
    h.controller.notifyScrolled();
    expect(h.hasScheduledFrames()).toBe(true);
  });

  it("远离底部时：setAutoScroll(false) 且按钮显现", () => {
    const h = makeHarness(false);
    h.controller.notifyScrolled();
    h.flushFrames();

    expect(h.getAutoScroll()).toBe(false);
    expect(h.button.hidden).toBe(false);
  });

  it("靠近底部时：setAutoScroll(true) 且按钮隐藏", () => {
    const h = makeHarness(true);
    h.button.hidden = false;

    h.controller.notifyScrolled();
    h.flushFrames();

    expect(h.getAutoScroll()).toBe(true);
    expect(h.button.hidden).toBe(true);
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

    // 动画途中产生 scroll 事件，几何读数依然远离底部
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

    // 滚动落底
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

    // 用户滚轮干预
    h.messages.dispatchEvent("wheel");
    expect(h.controller.isHolding()).toBe(false);
    expect(h.messages.listenerCount("wheel")).toBe(0);

    // 随后远离底部判定生效
    h.setNearBottom(false);
    h.controller.notifyScrolled();
    h.flushFrames();

    expect(h.getAutoScroll()).toBe(false);
    expect(h.button.hidden).toBe(false);
  });

  it("用户主动干预放闸（touchstart 与 keydown）", () => {
    const h1 = makeHarness(false);
    h1.controller.scrollBottomClicked();
    h1.messages.dispatchEvent("touchstart");
    expect(h1.controller.isHolding()).toBe(false);

    const h2 = makeHarness(false);
    h2.controller.scrollBottomClicked();
    h2.messages.dispatchEvent("keydown");
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

    // scroll 触发调度
    h.messages.dispatchEvent("scroll");
    expect(h.hasScheduledFrames()).toBe(true);
    h.flushFrames();
    expect(h.getAutoScroll()).toBe(false);

    // button click 触发回底
    h.button.click();
    expect(h.controller.isHolding()).toBe(true);
    expect(h.getAutoScroll()).toBe(true);
  });
});
