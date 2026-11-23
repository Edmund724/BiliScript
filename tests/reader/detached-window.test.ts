import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

class StubChildWindow extends EventTarget {
  closed = false;
  innerWidth: number;
  innerHeight: number;
  document: Document;
  focus = vi.fn();
  private closeTriggersPagehide: boolean;

  constructor(options: { width?: number; height?: number; closeTriggersPagehide?: boolean } = {}) {
    super();
    this.innerWidth = options.width ?? 540;
    this.innerHeight = options.height ?? 720;
    this.closeTriggersPagehide = options.closeTriggersPagehide ?? true;
    this.document = document.implementation.createHTMLDocument("Detached");
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.closeTriggersPagehide) {
      this.dispatchEvent(new Event("pagehide"));
    }
  }
}

async function loadDetachedModule() {
  return import("../../extension/reader/detached-window.js");
}

beforeEach(() => {
  resetModuleState();
});

afterEach(async () => {
  const mod = await loadDetachedModule();
  mod.closeDetachedWindowHost(true);
  vi.restoreAllMocks();
});

describe("detached-window 宿主工厂与生命周期", () => {
  it("pip 模式调用 documentPictureInPicture.requestWindow({ disallowReturnToOpener: true }) 并钳制最小尺寸", async () => {
    const childWin = new StubChildWindow({ width: 540, height: 720 });
    const requestWindow = vi.fn(async () => childWin as unknown as Window);
    vi.stubGlobal("documentPictureInPicture", { requestWindow });

    const mod = await loadDetachedModule();
    const res = await mod.openDetachedWindowHost({
      mode: "pip",
      bounds: { width: 200, height: 300 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn()
    });

    expect(requestWindow).toHaveBeenCalledWith({
      width: 360,
      height: 420,
      disallowReturnToOpener: true
    });
    expect(res).toEqual({
      ok: true,
      window: childWin,
      document: childWin.document,
      actualMode: "pip"
    });
    expect(mod.getDetachedWindowHost()).toEqual({
      window: childWin,
      document: childWin.document,
      actualMode: "pip"
    });
  });

  it("pip 不可用、同步抛错、异步拒绝或返回无效窗口时静默降级至 popup", async () => {
    const popup1 = new StubChildWindow();
    const popup2 = new StubChildWindow();
    const popup3 = new StubChildWindow();
    const popup4 = new StubChildWindow();
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValueOnce(popup1 as unknown as Window)
      .mockReturnValueOnce(popup2 as unknown as Window)
      .mockReturnValueOnce(popup3 as unknown as Window)
      .mockReturnValueOnce(popup4 as unknown as Window);

    const mod = await loadDetachedModule();

    vi.stubGlobal("documentPictureInPicture", undefined);
    const r1 = await mod.openDetachedWindowHost({
      mode: "pip",
      bounds: { width: 500, height: 600 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn()
    });
    expect(r1).toMatchObject({ ok: true, actualMode: "popup", window: popup1 });
    mod.closeDetachedWindowHost(true);

    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(() => {
        throw new Error("gesture lost");
      })
    });
    const r2 = await mod.openDetachedWindowHost({
      mode: "pip",
      bounds: { width: 500, height: 600 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn()
    });
    expect(r2).toMatchObject({ ok: true, actualMode: "popup", window: popup2 });
    mod.closeDetachedWindowHost(true);

    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => {
        throw new Error("rejected");
      })
    });
    const r3 = await mod.openDetachedWindowHost({
      mode: "pip",
      bounds: { width: 500, height: 600 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn()
    });
    expect(r3).toMatchObject({ ok: true, actualMode: "popup", window: popup3 });
    mod.closeDetachedWindowHost(true);

    const closedCandidate = new StubChildWindow();
    closedCandidate.closed = true;
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => closedCandidate as unknown as Window)
    });
    const r4 = await mod.openDetachedWindowHost({
      mode: "pip",
      bounds: { width: 500, height: 600 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn()
    });
    expect(r4).toMatchObject({ ok: true, actualMode: "popup", window: popup4 });
    expect(openSpy).toHaveBeenCalledTimes(4);
  });

  it("popup 模式传参准确，被拦截返回 blocked，缺少 window.open 返回 unsupported", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValueOnce(null);
    const mod = await loadDetachedModule();

    const blocked = await mod.openDetachedWindowHost({
      mode: "popup",
      bounds: { width: 540, height: 700 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn()
    });
    expect(openSpy).toHaveBeenCalledWith(
      "about:blank",
      "biliscript-detached-reader",
      "popup=yes,width=540,height=700,resizable=yes,scrollbars=yes"
    );
    expect(blocked).toEqual({ ok: false, reason: "blocked" });

    const originalOpen = window.open;
    Object.defineProperty(window, "open", { value: undefined, configurable: true });
    try {
      const unsupported = await mod.openDetachedWindowHost({
        mode: "popup",
        bounds: { width: 540, height: 700 },
        onExternalClose: vi.fn(),
        onResizeBounds: vi.fn()
      });
      expect(unsupported).toEqual({ ok: false, reason: "unsupported" });
    } finally {
      Object.defineProperty(window, "open", { value: originalOpen, configurable: true });
    }
  });

  it("opener pagehide 自动关闭 pip 与 popup 子窗口且不触发 onExternalClose", async () => {
    const pipWin = new StubChildWindow();
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => pipWin as unknown as Window)
    });
    const mod = await loadDetachedModule();
    const onExternalClosePip = vi.fn();

    await mod.openDetachedWindowHost({
      mode: "pip",
      bounds: { width: 540, height: 720 },
      onExternalClose: onExternalClosePip,
      onResizeBounds: vi.fn()
    });
    window.dispatchEvent(new Event("pagehide"));
    expect(pipWin.closed).toBe(true);
    expect(onExternalClosePip).not.toHaveBeenCalled();
    expect(mod.getDetachedWindowHost()).toBeNull();

    const popupWin = new StubChildWindow();
    vi.spyOn(window, "open").mockReturnValueOnce(popupWin as unknown as Window);
    const onExternalClosePopup = vi.fn();
    await mod.openDetachedWindowHost({
      mode: "popup",
      bounds: { width: 540, height: 720 },
      onExternalClose: onExternalClosePopup,
      onResizeBounds: vi.fn()
    });
    window.dispatchEvent(new Event("pagehide"));
    expect(popupWin.closed).toBe(true);
    expect(onExternalClosePopup).not.toHaveBeenCalled();
  });

  it("子窗口外部 pagehide 触发一次 onExternalClose；closeDetachedWindowHost(true) 不触发；closeDetachedWindowHost(false) 触发一次", async () => {
    const mod = await loadDetachedModule();
    const win1 = new StubChildWindow();
    const win2 = new StubChildWindow();
    const win3 = new StubChildWindow({ closeTriggersPagehide: false });
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi
        .fn()
        .mockResolvedValueOnce(win1 as unknown as Window)
        .mockResolvedValueOnce(win2 as unknown as Window)
        .mockResolvedValueOnce(win3 as unknown as Window)
    });

    const onExt1 = vi.fn();
    await mod.openDetachedWindowHost({
      mode: "pip",
      bounds: { width: 500, height: 600 },
      onExternalClose: onExt1,
      onResizeBounds: vi.fn()
    });
    win1.dispatchEvent(new Event("pagehide"));
    win1.dispatchEvent(new Event("pagehide"));
    expect(onExt1).toHaveBeenCalledTimes(1);

    const onExt2 = vi.fn();
    await mod.openDetachedWindowHost({
      mode: "pip",
      bounds: { width: 500, height: 600 },
      onExternalClose: onExt2,
      onResizeBounds: vi.fn()
    });
    mod.closeDetachedWindowHost(true);
    expect(win2.closed).toBe(true);
    expect(onExt2).not.toHaveBeenCalled();

    const onExt3 = vi.fn();
    await mod.openDetachedWindowHost({
      mode: "pip",
      bounds: { width: 500, height: 600 },
      onExternalClose: onExt3,
      onResizeBounds: vi.fn()
    });
    mod.closeDetachedWindowHost(false);
    expect(win3.closed).toBe(true);
    expect(onExt3).toHaveBeenCalledTimes(1);
  });

  it("子窗口 resize 事件防抖并钳制尺寸，关闭后取消待执行定时器", async () => {
    vi.useFakeTimers();
    const childWin = new StubChildWindow({ width: 540, height: 720 });
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => childWin as unknown as Window)
    });
    const mod = await loadDetachedModule();
    const onResizeBounds = vi.fn();

    await mod.openDetachedWindowHost({
      mode: "pip",
      bounds: { width: 540, height: 720 },
      onExternalClose: vi.fn(),
      onResizeBounds
    });

    childWin.innerWidth = 300;
    childWin.innerHeight = 350;
    childWin.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(100);
    childWin.innerWidth = 310;
    childWin.innerHeight = 610;
    childWin.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(250);

    expect(onResizeBounds).toHaveBeenCalledTimes(1);
    expect(onResizeBounds).toHaveBeenCalledWith({ width: 360, height: 610 });

    childWin.innerWidth = 700;
    childWin.innerHeight = 800;
    childWin.dispatchEvent(new Event("resize"));
    mod.closeDetachedWindowHost(true);
    vi.advanceTimersByTime(300);
    expect(onResizeBounds).toHaveBeenCalledTimes(1);
  });

  it("focusDetachedWindowHost 仅在窗口存活且 focus 不抛错时返回 true", async () => {
    const mod = await loadDetachedModule();
    expect(mod.focusDetachedWindowHost()).toBe(false);

    const childWin = new StubChildWindow();
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => childWin as unknown as Window)
    });
    await mod.openDetachedWindowHost({
      mode: "pip",
      bounds: { width: 540, height: 720 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn()
    });

    expect(mod.focusDetachedWindowHost()).toBe(true);
    expect(childWin.focus).toHaveBeenCalledTimes(1);

    childWin.focus.mockImplementationOnce(() => {
      throw new Error("cannot focus");
    });
    expect(mod.focusDetachedWindowHost()).toBe(false);

    childWin.closed = true;
    expect(mod.focusDetachedWindowHost()).toBe(false);
  });

  it("switchDetachedWindowHostMode 支持双向切换、拦截保留旧窗口、同模式 popup 防自毁及 beforeClosePrevious 时序", async () => {
    const mod = await loadDetachedModule();
    const pipWin = new StubChildWindow();
    const popupWin1 = new StubChildWindow();
    const popupWin2 = new StubChildWindow();
    const pipWin2 = new StubChildWindow();

    const pipRequestMock = vi
      .fn()
      .mockResolvedValueOnce(pipWin as unknown as Window)
      .mockRejectedValueOnce(new Error("pip blocked"))
      .mockResolvedValueOnce(pipWin2 as unknown as Window);
    vi.stubGlobal("documentPictureInPicture", { requestWindow: pipRequestMock });

    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(popupWin1 as unknown as Window)
      .mockReturnValueOnce(popupWin2 as unknown as Window);

    await mod.openDetachedWindowHost({
      mode: "pip",
      bounds: { width: 540, height: 720 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn()
    });

    const blockedToPopup = await mod.switchDetachedWindowHostMode({
      mode: "popup",
      bounds: { width: 540, height: 720 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn()
    });
    expect(blockedToPopup).toEqual({ ok: false, reason: "blocked" });
    expect(pipWin.closed).toBe(false);
    expect(mod.getDetachedWindowHost()?.window).toBe(pipWin);

    const callOrder: string[] = [];
    const switchedToPopup = await mod.switchDetachedWindowHostMode({
      mode: "popup",
      bounds: { width: 540, height: 720 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn(),
      beforeClosePrevious: (next) => {
        callOrder.push(`before:${pipWin.closed}:${next.actualMode}`);
      }
    });
    expect(callOrder).toEqual(["before:false:popup"]);
    expect(switchedToPopup).toMatchObject({ ok: true, actualMode: "popup", window: popupWin1 });
    expect(pipWin.closed).toBe(true);

    const blockedToPip = await mod.switchDetachedWindowHostMode({
      mode: "pip",
      bounds: { width: 540, height: 720 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn()
    });
    expect(blockedToPip).toEqual({ ok: false, reason: "blocked" });
    expect(popupWin1.closed).toBe(false);
    expect(openSpy).toHaveBeenCalledTimes(2);

    const popupToPopup = await mod.switchDetachedWindowHostMode({
      mode: "popup",
      bounds: { width: 540, height: 720 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn()
    });
    expect(openSpy).toHaveBeenLastCalledWith(
      "about:blank",
      "biliscript-detached-reader-alt",
      "popup=yes,width=540,height=720,resizable=yes,scrollbars=yes"
    );
    expect(popupToPopup).toMatchObject({ ok: true, actualMode: "popup", window: popupWin2 });
    expect(popupWin1.closed).toBe(true);

    const switchedToPip = await mod.switchDetachedWindowHostMode({
      mode: "pip",
      bounds: { width: 540, height: 720 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn()
    });
    expect(switchedToPip).toMatchObject({ ok: true, actualMode: "pip", window: pipWin2 });
    expect(popupWin2.closed).toBe(true);
  });

  it("在途异步 openDetachedWindowHost 被 closeDetachedWindowHost(true) 取消后会立即关闭迟到的 PiP 窗口", async () => {
    let resolvePip!: (win: Window) => void;
    const lateWin = new StubChildWindow();
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(
        () =>
          new Promise<Window>((resolve) => {
            resolvePip = resolve;
          })
      )
    });

    const mod = await loadDetachedModule();
    const pendingOpen = mod.openDetachedWindowHost({
      mode: "pip",
      bounds: { width: 540, height: 720 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn()
    });

    mod.closeDetachedWindowHost(true);
    resolvePip(lateWin as unknown as Window);
    const res = await pendingOpen;

    expect(res).toEqual({ ok: false, reason: "blocked" });
    expect(lateWin.closed).toBe(true);
    expect(mod.getDetachedWindowHost()).toBeNull();
  });

  it("switchDetachedWindowHostMode 在 beforeClosePrevious 抛错时保留旧窗口与监听器并关闭新候选窗口", async () => {
    const mod = await loadDetachedModule();
    const oldPopup = new StubChildWindow();
    const newPip = new StubChildWindow();
    vi.spyOn(window, "open").mockReturnValueOnce(oldPopup as unknown as Window);
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => newPip as unknown as Window)
    });

    const onOldExternalClose = vi.fn();
    await mod.openDetachedWindowHost({
      mode: "popup",
      bounds: { width: 540, height: 720 },
      onExternalClose: onOldExternalClose,
      onResizeBounds: vi.fn()
    });

    const res = await mod.switchDetachedWindowHostMode({
      mode: "pip",
      bounds: { width: 540, height: 720 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn(),
      beforeClosePrevious: () => {
        throw new Error("adopt failed");
      }
    });

    expect(res).toEqual({ ok: false, reason: "blocked" });
    expect(oldPopup.closed).toBe(false);
    expect(newPip.closed).toBe(true);
    expect(mod.getDetachedWindowHost()?.window).toBe(oldPopup);

    oldPopup.dispatchEvent(new Event("pagehide"));
    expect(onOldExternalClose).toHaveBeenCalledTimes(1);
    expect(mod.getDetachedWindowHost()).toBeNull();
  });

  it("switchDetachedWindowHostMode 期间旧窗口外部关闭时关闭迟到候选窗口且不重复触发回调", async () => {
    const mod = await loadDetachedModule();
    const oldPopup = new StubChildWindow();
    const latePip = new StubChildWindow();
    let resolvePip!: (win: Window) => void;
    vi.spyOn(window, "open").mockReturnValueOnce(oldPopup as unknown as Window);
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(
        () =>
          new Promise<Window>((resolve) => {
            resolvePip = resolve;
          })
      )
    });

    const onOldExternalClose = vi.fn();
    await mod.openDetachedWindowHost({
      mode: "popup",
      bounds: { width: 540, height: 720 },
      onExternalClose: onOldExternalClose,
      onResizeBounds: vi.fn()
    });

    const pendingSwitch = mod.switchDetachedWindowHostMode({
      mode: "pip",
      bounds: { width: 540, height: 720 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn(),
      beforeClosePrevious: vi.fn()
    });

    oldPopup.dispatchEvent(new Event("pagehide"));
    expect(onOldExternalClose).toHaveBeenCalledTimes(1);

    resolvePip(latePip as unknown as Window);
    const res = await pendingSwitch;

    expect(res).toEqual({ ok: false, reason: "blocked" });
    expect(latePip.closed).toBe(true);
    expect(mod.getDetachedWindowHost()).toBeNull();
    expect(onOldExternalClose).toHaveBeenCalledTimes(1);
  });

  it("openDetachedWindowHost 在 window.open 返回同一 Window 引用时不误关候选窗口", async () => {
    const mod = await loadDetachedModule();
    const sharedWin = new StubChildWindow();
    vi.spyOn(window, "open").mockReturnValue(sharedWin as unknown as Window);

    const onExt1 = vi.fn();
    const onExt2 = vi.fn();
    await mod.openDetachedWindowHost({
      mode: "popup",
      bounds: { width: 540, height: 720 },
      onExternalClose: onExt1,
      onResizeBounds: vi.fn()
    });

    const second = await mod.openDetachedWindowHost({
      mode: "popup",
      bounds: { width: 540, height: 720 },
      onExternalClose: onExt2,
      onResizeBounds: vi.fn()
    });

    expect(second).toMatchObject({ ok: true, window: sharedWin, actualMode: "popup" });
    expect(sharedWin.closed).toBe(false);
    expect(mod.getDetachedWindowHost()?.window).toBe(sharedWin);

    sharedWin.dispatchEvent(new Event("pagehide"));
    expect(onExt1).not.toHaveBeenCalled();
    expect(onExt2).toHaveBeenCalledTimes(1);
  });

  it("beforeClosePrevious 不抛错但同步触发旧窗口 pagehide 时关闭新窗口且不复活会话", async () => {
    const mod = await loadDetachedModule();
    const oldPopup = new StubChildWindow();
    const newPip = new StubChildWindow();
    vi.spyOn(window, "open").mockReturnValueOnce(oldPopup as unknown as Window);
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => newPip as unknown as Window)
    });

    const onOldExternalClose = vi.fn();
    await mod.openDetachedWindowHost({
      mode: "popup",
      bounds: { width: 540, height: 720 },
      onExternalClose: onOldExternalClose,
      onResizeBounds: vi.fn()
    });

    const res = await mod.switchDetachedWindowHostMode({
      mode: "pip",
      bounds: { width: 540, height: 720 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn(),
      beforeClosePrevious: () => {
        oldPopup.dispatchEvent(new Event("pagehide"));
      }
    });

    expect(res).toEqual({ ok: false, reason: "blocked" });
    expect(newPip.closed).toBe(true);
    expect(mod.getDetachedWindowHost()).toBeNull();
    expect(onOldExternalClose).toHaveBeenCalledTimes(1);
  });

  it("beforeClosePrevious 不抛错但关闭新候选窗口时保留旧窗口与监听器", async () => {
    const mod = await loadDetachedModule();
    const oldPopup = new StubChildWindow();
    const newPip = new StubChildWindow();
    vi.spyOn(window, "open").mockReturnValueOnce(oldPopup as unknown as Window);
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => newPip as unknown as Window)
    });

    const onOldExternalClose = vi.fn();
    await mod.openDetachedWindowHost({
      mode: "popup",
      bounds: { width: 540, height: 720 },
      onExternalClose: onOldExternalClose,
      onResizeBounds: vi.fn()
    });

    const res = await mod.switchDetachedWindowHostMode({
      mode: "pip",
      bounds: { width: 540, height: 720 },
      onExternalClose: vi.fn(),
      onResizeBounds: vi.fn(),
      beforeClosePrevious: (nextHost) => {
        nextHost.window.close();
      }
    });

    expect(res).toEqual({ ok: false, reason: "blocked" });
    expect(newPip.closed).toBe(true);
    expect(oldPopup.closed).toBe(false);
    expect(mod.getDetachedWindowHost()?.window).toBe(oldPopup);

    oldPopup.dispatchEvent(new Event("pagehide"));
    expect(onOldExternalClose).toHaveBeenCalledTimes(1);
    expect(mod.getDetachedWindowHost()).toBeNull();
  });

  it("window.open 返回 opener window 时拒绝弹出且不关闭 opener", async () => {
    const mod = await loadDetachedModule();
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    try {
      vi.spyOn(window, "open").mockReturnValueOnce(window);

      const res = await mod.openDetachedWindowHost({
        mode: "popup",
        bounds: { width: 540, height: 720 },
        onExternalClose: vi.fn(),
        onResizeBounds: vi.fn()
      });

      expect(res).toEqual({ ok: false, reason: "blocked" });
      expect(mod.getDetachedWindowHost()).toBeNull();
      expect(closeSpy).not.toHaveBeenCalled();
    } finally {
      closeSpy.mockRestore();
    }
  });

  it("pip requestWindow 返回 opener window 时 open 降级至 popup，switch 不降级且保留旧 popup", async () => {
    const mod = await loadDetachedModule();
    const popupWin = new StubChildWindow();
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    try {
      vi.stubGlobal("documentPictureInPicture", {
        requestWindow: vi.fn(async () => window)
      });
      vi.spyOn(window, "open").mockReturnValueOnce(popupWin as unknown as Window);

      const opened = await mod.openDetachedWindowHost({
        mode: "pip",
        bounds: { width: 540, height: 720 },
        onExternalClose: vi.fn(),
        onResizeBounds: vi.fn()
      });

      expect(opened).toMatchObject({
        ok: true,
        actualMode: "popup",
        window: popupWin
      });
      expect(closeSpy).not.toHaveBeenCalled();

      const switched = await mod.switchDetachedWindowHostMode({
        mode: "pip",
        bounds: { width: 540, height: 720 },
        onExternalClose: vi.fn(),
        onResizeBounds: vi.fn()
      });

      expect(switched).toEqual({ ok: false, reason: "blocked" });
      expect(popupWin.closed).toBe(false);
      expect(mod.getDetachedWindowHost()?.window).toBe(popupWin);
      expect(closeSpy).not.toHaveBeenCalled();
    } finally {
      closeSpy.mockRestore();
    }
  });

  it("Firefox Xray 场景优先通过 wrappedJSObject.open 弹窗并通过 XPCNativeWrapper 还原 Xray 包装", async () => {
    const mod = await loadDetachedModule();
    const waivedPopup = new StubChildWindow({ width: 540, height: 720 });
    const unwaivedPopup = new StubChildWindow({ width: 540, height: 720 });
    const wrappedOpen = vi.fn(() => waivedPopup as unknown as Window);
    const xpcNativeWrapper = vi.fn((win: unknown) =>
      win === waivedPopup ? (unwaivedPopup as unknown as Window) : (win as Window)
    );
    const openerOpenSpy = vi.spyOn(window, "open");
    Object.defineProperty(window, "wrappedJSObject", {
      value: { open: wrappedOpen },
      configurable: true
    });
    vi.stubGlobal("XPCNativeWrapper", xpcNativeWrapper);
    try {
      const opened = await mod.openDetachedWindowHost({
        mode: "popup",
        bounds: { width: 540, height: 720 },
        onExternalClose: vi.fn(),
        onResizeBounds: vi.fn()
      });

      expect(openerOpenSpy).not.toHaveBeenCalled();
      expect(wrappedOpen).toHaveBeenCalledWith(
        "about:blank",
        "biliscript-detached-reader",
        "popup=yes,width=540,height=720,resizable=yes,scrollbars=yes"
      );
      expect(xpcNativeWrapper).toHaveBeenCalledWith(waivedPopup);
      expect(opened).toEqual({
        ok: true,
        window: unwaivedPopup,
        document: unwaivedPopup.document,
        actualMode: "popup"
      });
      expect(mod.getDetachedWindowHost()).toEqual({
        window: unwaivedPopup,
        document: unwaivedPopup.document,
        actualMode: "popup"
      });
    } finally {
      Reflect.deleteProperty(window, "wrappedJSObject");
      Reflect.deleteProperty(globalThis, "XPCNativeWrapper");
    }
  });
});
