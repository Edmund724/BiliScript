import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

type ReaderBus = typeof import("../../extension/reader/reader-bus.js");
type Capabilities = Parameters<ReaderBus["registerContentCapabilities"]>[0];

let resident: ReaderBus;
let lazy: ReaderBus;

beforeEach(async () => {
  resetModuleState();
  resident = await import("../../extension/reader/reader-bus.js");
  vi.resetModules();
  lazy = await import("../../extension/reader/reader-bus.js");
});

function registerCapabilities(target: ReaderBus, overrides: Partial<Capabilities> = {}) {
  target.registerContentCapabilities({
    persistSettings: () => {},
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

    lazy.notifyReaderPresenter({ kind: "notice", text: "提示文案" });

    expect(received).toEqual([{ kind: "notice", text: "提示文案" }]);
  });

  it("未注册时消费端静默（不抛）", () => {
    expect(() => lazy.persistReaderSettingsThroughSeam()).not.toThrow();
  });
});
