// 非支持页扩展图标可见反馈（工单 04）——toolbar-* 命名（entry 测试 scope 限制）。
//
// 两段验证：
//   1. SW 半边（background.js 动态装载 + superset chrome stub）：支持页零打扰
//      （无徽标/无注入、照常 reader-enter）；www.bilibili.com 非支持页（首页/
//      番剧/缺 url）徽标 + 标题 + 页内提示注入；search./space. 等未获 host 权限
//      页只徽标+标题不注入（权限边界）；注入失败降级（徽标保留 + 失败日志）；
//      导航开始（loading）与支持页成功打开均清反馈。
//   2. 页内提示渲染（renderUnsupportedPageToast 直接进 jsdom）：顶部居中样式、
//      6 秒自动移除、重复点击复用同一节点并重置计时器。
//
// stub 与装载方式同 tests/entry/toolbar-action-script.test.ts。
// 监听器是异步链：waitFor 的立即检查可能在链尾副作用落盘前返回，凡断言「先置
// 条件之后」的副作用，一律先 flushMicrotasks()（一个宏任务 = 排干全部微任务链，
// 链内无定时器）再做断言。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessageToTab } from "../../extension/shared/tab-utils.js";
import {
  renderUnsupportedPageToast,
  UNSUPPORTED_PAGE_ACTION_TITLE,
  UNSUPPORTED_PAGE_TOAST_DURATION_MS,
  UNSUPPORTED_PAGE_TOAST_MESSAGE
} from "../../extension/entry/unsupported-page-feedback.js";

vi.mock("../../extension/shared/tab-utils.js", () => ({
  sendMessageToTab: vi.fn(async () => ({ ok: true })),
  waitForTabComplete: vi.fn(async () => true)
}));

const VIDEO_URL = "https://www.bilibili.com/video/BV1abc000000/";

// 排干监听器微任务链：链内全是即时 resolve 的 mock，一个宏任务足够。
function flushMicrotasks() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ===== SW 半边：非支持页点击 → 徽标/标题/页内提示 =====

