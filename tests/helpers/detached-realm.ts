import { JSDOM } from "jsdom";
import { vi } from "vitest";
import { installCanvasContextStub } from "../setup.js";

export interface DetachedRealm {
  dom: JSDOM;
  doc: Document;
  win: Window;
  clipboardWriteText: ReturnType<typeof vi.fn>;
  clipboardWrite: ReturnType<typeof vi.fn>;
  rafQueue: Map<number, FrameRequestCallback>;
  flushRaf: (time?: number) => void;
  close: () => void;
}

export function createDetachedRealm(options: {
  innerWidth?: number;
  innerHeight?: number;
  reducedMotion?: boolean;
  devicePixelRatio?: number;
} = {}): DetachedRealm {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "https://www.bilibili.com/video/BV1detached",
  });
  const win = dom.window as unknown as Window & Record<string, unknown>;
  const doc = dom.window.document;

  Object.defineProperty(win, "innerWidth", {
    value: options.innerWidth ?? 480,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(win, "innerHeight", {
    value: options.innerHeight ?? 640,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(win, "devicePixelRatio", {
    value: options.devicePixelRatio ?? 2,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(win, "closed", {
    value: false,
    writable: true,
    configurable: true,
  });

  const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(win.navigator, "clipboard", {
    value: {
      writeText: clipboardWriteText,
      write: clipboardWrite,
    },
    configurable: true,
  });

  win.matchMedia = vi.fn((query: string) => ({
    matches: Boolean(options.reducedMotion && query.includes("reduce")),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })) as unknown as Window["matchMedia"];

  let nextRafId = 1;
  const rafQueue = new Map<number, FrameRequestCallback>();
  win.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
    const id = nextRafId++;
    rafQueue.set(id, cb);
    return id;
  });
  win.cancelAnimationFrame = vi.fn((id: number) => {
    rafQueue.delete(id);
  });

  if (typeof dom.window.Element.prototype.scrollIntoView !== "function") {
    dom.window.Element.prototype.scrollIntoView = () => {};
  }
  dom.window.Element.prototype.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 300,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    }) as DOMRect;

  if (typeof (dom.window as unknown as { HTMLDialogElement?: typeof HTMLDialogElement }).HTMLDialogElement !== "undefined") {
    const proto = (dom.window as unknown as { HTMLDialogElement: typeof HTMLDialogElement }).HTMLDialogElement.prototype;
    if (typeof proto.showModal !== "function") {
      proto.showModal = function showModal() {
        this.setAttribute("open", "");
      };
    }
    if (typeof proto.close !== "function") {
      proto.close = function close() {
        this.removeAttribute("open");
      };
    }
  }

  installCanvasContextStub(
    (dom.window as unknown as { HTMLCanvasElement?: typeof HTMLCanvasElement }).HTMLCanvasElement
  );

  return {
    dom,
    doc,
    win: win as Window,
    clipboardWriteText,
    clipboardWrite,
    rafQueue,
    flushRaf(time = 16) {
      const entries = Array.from(rafQueue.entries());
      rafQueue.clear();
      for (const [, cb] of entries) {
        cb(time);
      }
    },
    close() {
      Object.defineProperty(win, "closed", { value: true, configurable: true });
      dom.window.close();
    },
  };
}
