// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl, setupEnvironment } from "../setup.js";
import { sendMessageToTab } from "../../extension/shared/tab-utils.js";
import { buildReaderModeUrl } from "../../extension/bilibili/video-id-shared.js";
import { registerDebugGate } from "../../extension/shared/logging.js";

vi.mock("../../extension/shared/tab-utils.js", () => ({
  sendMessageToTab: vi.fn(async () => ({ ok: true })),
  waitForTabComplete: vi.fn(async () => true)
}));

const VIDEO_URL = "https://www.bilibili.com/video/BV1abc000000/?p=2&spm_id_from=x";
const VIDEO_READER_URL = "https://www.bilibili.com/video/BV1abc000000/?p=2&biliscript_reader=1";

describe("SW 半边：action onClicked → 同一 reader-enter 事务", () => {
  let onClickedListener: (tab: chrome.tabs.Tab) => void;
  let onUpdatedReinjectListener: (
    tabId: number,
    changeInfo: { status?: string },
    tab: chrome.tabs.Tab
  ) => Promise<void>;
  const actionOnClickedAddListener = vi.fn();
  const tabsOnUpdatedAddListener = vi.fn();

  beforeAll(async () => {
    setupEnvironment();
    vi.stubGlobal("chrome", {
      ...globalThis.chrome,
      runtime: {
        ...globalThis.chrome.runtime,
        lastError: null,
        getURL: (path: string) => `chrome-extension://test/${path}`,
        sendMessage: vi.fn(),
        getManifest: () => ({ version: "9.9.9" }),
        onInstalled: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() }
      },
      tabs: { ...globalThis.chrome.tabs, onUpdated: { addListener: tabsOnUpdatedAddListener } },
      action: {
        ...globalThis.chrome.action,
        onClicked: { addListener: actionOnClickedAddListener },
        setBadgeText: vi.fn(async () => {}),
        setBadgeBackgroundColor: vi.fn(async () => {}),
        setTitle: vi.fn(async () => {})
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
    onClickedListener = actionOnClickedAddListener.mock.calls[0][0] as typeof onClickedListener;
    onUpdatedReinjectListener = tabsOnUpdatedAddListener.mock.calls[0][0] as typeof onUpdatedReinjectListener;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.mocked(sendMessageToTab).mockClear();
    vi.mocked(sendMessageToTab).mockImplementation(async () => ({ ok: true }));
  });

  it("受支持视频页：单条 reader-enter 直达事件标签页，readerUrl 与页内按钮同源拼法，载荷无 tabId", async () => {
    onClickedListener({ id: 7, url: VIDEO_URL });

    await vi.waitFor(() => expect(sendMessageToTab).toHaveBeenCalledTimes(1));

    expect(sendMessageToTab).toHaveBeenCalledWith(7, {
      type: "reader-enter",
      readerUrl: VIDEO_READER_URL
    });
    const payload = vi.mocked(sendMessageToTab).mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("tabId");
  });

  it("稍后再看页：同样派发，readerUrl 保留 /list/watchlater 与上下文参数并剥离追踪参数", async () => {
    onClickedListener({
      id: 8,
      url: "https://www.bilibili.com/list/watchlater/?bvid=BV1wl000001&oid=123&p=2&spm_id_from=333.1007"
    });

    await vi.waitFor(() => expect(sendMessageToTab).toHaveBeenCalledTimes(1));

    expect(sendMessageToTab).toHaveBeenCalledWith(8, {
      type: "reader-enter",
      readerUrl: "https://www.bilibili.com/list/watchlater?bvid=BV1wl000001&oid=123&p=2&biliscript_reader=1"
    });
  });

  it("收藏夹播单页 /list/ml...：派发 reader-enter，readerUrl 保留路径与 oid/bvid 并剥离追踪参数", async () => {
    onClickedListener({
      id: 10,
      url: "https://www.bilibili.com/list/ml4110522184?spm_id_from=333.1387.0.0&oid=117323927129038&bvid=BV1RWaw6jEay"
    });

    await vi.waitFor(() => expect(sendMessageToTab).toHaveBeenCalledTimes(1));

    expect(sendMessageToTab).toHaveBeenCalledWith(10, {
      type: "reader-enter",
      readerUrl: "https://www.bilibili.com/list/ml4110522184?oid=117323927129038&bvid=BV1RWaw6jEay&biliscript_reader=1"
    });
  });

  it("活动专题页（带 bvid）：派发 reader-enter，readerUrl 保留 /festival/<slug> 与 bvid/p 并剥离追踪参数", async () => {
    onClickedListener({
      id: 9,
      url: "https://www.bilibili.com/festival/27kaoyanshangan?bvid=BV1pNyWzAE2f&p=1&spm_id_from=333.40164.0.0"
    });

    await vi.waitFor(() => expect(sendMessageToTab).toHaveBeenCalledTimes(1));

    expect(sendMessageToTab).toHaveBeenCalledWith(9, {
      type: "reader-enter",
      readerUrl: "https://www.bilibili.com/festival/27kaoyanshangan?bvid=BV1pNyWzAE2f&p=1&biliscript_reader=1"
    });
  });

  it("非 B 站页 / 非视频路径 / 无 bvid 活动页 / 缺 tab.url / 缺 tab.id：零派发", async () => {
    onClickedListener({ id: 7, url: "https://example.com/video/BV1abc000000/" });
    onClickedListener({ id: 7, url: "https://www.bilibili.com/" });
    onClickedListener({ id: 7, url: "https://www.bilibili.com/festival/27kaoyanshangan" });
    onClickedListener({ id: 7 });
    onClickedListener({ url: VIDEO_URL });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendMessageToTab).not.toHaveBeenCalled();
  });

  it("重复点击与活动标签页切换：各次点击只投递到当次事件标签页", async () => {
    onClickedListener({ id: 7, url: VIDEO_URL });
    await vi.waitFor(() => expect(sendMessageToTab).toHaveBeenCalledTimes(1));

    onClickedListener({ id: 9, url: "https://www.bilibili.com/video/BV1def000000/" });
    await vi.waitFor(() => expect(sendMessageToTab).toHaveBeenCalledTimes(2));

    const targets = vi.mocked(sendMessageToTab).mock.calls.map((call) => call[0]);
    expect(targets).toEqual([7, 9]);
  });

  it("重试不换目标：触发失败时 12 次重试全部指向事件标签页", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(sendMessageToTab).mockImplementation(async () => ({ ok: false }));
      onClickedListener({ id: 7, url: VIDEO_URL });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(sendMessageToTab).toHaveBeenCalledTimes(12);
      expect(vi.mocked(sendMessageToTab).mock.calls.every((call) => call[0] === 7)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("内容脚本注入恢复失败：重试耗尽后在扩展图标上留下可见失败反馈", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(sendMessageToTab).mockRejectedValue(new Error("Could not establish connection. Receiving end does not exist."));
      vi.mocked(chrome.scripting.executeScript).mockRejectedValue(new Error("Cannot inject"));

      onClickedListener({ id: 7, url: VIDEO_URL });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: "!" });
      expect(chrome.action.setTitle).toHaveBeenCalledWith({
        tabId: 7,
        title: "BiliScript｜文摘面板打开失败，请刷新浏览器网页重试"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("tabs.onUpdated 推测性重注入：已关闭标签页/缺失 frame 静默忽略，非预期注入失败记 logWarn 且不阻断", async () => {
    registerDebugGate(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.mocked(chrome.scripting.executeScript).mockRejectedValueOnce(new Error("No tab with id: 7."));
      await expect(
        onUpdatedReinjectListener(7, { status: "complete" }, { id: 7, url: VIDEO_URL })
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();

      vi.mocked(chrome.scripting.executeScript).mockRejectedValueOnce(new Error("Frame with ID 0 was removed."));
      await expect(
        onUpdatedReinjectListener(7, { status: "complete" }, { id: 7, url: VIDEO_URL })
      ).resolves.toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();

      const unexpectedError = new Error('Cannot access contents of url "https://www.bilibili.com/video/BV1abc000000/"');
      vi.mocked(chrome.scripting.executeScript).mockRejectedValueOnce(unexpectedError);
      await expect(
        onUpdatedReinjectListener(7, { status: "complete" }, { id: 7, url: VIDEO_URL })
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        "[BILISCRIPT] speculative reader content reinjection failed",
        unexpectedError
      );
    } finally {
      warnSpy.mockRestore();
      registerDebugGate(() => false);
      vi.mocked(chrome.scripting.executeScript).mockImplementation(async () => []);
    }
  });
});

const shellMocks = vi.hoisted(() => ({
  enterReaderShell: vi.fn(
    async (_options: { readerUrl: string; intent: string; prompt?: string }) => {}
  )
}));

vi.mock("../../extension/reader/lazy-shell.js", () => ({
  ensureReaderShell: vi.fn(async () => ({
    enterReaderShell: shellMocks.enterReaderShell,
    enterReaderShellOnUrlNavigation: vi.fn(async () => {}),
    exitReaderShell: vi.fn(async () => {})
  }))
}));
vi.mock("../../extension/reader/lazy-reader.js", () => ({
  ensureReaderDomain: vi.fn()
}));
vi.mock("../../extension/ui/lazy-ui.js", () => ({
  ensureUiReady: vi.fn(async () => {})
}));
vi.mock("../../extension/ai/lazy-player-ai.js", () => ({
  loadPlayerAi: vi.fn(),
  isPlayerAiLoaded: vi.fn(() => false)
}));

function makeToolbarHtml() {
  return `
    <div id="arc_toolbar_report">
      <div class="video-toolbar-right">
        <div class="video-complaint"><span>稿件举报</span></div>
      </div>
    </div>`;
}

describe("工具栏载荷与页内 文摘按钮的进入事务等价", () => {
  beforeEach(() => {
    resetModuleState();
    setLocationUrl(NORMAL_PAGE_URL);
    document.body.innerHTML = "";
    shellMocks.enterReaderShell.mockClear();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("工具栏载荷经 content 分发进入同一 reader-enter 事务（open 意图，无 chat）", async () => {
    const { dispatchContentScriptMessage } = await import("../../extension/entry/message-handler.js");
    const sendResponse = vi.fn();

    const keepOpen = dispatchContentScriptMessage(
      { type: "reader-enter", readerUrl: buildReaderModeUrl(NORMAL_PAGE_URL) },
      sendResponse
    );

    expect(keepOpen).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    expect(shellMocks.enterReaderShell).toHaveBeenCalledTimes(1);
    expect(shellMocks.enterReaderShell).toHaveBeenCalledWith({
      readerUrl: buildReaderModeUrl(NORMAL_PAGE_URL),
      intent: "open"
    });
  });

  it("页内按钮点击与工具栏路径产生相同的事务参数（同 readerUrl / 同 open 意图）", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;

    const handler = await import("../../extension/entry/message-handler.js");
    handler.bindRuntimeEvents();
    const lazy = await import("../../extension/ui/lazy-script-button.js");
    await lazy.loadScriptButton();

    const button = document.getElementById("biliscript-script-button");
    expect(button).not.toBeNull();
    button!.click();

    await vi.waitFor(() => expect(shellMocks.enterReaderShell).toHaveBeenCalledTimes(1));

    const options = shellMocks.enterReaderShell.mock.calls[0][0];

    expect(options.readerUrl).toBe(buildReaderModeUrl(NORMAL_PAGE_URL));
    expect(options.intent).toBe("open");
    expect(options.prompt).toBeUndefined();
  });

  it("enterReaderMode 失败：页内按钮自身显示失败，不只写隐藏阅读状态行", async () => {
    document.body.innerHTML = `${makeToolbarHtml()}<video src="blob:test"></video>`;
    shellMocks.enterReaderShell.mockRejectedValueOnce(new Error("enter failed"));
    const handler = await import("../../extension/entry/message-handler.js");
    handler.bindRuntimeEvents();
    const lazy = await import("../../extension/ui/lazy-script-button.js");
    await lazy.loadScriptButton();
    const button = document.getElementById("biliscript-script-button") as HTMLButtonElement;

    button.click();

    await vi.waitFor(() => expect(button.textContent).toBe("文摘打开失败"));
    expect(button.title).toBe("文摘面板打开失败：enter failed");
    expect(document.getElementById("biliscript-reading-status")).toBeNull();
  });
});