describe("SW 半边：非支持页 action 点击的可见反馈", () => {
  let onClickedListener: (tab: chrome.tabs.Tab) => void;
  let updatedListeners: Array<(tabId: number, changeInfo: { status?: string }, tab: unknown) => void>;
  const actionOnClickedAddListener = vi.fn();
  const tabsOnUpdatedAddListener = vi.fn();
  const setBadgeText = vi.fn<(details: { tabId?: number; text: string }) => Promise<void>>(async () => {});
  const setBadgeBackgroundColor = vi.fn<
    (details: { tabId?: number; color: string }) => Promise<void>
  >(async () => {});
  const setTitle = vi.fn<(details: { tabId?: number; title: string }) => Promise<void>>(async () => {});
  const executeScript = vi.fn<
    (injection: { target: { tabId: number }; func: unknown; args?: unknown[] }) => Promise<unknown[]>
  >(async () => []);

  beforeAll(async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        lastError: null,
        getURL: (path: string) => `chrome-extension://test/${path}`,
        sendMessage: vi.fn(),
        getManifest: () => ({ version: "9.9.9" }),
        onInstalled: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() }
      },
      tabs: { onUpdated: { addListener: tabsOnUpdatedAddListener } },
      action: {
        onClicked: { addListener: actionOnClickedAddListener },
        setBadgeText,
        setBadgeBackgroundColor,
        setTitle
      },
      scripting: { executeScript },
      storage: {
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
      }
    });
    await import("../../extension/entry/background.js");
    onClickedListener = actionOnClickedAddListener.mock.calls[0][0] as typeof onClickedListener;
    updatedListeners = tabsOnUpdatedAddListener.mock.calls.map(
      (call) => call[0] as (tabId: number, changeInfo: { status?: string }, tab: unknown) => void
    );
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.mocked(sendMessageToTab).mockClear();
    vi.mocked(sendMessageToTab).mockImplementation(async () => ({ ok: true }));
    setBadgeText.mockClear();
    setBadgeBackgroundColor.mockClear();
    setTitle.mockClear();
    executeScript.mockReset();
    executeScript.mockResolvedValue([]);
  });

  it("受支持视频页：零打扰——无「!」徽标/无引导标题/无注入，照常派发 reader-enter", async () => {
    onClickedListener({ id: 7, url: VIDEO_URL });

    await vi.waitFor(() => expect(sendMessageToTab).toHaveBeenCalledTimes(1));
    await flushMicrotasks();

    // 成功路径只做防御性清理（空串调用）；「!」徽标与引导标题不得出现。
    const badgeCalls = setBadgeText.mock.calls.map((call) => call[0]);
    expect(badgeCalls.every((details) => details.text === "")).toBe(true);
    expect(setBadgeBackgroundColor).not.toHaveBeenCalled();
    const titleCalls = setTitle.mock.calls.map((call) => call[0]);
    expect(titleCalls.every((details) => details.title === "")).toBe(true);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("受支持页成功打开面板后：清掉本标签页的非支持反馈（徽标清空、标题回落默认）", async () => {
    onClickedListener({ id: 7, url: "https://www.bilibili.com/" });
    await vi.waitFor(() => expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: "!" }));

    onClickedListener({ id: 7, url: VIDEO_URL });
    await vi.waitFor(() => expect(sendMessageToTab).toHaveBeenCalledTimes(1));

    await vi.waitFor(() => expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: "" }));
    await vi.waitFor(() => expect(setTitle).toHaveBeenCalledWith({ tabId: 7, title: "" }));
  });

  it("首页（www.bilibili.com 非支持页）：! 徽标 + 标题引导 + 页内提示注入", async () => {
    onClickedListener({ id: 7, url: "https://www.bilibili.com/" });

    await vi.waitFor(() => expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: "!" }));
    await flushMicrotasks();

    expect(setBadgeBackgroundColor).toHaveBeenCalledWith({ tabId: 7, color: expect.any(String) });
    expect(setTitle).toHaveBeenCalledWith({ tabId: 7, title: UNSUPPORTED_PAGE_ACTION_TITLE });
    expect(executeScript).toHaveBeenCalledTimes(1);
    const injection = executeScript.mock.calls[0][0];
    expect(injection.target).toEqual({ tabId: 7 });
    expect(typeof injection.func).toBe("function");
    expect(injection.args).toEqual([UNSUPPORTED_PAGE_TOAST_MESSAGE, UNSUPPORTED_PAGE_TOAST_DURATION_MS]);
  });

  it("番剧页（/bangumi/）：同属 www.bilibili.com 非支持页，同样徽标 + 页内提示", async () => {
    onClickedListener({ id: 8, url: "https://www.bilibili.com/bangumi/play/ep123456" });

    await vi.waitFor(() => expect(setBadgeText).toHaveBeenCalledWith({ tabId: 8, text: "!" }));
    await flushMicrotasks();

    expect(setTitle).toHaveBeenCalledWith({ tabId: 8, title: UNSUPPORTED_PAGE_ACTION_TITLE });
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript.mock.calls[0][0].target).toEqual({ tabId: 8 });
  });

  it("权限边界：search./space. 子域、裸域与站外页只徽标+标题，绝不尝试注入", async () => {
    onClickedListener({ id: 7, url: "https://search.bilibili.com/all?keyword=x" });
    onClickedListener({ id: 8, url: "https://space.bilibili.com/123" });
    onClickedListener({ id: 9, url: "https://bilibili.com/" });
    onClickedListener({ id: 10, url: "https://example.com/" });

    await vi.waitFor(() => expect(setBadgeText).toHaveBeenCalledTimes(4));
    await flushMicrotasks();

    for (const tabId of [7, 8, 9, 10]) {
      expect(setBadgeText).toHaveBeenCalledWith({ tabId, text: "!" });
      expect(setTitle).toHaveBeenCalledWith({ tabId, title: UNSUPPORTED_PAGE_ACTION_TITLE });
    }
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("缺 tab.url 的非支持页：仍给徽标+标题（所有不支持页都有反馈），不注入", async () => {
    onClickedListener({ id: 7 });

    await vi.waitFor(() => expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: "!" }));
    await flushMicrotasks();

    expect(setTitle).toHaveBeenCalledWith({ tabId: 7, title: UNSUPPORTED_PAGE_ACTION_TITLE });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("注入失败降级：徽标+标题已先落保留，失败被记录不静默、不进 unhandled rejection", async () => {
    executeScript.mockRejectedValue(new Error("Cannot inject"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    onClickedListener({ id: 7, url: "https://www.bilibili.com/" });

    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());
    await flushMicrotasks();

    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: "!" });
    expect(setTitle).toHaveBeenCalledWith({ tabId: 7, title: UNSUPPORTED_PAGE_ACTION_TITLE });
    const logged = warnSpy.mock.calls.some((call) =>
      String(call[0]).includes("unsupported-page toast injection failed")
    );
    expect(logged).toBe(true);
    warnSpy.mockRestore();
  });

  it("标签页开始导航（loading）：清徽标并恢复默认标题，不跨导航残留", async () => {
    for (const listener of updatedListeners) {
      listener(7, { status: "loading" }, {});
    }
    await flushMicrotasks();

    expect(setBadgeText).toHaveBeenCalledWith({ tabId: 7, text: "" });
    expect(setTitle).toHaveBeenCalledWith({ tabId: 7, title: "" });
  });
});

