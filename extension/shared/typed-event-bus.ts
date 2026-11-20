// extension/shared/typed-event-bus.ts
// 零依赖进程内强类型事件总线与统一资源生命周期上下文（DisposableContext）。
//
// 设计约束：
// - shared 叶子层，严禁 import shared/ 以外任何模块；
// - 支持强类型事件映射与 `{ signal?: AbortSignal, once?: boolean }` 自动退订；
// - DisposableContext 围绕单一 AbortController 管理 DOM 监听、定时器、rAF 与任意
//   可释放资源（observer / 订阅 / 子上下文），通过一次 dispose() 逆序回收，防止泄漏。

export interface EventSubscribeOptions {
  signal?: AbortSignal;
  once?: boolean;
}

export type TypedEventListener<Payload> = (payload: Payload) => void;

export interface TypedEventBus<TEventMap extends object> {
  on<K extends keyof TEventMap>(
    event: K,
    listener: TypedEventListener<TEventMap[K]>,
    options?: EventSubscribeOptions
  ): () => void;
  once<K extends keyof TEventMap>(
    event: K,
    listener: TypedEventListener<TEventMap[K]>,
    options?: Omit<EventSubscribeOptions, "once">
  ): () => void;
  emit<K extends keyof TEventMap>(
    event: K,
    ...args: TEventMap[K] extends void ? [payload?: TEventMap[K]] : [payload: TEventMap[K]]
  ): void;
  listenerCount<K extends keyof TEventMap>(event?: K): number;
  clear(): void;
}

export function createTypedEventBus<TEventMap extends object>(): TypedEventBus<TEventMap> {
  const registry = new Map<keyof TEventMap, Set<TypedEventListener<unknown>>>();

  function on<K extends keyof TEventMap>(
    event: K,
    listener: TypedEventListener<TEventMap[K]>,
    options?: EventSubscribeOptions
  ): () => void {
    if (typeof listener !== "function") {
      return () => {};
    }
    const signal = options?.signal;
    if (signal?.aborted) {
      return () => {};
    }

    let listeners = registry.get(event);
    if (!listeners) {
      listeners = new Set();
      registry.set(event, listeners);
    }

    let active = true;
    const unsubscribe = (): void => {
      if (!active) {
        return;
      }
      active = false;
      listeners?.delete(wrapped);
      if (listeners && listeners.size === 0) {
        registry.delete(event);
      }
      if (signal) {
        signal.removeEventListener("abort", unsubscribe);
      }
    };

    const wrapped: TypedEventListener<unknown> = (payload) => {
      if (!active) {
        return;
      }
      if (options?.once) {
        unsubscribe();
      }
      listener(payload as TEventMap[K]);
    };

    listeners.add(wrapped);
    if (signal) {
      signal.addEventListener("abort", unsubscribe, { once: true });
    }
    return unsubscribe;
  }

  function once<K extends keyof TEventMap>(
    event: K,
    listener: TypedEventListener<TEventMap[K]>,
    options?: Omit<EventSubscribeOptions, "once">
  ): () => void {
    return on(event, listener, { ...options, once: true });
  }

  function emit<K extends keyof TEventMap>(
    event: K,
    ...args: TEventMap[K] extends void ? [payload?: TEventMap[K]] : [payload: TEventMap[K]]
  ): void {
    const listeners = registry.get(event);
    if (!listeners || listeners.size === 0) {
      return;
    }
    const payload = args[0];
    // 快照遍历：订阅者在回调内退订或新增订阅不影响本轮派发。
    for (const listener of [...listeners]) {
      try {
        listener(payload);
      } catch {
        // 订阅者异常隔离：单个消费方抛错不得打断其它订阅者与发布主流程。
      }
    }
  }

  function listenerCount<K extends keyof TEventMap>(event?: K): number {
    if (event !== undefined) {
      return registry.get(event)?.size ?? 0;
    }
    let total = 0;
    for (const listeners of registry.values()) {
      total += listeners.size;
    }
    return total;
  }

  function clear(): void {
    registry.clear();
  }

  return { on, once, emit, listenerCount, clear };
}

export type DisposableCleanup =
  | (() => void)
  | { dispose(): void }
  | { disconnect(): void }
  | { abort(): void };

export interface DisposableContext {
  readonly signal: AbortSignal;
  readonly disposed: boolean;
  isDisposed(): boolean;
  addListener<T extends EventTarget>(
    target: T | null | undefined,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean
  ): () => void;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(id: number): void;
  setInterval(callback: () => void, intervalMs: number): number;
  clearInterval(id: number): void;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(id: number): void;
  track(cleanup: DisposableCleanup | null | undefined): () => void;
  createChild(): DisposableContext;
  dispose(): void;
}

function invokeCleanup(cleanup: DisposableCleanup): void {
  if (typeof cleanup === "function") {
    cleanup();
    return;
  }
  if ("dispose" in cleanup && typeof cleanup.dispose === "function") {
    cleanup.dispose();
    return;
  }
  if ("disconnect" in cleanup && typeof cleanup.disconnect === "function") {
    cleanup.disconnect();
    return;
  }
  if ("abort" in cleanup && typeof cleanup.abort === "function") {
    cleanup.abort();
  }
}

