// reader/reader-bus.ts（presenter seam，arch-slim-2/03 改名）的 notifyReaderPresenter 事件透传测试。
//
// 事件对象原样透传给每个 handler：带 text 的 kind（subtitle-ready/status）把状态栏
// 文案送到 reader 侧（例如「当前视频无字幕。」），不带的只有 kind 一栏；handler 异常
// 仍被隔离，不中断其余 handler。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let presenter: typeof import("../../extension/reader/reader-bus.js");
let received: unknown[];

beforeEach(async () => {
  resetModuleState();
  // resetModules 后动态导入：每个用例拿到全新的 presenter 模块（readers
  // 注册表清空），避免跨用例的 handler 累积污染断言。
  presenter = await import("../../extension/reader/reader-bus.js");
  received = [];
  presenter.subscribeReaderPresenter((event) => {
    received.push(event);
  });
});

describe("notifyReaderPresenter 透传", () => {
  it("subtitle-ready + 状态文案：text 透传给 reader 侧 handler", () => {
    presenter.notifyReaderPresenter({ kind: "subtitle-ready", text: "当前视频无字幕。" });

    expect(received).toEqual([{ kind: "subtitle-ready", text: "当前视频无字幕。" }]);
  });

  it("status 提示文本：text 透传（resetClipState 的「请先点击刷新抓取」提示可达阅读视图）", () => {
    presenter.notifyReaderPresenter({ kind: "status", text: "请先点击“刷新抓取”加载当前视频字幕。" });

    expect(received).toEqual([{ kind: "status", text: "请先点击“刷新抓取”加载当前视频字幕。" }]);
  });

  it("无文案事件行为不变：handler 只收到 kind", () => {
    presenter.notifyReaderPresenter({ kind: "reset" });
    presenter.notifyReaderPresenter({ kind: "rerender" });
    presenter.notifyReaderPresenter({ kind: "subtitle-ready" });

    expect(received).toEqual([{ kind: "reset" }, { kind: "rerender" }, { kind: "subtitle-ready" }]);
  });

  it("handler 抛错被隔离：不影响其余 handler（含带文案事件）", () => {
    const failing = vi.fn(() => {
      throw new Error("boom");
    });
    const ok = vi.fn();
    presenter.subscribeReaderPresenter(failing);
    presenter.subscribeReaderPresenter(ok);

    expect(() =>
      presenter.notifyReaderPresenter({ kind: "subtitle-ready", text: "当前视频无字幕。" })
    ).not.toThrow();
    expect(ok).toHaveBeenCalledWith({ kind: "subtitle-ready", text: "当前视频无字幕。" });
  });
});
