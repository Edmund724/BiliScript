import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBackgroundContentOrchestrator,
  type BackgroundContentOrchestratorDeps
} from "../../extension/core/background-content-orchestration.js";
import { sleep } from "../../extension/shared/utils.js";
import {
  DUPLICATE_CLASSIC_INJECTION_SENTINEL,
  RECEIVING_END_MISSING_SENTINEL
} from "../../extension/shared/content-error-sentinels.js";

const TAB_ID = 7;
const EXPECTED_VERSION = "2.0.0";
const STALE_VERSION = "0.9.0";
const READER_URL = "https://www.bilibili.com/video/BV1test000000/?biliscript_reader=1";

function makeHarness(overrides = {}) {
  const deps = {
    probeOnce: vi.fn(async () => EXPECTED_VERSION),
    injectAssets: vi.fn(async () => {}),
    reloadTab: vi.fn(async () => {}),
    waitForTabComplete: vi.fn(async () => true),
    sendMessageToTab: vi.fn(async () => ({ ok: true })),
    isTabReaderModeOff: vi.fn(async () => true),
    canInject: vi.fn(() => true),
    expectedVersion: EXPECTED_VERSION,
    logWarn: vi.fn(),
    ...overrides
  };
  return { deps, orch: createBackgroundContentOrchestrator(deps) };
}

function makeSpyDelayHarness(overrides = {}) {
  return makeHarness({ delay: vi.fn((ms) => sleep(ms)), ...overrides });
}

