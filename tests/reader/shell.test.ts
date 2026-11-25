import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NORMAL_PAGE_URL,
  READER_MODE_URL,
  setLocationUrl
} from "../setup.js";

const mocks = vi.hoisted(() => ({
  ensureUiReady: vi.fn(),
  loadPlayerAi: vi.fn(),
  isPlayerAiLoaded: vi.fn(),
  ensureReaderDomain: vi.fn(),
  ensureReaderChatTab: vi.fn(),
  replaceReaderModeUrl: vi.fn(),
  requestUiCommand: vi.fn()
}));

vi.mock("../../extension/ui/lazy-ui.js", () => ({
  ensureUiReady: mocks.ensureUiReady
}));
vi.mock("../../extension/ai/lazy-player-ai.js", () => ({
  loadPlayerAi: mocks.loadPlayerAi,
  isPlayerAiLoaded: mocks.isPlayerAiLoaded
}));
vi.mock("../../extension/reader/lazy-reader.js", () => ({
  ensureReaderDomain: mocks.ensureReaderDomain
}));
vi.mock("../../extension/reader/lazy-chat-tab.js", () => ({
  ensureReaderChatTab: mocks.ensureReaderChatTab,
  isReaderChatTabLoaded: vi.fn(() => false)
}));
vi.mock("../../extension/reader/reader-bus.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../extension/reader/reader-bus.js")>(),
  requestUiCommand: mocks.requestUiCommand
}));
vi.mock("../../extension/bilibili/reader-url.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/reader-url.js")>();
  return {
    ...actual,
    replaceReaderModeUrl: mocks.replaceReaderModeUrl
  };
});

import {
  enterReaderShell,
  enterReaderShellOnUrlNavigation,
  exitReaderShell,
  isReaderShellIntact
} from "../../extension/reader/shell.js";
import { READER_READY_ATTR } from "../../extension/reader/presentation-fields.js";
import { contentEventBus } from "../../extension/shared/content-event-bus.js";
import { state, transitionReaderShell } from "../../extension/core/state.js";
import { playerAiState } from "../../extension/ai/player-ai-state.js";
import { ensureReaderStyles, removeReaderStyles } from "../../extension/shared/style-injector.js";

const {
  ensureUiReady,
  loadPlayerAi,
  isPlayerAiLoaded,
  ensureReaderDomain,
  ensureReaderChatTab,
  replaceReaderModeUrl
} = mocks;

function makeReaderStub() {
  return {
    enterReaderMode: vi.fn(async () => {}),
    focusReadingView: vi.fn(),
    beginClosingReadingView: vi.fn(() => false),
    closeReadingView: vi.fn(() => {
      transitionReaderShell("closed");
      state.reader.setViewReady(false);
    }),
    restoreReadingViewFocus: vi.fn()
  };
}

function makeChatStub() {
  return {
    ensureChatTabActivated: vi.fn(async () => {}),
    runQuickActionPrompt: vi.fn(async () => true)
  };
}

interface ShellMountOptions {
  present?: boolean;
  open?: boolean;
  hidden?: boolean;
  ready?: string;
  bodyAttr?: boolean;
  htmlAttr?: boolean;
}

function mountShell({
  present = true,
  open = true,
  hidden = false,
  ready = "1",
  bodyAttr = true,
  htmlAttr = true
}: ShellMountOptions = {}): void {
  if (present) {
    const shell = document.createElement("section");
    shell.id = "biliscript-reading-view";
    shell.hidden = hidden;
    if (open) {
      shell.classList.add("open");
    }
    shell.setAttribute(READER_READY_ATTR, ready);
    document.body.appendChild(shell);
  }
  if (bodyAttr) {
    document.body.setAttribute("data-biliscript-reader-mode", "1");
  }
  if (htmlAttr) {
    document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
  }
}

const READER_STYLE_PATHS = [
  "entry/styles/tokens-primitive.css",
  "entry/styles/reader.css",
  "entry/styles/reader-gate.css"
];

const mountedMainStyles = new Set<string>();
let pendingStyleInsertResolvers: Array<() => void> = [];
let holdStyleInsert = false;

