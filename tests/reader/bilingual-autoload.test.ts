// 双语副轨的自动装载编排（票 bilingual-subtitles/02 Q1 + Q7a，06 号票落地）。
//
// 主轨就绪（"subtitle-ready" 通知）即副轨起点：双语开着就立刻并行抓，不做面板
// 可见判定、不做滚动懒加载；换视频后按全局偏好 lan 在新轨列表上重新匹配。
// 三重守卫：① 双语关不动；② 槽非 idle 不动（在飞/已就绪/已失败都不重来）；③ 本视频
// 没有目标语言的轨不动（Q4「副列留空、不替用户猜」）。
//
// 系统可能怎么坏（先列失败方式，再据此写用例）：
//   a. 双语关也去抓副轨（白白多一次网络 + 无谓的 loading 占位）；
//   b. 换视频后不重抓（副列永远停在空态）或每次重渲都重抓（网络抖动、loading 闪烁）；
//   c. 匹配用完整 lan 串比对，"en-US" 偏好匹配不上本仓的 "ai-en" 轨（真实形态）；
//   d. 本视频没有该语言轨时自作主张换一条（Q4 明确不猜）；
//   e. 自动装载失败把异常抛出通知链（污染主轨渲染路径）。
//
// mock 只有一条边界：总结链（lazy.js）——它是网络入口，其余（state、lifecycle、
// 通知分派）全部走真实实现。

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

describe("主轨就绪后的副轨自动装载", () => {
  it("双语关 ⇒ 不装载（零行为差）", async () => {
    setBilingual(false);
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);

    lifecycle.handleReaderPresenterNotification("subtitle-ready");
    await Promise.resolve();

    expect(lazy.loadSecondarySubtitle).not.toHaveBeenCalled();
  });

  it("双语开 + 本视频有该语言轨 ⇒ 按主语言子标签匹配并装载（不等面板可见）", async () => {
    setBilingual(true, "en-US");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);

    lifecycle.handleReaderPresenterNotification("subtitle-ready");

    await vi.waitFor(() => expect(lazy.loadSecondarySubtitle).toHaveBeenCalledTimes(1));
    expect(lazy.loadSecondarySubtitle).toHaveBeenCalledWith(
      EN_TRACK.subtitleUrl,
      EN_TRACK.lanDoc,
      3,
      EN_TRACK.id
    );
  });

  it("混源（人工 en-US + AI ai-en）：精确 lan 命中优先，结果不依赖轨序", async () => {
    setBilingual(true, "en-US");
    const CC_TRACK = {
      id: "cc-en",
      lan: "en-US",
      lanDoc: "English (CC)",
      subtitleUrl: "https://sub/cc-en.json",
      source: "player-wbi-v2"
    };
    // AI 轨排在前面：单级子标签匹配会先命中它 ⇒ 两级后必须仍选人工 CC 轨
    clipState.setSubtitles([ZH_TRACK, EN_TRACK, CC_TRACK]);

    lifecycle.handleReaderPresenterNotification("subtitle-ready");

    await vi.waitFor(() => expect(lazy.loadSecondarySubtitle).toHaveBeenCalledTimes(1));
    expect(lazy.loadSecondarySubtitle).toHaveBeenCalledWith(
      CC_TRACK.subtitleUrl,
      CC_TRACK.lanDoc,
      3,
      CC_TRACK.id
    );
  });

  it("精确命中不了时退回主语言子标签（偏好 en-US 命中 ai-en）", async () => {
    setBilingual(true, "en-US");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);

    lifecycle.handleReaderPresenterNotification("subtitle-ready");

    await vi.waitFor(() => expect(lazy.loadSecondarySubtitle).toHaveBeenCalledTimes(1));
    expect(lazy.loadSecondarySubtitle).toHaveBeenCalledWith(
      EN_TRACK.subtitleUrl,
      EN_TRACK.lanDoc,
      3,
      EN_TRACK.id
    );
  });

  it("双语开但本视频没有该语言轨 ⇒ 不装载（副列留空，不替用户猜）", async () => {
    setBilingual(true, "ja-JP");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);

    lifecycle.handleReaderPresenterNotification("subtitle-ready");
    await Promise.resolve();

    expect(lazy.loadSecondarySubtitle).not.toHaveBeenCalled();
  });

  it("ASR 伪轨（无 subtitleUrl）不作为副轨候选", async () => {
    setBilingual(true, "en-US");
    clipState.setSubtitles([{ id: "asr", lan: "en-US", lanDoc: "English", subtitleUrl: "" }]);

    lifecycle.handleReaderPresenterNotification("subtitle-ready");
    await Promise.resolve();

    expect(lazy.loadSecondarySubtitle).not.toHaveBeenCalled();
  });

  it("槽非 idle（已在飞 / 已就绪 / 已失败）⇒ 不重复装载", async () => {
    setBilingual(true, "en-US");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);

    clipState.markSecondarySubtitleLoading({ id: EN_TRACK.id, url: EN_TRACK.subtitleUrl, lang: "English" });
    lifecycle.handleReaderPresenterNotification("subtitle-ready");
    await Promise.resolve();
    expect(lazy.loadSecondarySubtitle).not.toHaveBeenCalled();

    clipState.markSecondarySubtitleError();
    lifecycle.handleReaderPresenterNotification("subtitle-ready");
    await Promise.resolve();
    expect(lazy.loadSecondarySubtitle).not.toHaveBeenCalled();
  });

  it("自动装载失败不抛出到通知链（副列 error 占位即用户的入口）", async () => {
    setBilingual(true, "en-US");
    clipState.setSubtitles([ZH_TRACK, EN_TRACK]);
    lazy.loadSecondarySubtitle.mockRejectedValueOnce(new Error("boom"));

    expect(() => lifecycle.handleReaderPresenterNotification("subtitle-ready")).not.toThrow();
    await vi.waitFor(() => expect(lazy.loadSecondarySubtitle).toHaveBeenCalledTimes(1));
  });
});
