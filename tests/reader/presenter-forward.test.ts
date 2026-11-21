import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let presenter: typeof import("../../extension/reader/reader-bus.js");
let received: unknown[];

beforeEach(async () => {
  resetModuleState();
  presenter = await import("../../extension/reader/reader-bus.js");
  received = [];
  presenter.subscribeReaderPresenter((event) => {
    received.push(event);
  });
});

describe("notifyReaderPresenter 透传", () => {
  it("notice 提示文本：text 透传给 reader 侧 handler", () => {
    presenter.notifyReaderPresenter({ kind: "notice", text: "字幕轨切换失败" });

    expect(received).toEqual([{ kind: "notice", text: "字幕轨切换失败" }]);
  });

  it("无文案事件：handler 只收到 kind", () => {
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
      presenter.notifyReaderPresenter({ kind: "notice", text: "提示" })
    ).not.toThrow();
    expect(ok).toHaveBeenCalledWith({ kind: "notice", text: "提示" });
  });
});