function installStyleIpcMock(): void {
  mountedMainStyles.clear();
  pendingStyleInsertResolvers = [];
  holdStyleInsert = false;
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(
    (raw: unknown, callback?: (resp?: unknown) => void) => {
      const msg = raw as { type?: string; files?: string[] };
      if (msg?.type === "content-style-insert" && Array.isArray(msg.files)) {
        const files = [...msg.files];
        const done = () => {
          files.forEach((f) => mountedMainStyles.add(f));
          callback?.({ ok: true });
        };
        if (holdStyleInsert) {
          pendingStyleInsertResolvers.push(done);
        } else {
          done();
        }
        return undefined;
      }
      if (msg?.type === "content-style-remove" && Array.isArray(msg.files)) {
        msg.files.forEach((f) => mountedMainStyles.delete(f));
        callback?.({ ok: true });
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    }
  );
}

function expectReaderStylesMounted(mounted: boolean): void {
  expect(document.head.querySelectorAll('link[data-biliscript-style="1"]')).toHaveLength(0);
  for (const path of READER_STYLE_PATHS) {
    expect(mountedMainStyles.has(path), `${path} ${mounted ? "未注入" : "未移除"}`).toBe(mounted);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  installStyleIpcMock();
  setLocationUrl(NORMAL_PAGE_URL);
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-biliscript-reader-mode");
  document.body.removeAttribute("data-biliscript-reader-mode");
  removeReaderStyles();
  playerAiState.setSuppressedUntil(0);
  transitionReaderShell("closed");
  state.reader.setViewReady(false);
  isPlayerAiLoaded.mockReturnValue(false);
  ensureReaderDomain.mockResolvedValue(makeReaderStub());
  ensureReaderChatTab.mockResolvedValue(makeChatStub());
});

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-biliscript-reader-mode");
  document.body.removeAttribute("data-biliscript-reader-mode");
  removeReaderStyles();
});

describe("enterReaderShell：open 档（按钮/编排触发的进入事务）", () => {
  it("完整时序：抑制 → 摘快捷按钮 → 改写 URL → 挂阅读表 → 翻门控属性 → enterReaderMode", async () => {
    isPlayerAiLoaded.mockReturnValue(true);
    const removeButton = vi.fn();
    loadPlayerAi.mockResolvedValue({ removePlayerAiQuickActionButton: removeButton });
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);

    await enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });

    expect(playerAiState.playerAiQuickActionSuppressedUntil).toBeGreaterThan(Date.now());
    expect(removeButton).toHaveBeenCalledTimes(1);
    expect(ensureUiReady).toHaveBeenCalledTimes(1);
    expect(replaceReaderModeUrl).toHaveBeenCalledWith(READER_MODE_URL);
    expectReaderStylesMounted(true);
    expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBe("1");
    expect(document.body.getAttribute("data-biliscript-reader-mode")).toBe("1");
    expect(reader.enterReaderMode).toHaveBeenCalledTimes(1);
    const uiOrder = ensureUiReady.mock.invocationCallOrder[0];
    const replaceOrder = replaceReaderModeUrl.mock.invocationCallOrder[0];
    const enterOrder = reader.enterReaderMode.mock.invocationCallOrder[0];
    expect(uiOrder).toBeLessThan(replaceOrder);
    expect(replaceOrder).toBeLessThan(enterOrder);
  });

  it("伴看设置意图在进入后携带定位目标打开设置", async () => {
    await enterReaderShell({
      readerUrl: READER_MODE_URL,
      intent: "open",
      settingsTarget: "gemini-key"
    });

    expect(mocks.requestUiCommand).toHaveBeenCalledWith("open-settings", { target: "gemini-key" });
  });

  it("阅读样式表全部加载完成后才进入 reader 域", async () => {
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);
    holdStyleInsert = true;

    const entry = enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await vi.waitFor(() => expect(pendingStyleInsertResolvers).toHaveLength(1));
    expect(reader.enterReaderMode).not.toHaveBeenCalled();

    pendingStyleInsertResolvers.shift()?.();
    await entry;
    expectReaderStylesMounted(true);
    expect(reader.enterReaderMode).toHaveBeenCalledTimes(1);
  });

  it("空 readerUrl 且视图未开 → 兜底构造阅读 URL（与 script-button 拼法一致）", async () => {
    setLocationUrl("https://www.bilibili.com/video/BV1test000000/?p=2&spm_id_from=x");

    await enterReaderShell({ readerUrl: "", intent: "open" });

    expect(replaceReaderModeUrl).toHaveBeenCalledWith(
      "https://www.bilibili.com/video/BV1test000000/?p=2&biliscript_reader=1"
    );
  });

  it("稍后再看页空 readerUrl → 保留 /list/watchlater 与 oid/p 参数并剥离追踪参数", async () => {
    setLocationUrl(
      "https://www.bilibili.com/list/watchlater/?bvid=BV1test000000&oid=170001&p=2&spm_id_from=x"
    );

    await enterReaderShell({ readerUrl: "", intent: "open" });

    expect(replaceReaderModeUrl).toHaveBeenCalledWith(
      "https://www.bilibili.com/list/watchlater?bvid=BV1test000000&oid=170001&p=2&biliscript_reader=1"
    );
  });

  it("空 readerUrl 且视图已开 → 纯聚焦语义：不改写、不翻属性、不重进", async () => {
    transitionReaderShell("open");
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);

    await enterReaderShell({ readerUrl: "", intent: "open" });

    expect(replaceReaderModeUrl).not.toHaveBeenCalled();
    expectReaderStylesMounted(false);
    expect(reader.enterReaderMode).not.toHaveBeenCalled();
    expect(reader.focusReadingView).toHaveBeenCalledTimes(1);
  });

  it("enterReaderMode 失败 → 向上拒绝，让实际触发入口收到失败", async () => {
    const reader = makeReaderStub();
    reader.enterReaderMode.mockRejectedValue(new Error("boom"));
    ensureReaderDomain.mockResolvedValue(reader);

    await expect(enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" })).rejects.toThrow("boom");
  });
});

