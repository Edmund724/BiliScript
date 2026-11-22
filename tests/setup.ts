import { beforeEach, vi } from "vitest";
import { createMemoryStorageArea } from "./helpers/memory-storage-area.js";

export const READER_MODE_URL = "https://www.bilibili.com/video/BV1test000000/?biliscript_reader=1";
export const NORMAL_PAGE_URL = "https://www.bilibili.com/video/BV1test000000/";

const defaultLocalStore = new Map<string, unknown>();
const defaultSyncStore = new Map<string, unknown>();

function createChromeEventStub() {
  const listeners = new Set<(...args: unknown[]) => void>();
  return {
    addListener: vi.fn((listener: (...args: unknown[]) => void) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: (...args: unknown[]) => void) => {
      listeners.delete(listener);
    }),
    hasListener: vi.fn((listener: (...args: unknown[]) => void) => listeners.has(listener))
  };
}

function stubChromeApi() {
  const chromeStub = {
    runtime: {
      lastError: null,
      getURL: vi.fn((path) => `chrome-extension://test/${path}`),
      getManifest: vi.fn(() => ({ version: "0.0.0" })),
      sendMessage: vi.fn((_message, callback) => {
        callback?.({ ok: true });
        return undefined;
      }),
      onMessage: createChromeEventStub(),
      onConnect: createChromeEventStub(),
      onInstalled: createChromeEventStub(),
      onStartup: createChromeEventStub()
    },
    action: {
      onClicked: createChromeEventStub(),
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      setIcon: vi.fn(async () => {}),
      setPopup: vi.fn(async () => {}),
      getBadgeText: vi.fn(async () => ""),
      getTitle: vi.fn(async () => "")
    },
    commands: {
      onCommand: createChromeEventStub(),
      getAll: vi.fn(async () => [])
    },
    tabs: {
      onUpdated: createChromeEventStub(),
      onRemoved: createChromeEventStub(),
      query: vi.fn(async () => []),
      get: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      reload: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => ({ ok: true }))
    },
    alarms: {
      onAlarm: createChromeEventStub(),
      create: vi.fn(async () => {}),
      clear: vi.fn(async () => true)
    },
    storage: {
      local: createMemoryStorageArea(defaultLocalStore),
      sync: createMemoryStorageArea(defaultSyncStore),
      onChanged: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      }
    }
  };

  if (!globalThis.chrome) {
    vi.stubGlobal("chrome", chromeStub);
  }
  return chromeStub;
}

function installDialogClosePolyfill() {
  if (typeof HTMLDialogElement === "undefined") return;
  if (!("returnValue" in HTMLDialogElement.prototype)) {
    const returnValues = new WeakMap<HTMLDialogElement, string>();
    Object.defineProperty(HTMLDialogElement.prototype, "returnValue", {
      configurable: true,
      get(this: HTMLDialogElement) {
        return returnValues.get(this) ?? "";
      },
      set(this: HTMLDialogElement, value: string) {
        returnValues.set(this, String(value));
      }
    });
  }
  if (typeof HTMLDialogElement.prototype.close !== "function") {
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      writable: true,
      value: function close(this: HTMLDialogElement, returnValue?: string): void {
        if (!this.hasAttribute("open")) {
          return;
        }
        this.removeAttribute("open");
        if (arguments.length > 0 && returnValue !== undefined) {
          this.returnValue = String(returnValue);
        }
        this.dispatchEvent(new Event("close", { bubbles: false, cancelable: false }));
      }
    });
  }
}

class StubAnimation extends EventTarget {
  effect: AnimationEffect | null = null;
  id = "";
  playbackRate = 1;
  playState: AnimationPlayState = "running";
  replaceState: AnimationReplaceState = "active";
  pending = false;
  startTime: CSSNumberish | null = 0;
  currentTime: CSSNumberish | null = 0;
  timeline: AnimationTimeline | null = null;
  onfinish: ((this: Animation, ev: AnimationPlaybackEvent) => unknown) | null = null;
  oncancel: ((this: Animation, ev: AnimationPlaybackEvent) => unknown) | null = null;
  onremove: ((this: Animation, ev: Event) => unknown) | null = null;
  #finishedPromise: Promise<Animation> | null = null;
  #resolveFinished?: (anim: Animation) => void;
  #rejectFinished?: (reason?: unknown) => void;
  #settled: "none" | "finished" | "cancelled" = "none";
  #autoFinishOnListener = false;

