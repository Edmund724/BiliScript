import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState, setupEnvironment } from "../setup.js";
import { sendMessageToTab } from "../../extension/shared/tab-utils.js";

vi.mock("../../extension/shared/tab-utils.js", () => ({
  sendMessageToTab: vi.fn(async () => ({ ok: true })),
  waitForTabComplete: vi.fn(async () => true)
}));

const shellMocks = vi.hoisted(() => ({
  enterReaderShell: vi.fn(async () => {}),
  exitReaderShell: vi.fn(async () => {})
}));

vi.mock("../../extension/reader/lazy-shell.js", () => ({
  ensureReaderShell: vi.fn(async () => shellMocks)
}));

const VIDEO_URL = "https://www.bilibili.com/video/BV1cmd000001/?p=1&spm_id_from=333.1";
const VIDEO_READER_URL = "https://www.bilibili.com/video/BV1cmd000001/?p=1&biliscript_reader=1";

describe("manifest commands 声明", () => {
  it("extension/manifest.json 注册 toggle-reader 且默认建议 Alt+B", () => {
    const manifestPath = resolve(process.cwd(), "extension", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.commands?.["toggle-reader"]).toBeDefined();
    expect(manifest.commands["toggle-reader"].suggested_key?.default).toBe("Alt+B");
    expect(manifest.commands["toggle-reader"].description).toBeTruthy();
  });
});

describe("SW 端 chrome.commands.onCommand → reader-toggle", () => {
  let onCommandListener: (command: string, tab?: chrome.tabs.Tab) => void;
  const onCommandAddListener = vi.fn();
  const tabsQuery = vi.fn(async () => [{ id: 12, url: VIDEO_URL }]);
  const setBadgeText = vi.fn(async () => {});
  const setTitle = vi.fn(async () => {});

  beforeAll(async () => {
    setupEnvironment();
    vi.stubGlobal("chrome", {
      ...globalThis.chrome,
      runtime: {
        ...globalThis.chrome.runtime,
        lastError: null,
        getURL: (p: string) => `chrome-extension://test/${p}`,
        sendMessage: vi.fn(),
        getManifest: () => ({ version: "9.9.9" }),
        onInstalled: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() }
      },
      tabs: {
        ...globalThis.chrome.tabs,
        onUpdated: { addListener: vi.fn() },
        query: tabsQuery
      },
      action: {
        ...globalThis.chrome.action,
        onClicked: { addListener: vi.fn() },
        setBadgeText,
        setBadgeBackgroundColor: vi.fn(async () => {}),
        setTitle
      },
      commands: {
        ...globalThis.chrome.commands,
        onCommand: { addListener: onCommandAddListener }
      },
      scripting: { executeScript: vi.fn(async () => []) },
      storage: {
        ...globalThis.chrome.storage,
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
      }
    });
    await import("../../extension/entry/background.js");
    onCommandListener = onCommandAddListener.mock.calls[0]?.[0] as typeof onCommandListener;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.mocked(sendMessageToTab).mockClear();
    vi.mocked(sendMessageToTab).mockImplementation(async () => ({ ok: true }));
    tabsQuery.mockClear();
    setBadgeText.mockClear();
    setTitle.mockClear();
  });

  it("按下 toggle-reader 且当前页为 B 站视频页时向该标签页派发 reader-toggle", async () => {
    onCommandListener("toggle-reader", { id: 12, url: VIDEO_URL });

    await vi.waitFor(() => expect(sendMessageToTab).toHaveBeenCalledTimes(1));
    expect(sendMessageToTab).toHaveBeenCalledWith(12, {
      type: "reader-toggle",
      readerUrl: VIDEO_READER_URL
    });
  });

  it("按下 toggle-reader 且当前页为 YouTube watch 页时向该标签页派发 reader-toggle", async () => {
    onCommandListener("toggle-reader", {
      id: 13,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s"
    });

    await vi.waitFor(() => expect(sendMessageToTab).toHaveBeenCalledTimes(1));
    expect(sendMessageToTab).toHaveBeenCalledWith(13, {
      type: "reader-toggle",
      readerUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&biliscript_reader=1"
    });
  });

  it("回调未传 tab 时回退查询 currentWindow 活动标签页", async () => {
    onCommandListener("toggle-reader");

    await vi.waitFor(() => expect(sendMessageToTab).toHaveBeenCalledTimes(1));
    expect(tabsQuery).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(sendMessageToTab).toHaveBeenCalledWith(12, {
      type: "reader-toggle",
      readerUrl: VIDEO_READER_URL
    });
  });

  it("非支持页不派发 reader-toggle，非目标 command 直接忽略", async () => {
    onCommandListener("other-command", { id: 12, url: VIDEO_URL });
    onCommandListener("toggle-reader", { id: 15, url: "https://example.com/page" });

    await new Promise((r) => setTimeout(r, 0));
    expect(sendMessageToTab).not.toHaveBeenCalled();
    expect(setBadgeText).toHaveBeenCalled();
  });
});

describe("content 端 reader-toggle 处理器：开/关双向切换", () => {
  beforeEach(() => {
    resetModuleState();
    shellMocks.enterReaderShell.mockClear();
    shellMocks.exitReaderShell.mockClear();
  });

  it("侧边栏未展开时调用 enterReaderShell，已展开时调用 exitReaderShell", async () => {
    const { transitionReaderShell } = await import("../../extension/core/state.js");
    const { dispatchContentScriptMessage } = await import("../../extension/entry/message-handler.js");

    transitionReaderShell("closed");
    const openResp = await new Promise<Record<string, unknown>>((resolve) => {
      dispatchContentScriptMessage(
        { type: "reader-toggle", readerUrl: VIDEO_READER_URL },
        (resp) => resolve(resp as Record<string, unknown>)
      );
    });
    expect(openResp).toEqual({ ok: true, open: true });
    expect(shellMocks.enterReaderShell).toHaveBeenCalledWith({
      readerUrl: VIDEO_READER_URL,
      intent: "open"
    });

    transitionReaderShell("open");
    const closeResp = await new Promise<Record<string, unknown>>((resolve) => {
      dispatchContentScriptMessage(
        { type: "reader-toggle", readerUrl: VIDEO_READER_URL },
        (resp) => resolve(resp as Record<string, unknown>)
      );
    });
    expect(closeResp).toEqual({ ok: true, open: false });
    expect(shellMocks.exitReaderShell).toHaveBeenCalledTimes(1);
  });
});