describe("enterReaderShell：restore 档（失同步自愈，壳级接口测试）", () => {
  it.each([
    ["壳节点被整树摘走", { present: false }],
    ["hidden 未解除", { hidden: true }],
    [".open 掉了", { open: false }],
    ["ready 门控卡 0", { ready: "0" }],
    ["body 门控属性被清", { bodyAttr: false }],
    ["html 门控属性被清", { htmlAttr: false }]
  ])("状态开着而壳失整（%s）→ 先 closeReadingView 收敛再重进", async (_name, broken) => {
    transitionReaderShell("open");
    mountShell(broken as ShellMountOptions);
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);

    await enterReaderShell({ readerUrl: READER_MODE_URL, intent: "restore" });

    expect(reader.closeReadingView).toHaveBeenCalledTimes(1);
    expect(reader.enterReaderMode).toHaveBeenCalledTimes(1);
    expect(reader.closeReadingView.mock.invocationCallOrder[0]).toBeLessThan(
      reader.enterReaderMode.mock.invocationCallOrder[0]
    );
    expect(replaceReaderModeUrl).toHaveBeenCalledWith(READER_MODE_URL);
  });

  it("状态开着而壳完好 → 不收敛，只按 URL 翻属性，不重进", async () => {
    transitionReaderShell("open");
    mountShell();
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);

    await enterReaderShell({ readerUrl: READER_MODE_URL, intent: "restore" });

    expect(reader.closeReadingView).not.toHaveBeenCalled();
    expect(reader.enterReaderMode).not.toHaveBeenCalled();
    expect(replaceReaderModeUrl).toHaveBeenCalledWith(READER_MODE_URL);
    expect(document.body.getAttribute("data-biliscript-reader-mode")).toBe("1");
  });

  it("视图没开（URL 带阅读标记而进入链半途失败）→ 直接走进入链，无收敛步", async () => {
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);

    await enterReaderShell({ readerUrl: READER_MODE_URL, intent: "restore" });

    expect(reader.closeReadingView).not.toHaveBeenCalled();
    expect(reader.enterReaderMode).toHaveBeenCalledTimes(1);
  });

  it("收敛失败（reader 域装载被拒）→ 不阻断进入链（翻属性照走）；视图状态位未收敛故不重进", async () => {
    transitionReaderShell("open");
    mountShell({ open: false });
    const reader = makeReaderStub();
    ensureReaderDomain
      .mockRejectedValueOnce(new Error("load fail"))
      .mockResolvedValueOnce(reader);

    await expect(enterReaderShell({ readerUrl: READER_MODE_URL, intent: "restore" })).resolves.toBeUndefined();
    expect(replaceReaderModeUrl).toHaveBeenCalledWith(READER_MODE_URL);
    expect(reader.enterReaderMode).not.toHaveBeenCalled();
  });

  it("restore 档不摘播放器快捷按钮（失同步自愈与用户点击无关），但抑制窗口照设", async () => {
    isPlayerAiLoaded.mockReturnValue(true);
    loadPlayerAi.mockResolvedValue({ removePlayerAiQuickActionButton: vi.fn() });

    await enterReaderShell({ readerUrl: READER_MODE_URL, intent: "restore" });

    expect(loadPlayerAi).not.toHaveBeenCalled();
    expect(playerAiState.playerAiQuickActionSuppressedUntil).toBeGreaterThan(Date.now());
  });
});