const msSeq = (harness: { deps: BackgroundContentOrchestratorDeps }): number[] =>
  vi.mocked(harness.deps.delay!).mock.calls.map((call) => call[0]);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ensureReaderContentReady", () => {
  it("probe 首发即命中期望版本：零等待、零注入、零 reload", async () => {
    const { orch, deps } = makeHarness();

    await expect(orch.ensureReaderContentReady(TAB_ID)).resolves.toBeUndefined();

    expect(deps.probeOnce).toHaveBeenCalledTimes(1);
    expect(deps.probeOnce).toHaveBeenCalledWith(TAB_ID);
    expect(deps.injectAssets).not.toHaveBeenCalled();
    expect(deps.reloadTab).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("canInject 为假（无 scripting / 无 tabId）：直接返回，零副作用", async () => {
    const { orch, deps } = makeHarness({ canInject: vi.fn(() => false) });

    await expect(orch.ensureReaderContentReady(0)).resolves.toBeUndefined();

    expect(deps.canInject).toHaveBeenCalledWith(0);
    expect(deps.probeOnce).not.toHaveBeenCalled();
    expect(deps.injectAssets).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("探针瞬时消息失败（Receiving end）：3 发内静默重试成功，不打 logWarn、不触发注入", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    deps.probeOnce
      .mockRejectedValueOnce(new Error(RECEIVING_END_MISSING_SENTINEL))
      .mockRejectedValueOnce(new Error(RECEIVING_END_MISSING_SENTINEL))
      .mockResolvedValueOnce(EXPECTED_VERSION);

    const promise = orch.ensureReaderContentReady(TAB_ID);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toBeUndefined();

    expect(deps.probeOnce).toHaveBeenCalledTimes(3);
    expect(msSeq({ deps })).toEqual([100, 100]);
    expect(deps.injectAssets).not.toHaveBeenCalled();
    expect(deps.logWarn).not.toHaveBeenCalled();
  });

  it("探针非预期非终端异常：记录 logWarn 并允许重试恢复", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    deps.probeOnce
      .mockRejectedValueOnce(new Error("executeScript failed"))
      .mockResolvedValueOnce(EXPECTED_VERSION);

    const promise = orch.ensureReaderContentReady(TAB_ID);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toBeUndefined();

    expect(deps.probeOnce).toHaveBeenCalledTimes(2);
    expect(deps.logWarn).toHaveBeenCalledTimes(1);
    expect(deps.logWarn).toHaveBeenCalledWith(
      "[BILISCRIPT] probeContentScriptVersion failed",
      expect.any(Error)
    );
  });

  it("探针终端标签页错误（已关闭标签页 / 权限拒绝 / 受限 frame）：首轮快速失败透传，不重试", async () => {
    for (const msg of [
      "No tab with id: 7.",
      'Cannot access contents of url "https://www.bilibili.com/". Extension manifest must request permission.',
      "Frame with ID 0 is showing error page."
    ]) {
      const { orch, deps } = makeSpyDelayHarness();
      const terminalError = new Error(msg);
      deps.probeOnce.mockRejectedValue(terminalError);

      await expect(orch.probeContentScriptVersion(TAB_ID)).rejects.toBe(terminalError);
      expect(deps.probeOnce).toHaveBeenCalledTimes(1);
      expect(msSeq({ deps })).toEqual([]);
    }
  });

  it("版本偏斜：注入后第 2 轮轮询成功（探针空版本按 3×100ms 内部重试）", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    deps.probeOnce
      .mockResolvedValueOnce(STALE_VERSION)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(EXPECTED_VERSION);

    const promise = orch.ensureReaderContentReady(TAB_ID);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBeUndefined();

    expect(deps.injectAssets).toHaveBeenCalledTimes(1);
    expect(deps.reloadTab).not.toHaveBeenCalled();
    expect(deps.probeOnce).toHaveBeenCalledTimes(5);
    expect(msSeq({ deps })).toEqual([100, 100, 150]);
  });

  it("轮询耗尽 → 整页 reload → 等加载完 + 停顿 120ms → 二次注入轮询成功", async () => {
    let reloaded = false;
    const { orch, deps } = makeSpyDelayHarness({
      probeOnce: vi.fn(async () => (reloaded ? EXPECTED_VERSION : STALE_VERSION)),
      reloadTab: vi.fn(async () => {
        reloaded = true;
      })
    });

    const promise = orch.ensureReaderContentReady(TAB_ID);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(promise).resolves.toBeUndefined();

    expect(deps.injectAssets).toHaveBeenCalledTimes(2);
    expect(deps.reloadTab).toHaveBeenCalledTimes(1);
    expect(deps.waitForTabComplete).toHaveBeenCalledWith(TAB_ID, { polls: 40 });
    expect(msSeq({ deps })).toEqual([150, 150, 150, 150, 120]);
    expect(deps.probeOnce).toHaveBeenCalledTimes(7);
  });

  it("二次轮询仍耗尽 → 最终失败（同步文案），reload 恰好一次", async () => {
    const { orch, deps } = makeSpyDelayHarness({
      probeOnce: vi.fn(async () => STALE_VERSION)
    });

    const promise = orch.ensureReaderContentReady(TAB_ID);
    const assertion = expect(promise).rejects.toThrow(
      "扩展脚本未能和当前页面同步，请刷新浏览器网页重试"
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    expect(deps.reloadTab).toHaveBeenCalledTimes(1);
    expect(deps.injectAssets).toHaveBeenCalledTimes(2);
    expect(msSeq({ deps })).toEqual([150, 150, 150, 150, 120, 150, 150, 150, 150]);
    expect(deps.probeOnce).toHaveBeenCalledTimes(11);
  });

  it("探针全程无版本：跳过 reload 直接最终失败", async () => {
    const { orch, deps } = makeHarness({
      probeOnce: vi.fn(async () => "")
    });

    const promise = orch.ensureReaderContentReady(TAB_ID);
    const assertion = expect(promise).rejects.toThrow(
      "扩展脚本未能和当前页面同步，请刷新浏览器网页重试"
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    expect(deps.injectAssets).toHaveBeenCalledTimes(1);
    expect(deps.reloadTab).not.toHaveBeenCalled();
    expect(deps.waitForTabComplete).not.toHaveBeenCalled();
    expect(deps.probeOnce).toHaveBeenCalledTimes(18);
  });

  it("reload 后页面未恢复：抛「页面未及时恢复」，无停顿、无二次注入", async () => {
    const { orch, deps } = makeSpyDelayHarness({
      probeOnce: vi.fn(async () => STALE_VERSION),
      waitForTabComplete: vi.fn(async () => false)
    });

    const promise = orch.ensureReaderContentReady(TAB_ID);
    const assertion = expect(promise).rejects.toThrow(
      "扩展更新后页面未及时恢复，请刷新浏览器网页重试"
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    expect(deps.reloadTab).toHaveBeenCalledTimes(1);
    expect(deps.waitForTabComplete).toHaveBeenCalledWith(TAB_ID, { polls: 40 });
    expect(deps.injectAssets).toHaveBeenCalledTimes(1);
    expect(msSeq({ deps })).toEqual([150, 150, 150, 150]);
  });

  it("注入报错命中 DEFAULT_SETTINGS 哨兵：视为已注入吞掉，继续轮询", async () => {
    const { orch, deps } = makeHarness();
    deps.probeOnce
      .mockResolvedValueOnce(STALE_VERSION)
      .mockResolvedValueOnce(EXPECTED_VERSION);
    deps.injectAssets.mockRejectedValueOnce(
      new Error(`Uncaught SyntaxError: ${DUPLICATE_CLASSIC_INJECTION_SENTINEL}`)
    );

    await expect(orch.ensureReaderContentReady(TAB_ID)).resolves.toBeUndefined();

    expect(deps.injectAssets).toHaveBeenCalledTimes(1);
  });

  it("注入报错非哨兵：原样上抛（错误对象同一性）", async () => {
    const { orch, deps } = makeHarness();
    const failure = new Error("Cannot access 'foo' before initialization");
    deps.probeOnce.mockResolvedValue(STALE_VERSION);
    deps.injectAssets.mockRejectedValue(failure);

    await expect(orch.ensureReaderContentReady(TAB_ID)).rejects.toBe(failure);
    expect(deps.reloadTab).not.toHaveBeenCalled();
  });

  it("probeContentScriptVersion：全程落空返回空串（3 发、间隔 100ms）", async () => {
    const { orch, deps } = makeSpyDelayHarness({
      probeOnce: vi.fn(async () => "")
    });

    const promise = orch.probeContentScriptVersion(TAB_ID);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toBe("");

    expect(deps.probeOnce).toHaveBeenCalledTimes(3);
    expect(msSeq({ deps })).toEqual([100, 100]);
  });
});

describe("triggerReaderModeInTab", () => {
  it("首发即 ok：返回 true，消息契约正确，零兜底零延时", async () => {
    const { orch, deps } = makeHarness();

    await expect(orch.triggerReaderModeInTab(TAB_ID, READER_URL)).resolves.toBe(true);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(1);
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(TAB_ID, {
      type: "reader-enter",
      readerUrl: READER_URL
    });
    expect(deps.probeOnce).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("带 chat 负载：单条 reader-enter 透传 chat（进入事务内激活对话 tab）", async () => {
    const { orch, deps } = makeHarness();

    await expect(orch.triggerReaderModeInTab(TAB_ID, READER_URL, { prompt: "总结" })).resolves.toBe(true);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(1);
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(TAB_ID, {
      type: "reader-enter",
      readerUrl: READER_URL,
      chat: { prompt: "总结" }
    });
  });

  it("Receiving end 错误 → 兜底 ensureReaderContentReady → 下一轮成功", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    deps.sendMessageToTab
      .mockRejectedValueOnce(new Error(RECEIVING_END_MISSING_SENTINEL))
      .mockResolvedValueOnce({ ok: true });

    const promise = orch.triggerReaderModeInTab(TAB_ID, READER_URL);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBe(true);

    expect(deps.canInject).toHaveBeenCalledWith(TAB_ID);
    expect(deps.probeOnce).toHaveBeenCalledTimes(1);
    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(2);
    expect(msSeq({ deps })).toEqual([300]);
  });

  it("ok:false（无异常）：不触发兜底，重试后成功", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    deps.sendMessageToTab
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    const promise = orch.triggerReaderModeInTab(TAB_ID, READER_URL);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBe(true);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(2);
    expect(deps.probeOnce).not.toHaveBeenCalled();
    expect(msSeq({ deps })).toEqual([300]);
  });

  it("已知端口提前关闭错误：不触发兜底，静默重试 12 次耗尽 → false，不打 logWarn", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    deps.sendMessageToTab.mockRejectedValue(
      new Error("The message port closed before a response was received.")
    );

    const promise = orch.triggerReaderModeInTab(TAB_ID, READER_URL);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(promise).resolves.toBe(false);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(12);
    expect(deps.canInject).not.toHaveBeenCalled();
    expect(deps.probeOnce).not.toHaveBeenCalled();
    expect(deps.logWarn).not.toHaveBeenCalled();
    expect(msSeq({ deps })).toEqual(Array.from({ length: 11 }, () => 300));
  });

  it("非瞬时消息异常（如标签页不存在或权限错误）：记 logWarn 并立即透传，不重试也不触发兜底", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    const fatalError = new Error("No tab with id: 7.");
    deps.sendMessageToTab.mockRejectedValue(fatalError);

    await expect(orch.triggerReaderModeInTab(TAB_ID, READER_URL)).rejects.toBe(fatalError);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(1);
    expect(deps.canInject).not.toHaveBeenCalled();
    expect(deps.logWarn).toHaveBeenCalledWith("[BILISCRIPT] reader-enter message failed", fatalError);
    expect(msSeq({ deps })).toEqual([]);
  });

  it("Receiving end 且兜底 ensureReaderContentReady 抛同步错误：立即中止重试并透传给调用方", async () => {
    const { orch, deps } = makeHarness({
      probeOnce: vi.fn(async () => "")
    });
    deps.sendMessageToTab.mockRejectedValue(new Error(RECEIVING_END_MISSING_SENTINEL));

    const promise = orch.triggerReaderModeInTab(TAB_ID, READER_URL);
    const assertion = expect(promise).rejects.toThrow(
      "扩展脚本未能和当前页面同步，请刷新浏览器网页重试"
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(1);
    expect(deps.canInject).toHaveBeenCalledTimes(1);
  });
});

describe("triggerReaderModeToggleInTab", () => {
  it("Receiving end 兜底成功后下一轮 reader-toggle 返回 true，零 logWarn", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    deps.sendMessageToTab
      .mockRejectedValueOnce(new Error(RECEIVING_END_MISSING_SENTINEL))
      .mockResolvedValueOnce({ ok: true });

    const promise = orch.triggerReaderModeToggleInTab(TAB_ID, READER_URL);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBe(true);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(2);
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(TAB_ID, {
      type: "reader-toggle",
      readerUrl: READER_URL
    });
    expect(deps.logWarn).not.toHaveBeenCalled();
  });

  it("Receiving end 兜底 ensureReaderContentReady 抛终端错误：停止重试并透传", async () => {
    const { orch, deps } = makeHarness({
      probeOnce: vi.fn(async () => STALE_VERSION),
      waitForTabComplete: vi.fn(async () => false)
    });
    deps.sendMessageToTab.mockRejectedValue(new Error(RECEIVING_END_MISSING_SENTINEL));

    const promise = orch.triggerReaderModeToggleInTab(TAB_ID, READER_URL);
    const assertion = expect(promise).rejects.toThrow(
      "扩展更新后页面未及时恢复，请刷新浏览器网页重试"
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(1);
    expect(deps.reloadTab).toHaveBeenCalledTimes(1);
  });

  it("非瞬时消息异常：记 logWarn 并立即透传，不重试", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    const fatalError = new Error("Cannot access contents of url");
    deps.sendMessageToTab.mockRejectedValue(fatalError);

    await expect(orch.triggerReaderModeToggleInTab(TAB_ID, READER_URL)).rejects.toBe(fatalError);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(1);
    expect(deps.logWarn).toHaveBeenCalledWith("[BILISCRIPT] reader-toggle message failed", fatalError);
    expect(msSeq({ deps })).toEqual([]);
  });
});

