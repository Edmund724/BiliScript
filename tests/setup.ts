import { beforeEach, vi } from "vitest";
import { createMemoryStorageArea } from "./helpers/memory-storage-area.js";

export const READER_MODE_URL = "https://www.bilibili.com/video/BV1test000000/?biliscript_reader=1";
export const NORMAL_PAGE_URL = "https://www.bilibili.com/video/BV1test000000/";

const defaultLocalStore = new Map<string, unknown>();
const defaultSyncStore = new Map<string, unknown>();

function stubChromeApi() {
  const listeners = new Set<(...args: unknown[]) => void>();

  const chromeStub = {
    runtime: {
      lastError: null,
      getURL: vi.fn((path) => `chrome-extension://test/${path}`),
      sendMessage: vi.fn((_message, callback) => {
        callback?.({ ok: true });
        return undefined;
      }),
      onMessage: {
        addListener(listener: (...args: unknown[]) => void) {
          listeners.add(listener);
        },
        removeListener(listener: (...args: unknown[]) => void) {
          listeners.delete(listener);
        },
        hasListener(listener: (...args: unknown[]) => void) {
          return listeners.has(listener);
        }
      }
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

export function setupEnvironment() {
  stubChromeApi();
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
