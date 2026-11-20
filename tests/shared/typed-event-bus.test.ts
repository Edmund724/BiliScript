import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDisposableContext,
  createTypedEventBus
} from "../../extension/shared/typed-event-bus.js";

interface SampleEvents {
  ping: { id: number };
  reset: void;
}

describe("shared/typed-event-bus", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("支持强类型事件派发与 { signal } 自动退订", () => {
    const bus = createTypedEventBus<SampleEvents>();
    const ac = new AbortController();
    const seen: number[] = [];

    bus.on("ping", (payload) => seen.push(payload.id), { signal: ac.signal });
    expect(bus.listenerCount("ping")).toBe(1);

    bus.emit("ping", { id: 1 });
    expect(seen).toEqual([1]);

    ac.abort();
    expect(bus.listenerCount("ping")).toBe(0);

    bus.emit("ping", { id: 2 });
    expect(seen).toEqual([1]);
  });

  it("已中止的 signal 不注册监听器，手动退订时移除 abort 监听", () => {
    const bus = createTypedEventBus<SampleEvents>();
    const aborted = new AbortController();
    aborted.abort();

    const neverCalled = vi.fn();
    bus.on("reset", neverCalled, { signal: aborted.signal });
    expect(bus.listenerCount("reset")).toBe(0);
    bus.emit("reset");
    expect(neverCalled).not.toHaveBeenCalled();

    const live = new AbortController();
    const removeSpy = vi.spyOn(live.signal, "removeEventListener");
    const unsub = bus.on("reset", () => {}, { signal: live.signal });
    unsub();
    expect(bus.listenerCount("reset")).toBe(0);
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("支持 once 与订阅者异常隔离", () => {
    const bus = createTypedEventBus<SampleEvents>();
    const onceFn = vi.fn();
    const healthy = vi.fn();

    bus.once("reset", onceFn);
    bus.on("reset", () => {
      throw new Error("boom");
    });
    bus.on("reset", healthy);

    expect(() => bus.emit("reset")).not.toThrow();
    expect(onceFn).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(1);

    bus.emit("reset");
    expect(onceFn).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(2);
  });

  it("DisposableContext 通过单次 dispose 一次性回收监听器、定时器、rAF 与级联子作用域", () => {
    vi.useFakeTimers();
    const parent = createDisposableContext();
    const child = parent.createChild();

    const target = new EventTarget();
    const onEvent = vi.fn();
    parent.addListener(target, "custom", onEvent);

    const onTimeout = vi.fn();
    const onInterval = vi.fn();
    const onChildInterval = vi.fn();
    parent.setTimeout(onTimeout, 100);
    parent.setInterval(onInterval, 50);
    child.setInterval(onChildInterval, 50);

    const order: string[] = [];
    parent.track(() => order.push("first"));
    parent.track(() => order.push("second"));
    child.track(() => order.push("child"));

    const bus = createTypedEventBus<SampleEvents>();
    const onBus = vi.fn();
    bus.on("ping", onBus, { signal: child.signal });

    target.dispatchEvent(new Event("custom"));
    bus.emit("ping", { id: 10 });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onBus).toHaveBeenCalledTimes(1);

    parent.dispose();
    // 幂等二次调用安全
    parent.dispose();

    expect(parent.disposed).toBe(true);
    expect(parent.signal.aborted).toBe(true);
    expect(child.disposed).toBe(true);
    expect(child.signal.aborted).toBe(true);
    expect(bus.listenerCount()).toBe(0);
    // 逆序 LIFO 回收（父 abort 先级联释放 child，再逆序跑 parent 自身 cleanup）
    expect(order).toEqual(["child", "second", "first"]);

    target.dispatchEvent(new Event("custom"));
    bus.emit("ping", { id: 11 });
    vi.advanceTimersByTime(500);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onBus).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onInterval).not.toHaveBeenCalled();
    expect(onChildInterval).not.toHaveBeenCalled();
  });
});
