import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";

describe("agent-bridge content-subtitles 轮询边界", () => {
  beforeEach(() => {
    resetModuleState();
    setLocationUrl(NORMAL_PAGE_URL);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("subtitleFetchState=loading 持续卡住时在有界超时后退出，不无限轮询", async () => {
    const { clipState } = await import("../../extension/core/state.js");
    const { getAgentBridgeSubtitles, WAIT_FOR_SUBTITLES_TIMEOUT_MS } = await import(
      "../../extension/agent-bridge/content-subtitles.js"
    );

    clipState.setBvid("BV1test000000");
    clipState.setCid("101");
    clipState.setPageIndex(1);
    clipState.setSubtitleFetchState("loading");
    clipState.setSubtitleBody([]);

    const pending = getAgentBridgeSubtitles();
    const assertion = expect(pending).rejects.toThrow("等待字幕抓取超时");

    await vi.advanceTimersByTimeAsync(WAIT_FOR_SUBTITLES_TIMEOUT_MS + 250);
    await assertion;
  });

  it("loading 在超时前就绪时立即返回字幕结果", async () => {
    const { clipState } = await import("../../extension/core/state.js");
    const { getAgentBridgeSubtitles } = await import("../../extension/agent-bridge/content-subtitles.js");

    clipState.setBvid("BV1test000000");
    clipState.setCid("101");
    clipState.setPageIndex(1);
    clipState.setSubtitleFetchState("loading");
    clipState.setSubtitleBody([]);

    const pending = getAgentBridgeSubtitles();
    await vi.advanceTimersByTimeAsync(250);

    clipState.setSelectedSubtitleId("track-1");
    clipState.setSelectedSubtitleLang("中文");
    clipState.setSubtitleBody([{ from: 0, to: 5, content: "就绪句" }]);
    clipState.setSubtitleFetchState("ready");

    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toMatchObject({
      bvid: "BV1test000000",
      cid: "101",
      subtitle: {
        trackId: "track-1",
        language: "中文",
        items: [{ from: 0, to: 5, content: "就绪句" }]
      }
    });
  });
});
