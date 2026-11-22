import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let transitionReaderShell: typeof import("../../extension/core/state.js").transitionReaderShell;
let ids: typeof import("../../extension/reader/state.js").ids;
let presenter: typeof import("../../extension/reader/reader-bus.js");

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  setLocationUrl(READER_MODE_URL);
  const stateMod = await import("../../extension/core/state.js");
  state = stateMod.state as TestState;
  transitionReaderShell = stateMod.transitionReaderShell;
  ids = (await import("../../extension/reader/state.js")).ids;
  mountReaderSkeleton(ids);
  mountPlayerChain();
  presenter = await import("../../extension/reader/reader-bus.js");
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
    transitionReaderShell("open");
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];

    presenter.notifyReaderPresenter({ kind: "subtitle-ready" });

    expect(document.querySelectorAll(".biliscript-reading-item").length).toBe(1);
  });
});
