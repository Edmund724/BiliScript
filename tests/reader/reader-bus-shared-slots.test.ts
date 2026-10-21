// reader-bus 槽表跨实例共享回归（content 两轮构建的双实例缺陷）。
//
// scripts/build-content.js 是两轮构建——轮 A 常驻单文件（content-main.mjs）、
// 轮 B 懒加载区（chunks/），共享底座在两侧各有一份实例。reader-bus 的槽表必须
// 挂 globalThis：能力槽（settings persist/load、player-ai sync）由常驻包注册、
// 懒加载区的 reader 域消费——注册与调用落在不同实例上时，模块级槽会静默错开
//（阅读面板里改主题不落盘、player-ai 同步请求无人接收）。
//
// 手法：vi.resetModules() 后重新 import 得到**另一个模块实例**，用它调用消费端，
// 断言注册在第一个实例上的 handler 仍被命中——正是生产里两侧实例的分工。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

type ReaderBus = typeof import("../../extension/reader/reader-bus.js");
type Capabilities = Parameters<ReaderBus["registerContentCapabilities"]>[0];

let resident: ReaderBus;
let lazy: ReaderBus;

beforeEach(async () => {
  resetModuleState();
  resident = await import("../../extension/reader/reader-bus.js");
  // 模拟轮 B 懒加载区那份实例
  vi.resetModules();
  lazy = await import("../../extension/reader/reader-bus.js");
});

function registerCapabilities(target: ReaderBus, overrides: Partial<Capabilities> = {}) {
  target.registerContentCapabilities({
    persistSettings: () => {},
    loadSettings: () => Promise.resolve(null),
    playerAiSync: () => {},
    ...overrides
  });
}

describe("reader-bus 槽表跨实例共享", () => {
  it("两个模块实例确实不同（前提校验）", () => {
    expect(lazy).not.toBe(resident);
  });

  it("settings persist：常驻实例注册，懒加载区实例调用命中", () => {
    const persist = vi.fn();
    registerCapabilities(resident, { persistSettings: persist });

    lazy.persistReaderSettingsThroughSeam();

    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("settings load：常驻实例注册，懒加载区实例调用取回同一结果", async () => {
    registerCapabilities(resident, { loadSettings: () => Promise.resolve({ readerTheme: "dark" }) });

    await expect(lazy.loadReaderSettingsThroughSeam()).resolves.toEqual({ readerTheme: "dark" });
  });

  it("player-ai sync：常驻实例注册，懒加载区实例请求透传参数", () => {
    const sync = vi.fn();
    registerCapabilities(resident, { playerAiSync: sync });

    lazy.requestPlayerAiSync(120, { resetRetry: true });

    expect(sync).toHaveBeenCalledWith(120, { resetRetry: true });
  });

  it("tabIntent 反向槽（ui→reader）：一侧实例注册，另一侧实例上报命中", () => {
    const intent = vi.fn();
    resident.subscribeTabIntent(intent);

    lazy.reportTabIntent("chat");

    expect(intent).toHaveBeenCalledTimes(1);
    expect(intent).toHaveBeenCalledWith("chat");
  });

  it("外点关闭转发槽同样跨实例：一侧注册，另一侧转发命中", () => {
    const handler = vi.fn();
    resident.setChatTabOutsideClickHandler(handler);
    const event = new MouseEvent("click");

    lazy.dispatchChatTabOutsideClick(event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it("presenter 订阅表同样跨实例：一侧订阅、另一侧发布可达", () => {
    const received: unknown[] = [];
    resident.subscribeReaderPresenter((event) => {
      received.push(event);
    });

    lazy.notifyReaderPresenter({ kind: "status", text: "抓取完成，可以复制或下载字幕。" });

    expect(received).toEqual([{ kind: "status", text: "抓取完成，可以复制或下载字幕。" }]);
  });

  it("未注册时消费端静默（不抛）", async () => {
    expect(() => lazy.persistReaderSettingsThroughSeam()).not.toThrow();
    expect(() => lazy.requestPlayerAiSync()).not.toThrow();
    await expect(lazy.loadReaderSettingsThroughSeam()).resolves.toBe(null);
  });
});
