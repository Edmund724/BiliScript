// Presenter seam 在 reader 域自注册（双实例缺陷回归测试）。
//
// 缺陷背景：lifecycle.js 曾将 notifyReaderPresenter 订阅放在「仅打开阅读视图才
// 跑」的路径里，而 presenter 是模块级单例；若在阅读视图打开前有抓取完成通知，
// 状态行和字幕列表都丢通知。修复后由 lifecycle 模块求值期顶层注册。
//
// 依赖：setup（READER_MODE_URL）、reader-skeleton、reader/reader-bus、
// reader/index（触发域装载）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
let presenter: typeof import("../../extension/reader/reader-bus.js");

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  mountReaderSkeleton(ids);
  mountPlayerChain();
  presenter = await import("../../extension/reader/reader-bus.js");
  // 域装载：lifecycle 模块求值期注册 presenter 订阅（本用例的断言面）
  await import("../../extension/reader/index.js");
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("reader 域自注册 presenter 订阅（双实例缺陷回归）", () => {
  it("notice 通知直达字幕提示节点，reset 清空", () => {
    const notice = document.getElementById(ids.readingSubtitleNotice) as HTMLElement;

    presenter.notifyReaderPresenter({ kind: "notice", text: "字幕轨切换失败" });

    expect(notice.textContent).toBe("字幕轨切换失败");

    presenter.notifyReaderPresenter({ kind: "reset" });

    expect(notice.textContent).toBe("");
  });

  it("subtitle-ready 通知渲染字幕列表（域内处理体可达）", () => {
    state.reader.setViewOpen(true);
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];

    presenter.notifyReaderPresenter({ kind: "subtitle-ready" });

    expect(document.querySelectorAll(".biliscript-reading-item").length).toBe(1);
  });
});
