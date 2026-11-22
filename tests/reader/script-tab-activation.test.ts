import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";

vi.mock("../../extension/reader/lazy-chat-tab.js", () => ({
  ensureReaderChatTab: vi.fn(),
  isReaderChatTabLoaded: vi.fn(() => false)
}));
vi.mock("../../extension/reader/lazy-reader.js", () => ({
  ensureReaderDomain: vi.fn()
}));

type Modules = {
  activateScriptTab: typeof import("../../extension/reader/script-tab-activation.js").activateScriptTab;
  subscribeTabIntent: typeof import("../../extension/reader/reader-bus.js").subscribeTabIntent;
  reportTabIntent: typeof import("../../extension/reader/reader-bus.js").reportTabIntent;
  subscribeUiCommand: typeof import("../../extension/reader/reader-bus.js").subscribeUiCommand;
  isReadingSubtitleBodyVisible: typeof import("../../extension/reader/state.js").isReadingSubtitleBodyVisible;
  ensureReaderChatTab: typeof import("../../extension/reader/lazy-chat-tab.js").ensureReaderChatTab;
  ensureReaderDomain: typeof import("../../extension/reader/lazy-reader.js").ensureReaderDomain;
  registerDebugGate: typeof import("../../extension/shared/logging.js").registerDebugGate;
  state: typeof import("../../extension/core/state.js").state;
  transitionReaderShell: typeof import("../../extension/core/state.js").transitionReaderShell;
};

let m: Modules;
let commandSpy: Mock<(name: string, payload?: unknown) => void>;
let chatActivated: ReturnType<typeof vi.fn>;
let ensureOverviewTab: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  resetModuleState();
  setLocationUrl(NORMAL_PAGE_URL);
  document.body.innerHTML = "";
  vi.mocked(chrome.storage.local.set).mockReset().mockResolvedValue(undefined);

  const activation = await import("../../extension/reader/script-tab-activation.js");
  const readerBus = await import("../../extension/reader/reader-bus.js");
  const lazyChatTab = await import("../../extension/reader/lazy-chat-tab.js");
  vi.mocked(lazyChatTab.isReaderChatTabLoaded).mockReturnValue(false);
  const lazyReader = await import("../../extension/reader/lazy-reader.js");
  const readerState = await import("../../extension/reader/state.js");
  const coreState = await import("../../extension/core/state.js");
  const logging = await import("../../extension/shared/logging.js");

  m = {
    activateScriptTab: activation.activateScriptTab,
    subscribeTabIntent: readerBus.subscribeTabIntent,
    reportTabIntent: readerBus.reportTabIntent,
    subscribeUiCommand: readerBus.subscribeUiCommand,
    isReadingSubtitleBodyVisible: readerState.isReadingSubtitleBodyVisible,
    ensureReaderChatTab: lazyChatTab.ensureReaderChatTab,
    ensureReaderDomain: lazyReader.ensureReaderDomain,
    registerDebugGate: logging.registerDebugGate,
    state: coreState.state,
    transitionReaderShell: coreState.transitionReaderShell
  };

  commandSpy = vi.fn<(name: string, payload?: unknown) => void>();
  m.subscribeUiCommand(commandSpy);

  chatActivated = vi.fn(async () => {});
  (m.ensureReaderChatTab as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
    ensureChatTabActivated: chatActivated,
    runQuickActionPrompt: vi.fn(async () => true),
    closeChatSession: vi.fn()
  }));
  ensureOverviewTab = vi.fn();
  (m.ensureReaderDomain as ReturnType<typeof vi.fn>).mockResolvedValue({
    enterReaderMode: vi.fn(async () => {}),
    closeReadingView: vi.fn(),
    ensureReaderOverviewTab: ensureOverviewTab
  });

  m.registerDebugGate(() => true);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("单次激活顺序（状态位 → 持久化 → 投影 → 二级激活）", () => {
  it("投影命令：发 project-tab，载荷为标签名；状态位先于投影命令落地", async () => {
    m.transitionReaderShell("open");
    let predicateAtProjection: boolean | null = null;
    commandSpy.mockImplementation((name: string) => {
      if (name === "project-tab") {
        predicateAtProjection = m.isReadingSubtitleBodyVisible();
      }
    });

    await m.activateScriptTab("subtitle");

    expect(commandSpy).toHaveBeenCalledWith("project-tab", { tab: "subtitle" });
    expect(predicateAtProjection).toBe(true);
  });

  it("subtitle：无二级激活（不触达对话组合根，也不装载 reader 域）", async () => {
    await m.activateScriptTab("subtitle");

    expect(commandSpy).toHaveBeenCalledWith("project-tab", { tab: "subtitle" });
    expect(m.ensureReaderChatTab).not.toHaveBeenCalled();
    expect(m.ensureReaderDomain).not.toHaveBeenCalled();
  });

  it("离开已装载的 chat：停止朗读并关闭对话浮层；未装载时不为停止而加载对话域", async () => {
    const stopChatSpeech = vi.fn();
    const deactivateChatTabOverlays = vi.fn();
    const lazyChat = await import("../../extension/reader/lazy-chat-tab.js");
    vi.mocked(lazyChat.isReaderChatTabLoaded).mockReturnValue(true);
    (m.ensureReaderChatTab as ReturnType<typeof vi.fn>).mockResolvedValue({ stopChatSpeech, deactivateChatTabOverlays });

    await m.activateScriptTab("subtitle");

    expect(stopChatSpeech).toHaveBeenCalledTimes(1);
    expect(deactivateChatTabOverlays).toHaveBeenCalledTimes(1);
  });

  it("chat：走 chat seam 的 ensureChatTabActivated，consumeIntent 默认 true / 显式 false 透传", async () => {
    await m.activateScriptTab("chat");
    expect(chatActivated).toHaveBeenNthCalledWith(1, { consumeIntent: true });

    await m.activateScriptTab("chat", { consumeIntent: false });
    expect(chatActivated).toHaveBeenNthCalledWith(2, { consumeIntent: false });
    expect(commandSpy).toHaveBeenLastCalledWith("project-tab", { tab: "chat" });
  });

  it("overview：走 reader 域的概览激活（ensureReaderOverviewTab），不触达对话 seam", async () => {
    await m.activateScriptTab("overview");

    expect(ensureOverviewTab).toHaveBeenCalledTimes(1);
    expect(m.ensureReaderChatTab).not.toHaveBeenCalled();
    expect(commandSpy).toHaveBeenCalledWith("project-tab", { tab: "overview" });
  });
});

