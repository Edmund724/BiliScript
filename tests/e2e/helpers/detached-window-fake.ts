import { vi, type Mock } from "vitest";

export type PipFakeMode = "allow" | "unsupported" | "reject" | "throw" | "null";
export type PopupFakeMode = "allow" | "blocked" | "throw" | "closed" | "no-doc";

export interface PipRequestRecord {
  width?: number;
  height?: number;
  disallowReturnToOpener?: boolean;
  [key: string]: unknown;
}

export interface WindowOpenRecord {
  url: string;
  target: string;
  features: string;
}

export interface FakeDetachedWindow extends EventTarget {
  readonly document: Document;
  readonly window: FakeDetachedWindow;
  readonly self: FakeDetachedWindow;
  readonly opener: Window;
  readonly screen: Screen;
  closed: boolean;
  innerWidth: number;
  innerHeight: number;
  outerWidth: number;
  outerHeight: number;
  focus: Mock<() => void>;
  close: Mock<() => void>;
  getComputedStyle: (elt: Element, pseudoElt?: string | null) => CSSStyleDeclaration;
  matchMedia: (query: string) => MediaQueryList;
  getSelection: () => Selection | null;
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (handle: number) => void;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
  scrollTo: (x?: number | ScrollToOptions, y?: number) => void;
  scrollBy: (x?: number | ScrollToOptions, y?: number) => void;
  simulateResize: (width: number, height: number) => void;
  simulateUserClose: () => void;
}

export interface DetachedPlatformFakeOptions {
  pipMode?: PipFakeMode;
  popupMode?: PopupFakeMode;
  availHeight?: number;
  openerWindow?: Window;
  closeThrows?: boolean;
}

export interface DetachedPlatformFake {
  readonly pipRequests: PipRequestRecord[];
  readonly openCalls: WindowOpenRecord[];
  readonly openedWindows: FakeDetachedWindow[];
  readonly openerFocusSpy: Mock<() => void>;
  getLastFocusedWindow: () => Window | FakeDetachedWindow | null;
  getCurrentActiveChild: () => FakeDetachedWindow | null;
  setPipMode: (mode: PipFakeMode) => void;
  setPopupMode: (mode: PopupFakeMode) => void;
  setAvailHeight: (availHeight: number) => void;
  setCloseThrows: (shouldThrow: boolean) => void;
  simulateOpenerPageHide: () => void;
  restore: () => void;
}

