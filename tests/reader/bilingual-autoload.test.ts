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