  constructor(effect: AnimationEffect | null = null, timeline: AnimationTimeline | null = null, autoFinishOnListener = false) {
    super();
    this.effect = effect;
    this.timeline = timeline;
    this.#autoFinishOnListener = autoFinishOnListener;
  }

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ): void {
    super.addEventListener(type, callback, options);
    if (type === "finish" && this.#autoFinishOnListener && this.playState === "running") {
      this.finish();
    }
  }

  get finished(): Promise<Animation> {
    if (this.#finishedPromise) {
      return this.#finishedPromise;
    }
    if (this.#settled === "finished") {
      this.#finishedPromise = Promise.resolve(this as unknown as Animation);
      return this.#finishedPromise;
    }
    if (this.#settled === "cancelled") {
      this.#finishedPromise = Promise.reject(new DOMException("Animation was cancelled", "AbortError"));
      return this.#finishedPromise;
    }
    this.#finishedPromise = new Promise<Animation>((resolve, reject) => {
      this.#resolveFinished = resolve;
      this.#rejectFinished = reject;
    });
    return this.#finishedPromise;
  }

  get ready(): Promise<Animation> {
    return Promise.resolve(this as unknown as Animation);
  }

  cancel(): void {
    if (this.playState === "idle") return;
    this.playState = "idle";
    this.startTime = null;
    this.currentTime = null;
    this.#settled = "cancelled";
    this.#rejectFinished?.(new DOMException("Animation was cancelled", "AbortError"));
    const ev = new Event("cancel") as AnimationPlaybackEvent;
    this.oncancel?.call(this as unknown as Animation, ev);
    this.dispatchEvent(ev);
  }

  finish(): void {
    if (this.playState === "finished") return;
    this.playState = "finished";
    this.#settled = "finished";
    this.#resolveFinished?.(this as unknown as Animation);
    const ev = new Event("finish") as AnimationPlaybackEvent;
    this.onfinish?.call(this as unknown as Animation, ev);
    this.dispatchEvent(ev);
  }

  pause(): void {
    if (this.playState !== "idle") {
      this.playState = "paused";
    }
  }

  play(): void {
    this.playState = "running";
  }

  reverse(): void {
    this.playbackRate = -this.playbackRate;
  }

  persist(): void {}

  commitStyles(): void {}

  updatePlaybackRate(playbackRate: number): void {
    this.playbackRate = playbackRate;
  }
}

function installWebAnimationsStub() {
  if (typeof globalThis.Animation === "undefined") {
    vi.stubGlobal("Animation", StubAnimation);
  }

  if (typeof Element !== "undefined" && typeof Element.prototype.animate !== "function") {
    Object.defineProperty(Element.prototype, "animate", {
      configurable: true,
      writable: true,
      value: function animate(
        _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
        options?: number | KeyframeAnimationOptions
      ): Animation {
        const anim = new StubAnimation(null, null, true);
        if (typeof options === "object" && options?.id) {
          anim.id = options.id;
        }
        return anim as unknown as Animation;
      }
    });
  }
}

export function setupEnvironment() {
  stubChromeApi();
  installDialogClosePolyfill();
  installWebAnimationsStub();
  if (typeof Element !== "undefined" && typeof Element.prototype.setPointerCapture !== "function") {
    const capturedPointers = new WeakMap<Element, Set<number>>();
    Element.prototype.setPointerCapture = function setPointerCapture(pointerId: number): void {
      if (!this.isConnected) {
        throw new DOMException("Element is not connected", "InvalidStateError");
      }
      if (typeof pointerId !== "number" || !Number.isFinite(pointerId)) {
        throw new DOMException("Invalid pointerId", "NotFoundError");
      }
      let set = capturedPointers.get(this);
      if (!set) {
        set = new Set();
        capturedPointers.set(this, set);
      }
      set.add(pointerId);
    };
    Element.prototype.releasePointerCapture = function releasePointerCapture(pointerId: number): void {
      capturedPointers.get(this)?.delete(pointerId);
    };
    Element.prototype.hasPointerCapture = function hasPointerCapture(pointerId: number): boolean {
      return capturedPointers.get(this)?.has(pointerId) ?? false;
    };
  }
}

export function clearSharedSlots() {
  const slots = globalThis as unknown as Record<PropertyKey, unknown>;
  const eventBusSlot = slots.__BILISCRIPT_EVENT_BUS__ as { clipScope?: { dispose?: () => void } } | undefined;
  eventBusSlot?.clipScope?.dispose?.();
  delete slots.__BILISCRIPT_CONTENT_SCRIPT_DISPATCHER__;
  delete slots.__BILISCRIPT_LOG_GATE__;
  delete slots.__BILISCRIPT_READER_BUS__;
  delete slots.__BILISCRIPT_STATE__;
  delete slots.__BILISCRIPT_STYLE_INJECTOR__;
  delete slots.__BILISCRIPT_EVENT_BUS__;
  (slots[Symbol.for("biliscript.subtitleStoreReset")] as (() => void) | undefined)?.();
}

beforeEach(() => {
  clearSharedSlots();
  defaultLocalStore.clear();
  defaultSyncStore.clear();
  installDialogClosePolyfill();
  installWebAnimationsStub();
});

export function resetModuleState() {
  vi.resetModules();
  vi.useRealTimers();
  setupEnvironment();
  history.replaceState({}, "", NORMAL_PAGE_URL);
  clearSharedSlots();

  if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }

  if (typeof window !== "undefined") {
    window.scrollTo = () => {};
    window.scrollBy = () => {};
  }

  if (typeof Element !== "undefined") {
    const rect = Element.prototype.getBoundingClientRect as (() => DOMRect) & { __biliscriptDefaultPatched?: boolean };
    if (!rect.__biliscriptDefaultPatched) {
      const patched = function getBoundingClientRect() {
        return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 450, width: 800, height: 450, toJSON: () => ({}) };
      } as (() => DOMRect) & { __biliscriptDefaultPatched?: boolean };
      patched.__biliscriptDefaultPatched = true;
      Element.prototype.getBoundingClientRect = patched;
    }
  }
}

export function setLocationUrl(url: string) {
  history.replaceState({}, "", url);
}

export function makeSubtitleBody(totalChars: number, charsPerItem = 1000) {
  const items = [];
  let remaining = totalChars;
  let t = 0;
  while (remaining > 0) {
    const n = Math.min(charsPerItem, remaining);
    items.push({ from: t, to: t + 5, content: "x".repeat(n) });
    remaining -= n;
    t += 5;
  }
  return items;
}

setupEnvironment();