export function createDisposableContext(parentSignal?: AbortSignal): DisposableContext {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  const timeouts = new Set<number>();
  const intervals = new Set<number>();
  const rafs = new Set<number>();
  let isDisposedFlag = false;

  const dispose = (): void => {
    if (isDisposedFlag) {
      return;
    }
    isDisposedFlag = true;
    if (parentSignal) {
      parentSignal.removeEventListener("abort", dispose);
    }

    for (const id of timeouts) {
      globalThis.clearTimeout(id);
    }
    timeouts.clear();

    for (const id of intervals) {
      globalThis.clearInterval(id);
    }
    intervals.clear();

    if (typeof globalThis.cancelAnimationFrame === "function") {
      for (const id of rafs) {
        globalThis.cancelAnimationFrame(id);
      }
    }
    rafs.clear();

    if (!controller.signal.aborted) {
      controller.abort();
    }

    // 逆序（LIFO）回收全部已登记资源，单个清理失败不阻塞剩余资源释放。
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()!;
      try {
        cleanup();
      } catch {
        // 清理异常隔离
      }
    }
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      dispose();
    } else {
      parentSignal.addEventListener("abort", dispose, { once: true });
    }
  }

  function addListener<T extends EventTarget>(
    target: T | null | undefined,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean
  ): () => void {
    if (!target || isDisposedFlag) {
      return () => {};
    }
    const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
    const normalized: AddEventListenerOptions =
      typeof options === "boolean"
        ? { capture, signal: controller.signal }
        : { ...options, signal: controller.signal };
    target.addEventListener(type, listener, normalized);
    let removed = false;
    const remove = (): void => {
      if (removed) {
        return;
      }
      removed = true;
      target.removeEventListener(type, listener, capture);
    };
    return track(remove);
  }

  function setTrackedTimeout(callback: () => void, delayMs: number): number {
    if (isDisposedFlag) {
      return 0;
    }
    let id = 0;
    let fired = false;
    id = Number(
      globalThis.setTimeout(() => {
        fired = true;
        if (id) {
          timeouts.delete(id);
        }
        if (!isDisposedFlag) {
          callback();
        }
      }, delayMs)
    );
    if (!fired) {
      timeouts.add(id);
    }
    return id;
  }

  function clearTrackedTimeout(id: number): void {
    if (!id) {
      return;
    }
    timeouts.delete(id);
    globalThis.clearTimeout(id);
  }

  function setTrackedInterval(callback: () => void, intervalMs: number): number {
    if (isDisposedFlag) {
      return 0;
    }
    const id = Number(
      globalThis.setInterval(() => {
        if (!isDisposedFlag) {
          callback();
        }
      }, intervalMs)
    );
    intervals.add(id);
    return id;
  }

  function clearTrackedInterval(id: number): void {
    if (!id) {
      return;
    }
    intervals.delete(id);
    globalThis.clearInterval(id);
  }

  function requestTrackedAnimationFrame(callback: FrameRequestCallback): number {
    if (isDisposedFlag || typeof globalThis.requestAnimationFrame !== "function") {
      return 0;
    }
    let id = 0;
    let fired = false;
    id = globalThis.requestAnimationFrame((timestamp) => {
      fired = true;
      if (id) {
        rafs.delete(id);
      }
      if (!isDisposedFlag) {
        callback(timestamp);
      }
    });
    if (!fired) {
      rafs.add(id);
    }
    return id;
  }

  function cancelTrackedAnimationFrame(id: number): void {
    if (!id) {
      return;
    }
    rafs.delete(id);
    if (typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(id);
    }
  }

  function track(cleanup: DisposableCleanup | null | undefined): () => void {
    if (!cleanup) {
      return () => {};
    }
    if (isDisposedFlag) {
      try {
        invokeCleanup(cleanup);
      } catch {
        // 清理异常隔离
      }
      return () => {};
    }
    let active = true;
    const run = (): void => {
      if (!active) {
        return;
      }
      active = false;
      const idx = cleanups.indexOf(run);
      if (idx !== -1) {
        cleanups.splice(idx, 1);
      }
      invokeCleanup(cleanup);
    };
    cleanups.push(run);
    return run;
  }

  function createChild(): DisposableContext {
    return createDisposableContext(controller.signal);
  }

  return {
    get signal() {
      return controller.signal;
    },
    get disposed() {
      return isDisposedFlag;
    },
    isDisposed: () => isDisposedFlag,
    addListener,
    setTimeout: setTrackedTimeout,
    clearTimeout: clearTrackedTimeout,
    setInterval: setTrackedInterval,
    clearInterval: clearTrackedInterval,
    requestAnimationFrame: requestTrackedAnimationFrame,
    cancelAnimationFrame: cancelTrackedAnimationFrame,
    track,
    createChild,
    dispose
  };
}