describe("持久化写穿（persist 开关）", () => {
  it("默认落盘：写穿同键 readerActiveScriptTab", async () => {
    await m.activateScriptTab("overview");

    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenCalledWith({
      readerActiveScriptTab: "overview"
    });
  });

  it("persist:false（进入阅读模式的恢复路径）不落盘", async () => {
    await m.activateScriptTab("overview", { persist: false });

    expect(vi.mocked(chrome.storage.local.set)).not.toHaveBeenCalled();
    expect(commandSpy).toHaveBeenCalledWith("project-tab", { tab: "overview" });
    expect(ensureOverviewTab).toHaveBeenCalledTimes(1);
  });
});

describe("串行队列（并发意图）", () => {
  it("并发两次 activate 串行：第二次的投影不早于第一次落定；最终状态 = 最后意图", async () => {
    const events: string[] = [];
    let releaseChat: () => void = () => {};
    const chatGate = new Promise<void>((resolve) => {
      releaseChat = resolve;
    });
    chatActivated.mockImplementation(async () => {
      events.push("chat-activate-start");
      await chatGate;
      events.push("chat-activate-end");
    });
    commandSpy.mockImplementation((name: string, payload?: unknown) => {
      if (name === "project-tab") {
        events.push(`project:${(payload as { tab: string }).tab}`);
      }
    });

    const first = m.activateScriptTab("chat");
    const second = m.activateScriptTab("subtitle");

    await vi.waitFor(() => expect(events).toContain("chat-activate-start"));
    expect(events).toEqual(["project:chat", "chat-activate-start"]);

    releaseChat();
    await Promise.all([first, second]);

    expect(events).toEqual([
      "project:chat",
      "chat-activate-start",
      "chat-activate-end",
      "project:subtitle"
    ]);
    m.transitionReaderShell("open");
    expect(m.isReadingSubtitleBodyVisible()).toBe(true);
    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenLastCalledWith({
      readerActiveScriptTab: "subtitle"
    });
  });
});

describe("二级激活失败（logWarn，不污染队列）", () => {
  it("chat 激活失败：logWarn 且 promise 照常 resolve，后续激活不受影响", async () => {
    const failure = new Error("chat init failed");
    chatActivated.mockRejectedValueOnce(failure);

    await expect(m.activateScriptTab("chat")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith("[BILISCRIPT] chat tab activate failed", failure);

    await m.activateScriptTab("overview");
    expect(ensureOverviewTab).toHaveBeenCalledTimes(1);
    expect(commandSpy).toHaveBeenLastCalledWith("project-tab", { tab: "overview" });
  });

  it("overview 激活失败（reader 域装载被拒）：logWarn 且不阻断后续激活", async () => {
    (m.ensureReaderDomain as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("load failed"));

    await expect(m.activateScriptTab("overview")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith("[BILISCRIPT] overview tab enter failed", expect.any(Error));

    await m.activateScriptTab("subtitle");
    expect(commandSpy).toHaveBeenLastCalledWith("project-tab", { tab: "subtitle" });
  });
});

describe("反向槽（ui → reader 意图上报）", () => {
  it("reportTabIntent → 属主 activateScriptTab（点击意图 fire-and-forget）", async () => {
    m.reportTabIntent("chat");

    await vi.waitFor(() => expect(chatActivated).toHaveBeenCalledTimes(1));
    expect(chatActivated).toHaveBeenCalledWith({ consumeIntent: true });
    expect(commandSpy).toHaveBeenCalledWith("project-tab", { tab: "chat" });
    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenCalledWith({
      readerActiveScriptTab: "chat"
    });
  });
});