describe("enterReaderShell：chat 档（进对话）", () => {
  it("视图未开 → 先 enterReaderMode，再激活对话 tab 并自动发送 prompt", async () => {
    const reader = makeReaderStub();
    const chat = makeChatStub();
    ensureReaderDomain.mockResolvedValue(reader);
    ensureReaderChatTab.mockResolvedValue(chat);

    await enterReaderShell({ readerUrl: READER_MODE_URL, intent: "chat", prompt: "总结" });

    expect(reader.enterReaderMode).toHaveBeenCalledTimes(1);
    expect(chat.runQuickActionPrompt).toHaveBeenCalledWith("总结");
    expect(chat.ensureChatTabActivated).not.toHaveBeenCalled();
  });

  it("视图已开且无 prompt → 只定位对话 tab（consumeIntent:false），不重进", async () => {
    transitionReaderShell("open");
    mountShell();
    const reader = makeReaderStub();
    const chat = makeChatStub();
    ensureReaderDomain.mockResolvedValue(reader);
    ensureReaderChatTab.mockResolvedValue(chat);

    await enterReaderShell({ readerUrl: "", intent: "chat" });

    expect(reader.enterReaderMode).not.toHaveBeenCalled();
    expect(replaceReaderModeUrl).not.toHaveBeenCalled();
    expect(chat.ensureChatTabActivated).toHaveBeenCalledWith({ consumeIntent: false });
    expect(chat.runQuickActionPrompt).not.toHaveBeenCalled();
  });
});

describe("enterReaderShellOnUrlNavigation：URL 跳转编排入口", () => {
  it("同一进入链：挂表 + 翻属性 + enterReaderMode", async () => {
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);

    await enterReaderShellOnUrlNavigation({ readerUrl: READER_MODE_URL });

    expect(replaceReaderModeUrl).toHaveBeenCalledWith(READER_MODE_URL);
    expectReaderStylesMounted(true);
    expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBe("1");
    expect(reader.enterReaderMode).toHaveBeenCalledTimes(1);
  });

  it("无 player-ai 前奏：URL 跳转没有用户点击在先，不抑制、不摘按钮", async () => {
    isPlayerAiLoaded.mockReturnValue(true);
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);

    await enterReaderShellOnUrlNavigation({ readerUrl: READER_MODE_URL });

    expect(loadPlayerAi).not.toHaveBeenCalled();
    expect(playerAiState.playerAiQuickActionSuppressedUntil).toBe(0);
    expect(reader.enterReaderMode).toHaveBeenCalledTimes(1);
  });

  it("enterReaderMode 失败 → onEnterFailed 收到错误（编排侧写状态栏口径）", async () => {
    const failure = new Error("start failed");
    const reader = makeReaderStub();
    reader.enterReaderMode.mockRejectedValue(failure);
    ensureReaderDomain.mockResolvedValue(reader);
    const onEnterFailed = vi.fn();

    await expect(
      enterReaderShellOnUrlNavigation({ readerUrl: READER_MODE_URL, onEnterFailed })
    ).rejects.toBe(failure);

    expect(onEnterFailed).toHaveBeenCalledWith(failure);
  });
});