// ===== 页内提示渲染：顶部居中 / 6 秒消失 / 重复点击复用 =====

describe("页内提示渲染（renderUnsupportedPageToast）", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    delete (globalThis as unknown as Record<string, unknown>).__BILISCRIPT_UNSUPPORTED_PAGE_TOAST__;
  });

  it("顶部居中渲染，约 6 秒后自动移除", () => {
    vi.useFakeTimers();
    try {
      renderUnsupportedPageToast(UNSUPPORTED_PAGE_TOAST_MESSAGE, UNSUPPORTED_PAGE_TOAST_DURATION_MS);

      const toast = document.getElementById("biliscript-unsupported-toast");
      expect(toast).not.toBeNull();
      expect(toast!.textContent).toBe(UNSUPPORTED_PAGE_TOAST_MESSAGE);
      expect(toast!.getAttribute("role")).toBe("status");
      const style = toast!.style;
      expect(style.position).toBe("fixed");
      expect(style.top).toBe("16px");
      expect(style.left).toBe("50%");
      expect(style.transform).toContain("translateX(-50%)");
      expect(document.querySelectorAll("#biliscript-unsupported-toast")).toHaveLength(1);

      vi.advanceTimersByTime(UNSUPPORTED_PAGE_TOAST_DURATION_MS);
      expect(document.getElementById("biliscript-unsupported-toast")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("重复点击复用同一节点并重置计时器（重新计满时长，不叠节点）", () => {
    vi.useFakeTimers();
    try {
      renderUnsupportedPageToast(UNSUPPORTED_PAGE_TOAST_MESSAGE, UNSUPPORTED_PAGE_TOAST_DURATION_MS);
      vi.advanceTimersByTime(3000);

      renderUnsupportedPageToast(UNSUPPORTED_PAGE_TOAST_MESSAGE, UNSUPPORTED_PAGE_TOAST_DURATION_MS);
      expect(document.querySelectorAll("#biliscript-unsupported-toast")).toHaveLength(1);

      vi.advanceTimersByTime(UNSUPPORTED_PAGE_TOAST_DURATION_MS - 1);
      expect(document.getElementById("biliscript-unsupported-toast")).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(document.getElementById("biliscript-unsupported-toast")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
