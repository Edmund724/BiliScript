// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  animateTriggerEnter,
  animateTriggerExit,
  applyElementTriggerOrigin,
  cancelTriggerExit,
  captureTriggerRect,
  computeRelativeOrigin,
  getSavedTriggerRect
} from "../../extension/ui/trigger-motion.js";
import { closeConfirmDialog, confirmDialog } from "../../extension/ui/confirm-dialog.js";
import { closeQuoteShareModal, openQuoteShareModal } from "../../extension/reader/quote-share-modal.js";
import { registerDebugGate } from "../../extension/shared/logging.js";

function createFakeAnimation() {
  const listeners = new Map<string, Set<() => void>>();
  const anim = {
    cancel: vi.fn(() => {
      const set = listeners.get("cancel");
      set?.forEach((cb) => cb());
    }),
    finish: () => {
      const set = listeners.get("finish");
      set?.forEach((cb) => cb());
    },
    addEventListener: vi.fn((type: string, cb: () => void) => {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(cb);
    })
  };
  return anim;
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {
      return {};
    }
  } as DOMRect;
}

describe("trigger-motion", () => {
  const origMatchMedia = window.matchMedia;
  const origAnimate = HTMLElement.prototype.animate;

  beforeEach(() => {
    document.body.innerHTML = "";
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    registerDebugGate(() => false);
    closeConfirmDialog();
    closeQuoteShareModal({ restoreFocus: false });
    window.matchMedia = origMatchMedia;
    HTMLElement.prototype.animate = origAnimate;
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("computes trigger-anchored origin instead of center when trigger rect is present", () => {
    const targetRect = rect(100, 100, 300, 200);
    const triggerRect = rect(370, 270, 40, 30);

    expect(computeRelativeOrigin(targetRect, triggerRect, "center")).toBe("290px 185px");
    expect(computeRelativeOrigin(targetRect, null, "top right")).toBe("top right");

    const clamped = computeRelativeOrigin(targetRect, rect(1200, -400, 20, 20), "center");
    expect(clamped).toBe("375px -50px");
  });

  it("applies trigger transformOrigin and remembers saved trigger rect across exit", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect(420, 50, 32, 28));

    const target = document.createElement("div");
    document.body.appendChild(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(160, 120, 300, 200));

    expect(applyElementTriggerOrigin(target, trigger, "center")).toBe("276px -50px");
    expect(target.style.transformOrigin).toBe("276px -50px");

    trigger.remove();
    const onFinish = vi.fn();
    animateTriggerExit({
      target,
      trigger: null,
      fallbackOrigin: "center",
      onFinish
    });

    expect(target.style.transformOrigin).toBe("276px -50px");
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("runs WAAPI scale+opacity exit before finishing and supports cancelTriggerExit", () => {
    const createdAnims: ReturnType<typeof createFakeAnimation>[] = [];
    HTMLElement.prototype.animate = vi.fn(() => {
      const anim = createFakeAnimation();
      createdAnims.push(anim);
      return anim as unknown as Animation;
    }) as unknown as typeof HTMLElement.prototype.animate;

    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect(120, 140, 20, 20));

    const host = document.createElement("div");
    const target = document.createElement("div");
    host.appendChild(target);
    document.body.appendChild(host);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(100, 100, 200, 120));

    animateTriggerEnter({ target, trigger, fallbackOrigin: "center" });
    expect(target.style.transformOrigin).toBe("30px 50px");
    expect(createdAnims.length).toBe(1);

    const onFinish = vi.fn();
    animateTriggerExit({
      target,
      host,
      trigger,
      fallbackOrigin: "center",
      onFinish
    });

    expect(host.getAttribute("data-biliscript-closing")).toBe("1");
    expect(host.inert).toBe(true);
    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(onFinish).not.toHaveBeenCalled();

    createdAnims[1].finish();
    expect(host.hasAttribute("data-biliscript-closing")).toBe(false);
    expect(host.inert).toBe(false);
    expect(onFinish).toHaveBeenCalledTimes(1);

    const cancelFinish = vi.fn();
    animateTriggerExit({ target, host, trigger, onFinish: cancelFinish });
    expect(host.getAttribute("data-biliscript-closing")).toBe("1");
    cancelTriggerExit(host);
    expect(host.hasAttribute("data-biliscript-closing")).toBe(false);
    expect(cancelFinish).toHaveBeenCalledTimes(1);
  });

  it("finishes synchronously under prefers-reduced-motion: reduce", () => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: "(prefers-reduced-motion: reduce)"
    }) as unknown as typeof window.matchMedia;
    const animateSpy = vi.fn();
    HTMLElement.prototype.animate = animateSpy as unknown as typeof HTMLElement.prototype.animate;

    const target = document.createElement("div");
    document.body.appendChild(target);
    const onFinish = vi.fn();

    animateTriggerEnter({ target, fallbackOrigin: "top left" });
    animateTriggerExit({ target, fallbackOrigin: "top left", onFinish });

    expect(animateSpy).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("anchors confirmDialog and quoteShareModal from their triggers under WAAPI", async () => {
    const createdAnims: ReturnType<typeof createFakeAnimation>[] = [];
    HTMLElement.prototype.animate = vi.fn(() => {
      const anim = createFakeAnimation();
      createdAnims.push(anim);
      return anim as unknown as Animation;
    }) as unknown as typeof HTMLElement.prototype.animate;

    const readingView = document.createElement("div");
    readingView.id = "biliscript-reading-view";
    document.body.appendChild(readingView);

    const confirmBtn = document.createElement("button");
    document.body.appendChild(confirmBtn);
    vi.spyOn(confirmBtn, "getBoundingClientRect").mockReturnValue(rect(420, 480, 60, 24));
    confirmBtn.focus();

    const confirmPromise = confirmDialog({ message: "确认清除？", mountHost: readingView });
    const confirmEl = readingView.querySelector<HTMLElement>(".confirm-dialog")!;
    vi.spyOn(confirmEl, "getBoundingClientRect").mockReturnValue(rect(200, 200, 300, 160));
    closeConfirmDialog();

    expect(confirmEl.style.transformOrigin).toBe("250px 208px");
    createdAnims.at(-2)!.finish();
    expect(await confirmPromise).toBe(false);
    expect(readingView.querySelector(".confirm-dialog-host")).toBeNull();

    const quoteBtn = document.createElement("button");
    readingView.appendChild(quoteBtn);
    vi.spyOn(quoteBtn, "getBoundingClientRect").mockReturnValue(rect(60, 70, 30, 30));

    openQuoteShareModal({ content: "测试金句", triggerEl: quoteBtn });
    const quoteDialog = readingView.querySelector<HTMLElement>(".biliscript-quote-share-dialog")!;
    vi.spyOn(quoteDialog, "getBoundingClientRect").mockReturnValue(rect(200, 150, 400, 300));
    closeQuoteShareModal({ restoreFocus: false });

    expect(quoteDialog.style.transformOrigin).toBe("-100px -65px");
    createdAnims.at(-2)!.finish();
    expect(readingView.querySelector(".biliscript-quote-share-host")).toBeNull();
  });

  it("logs unexpected WAAPI errors via logWarn and still completes exit cleanup", () => {
    registerDebugGate(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const badAnim = {
      cancel: vi.fn(() => {
        throw new Error("cancel failed");
      }),
      addEventListener: vi.fn()
    };
    const animateMock = vi.fn().mockReturnValueOnce(badAnim as unknown as Animation);
    HTMLElement.prototype.animate = animateMock as unknown as typeof HTMLElement.prototype.animate;

    const host = document.createElement("div");
    const target = document.createElement("div");
    host.appendChild(target);
    document.body.appendChild(host);

    animateTriggerEnter({ target, fallbackOrigin: "center" });
    animateMock.mockImplementationOnce(() => {
      throw new Error("animate failed");
    });

    const onFinish = vi.fn();
    animateTriggerExit({ target, host, fallbackOrigin: "center", onFinish });

    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(host.hasAttribute("data-biliscript-closing")).toBe(false);
    expect(host.inert).toBe(false);
    expect(host.hasAttribute("aria-hidden")).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "[BILISCRIPT] trigger-motion animation cancel failed",
      expect.any(Error)
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[BILISCRIPT] trigger-motion animation failed",
      expect.any(Error)
    );
  });

  it("clones captured trigger rects into plain objects so savedTriggerRects never pins a foreign DOMRect", () => {
    class ForeignDomRect {
      left = 12;
      top = 24;
      width = 80;
      height = 30;
      right = 92;
      bottom = 54;
      x = 12;
      y = 24;
      toJSON() {
        return {};
      }
    }
    const foreign = new ForeignDomRect() as unknown as DOMRect;
    const captured = captureTriggerRect(foreign);
    expect(captured).not.toBeNull();
    expect(captured).not.toBe(foreign);
    expect(captured instanceof ForeignDomRect).toBe(false);
    expect(Object.getPrototypeOf(captured)).toBe(Object.prototype);
    expect(captured?.left).toBe(12);
    expect(captured?.width).toBe(80);

    const target = document.createElement("div");
    document.body.appendChild(target);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(0, 0, 200, 100));
    applyElementTriggerOrigin(target, foreign, "center");
    const saved = getSavedTriggerRect(target);
    expect(saved).not.toBe(foreign);
    expect(saved instanceof ForeignDomRect).toBe(false);
  });
});
