// 主轨就绪后的副轨自动装载：**接线**（"subtitle-ready" 通知 → 副轨装载事务）。
//
// 判定与装载本体（目标解析的三态、两级匹配、排除主轨、三重守卫、在飞登记、参数口径）
// 已下沉到 tests/reader/secondary-subtitle.test.ts 的新模块接口上——那里不再需要
// 经「通知 → lifecycle」这条远端路径就能覆盖全部失败方式。本文件只留接线独有的两件事：
//   1. 通知确实会走到事务（lifecycle 的 handler 没有把这条调用漏掉）；
//   2. 自动装载失败不污染通知链（事务自己吞异常，副列 error 占位即用户的入口）。
//
// 系统可能怎么坏：
//   a. lifecycle 的 subtitle-ready 分支漏调事务（双语开着却永远不抓副轨）；
//   b. 自动装载的异常抛回通知链（主轨渲染路径被副轨失败带崩）；
//   c. 视图未开就不抓（Q1：双语是全局偏好，切到字幕 tab 时就该已经就绪）。
//
// mock 只有一条边界：总结链（lazy.js）——它是网络入口，其余（state、lifecycle、
// 通知分派、副轨事务本体）全部走真实实现。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";

const lazy = vi.hoisted(() => ({
  loadSecondarySubtitle: vi.fn(async () => {})
}));

vi.mock("../../extension/subtitle/lazy.js", () => ({
  ensureSummarizeChain: vi.fn(async () => ({
    refreshClip: vi.fn(),
    loadSubtitle: vi.fn(),
    loadSecondarySubtitle: lazy.loadSecondarySubtitle,
    resetClipState: vi.fn(),
    copySubtitleTranscript: vi.fn(),
    downloadSubtitle: vi.fn()
  }))
}));

let lifecycle: typeof import("../../extension/reader/lifecycle.js");
let state: (typeof import("../../extension/core/state.js"))["state"];
let clipState: (typeof import("../../extension/core/state.js"))["clipState"];

const EN_TRACK = {
  id: "2121827445538866944",
  lan: "ai-en",
  lanDoc: "English",
  subtitleUrl: "https://sub/ai-en.json",
  source: "player"
};
const ZH_TRACK = {
  id: "2120476497172283392",
  lan: "ai-zh",
  lanDoc: "中文",
  subtitleUrl: "https://sub/ai-zh.json",
  source: "player"
};

async function bootstrap() {
  lifecycle = await import("../../extension/reader/lifecycle.js");
  const stateModule = await import("../../extension/core/state.js");
  state = stateModule.state;
  clipState = stateModule.clipState;
  lazy.loadSecondarySubtitle.mockReset().mockResolvedValue(undefined);
}

function setBilingual(on: boolean, lang = "en-US") {
  state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: on, secondarySubtitleLang: lang });
}

beforeEach(async () => {
  resetModuleState();
  await bootstrap();
  clipState.setFetchRunId(3);
});

afterEach(() => {
  state.setSettings({ ...DEFAULT_SETTINGS });
});

describe("主轨就绪后的副轨自动装载（接线）", () => {
  it("subtitle-ready ⇒ 按全局偏好装载副轨（比面板可见更早；槽语言取 lanDoc）", async () => {
    setBilingual(true, "en-US");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);

    // 面板未打开（readingViewOpen=false）也照抓：双语是全局偏好，切到字幕 tab 时就该就绪
    lifecycle.handleReaderPresenterNotification({ kind: "subtitle-ready" });

    await vi.waitFor(() => expect(lazy.loadSecondarySubtitle).toHaveBeenCalledTimes(1));
    expect(lazy.loadSecondarySubtitle).toHaveBeenCalledWith(
      EN_TRACK.subtitleUrl,
      EN_TRACK.lanDoc,
      3,
      EN_TRACK.id,
      false
    );
  });

  it("双语关 ⇒ 通知链不装载（零行为差）", async () => {
    setBilingual(false);
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);

    lifecycle.handleReaderPresenterNotification({ kind: "subtitle-ready" });
    await Promise.resolve();

    expect(lazy.loadSecondarySubtitle).not.toHaveBeenCalled();
  });

  it("自动装载失败不抛出到通知链（副列 error 占位即用户的入口）", async () => {
    setBilingual(true, "en-US");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);
    lazy.loadSecondarySubtitle.mockRejectedValueOnce(new Error("boom"));

    expect(() => lifecycle.handleReaderPresenterNotification({ kind: "subtitle-ready" })).not.toThrow();
    await vi.waitFor(() => expect(lazy.loadSecondarySubtitle).toHaveBeenCalledTimes(1));
  });
});