describe("triggerReaderModeCloseInTab", () => {
  it("首发即 ok：返回 true，不做 URL 二次确认", async () => {
    const { orch, deps } = makeHarness();

    await expect(orch.triggerReaderModeCloseInTab(TAB_ID)).resolves.toBe(true);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(1);
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(TAB_ID, {
      type: "reader-close"
    });
    expect(deps.isTabReaderModeOff).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ok:false → URL 二次确认已退出：返回 true，零延时", async () => {
    const { orch, deps } = makeHarness();
    deps.sendMessageToTab.mockResolvedValue({ ok: false });
    deps.isTabReaderModeOff.mockResolvedValue(true);

    await expect(orch.triggerReaderModeCloseInTab(TAB_ID)).resolves.toBe(true);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(1);
    expect(deps.isTabReaderModeOff).toHaveBeenCalledTimes(1);
    expect(deps.isTabReaderModeOff).toHaveBeenCalledWith(TAB_ID);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("已知端口关闭异常且 URL 二次确认已退出：静默忽略不打 logWarn，返回 true", async () => {
    const { orch, deps } = makeHarness();
    deps.sendMessageToTab.mockRejectedValue(new Error("The message port closed"));
    deps.isTabReaderModeOff.mockResolvedValue(true);

    await expect(orch.triggerReaderModeCloseInTab(TAB_ID)).resolves.toBe(true);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(1);
    expect(deps.isTabReaderModeOff).toHaveBeenCalledTimes(1);
    expect(deps.logWarn).not.toHaveBeenCalled();
  });

  it("已知端口关闭异常但 URL 仍未退出：记录 logWarn 保留诊断信息并继续重试", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    const portError = new Error("The message port closed");
    deps.sendMessageToTab
      .mockRejectedValueOnce(portError)
      .mockResolvedValueOnce({ ok: true });
    deps.isTabReaderModeOff.mockResolvedValueOnce(false);

    const promise = orch.triggerReaderModeCloseInTab(TAB_ID);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toBe(true);

    expect(deps.logWarn).toHaveBeenCalledTimes(1);
    expect(deps.logWarn).toHaveBeenCalledWith(
      "[BILISCRIPT] reader-close transient error while reader mode still active",
      portError
    );
  });

  it("致命标签页错误（非端口关闭/receiving-end）：记 logWarn 并立即透传，不误当瞬时关闭", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    const fatalError = new Error("No tab with id: 7.");
    deps.sendMessageToTab.mockRejectedValue(fatalError);

    await expect(orch.triggerReaderModeCloseInTab(TAB_ID)).rejects.toBe(fatalError);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(1);
    expect(deps.isTabReaderModeOff).not.toHaveBeenCalled();
    expect(deps.logWarn).toHaveBeenCalledWith("[BILISCRIPT] reader-close message failed", fatalError);
    expect(msSeq({ deps })).toEqual([]);
  });

  it("12 次重试耗尽（URL 始终未退出）→ false，间隔 300ms", async () => {
    const { orch, deps } = makeSpyDelayHarness();
    deps.sendMessageToTab.mockResolvedValue({ ok: false });
    deps.isTabReaderModeOff.mockResolvedValue(false);

    const promise = orch.triggerReaderModeCloseInTab(TAB_ID);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(promise).resolves.toBe(false);

    expect(deps.sendMessageToTab).toHaveBeenCalledTimes(12);
    expect(deps.isTabReaderModeOff).toHaveBeenCalledTimes(12);
    expect(msSeq({ deps })).toEqual(Array.from({ length: 11 }, () => 300));
  });
});