describe("exitReaderShell：退出逆事务（吸收 reader-close 处理器与关闭按钮链）", () => {
  it("阅读模式 URL：先收敛地址栏，再 closeReadingView + 摘阅读表", async () => {
    setLocationUrl(READER_MODE_URL);
    mountShell();
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);
    ensureReaderStyles();
    expectReaderStylesMounted(true);

    await exitReaderShell();

    expect(replaceReaderModeUrl).toHaveBeenCalledWith("https://www.bilibili.com/video/BV1test000000/");
    expect(reader.closeReadingView).toHaveBeenCalledTimes(1);
    expectReaderStylesMounted(false);
    const replaceOrder = replaceReaderModeUrl.mock.invocationCallOrder[0];
    expect(replaceOrder).toBeLessThan(reader.closeReadingView.mock.invocationCallOrder[0]);
  });

  it("稍后再看阅读模式 URL 退出：仅移除 biliscript_reader，保留 /list/watchlater 与上下文参数", async () => {
    setLocationUrl(
      "https://www.bilibili.com/list/watchlater?bvid=BV1test000000&oid=170001&p=2&biliscript_reader=1"
    );
    mountShell();
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);

    await exitReaderShell();

    expect(replaceReaderModeUrl).toHaveBeenCalledWith(
      "https://www.bilibili.com/list/watchlater?bvid=BV1test000000&oid=170001&p=2"
    );
    expect(reader.closeReadingView).toHaveBeenCalledTimes(1);
  });

  it("补回页内按钮的关闭事件后再归还焦点", async () => {
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);
    const onClosed = vi.fn();
    contentEventBus.once("reader:closed", onClosed);

    await exitReaderShell();

    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(reader.restoreReadingViewFocus).toHaveBeenCalledTimes(1);
    expect(onClosed.mock.invocationCallOrder[0]).toBeLessThan(
      reader.restoreReadingViewFocus.mock.invocationCallOrder[0]
    );
  });

  it("收回过渡等待缩放结束后再收尾摘表", async () => {
    mountShell();
    ensureReaderStyles();
    const reader = makeReaderStub();
    reader.beginClosingReadingView.mockReturnValue(true);
    ensureReaderDomain.mockResolvedValue(reader);

    const exitPromise = exitReaderShell();
    await vi.waitFor(() => expect(reader.beginClosingReadingView).toHaveBeenCalledTimes(1));
    expect(reader.closeReadingView).not.toHaveBeenCalled();
    expectReaderStylesMounted(true);

    const readingView = document.getElementById("biliscript-reading-view") as HTMLElement;
    readingView.dispatchEvent(new TransitionEvent("transitionend", { propertyName: "translate" }));
    expect(reader.closeReadingView).not.toHaveBeenCalled();
    expectReaderStylesMounted(true);

    readingView.dispatchEvent(new TransitionEvent("transitionend", { propertyName: "scale" }));
    await exitPromise;

    expect(reader.closeReadingView).toHaveBeenCalledTimes(1);
    expectReaderStylesMounted(false);
  });

  it("非阅读模式 URL（页内跳转后点关闭）→ 不改写地址栏，仍关闭并摘表", async () => {
    const reader = makeReaderStub();
    ensureReaderDomain.mockResolvedValue(reader);

    await exitReaderShell();

    expect(replaceReaderModeUrl).not.toHaveBeenCalled();
    expect(reader.closeReadingView).toHaveBeenCalledTimes(1);
  });

  it("reader 域装载失败 → 向上拒绝（消息路径据此按错误回包）", async () => {
    ensureReaderDomain.mockRejectedValue(new Error("load fail"));

    await expect(exitReaderShell()).rejects.toThrow("load fail");
  });
});

describe("isReaderShellIntact：壳完好性判定（restore 自愈与 script 按钮守卫的唯一判定）", () => {
  it("六条件全真才完好", () => {
    mountShell();
    expect(isReaderShellIntact()).toBe(true);
  });

  it.each([
    ["壳节点缺失", { present: false }],
    ["hidden 未解除", { hidden: true }],
    [".open 缺失", { open: false }],
    ["ready=0", { ready: "0" }],
    ["body 属性缺失", { bodyAttr: false }],
    ["html 属性缺失", { htmlAttr: false }]
  ])("任一必要呈现条件缺失即失整（%s）", (_name, broken) => {
    mountShell(broken as ShellMountOptions);
    expect(isReaderShellIntact()).toBe(false);
  });
});
