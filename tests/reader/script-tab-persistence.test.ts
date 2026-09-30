// 文摘面板「当前标签」持久化叶子测试（2026-10 用户决议：刷新不跳回字幕 tab）。
//
// 语义：当前标签落 chrome.storage.local（设备本地 UI 偏好，与「对话 tab 选中
// 模型」同类，不进 settings 域）——刷新/新视频/手动进入一律恢复上次所在标签；
// 缺失、非法值或读写失败一律回落「字幕」，且不得让进入阅读模式失败。
//
// 覆盖的失败方式：
//   1. 非法/缺失/非字符串值被当成合法标签 → 必须回落 subtitle；
//   2. 读取抛错（storage 不可用）→ 回落 subtitle，不向调用方抛；
//   3. 写入失败（quota/异常）→ 静默，不向切换 tab 的交互抛；
//   4. 键名漂移：读写的键必须同一（否则永远读不到刚写的值）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

type Persistence = typeof import("../../extension/reader/script-tab-persistence.js");

let persistence: Persistence;

function storageLocal() {
  return chrome.storage.local as unknown as {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
}

beforeEach(async () => {
  resetModuleState();
  vi.mocked(chrome.storage.local.get).mockReset().mockResolvedValue({});
  vi.mocked(chrome.storage.local.set).mockReset().mockResolvedValue(undefined);
  persistence = await import("../../extension/reader/script-tab-persistence.js");
});

describe("reader 当前标签持久化叶子", () => {
  it("normalizeReaderScriptTab：三个合法标签原样返回，其余值回落 subtitle", () => {
    expect(persistence.normalizeReaderScriptTab("subtitle")).toBe("subtitle");
    expect(persistence.normalizeReaderScriptTab("overview")).toBe("overview");
    expect(persistence.normalizeReaderScriptTab("chat")).toBe("chat");
    expect(persistence.normalizeReaderScriptTab("ghost")).toBe("subtitle");
    expect(persistence.normalizeReaderScriptTab(undefined)).toBe("subtitle");
    expect(persistence.normalizeReaderScriptTab(3)).toBe("subtitle");
    expect(persistence.normalizeReaderScriptTab({ tab: "chat" })).toBe("subtitle");
  });

  it("isReaderScriptTab：三个合法标签为真，其余（含非字符串）为假", () => {
    expect(persistence.isReaderScriptTab("subtitle")).toBe(true);
    expect(persistence.isReaderScriptTab("overview")).toBe(true);
    expect(persistence.isReaderScriptTab("chat")).toBe(true);
    expect(persistence.isReaderScriptTab("ghost")).toBe(false);
    expect(persistence.isReaderScriptTab(undefined)).toBe(false);
    expect(persistence.isReaderScriptTab(null)).toBe(false);
    expect(persistence.isReaderScriptTab(3)).toBe(false);
  });

  it("load：命中存储值原样返回（键与 save 同源）", async () => {
    storageLocal().get.mockResolvedValue({ [persistence.READER_ACTIVE_TAB_KEY]: "overview" });
    await expect(persistence.loadReaderScriptTab()).resolves.toBe("overview");
    expect(storageLocal().get).toHaveBeenCalledWith(persistence.READER_ACTIVE_TAB_KEY);
  });

  it("load：缺失值 → subtitle", async () => {
    storageLocal().get.mockResolvedValue({});
    await expect(persistence.loadReaderScriptTab()).resolves.toBe("subtitle");
  });

  it("load：非法值 → subtitle（不把存储里的脏值当标签）", async () => {
    storageLocal().get.mockResolvedValue({ [persistence.READER_ACTIVE_TAB_KEY]: "ghost" });
    await expect(persistence.loadReaderScriptTab()).resolves.toBe("subtitle");
  });

  it("load：读取抛错 → subtitle，不向调用方抛（进入阅读模式不得因此失败）", async () => {
    storageLocal().get.mockRejectedValue(new Error("storage unavailable"));
    await expect(persistence.loadReaderScriptTab()).resolves.toBe("subtitle");
  });

  it("save：按同一键写入 local", () => {
    persistence.saveReaderScriptTab("chat");
    expect(storageLocal().set).toHaveBeenCalledWith({ [persistence.READER_ACTIVE_TAB_KEY]: "chat" });
  });

  it("save：写入同步抛错静默（不向 tab 切换抛）", () => {
    storageLocal().set.mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => persistence.saveReaderScriptTab("overview")).not.toThrow();
  });

  it("save：写入异步拒绝静默（不产生未处理拒绝）", async () => {
    storageLocal().set.mockRejectedValue(new Error("quota exceeded"));
    expect(() => persistence.saveReaderScriptTab("overview")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
