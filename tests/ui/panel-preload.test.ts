import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";

function getPreloadLinks(): HTMLLinkElement[] {
  return Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]'));
}

function cleanPreloadLinks(): void {
  getPreloadLinks().forEach((link) => link.remove());
}

describe("ui/panel-preload: 面板核心 chunk 低开销预热", () => {
  beforeEach(() => {
    resetModuleState();
    cleanPreloadLinks();
    document.body.innerHTML = "";
    setLocationUrl(NORMAL_PAGE_URL);
  });

  afterEach(() => {
    cleanPreloadLinks();
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("pointerenter 与 focus 均一次性注入全部面板核心入口且按 href 幂等去重", async () => {
    const { PANEL_PRELOAD_MODULE_PATHS, bindPanelPreloadOnButton } = await import(
      "../../extension/ui/panel-preload.js"
    );
    const button = document.createElement("button");
    document.body.appendChild(button);

    bindPanelPreloadOnButton(button);
    bindPanelPreloadOnButton(button);
    expect(getPreloadLinks()).toHaveLength(0);

    button.dispatchEvent(new Event("pointerenter"));
    const expectedHrefs = PANEL_PRELOAD_MODULE_PATHS.map((p) => chrome.runtime.getURL(p));
    expect(getPreloadLinks().map((link) => link.getAttribute("href"))).toEqual(expectedHrefs);

    button.dispatchEvent(new Event("focus"));
    expect(getPreloadLinks()).toHaveLength(PANEL_PRELOAD_MODULE_PATHS.length);
  });

  it("页面空闲预热优先使用 requestIdleCallback 且同一窗口内只调度一次", async () => {
    const idleCallbacks: IdleRequestCallback[] = [];
    const requestIdleCallback = vi.fn((cb: IdleRequestCallback) => {
      idleCallbacks.push(cb);
      return 42;
    });
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);

    const mod = await import("../../extension/ui/panel-preload.js");
    mod.schedulePanelPreloadOnIdle();
    mod.schedulePanelPreloadOnIdle();
    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(getPreloadLinks()).toHaveLength(0);

    idleCallbacks[0]?.({ didTimeout: false, timeRemaining: () => 50 });
    expect(getPreloadLinks()).toHaveLength(mod.PANEL_PRELOAD_MODULE_PATHS.length);
  });

  it("页面缺少 requestIdleCallback 时回退 setTimeout 兜底预热", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);

    const modFallback = await import("../../extension/ui/panel-preload.js");
    modFallback.schedulePanelPreloadOnIdle();
    modFallback.schedulePanelPreloadOnIdle();
    expect(getPreloadLinks()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1600);
    expect(getPreloadLinks()).toHaveLength(modFallback.PANEL_PRELOAD_MODULE_PATHS.length);
  });

  it("非支持视频页不注入预热 link；预热失败静默摘除 link 不影响主链", async () => {
    setLocationUrl("https://www.bilibili.com/");
    const mod = await import("../../extension/ui/panel-preload.js");
    mod.preloadReaderPanelChunks();
    expect(getPreloadLinks()).toHaveLength(0);

    setLocationUrl(NORMAL_PAGE_URL);
    mod.preloadReaderPanelChunks();
    const links = getPreloadLinks();
    expect(links).toHaveLength(mod.PANEL_PRELOAD_MODULE_PATHS.length);

    links[0].dispatchEvent(new Event("error"));
    expect(getPreloadLinks()).toHaveLength(mod.PANEL_PRELOAD_MODULE_PATHS.length - 1);
  });
});
