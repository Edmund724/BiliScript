import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setLocationUrl, NORMAL_PAGE_URL, READER_MODE_URL } from "../setup.js";

const mocks = vi.hoisted(() => ({
  loadScriptButton: vi.fn(() => Promise.resolve({}))
}));

vi.mock("../../extension/ui/lazy-script-button.js", () => ({
  loadScriptButton: mocks.loadScriptButton
}));
vi.mock("../../extension/ui/lazy-ui.js", () => ({
  ensureUiReady: vi.fn(() => Promise.resolve())
}));
vi.mock("../../extension/reader/lazy-reader-presentation.js", () => ({
  hydrateReaderStateFromSettings: vi.fn(() => Promise.resolve()),
  applyPrePaintReaderTheme: vi.fn(() => Promise.resolve()),
  applyReadingViewPresentation: vi.fn(() => Promise.resolve()),
  announceReadingStatus: vi.fn()
}));
vi.mock("../../extension/reader/lazy-reader.js", () => ({
  ensureReaderDomain: vi.fn(() => Promise.resolve({
    enterReaderMode: vi.fn(async () => {
      const { transitionReaderShell } = await import("../../extension/core/state.js");
      transitionReaderShell("open");
    })
  }))
}));

function stubChrome(settings?: { autoOpenReader?: boolean }) {
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: vi.fn((path) => `chrome-extension://test/${path}`),
      lastError: null,
      sendMessage: vi.fn((_message, callback) => {
        if (_message?.type === "get-settings") {
          if (settings) {
            callback?.({ ok: true, settings });
          }
        } else {
          callback?.({ ok: true });
        }
        return undefined;
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(() => false) }
    },
    storage: {
      sync: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      },
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {})
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
    }
  });
}

async function flushMicrotasks(times = 20) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  resetModuleState();
  mocks.loadScriptButton.mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
  document.head.querySelectorAll('link[data-biliscript-style="1"]').forEach((link) => link.remove());
  document.documentElement.removeAttribute("data-biliscript-reader-mode");
  vi.restoreAllMocks();
});

describe("script-button 快路径（不等 getSettings 水合）", () => {
  it("SW 冷启动（get-settings 未回包）时 script 按钮模块已装载", async () => {
    setLocationUrl(NORMAL_PAGE_URL);
    stubChrome();

    await import("../../extension/entry/content.js");
    await flushMicrotasks();

    expect(mocks.loadScriptButton).toHaveBeenCalledTimes(1);
  });
});

describe("阅读模式首屏样式门控", () => {
  async function expectGateAfterStyleLoad(url: string, settings?: { autoOpenReader?: boolean }) {
    setLocationUrl(url);
    stubChrome(settings);
    const htmlSetAttribute = vi.spyOn(document.documentElement, "setAttribute");
    const bodySetAttribute = vi.spyOn(document.body, "setAttribute");

    await import("../../extension/entry/content.js");
    await flushMicrotasks();

    expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBeNull();
    expect(document.body.getAttribute("data-biliscript-reader-mode")).toBeNull();
    expect(htmlSetAttribute).not.toHaveBeenCalledWith("data-biliscript-reader-mode", "1");
    expect(bodySetAttribute).not.toHaveBeenCalledWith("data-biliscript-reader-mode", "1");

    const links = document.head.querySelectorAll('link[data-biliscript-style="1"]');
    expect(links).toHaveLength(3);
    links.forEach((link) => link.dispatchEvent(new Event("load")));
    await flushMicrotasks();

    expect(htmlSetAttribute).toHaveBeenCalledWith("data-biliscript-reader-mode", "1");
    expect(bodySetAttribute).toHaveBeenCalledWith("data-biliscript-reader-mode", "1");
  }

  it("直达阅读 URL：link.load 前不设置门控属性", async () => {
    await expectGateAfterStyleLoad(READER_MODE_URL);
  });

  it("autoOpenReader：link.load 前不设置门控属性", async () => {
    await expectGateAfterStyleLoad(NORMAL_PAGE_URL, { autoOpenReader: true });
  });
});
