// reader seam 单 handler 槽与端口的声明纪律测试。
//
// 覆盖：
// - 单点注册后全部端口方法可路由（参数原样转发）；
// - 端口方法集只含真实调用名（无死槽位）；
// - 重复注册报错（防止实现被静默覆盖）；
// - 注册表缺方法 / 含未知方法键即抛错；
// - 未注册即调用端口方法抛错（缺失策略 throw）；
// - 合法缺席的槽按声明策略 no-op（字幕刷新 / 壳命令 / 标签意图 / 外点关闭）；
// - 常驻能力组同样精确覆盖。
//
// 槽表挂在 globalThis：每用例经 resetModuleState 清槽并重新动态 import。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { ContentSeamCapabilities, ReaderPortImpls } from "../../extension/reader/reader-bus.js";

let bus: typeof import("../../extension/reader/reader-bus.js");

beforeEach(async () => {
  resetModuleState();
  bus = await import("../../extension/reader/reader-bus.js");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function validImpls() {
  return {
    noteManualReaderInteraction: vi.fn(),
    syncReadingViewPlayback: vi.fn(),
    flushReadingSubtitleToIndex: vi.fn()
  };
}

function validCapabilities(): ContentSeamCapabilities {
  return {
    persistSettings: vi.fn(),
    loadSettings: vi.fn(() => Promise.resolve(null)),
    playerAiSync: vi.fn()
  };
}

describe("reader 显式端口", () => {
  it("单点注册后，全部端口方法可路由且参数原样转发", () => {
    const impls = validImpls();
    bus.registerReaderPorts(impls);

    bus.readerPorts.noteManualReaderInteraction(5000);
    bus.readerPorts.syncReadingViewPlayback(true);
    bus.readerPorts.flushReadingSubtitleToIndex(7);

    expect(impls.noteManualReaderInteraction).toHaveBeenCalledTimes(1);
    expect(impls.noteManualReaderInteraction).toHaveBeenCalledWith(5000);
    expect(impls.syncReadingViewPlayback).toHaveBeenCalledTimes(1);
    expect(impls.syncReadingViewPlayback).toHaveBeenCalledWith(true);
    expect(impls.flushReadingSubtitleToIndex).toHaveBeenCalledTimes(1);
    expect(impls.flushReadingSubtitleToIndex).toHaveBeenCalledWith(7);
  });

  it("方法集只含真实调用名（无死槽位）", () => {
    // LAYOUT 经端口回调 SYNC 的两个方法，SYNC 经端口回调 LIFECYCLE 的补渲染。
    expect(bus.READER_PORT_METHODS).toContain("syncReadingViewPlayback");
    expect(bus.READER_PORT_METHODS).toContain("noteManualReaderInteraction");
    expect(bus.READER_PORT_METHODS).toContain("flushReadingSubtitleToIndex");
    expect(bus.readerPorts).toHaveProperty("syncReadingViewPlayback");
    expect(bus.readerPorts).toHaveProperty("noteManualReaderInteraction");
  });

  it("重复注册报错（防止实现被静默覆盖）", () => {
    bus.registerReaderPorts(validImpls());
    expect(() => bus.registerReaderPorts(validImpls())).toThrow(/重复注册/);
  });

  it("注册表缺方法即抛错（禁止静默缺实现）", () => {
    const { flushReadingSubtitleToIndex: _omitted, ...partial } = validImpls();
    expect(() => bus.registerReaderPorts(partial as unknown as ReaderPortImpls)).toThrow(
      /缺少方法.*flushReadingSubtitleToIndex/
    );
  });

  it("注册表含未知方法键即抛错（防拼写漂移绕过显式方法集）", () => {
    expect(() =>
      bus.registerReaderPorts({
        ...validImpls(),
        someTypoMethod: vi.fn()
      } as unknown as ReaderPortImpls)
    ).toThrow(/未知方法.*someTypoMethod/);
  });

  it("未注册即调用端口方法抛错（不再静默 undefined/true）", () => {
    expect(() => bus.readerPorts.syncReadingViewPlayback()).toThrow(/未注册/);
    expect(() => bus.readerPorts.noteManualReaderInteraction()).toThrow(/未注册/);
    expect(() => bus.readerPorts.flushReadingSubtitleToIndex(0)).toThrow(/未注册/);
  });
});

describe("常驻能力槽", () => {
  it("注册后三个能力槽可路由", async () => {
    const caps = validCapabilities();
    bus.registerContentCapabilities(caps);

    bus.persistReaderSettingsThroughSeam();
    await bus.loadReaderSettingsThroughSeam();
    bus.requestPlayerAiSync(120, { resetRetry: true });

    expect(caps.persistSettings).toHaveBeenCalledTimes(1);
    expect(caps.loadSettings).toHaveBeenCalledTimes(1);
    expect(caps.playerAiSync).toHaveBeenCalledWith(120, { resetRetry: true });
  });

  it("缺方法 / 含未知方法 / 重复注册即抛错", () => {
    const { playerAiSync: _omitted, ...partial } = validCapabilities();
    expect(() => bus.registerContentCapabilities(partial as unknown as ContentSeamCapabilities)).toThrow(
      /缺少方法.*playerAiSync/
    );

    expect(() =>
      bus.registerContentCapabilities({
        ...validCapabilities(),
        someTypoMethod: vi.fn()
      } as unknown as ContentSeamCapabilities)
    ).toThrow(/未知方法.*someTypoMethod/);

    bus.registerContentCapabilities(validCapabilities());
    expect(() => bus.registerContentCapabilities(validCapabilities())).toThrow(/重复注册/);
  });
});

describe("缺失策略", () => {
  it("声明表一处可见：端口抛错、字幕刷新静默、命令类首次告警", () => {
    expect(bus.READER_SEAM_METHODS.flushReadingSubtitleToIndex.policy).toBe("throw");
    expect(bus.READER_SEAM_METHODS.subtitleRefresh.policy).toBe("noop");
    expect(bus.READER_SEAM_METHODS.uiCommand.policy).toBe("noop-warn");
    expect(bus.READER_SEAM_METHODS.tabIntent.policy).toBe("noop-warn");
    expect(bus.READER_SEAM_METHODS.chatTabOutsideClick.policy).toBe("noop-warn");
  });

  it("字幕刷新缺失不抛（链装载失败路径照旧发起刷新）", async () => {
    await expect(bus.requestSubtitleRefresh()).resolves.toBeUndefined();
  });

  it("壳命令 / 标签意图 / 外点关闭缺失为 no-op，不打断交互", () => {
    expect(() => bus.requestUiCommand("open-settings")).not.toThrow();
    expect(() => bus.reportTabIntent("chat")).not.toThrow();
    expect(() => bus.dispatchChatTabOutsideClick(new MouseEvent("click"))).not.toThrow();
  });

  it("能力槽缺失为 no-op，持久化/读取路径不抛", async () => {
    expect(() => bus.persistReaderSettingsThroughSeam()).not.toThrow();
    expect(() => bus.requestPlayerAiSync()).not.toThrow();
    await expect(bus.loadReaderSettingsThroughSeam()).resolves.toBeNull();
  });
});
