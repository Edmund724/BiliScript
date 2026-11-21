import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";

const ensureReaderDomainMock = vi.hoisted(() => vi.fn());
const ensureUiReadyMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../extension/reader/lazy-reader.js", () => ({
  ensureReaderDomain: ensureReaderDomainMock
}));
vi.mock("../../extension/reader/lazy-chat-tab.js", () => ({
  ensureReaderChatTab: vi.fn(),
  isReaderChatTabLoaded: vi.fn(() => false)
}));
vi.mock("../../extension/ui/lazy-ui.js", () => ({
  ensureUiReady: ensureUiReadyMock
}));
vi.mock("../../extension/ai/lazy-player-ai.js", () => ({
  loadPlayerAi: vi.fn(),
  isPlayerAiLoaded: vi.fn(() => false)
}));
vi.mock("../../extension/bilibili/reader-url.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/reader-url.js")>();
  return {
    ...actual,
    replaceReaderModeUrl: vi.fn()
  };
});

type Shell = typeof import("../../extension/reader/shell.js");
type StateModule = typeof import("../../extension/core/state.js");

let shell: Shell;
let stateModule: StateModule;
let warnSpy: ReturnType<typeof vi.spyOn>;

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  resetModuleState();
  setLocationUrl(NORMAL_PAGE_URL);
  ensureReaderDomainMock.mockReset();
  ensureUiReadyMock.mockClear();
  stateModule = await import("../../extension/core/state.js");
  shell = await import("../../extension/reader/shell.js");
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("entering 中收到 close：退出事务顺延", () => {
  it("close 在进入事务收敛后才执行，最终 closed（不交错）", async () => {
    const order: string[] = [];
    let releaseEnter!: () => void;
    const enterGate = new Promise<void>((resolve) => {
      releaseEnter = resolve;
    });
    ensureReaderDomainMock.mockResolvedValue({
      enterReaderMode: vi.fn(async () => {
        order.push("enter-start");
        await enterGate;
        stateModule.transitionReaderShell("open");
        order.push("enter-done");
      }),
      beginClosingReadingView: vi.fn(() => false),
      closeReadingView: vi.fn(() => {
        stateModule.transitionReaderShell("closed");
        order.push("close");
      }),
      restoreReadingViewFocus: vi.fn()
    });

    const enterPromise = shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await vi.waitFor(() => expect(order).toContain("enter-start"));
    expect(stateModule.getReaderShellState()).toBe("entering");

    const exitPromise = shell.exitReaderShell();
    await flushMicrotasks();
    expect(order).not.toContain("close");

    releaseEnter();
    await enterPromise;
    await exitPromise;
    expect(order).toEqual(["enter-start", "enter-done", "close"]);
    expect(stateModule.getReaderShellState()).toBe("closed");
  });
});

describe("restore 与 URL 跳转连发：同队列串行", () => {
  it("第二个事务等第一个收敛后才起跑，无交错", async () => {
    const order: string[] = [];
    let releaseRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    const enterReaderMode = vi.fn(async () => {
      order.push("restore-enter-start");
      await restoreGate;
      stateModule.transitionReaderShell("open");
      order.push("restore-enter-done");
    });
    ensureUiReadyMock.mockImplementation(async () => {
      order.push("ensure-ui");
    });
    ensureReaderDomainMock.mockResolvedValue({
      enterReaderMode,
      beginClosingReadingView: vi.fn(() => false),
      closeReadingView: vi.fn()
    });

    const restorePromise = shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "restore" });
    await vi.waitFor(() => expect(order).toContain("restore-enter-start"));

    const navPromise = shell.enterReaderShellOnUrlNavigation({ readerUrl: READER_MODE_URL });
    await flushMicrotasks();
    expect(order).toEqual(["ensure-ui", "restore-enter-start"]);

    releaseRestore();
    await restorePromise;
    await navPromise;
    expect(order).toEqual(["ensure-ui", "restore-enter-start", "restore-enter-done", "ensure-ui"]);
    expect(stateModule.getReaderShellState()).toBe("open");
  });
});

describe("非法迁移拒绝", () => {
  it("closed → exiting 被拒绝：状态不变 + logWarnAlways 直出", () => {
    expect(stateModule.transitionReaderShell("exiting")).toBe(false);
    expect(stateModule.getReaderShellState()).toBe("closed");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("非法阅读壳状态迁移");
    expect(String(warnSpy.mock.calls[0][0])).toContain("closed → exiting");
  });

  it("closed → open 合法；同态迁移幂等 no-op 不告警", () => {
    expect(stateModule.transitionReaderShell("open")).toBe(true);
    expect(stateModule.getReaderShellState()).toBe("open");
    warnSpy.mockClear();
    expect(stateModule.transitionReaderShell("open")).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("失败回退（不能卡在过渡态）", () => {
  it("进入失败：entering 回退 closed + logWarnAlways 留痕", async () => {
    ensureReaderDomainMock.mockResolvedValue({
      enterReaderMode: vi.fn(async () => {
        throw new Error("enter boom");
      })
    });

    await expect(
      shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" })
    ).rejects.toThrow("enter boom");

    expect(stateModule.getReaderShellState()).toBe("closed");
    expect(warnSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes("rolled back to closed"))).toBe(true);
  });

  it("退出失败（reader 域装载失败）：exiting 回退 open，拒绝向上传播", async () => {
    stateModule.transitionReaderShell("entering");
    stateModule.transitionReaderShell("open");
    ensureReaderDomainMock.mockRejectedValue(new Error("load fail"));

    await expect(shell.exitReaderShell()).rejects.toThrow("load fail");
    expect(stateModule.getReaderShellState()).toBe("open");
  });

  it("退出失败（closeReadingView 中途抛错）：exiting 回退 open", async () => {
    stateModule.transitionReaderShell("entering");
    stateModule.transitionReaderShell("open");
    ensureReaderDomainMock.mockResolvedValue({
      beginClosingReadingView: vi.fn(() => false),
      closeReadingView: vi.fn(() => {
        throw new Error("close boom");
      })
    });

    await expect(shell.exitReaderShell()).rejects.toThrow("close boom");
    expect(stateModule.getReaderShellState()).toBe("open");
  });
});
