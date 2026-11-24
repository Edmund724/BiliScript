// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

type ActiveHostModule = typeof import("../../extension/shared/active-host.js");

function makeMockWindow(closed = false): Window {
  return { closed } as unknown as Window;
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

describe("active-host 主/子宿主上下文与跨实例共享", () => {
  it("默认处于停靠状态：opener 与 active 均为当前主文档/主窗口", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");

    expect(activeHost.getOpenerDocument()).toBe(document);
    expect(activeHost.getOpenerWindow()).toBe(window);
    expect(activeHost.getActiveReaderDocument()).toBe(document);
    expect(activeHost.getActiveReaderWindow()).toBe(window);
    expect(activeHost.isReaderDetached()).toBe(false);

    const el = document.createElement("div");
    el.id = "panel-root";
    document.body.appendChild(el);
    expect(activeHost.activeById("panel-root")).toBe(el);
  });

  it("setActiveReaderHost 与 resetActiveReaderHost 切换活跃上下文并保留 opener 不变", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    const detachedWin = makeMockWindow(false);

    const openerEl = document.createElement("div");
    openerEl.id = "shared-node";
    document.body.appendChild(openerEl);

    const detachedEl = detachedDoc.createElement("div");
    detachedEl.id = "shared-node";
    detachedDoc.body.appendChild(detachedEl);

    activeHost.setActiveReaderHost(detachedDoc, detachedWin);

    expect(activeHost.isReaderDetached()).toBe(true);
    expect(activeHost.getOpenerDocument()).toBe(document);
    expect(activeHost.getOpenerWindow()).toBe(window);
    expect(activeHost.getActiveReaderDocument()).toBe(detachedDoc);
    expect(activeHost.getActiveReaderWindow()).toBe(detachedWin);
    expect(activeHost.activeById("shared-node")).toBe(detachedEl);

    activeHost.resetActiveReaderHost();

    expect(activeHost.isReaderDetached()).toBe(false);
    expect(activeHost.getActiveReaderDocument()).toBe(document);
    expect(activeHost.getActiveReaderWindow()).toBe(window);
    expect(activeHost.activeById("shared-node")).toBe(openerEl);
  });

  it("onActiveHostChange 去重、支持取消订阅与 AbortSignal、隔离监听器异常", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    const detachedWin = makeMockWindow(false);

    const events: Array<{ doc: Document; win: Window; detached: boolean }> = [];
    const controller = new AbortController();

    const unsub1 = activeHost.onActiveHostChange(() => {
      throw new Error("listener boom");
    });
    const unsub2 = activeHost.onActiveHostChange((ctx) => {
      events.push(ctx);
    });
    activeHost.onActiveHostChange(
      (ctx) => {
        events.push({ ...ctx });
      },
      { signal: controller.signal }
    );

    activeHost.setActiveReaderHost(detachedDoc, detachedWin);
    activeHost.setActiveReaderHost(detachedDoc, detachedWin);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ doc: detachedDoc, win: detachedWin, detached: true });

    controller.abort();
    activeHost.resetActiveReaderHost();
    activeHost.resetActiveReaderHost();
    expect(events).toHaveLength(3);
    expect(events[2]).toEqual({ doc: document, win: window, detached: false });

    unsub1();
    unsub2();
    unsub2();
    activeHost.setActiveReaderHost(detachedDoc, detachedWin);
    expect(events).toHaveLength(3);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const unsubAborted = activeHost.onActiveHostChange(() => {
      events.push({ doc: document, win: window, detached: false });
    }, { signal: alreadyAborted.signal });
    activeHost.resetActiveReaderHost();
    unsubAborted();
    expect(events).toHaveLength(3);
  });

  it("Firefox XrayWrapper 死亡对象与 closed 窗口自动安全回落 opener", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const detachedDoc = document.implementation.createHTMLDocument("Detached");

    const closedWin = makeMockWindow(true);
    activeHost.setActiveReaderHost(detachedDoc, closedWin);
    expect(activeHost.isReaderDetached()).toBe(false);
    expect(activeHost.getActiveReaderDocument()).toBe(document);
    expect(activeHost.getActiveReaderWindow()).toBe(window);

    const deadWin = {} as Window;
    Object.defineProperty(deadWin, "closed", {
      get() {
        throw new TypeError("can't access dead object");
      }
    });
    activeHost.setActiveReaderHost(detachedDoc, deadWin);
    expect(activeHost.isReaderDetached()).toBe(false);
    expect(activeHost.getActiveReaderDocument()).toBe(document);
    expect(activeHost.getActiveReaderWindow()).toBe(window);

    activeHost.setActiveReaderHost(document, window);
    expect(activeHost.isReaderDetached()).toBe(false);
  });

  it("跨实例（resident vs lazy）共享活跃宿主状态、变更事件与模式切换钩子", async () => {
    const resident: ActiveHostModule = await import("../../extension/shared/active-host.js");
    vi.resetModules();
    const lazy: ActiveHostModule = await import("../../extension/shared/active-host.js");

    expect(lazy).not.toBe(resident);

    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    const detachedWin = makeMockWindow(false);
    const seenByLazy: boolean[] = [];
    lazy.onActiveHostChange((ctx) => seenByLazy.push(ctx.detached));

    resident.setActiveReaderHost(detachedDoc, detachedWin);
    expect(lazy.isReaderDetached()).toBe(true);
    expect(lazy.getActiveReaderDocument()).toBe(detachedDoc);
    expect(seenByLazy).toEqual([true]);

    const switchHandler = vi.fn(() => "switched");
    const unregister = lazy.registerDetachedModeSwitchHandler(switchHandler);
    expect(resident.requestDetachedModeSwitch("popup")).toBe("switched");
    expect(switchHandler).toHaveBeenCalledWith("popup");

    unregister();
    expect(resident.requestDetachedModeSwitch("pip")).toBeUndefined();

    lazy.resetActiveReaderHost();
    expect(resident.isReaderDetached()).toBe(false);
    expect(seenByLazy).toEqual([true, false]);
  });

  it("onActiveHostChange 内重入 resetActiveReaderHost 时中止外层陈旧 detached 通知", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const detachedDoc = document.implementation.createHTMLDocument("Detached");
    const detachedWin = makeMockWindow(false);
    const seenByDownstream: Array<{ detached: boolean; live: boolean }> = [];

    activeHost.onActiveHostChange((ctx) => {
      if (ctx.detached) {
        activeHost.resetActiveReaderHost();
      }
    });
    activeHost.onActiveHostChange((ctx) => {
      seenByDownstream.push({ detached: ctx.detached, live: activeHost.isReaderDetached() });
    });

    activeHost.setActiveReaderHost(detachedDoc, detachedWin);
    expect(seenByDownstream).toEqual([{ detached: false, live: false }]);
    expect(activeHost.isReaderDetached()).toBe(false);
  });

  it("半主宿主配对 (document, foreignWin) 或 (foreignDoc, window) 不得判定为分离态", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const foreignDoc = document.implementation.createHTMLDocument("Foreign");
    const foreignWin = makeMockWindow(false);

    activeHost.setActiveReaderHost(document, foreignWin);
    expect(activeHost.isReaderDetached()).toBe(false);
    expect(activeHost.getActiveReaderDocument()).toBe(document);
    expect(activeHost.getActiveReaderWindow()).toBe(window);

    activeHost.setActiveReaderHost(foreignDoc, window);
    expect(activeHost.isReaderDetached()).toBe(false);
    expect(activeHost.getActiveReaderDocument()).toBe(document);
    expect(activeHost.getActiveReaderWindow()).toBe(window);
  });

  it("传入空 doc 或空 win 时安全回落 opener 且不触发 detached: true 事件", async () => {
    const activeHost = await import("../../extension/shared/active-host.js");
    const foreignDoc = document.implementation.createHTMLDocument("Foreign");
    const foreignWin = makeMockWindow(false);
    const events: Array<{ doc: Document; win: Window; detached: boolean }> = [];
    activeHost.onActiveHostChange((ctx) => events.push(ctx));

    activeHost.setActiveReaderHost(null as unknown as Document, foreignWin);
    expect(activeHost.isReaderDetached()).toBe(false);
    expect(events).toEqual([]);

    activeHost.setActiveReaderHost(foreignDoc, foreignWin);
    expect(activeHost.isReaderDetached()).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].detached).toBe(true);

    activeHost.setActiveReaderHost(foreignDoc, undefined as unknown as Window);
    expect(activeHost.isReaderDetached()).toBe(false);
    expect(activeHost.getActiveReaderDocument()).toBe(document);
    expect(activeHost.getActiveReaderWindow()).toBe(window);
    expect(events).toEqual([
      { doc: foreignDoc, win: foreignWin, detached: true },
      { doc: document, win: window, detached: false }
    ]);
  });
});