function parseFeatureNumber(features: string, key: string, fallback: number): number {
  const match = new RegExp(`(?:^|,)\\s*${key}\\s*=\\s*(\\d+)`, "i").exec(features);
  if (!match) {
    return fallback;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isOwnedByDocument(node: Node, doc: Document): boolean {
  return node === doc || node.ownerDocument === doc;
}

function createChildDocumentSelection(doc: Document): Selection {
  const ranges: Range[] = [];
  const selection = {
    get anchorNode(): Node | null {
      return ranges[0]?.startContainer ?? null;
    },
    get anchorOffset(): number {
      return ranges[0]?.startOffset ?? 0;
    },
    get focusNode(): Node | null {
      return ranges[ranges.length - 1]?.endContainer ?? null;
    },
    get focusOffset(): number {
      return ranges[ranges.length - 1]?.endOffset ?? 0;
    },
    get isCollapsed(): boolean {
      return ranges.length === 0 || ranges.every((range) => range.collapsed);
    },
    get rangeCount(): number {
      return ranges.length;
    },
    get type(): string {
      if (ranges.length === 0) {
        return "None";
      }
      return selection.isCollapsed ? "Caret" : "Range";
    },
    get direction(): string {
      return "none";
    },
    addRange(range: Range): void {
      if (!isOwnedByDocument(range.startContainer, doc) || !isOwnedByDocument(range.endContainer, doc)) {
        return;
      }
      if (!ranges.includes(range)) {
        ranges.push(range);
      }
    },
    removeRange(range: Range): void {
      const idx = ranges.indexOf(range);
      if (idx >= 0) {
        ranges.splice(idx, 1);
      }
    },
    removeAllRanges(): void {
      ranges.length = 0;
    },
    empty(): void {
      ranges.length = 0;
    },
    getRangeAt(index: number): Range {
      if (index < 0 || index >= ranges.length) {
        throw new DOMException("Failed to execute 'getRangeAt' on 'Selection': index out of range.", "IndexSizeError");
      }
      return ranges[index];
    },
    collapse(node: Node | null, offset = 0): void {
      ranges.length = 0;
      if (!node || !isOwnedByDocument(node, doc)) {
        return;
      }
      const range = doc.createRange();
      range.setStart(node, offset);
      range.collapse(true);
      ranges.push(range);
    },
    setPosition(node: Node | null, offset = 0): void {
      selection.collapse(node, offset);
    },
    collapseToStart(): void {
      if (ranges.length === 0) {
        return;
      }
      const first = ranges[0];
      first.collapse(true);
      ranges.splice(0, ranges.length, first);
    },
    collapseToEnd(): void {
      if (ranges.length === 0) {
        return;
      }
      const last = ranges[ranges.length - 1];
      last.collapse(false);
      ranges.splice(0, ranges.length, last);
    },
    selectAllChildren(node: Node): void {
      if (!isOwnedByDocument(node, doc)) {
        return;
      }
      const range = doc.createRange();
      range.selectNodeContents(node);
      ranges.splice(0, ranges.length, range);
    },
    containsNode(node: Node, allowPartialContainment = false): boolean {
      if (!isOwnedByDocument(node, doc)) {
        return false;
      }
      return ranges.some((range) => {
        if (allowPartialContainment && typeof range.intersectsNode === "function") {
          return range.intersectsNode(node);
        }
        return range.commonAncestorContainer === node || node.contains(range.commonAncestorContainer);
      });
    },
    deleteFromDocument(): void {
      for (const range of ranges) {
        range.deleteContents();
      }
    },
    setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number): void {
      if (!isOwnedByDocument(anchorNode, doc) || !isOwnedByDocument(focusNode, doc)) {
        return;
      }
      const range = doc.createRange();
      range.setStart(anchorNode, anchorOffset);
      range.setEnd(focusNode, focusOffset);
      ranges.splice(0, ranges.length, range);
    },
    extend(): void {},
    modify(): void {},
    toString(): string {
      return ranges.map((range) => range.toString()).join("");
    }
  };
  return selection as unknown as Selection;
}

export function createFakeDetachedWindow(options: {
  width: number;
  height: number;
  openerWindow: Window;
  onFocus: (win: FakeDetachedWindow) => void;
  onCloseThrows: () => boolean;
}): FakeDetachedWindow {
  const doc = options.openerWindow.document.implementation.createHTMLDocument("BiliScript Detached");
  const docSelection = createChildDocumentSelection(doc);
  const target = new EventTarget();
  let closed = false;
  let innerWidth = options.width;
  let innerHeight = options.height;

  const fakeWin: FakeDetachedWindow = {
    get document() {
      return doc;
    },
    get window() {
      return fakeWin;
    },
    get self() {
      return fakeWin;
    },
    get opener() {
      return options.openerWindow;
    },
    get screen() {
      return options.openerWindow.screen;
    },
    get closed() {
      return closed;
    },
    set closed(value: boolean) {
      closed = Boolean(value);
    },
    get innerWidth() {
      return innerWidth;
    },
    set innerWidth(value: number) {
      innerWidth = value;
    },
    get innerHeight() {
      return innerHeight;
    },
    set innerHeight(value: number) {
      innerHeight = value;
    },
    get outerWidth() {
      return innerWidth;
    },
    set outerWidth(value: number) {
      innerWidth = value;
    },
    get outerHeight() {
      return innerHeight;
    },
    set outerHeight(value: number) {
      innerHeight = value;
    },
    focus: vi.fn(() => {
      options.onFocus(fakeWin);
    }),
    close: vi.fn(() => {
      if (options.onCloseThrows()) {
        throw new Error("Simulated window.close failure");
      }
      if (closed) {
        return;
      }
      closed = true;
      fakeWin.dispatchEvent(new Event("pagehide"));
    }),
    getComputedStyle: (elt, pseudoElt) => options.openerWindow.getComputedStyle(elt, pseudoElt),
    matchMedia: (query) => options.openerWindow.matchMedia(query),
    getSelection: () => docSelection,
    requestAnimationFrame: (callback) => {
      return options.openerWindow.requestAnimationFrame(callback);
    },
    cancelAnimationFrame: (handle) => {
      options.openerWindow.cancelAnimationFrame(handle);
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    scrollTo: () => {},
    scrollBy: () => {},
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    simulateResize: (width: number, height: number) => {
      innerWidth = width;
      innerHeight = height;
      fakeWin.dispatchEvent(new Event("resize"));
    },
    simulateUserClose: () => {
      if (closed) {
        return;
      }
      closed = true;
      fakeWin.dispatchEvent(new Event("pagehide"));
    }
  };

  Object.defineProperty(doc, "defaultView", {
    value: fakeWin,
    configurable: true
  });
  Object.defineProperty(doc, "getSelection", {
    value: () => docSelection,
    configurable: true
  });

  return fakeWin;
}

export function installDetachedPlatformFake(options: DetachedPlatformFakeOptions = {}): DetachedPlatformFake {
  const openerWindow = options.openerWindow ?? window;
  let pipMode: PipFakeMode = options.pipMode ?? "allow";
  let popupMode: PopupFakeMode = options.popupMode ?? "allow";
  let closeThrows = options.closeThrows ?? false;
  let restored = false;

  const pipRequests: PipRequestRecord[] = [];
  const openCalls: WindowOpenRecord[] = [];
  const openedWindows: FakeDetachedWindow[] = [];
  let lastFocusedWindow: Window | FakeDetachedWindow | null = null;

  const origOpen = openerWindow.open;
  const origFocus = openerWindow.focus;
  const origPipDescriptor = Object.getOwnPropertyDescriptor(openerWindow, "documentPictureInPicture");
  const origAvailHeightDescriptor = Object.getOwnPropertyDescriptor(openerWindow.screen, "availHeight");

  const openerFocusSpy = vi.fn(() => {
    lastFocusedWindow = openerWindow;
  });
  Object.defineProperty(openerWindow, "focus", {
    value: openerFocusSpy,
    configurable: true,
    writable: true
  });

  const setAvailHeight = (availHeight: number) => {
    Object.defineProperty(openerWindow.screen, "availHeight", {
      value: availHeight,
      configurable: true
    });
  };

  setAvailHeight(options.availHeight ?? 1080);

  const createChild = (width: number, height: number): FakeDetachedWindow => {
    const child = createFakeDetachedWindow({
      width,
      height,
      openerWindow,
      onFocus: (win) => {
        lastFocusedWindow = win;
      },
      onCloseThrows: () => closeThrows
    });
    openedWindows.push(child);
    return child;
  };

  const applyPipBinding = () => {
    if (pipMode === "unsupported") {
      Object.defineProperty(openerWindow, "documentPictureInPicture", {
        value: undefined,
        configurable: true,
        writable: true
      });
      return;
    }
    const requestWindow = vi.fn(async (req: PipRequestRecord = {}) => {
      pipRequests.push({ ...req });
      if (pipMode === "reject") {
        throw new DOMException("Document Picture-in-Picture rejected", "NotAllowedError");
      }
      if (pipMode === "null") {
        return null;
      }
      return createChild(Number(req.width) || 540, Number(req.height) || 760);
    });
    const syncThrowRequestWindow = vi.fn((req: PipRequestRecord = {}) => {
      pipRequests.push({ ...req });
      throw new DOMException("Synchronous PiP gesture error", "NotAllowedError");
    });
    Object.defineProperty(openerWindow, "documentPictureInPicture", {
      value: {
        requestWindow: pipMode === "throw" ? syncThrowRequestWindow : requestWindow
      },
      configurable: true,
      writable: true
    });
  };

  applyPipBinding();

  const openStub = vi.fn((url = "", target = "", features = "") => {
    openCalls.push({
      url: String(url),
      target: String(target),
      features: String(features)
    });
    if (popupMode === "blocked") {
      return null;
    }
    if (popupMode === "throw") {
      throw new Error("Popup blocked by browser policy");
    }
    const width = parseFeatureNumber(String(features), "width", 540);
    const height = parseFeatureNumber(String(features), "height", 760);
    const child = createChild(width, height);
    if (popupMode === "closed") {
      child.closed = true;
      return child as unknown as Window;
    }
    if (popupMode === "no-doc") {
      return {
        closed: false,
        focus: vi.fn(),
        close: vi.fn()
      } as unknown as Window;
    }
    return child as unknown as Window;
  });

  Object.defineProperty(openerWindow, "open", {
    value: openStub,
    configurable: true,
    writable: true
  });

  return {
    pipRequests,
    openCalls,
    openedWindows,
    openerFocusSpy,
    getLastFocusedWindow: () => lastFocusedWindow,
    getCurrentActiveChild: () => {
      for (let i = openedWindows.length - 1; i >= 0; i -= 1) {
        if (!openedWindows[i].closed) {
          return openedWindows[i];
        }
      }
      return null;
    },
    setPipMode: (mode: PipFakeMode) => {
      pipMode = mode;
      applyPipBinding();
    },
    setPopupMode: (mode: PopupFakeMode) => {
      popupMode = mode;
    },
    setAvailHeight,
    setCloseThrows: (shouldThrow: boolean) => {
      closeThrows = shouldThrow;
    },
    simulateOpenerPageHide: () => {
      openerWindow.dispatchEvent(new Event("pagehide"));
    },
    restore: () => {
      if (restored) {
        return;
      }
      restored = true;
      closeThrows = false;
      for (const win of openedWindows) {
        win.closed = true;
      }
      Object.defineProperty(openerWindow, "open", {
        value: origOpen,
        configurable: true,
        writable: true
      });
      Object.defineProperty(openerWindow, "focus", {
        value: origFocus,
        configurable: true,
        writable: true
      });
      if (origPipDescriptor) {
        Object.defineProperty(openerWindow, "documentPictureInPicture", origPipDescriptor);
      } else {
        Reflect.deleteProperty(openerWindow, "documentPictureInPicture");
      }
      if (origAvailHeightDescriptor) {
        Object.defineProperty(openerWindow.screen, "availHeight", origAvailHeightDescriptor);
      }
    }
  };
}
