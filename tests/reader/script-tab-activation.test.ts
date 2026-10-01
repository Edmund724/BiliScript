// 文摘面板「切标签并激活」属主（reader/script-tab-activation.ts）回归。
//
// 收口后的不变式（工单：标签激活属主收口）：
//   1. 单次激活顺序 = ① 状态位（reader/state.ts）→ ② 持久化写穿 → ③ 投影命令
//      requestUiCommand("project-tab") → ④ await 二级激活（chat/overview）；
//   2. 并发调用经属主串行队列排队：后到调用的投影/二级激活不早于先到调用落定，
//      最终状态 = 最后意图（收口前的竞态根因就是两级激活与投影无排序）；
//   3. 二级激活失败只 logWarn、不污染队列（promise 照常 resolve）；
//   4. 反向槽：ui 壳 reportTabIntent → 属主 activateScriptTab。
//
// 消费面全部替身化：投影目标（ui 壳）用 reader-bus 的 uiCommand 槽捕获载荷，
// 二级激活对象（对话组合根 / reader 域）经 lazy 缝 mock——本文件只锁属主自己的
// 顺序与语义，DOM 三通道投影落点由 tests/reader/script-tab-command.test.ts 钉住。

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

  // 属主先装载（模块求值时经 reader-bus 反向槽注册 tabIntent handler）
  const activation = await import("../../extension/reader/script-tab-activation.js");
  const readerBus = await import("../../extension/reader/reader-bus.js");
  const lazyChatTab = await import("../../extension/reader/lazy-chat-tab.js");
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
    state: coreState.state
  };

  // 投影目标替身：ui 壳缺席时命令本该静默丢弃，此处捕获载荷断言属主到底发了什么。
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

  // 二级激活失败断言面：logWarn 走调试门（缺省关），开门 + 捕获 console.warn。
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
    m.state.reader.setViewOpen(true);
    let predicateAtProjection: boolean | null = null;
    commandSpy.mockImplementation((name: string) => {
      if (name === "project-tab") {
        predicateAtProjection = m.isReadingSubtitleBodyVisible();
      }
    });

    await m.activateScriptTab("subtitle");

    expect(commandSpy).toHaveBeenCalledWith("project-tab", { tab: "subtitle" });
    // 唯一状态位先落：谓词（视图开着 + 抽屉收起时 subtitle 才为真）在投影命令
    // 到达时已按新标签判定——顺序反了这里就是 null/false。
    expect(predicateAtProjection).toBe(true);
  });

  it("subtitle：无二级激活（不触达对话组合根，也不装载 reader 域）", async () => {
    await m.activateScriptTab("subtitle");

    expect(commandSpy).toHaveBeenCalledWith("project-tab", { tab: "subtitle" });
    expect(m.ensureReaderChatTab).not.toHaveBeenCalled();
    expect(m.ensureReaderDomain).not.toHaveBeenCalled();
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
    // 投影与二级激活照常（跳过持久化不等于跳过激活）
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
    // 第一次激活（含二级激活）未落定 ⇒ 第二次的投影命令只能排队等（收口前的
    // 形状下第二次会当场投影，把对话 tab 盖回字幕，正是偶发竞态的形态）
    expect(events).toEqual(["project:chat", "chat-activate-start"]);

    releaseChat();
    await Promise.all([first, second]);

    expect(events).toEqual([
      "project:chat",
      "chat-activate-start",
      "chat-activate-end",
      "project:subtitle"
    ]);
    // 最终状态 = 最后意图：唯一状态位（谓词可观测）与持久化都以第二次调用为准。
    m.state.reader.setViewOpen(true);
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
