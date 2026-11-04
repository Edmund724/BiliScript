import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createLiveToolsBridge } from "../../extension/live/live-tools-bridge.js";
import type { ClipState } from "../../extension/core/state.js";

const URL = "https://www.bilibili.com/video/BV1test000000/?p=2";

function makeClip(overrides: Partial<ClipState> = {}): Partial<ClipState> {
  return {
    bvid: "BV1test000000",
    cid: "123",
    title: "实时语音原理",
    pageIndex: 2,
    pageCount: 3,
    pageTitle: "工具调用",
    subtitleFetchState: "ready",
    subtitleBody: [
      { from: 0, to: 4, content: "开场介绍" },
      { from: 10, to: 14, content: "WebSocket 建立连接" },
      { from: 40, to: 44, content: "字幕检索与工具调用" },
      { from: 3725, to: 3728, content: "一小时后的总结" }
    ],
    chapters: [
      { title: "后半部分", from: 40 },
      { title: "开场", from: 0, to: 10 }
    ],
    ...overrides
  };
}

beforeEach(() => {
  resetModuleState();
  document.body.replaceChildren();
});

describe("createLiveToolsBridge", () => {
  it("projects current video, part and normalized chapters into session context", () => {
    const bridge = createLiveToolsBridge({ getClip: () => makeClip(), getUrl: () => URL });
    expect(bridge.getVideoContext()).toEqual({
      url: URL,
      bvid: "BV1test000000",
      cid: "123",
      title: "实时语音原理",
      pageIndex: 2,
      pageCount: 3,
      pageTitle: "工具调用",
      chapters: [
        { title: "开场", from: 0, to: 10 },
        { title: "后半部分", from: 40, to: 0 }
      ]
    });
  });

  it("queries subtitles around the current playback position and returns single-source clock text", async () => {
    const bridge = createLiveToolsBridge({
      getClip: () => makeClip(),
      getUrl: () => URL,
      getCurrentTime: () => 12
    });
    const result = await bridge.executeTool({
      callId: "c1",
      name: "get_subtitles_around_time",
      arguments: { before_seconds: 5, after_seconds: 35 }
    });
    expect(result).toMatchObject({
      ok: true,
      currentTime: 12,
      window: { from: 7, to: 47 },
      total: 2
    });
    expect(result.items).toEqual([
      { from: 10, to: 14, time: "0:10", content: "WebSocket 建立连接" },
      { from: 40, to: 44, time: "0:40", content: "字幕检索与工具调用" }
    ]);
  });

  it("searches the whole current part case-insensitively and caps result count", async () => {
    const bridge = createLiveToolsBridge({ getClip: () => makeClip(), getUrl: () => URL });
    const result = await bridge.executeTool({
      callId: "c2",
      name: "search_video_subtitles",
      arguments: JSON.stringify({ query: "websocket", max_results: 1 })
    });
    expect(result).toMatchObject({ ok: true, query: "websocket", total: 1 });
    expect(result.items).toEqual([
      { from: 10, to: 14, time: "0:10", content: "WebSocket 建立连接" }
    ]);
  });

  it("uses hour-aware clock text for long videos", async () => {
    const bridge = createLiveToolsBridge({ getClip: () => makeClip(), getUrl: () => URL });
    const result = await bridge.executeTool({
      callId: "c3",
      name: "get_subtitles_around_time",
      arguments: { current_time: 3725, before_seconds: 1, after_seconds: 1 }
    });
    expect(result.items).toEqual([
      { from: 3725, to: 3728, time: "1:02:05", content: "一小时后的总结" }
    ]);
  });

  it("rejects stale SPA clips and never exposes the previous video subtitles", async () => {
    const showNotice = vi.fn();
    const bridge = createLiveToolsBridge({ getClip: () => makeClip(), getUrl: () => URL, showNotice });
    const switchedUrl = "https://www.bilibili.com/video/BV1other00000/?p=1";
    const stale = createLiveToolsBridge({ getClip: () => makeClip(), getUrl: () => switchedUrl, showNotice });
    expect(stale.getVideoContext()).toBeNull();
    const result = await stale.executeTool({ callId: "c4", name: "search_video_subtitles", arguments: { query: "开场" } });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("视频已切换") });
    expect(result.items).toBeUndefined();
    expect(showNotice).toHaveBeenCalledWith(expect.stringContaining("视频已切换"), 4000);
  });

  it.each<Partial<ClipState>>([
    { subtitleFetchState: "loading", subtitleBody: [] },
    { subtitleFetchState: "empty", subtitleBody: [] },
    { subtitleFetchState: "error", subtitleBody: [] }
  ])("returns explicit subtitle state $subtitleFetchState without throwing", async (subtitleState) => {
    const showNotice = vi.fn();
    const bridge = createLiveToolsBridge({
      getClip: () => makeClip(subtitleState),
      getUrl: () => URL,
      showNotice
    });
    const result = await bridge.executeTool({
      callId: "c5",
      name: "get_subtitles_around_time",
      arguments: {}
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(showNotice).toHaveBeenLastCalledWith(result.error, 4000);
  });

  it("turns malformed arguments and unknown tools into feedback instead of rejected promises", async () => {
    const bridge = createLiveToolsBridge({ getClip: () => makeClip(), getUrl: () => URL });
    await expect(bridge.executeTool({
      callId: "c6",
      name: "search_video_subtitles",
      arguments: "not-json"
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("字幕工具执行失败") });
    await expect(bridge.executeTool({ callId: "c7", name: "unknown", arguments: {} }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining("不支持") });
  });
});

describe("control_bilibili_player", () => {
  function setupPlayer(readyState = 1) {
    const wrap = document.createElement("div");
    wrap.className = "bpx-player-video-wrap";
    const video = document.createElement("video");
    wrap.append(video);
    document.body.append(wrap);
    Object.defineProperty(video, "readyState", { configurable: true, value: readyState });
    Object.defineProperty(video, "duration", { configurable: true, value: 4000 });
    const play = vi.spyOn(video, "play").mockResolvedValue();
    const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
    const bridge = createLiveToolsBridge({
      getClip: () => makeClip(),
      getUrl: () => URL,
      getPlayer: () => video
    });
    return { bridge, video, play, pause };
  }

  it("seeks, pauses, plays and changes playback rate on the current Bilibili video", async () => {
    const { bridge, video, play, pause } = setupPlayer();
    await expect(bridge.executeTool({
      callId: "seek-1",
      name: "control_bilibili_player",
      arguments: { command: "seek", time: 3725 }
    })).resolves.toMatchObject({ ok: true, command: "seek", currentTime: 3725, message: "已跳转到 1:02:05" });
    await expect(bridge.executeTool({
      callId: "rate-1",
      name: "control_bilibili_player",
      arguments: JSON.stringify({ command: "rate", rate: 1.5 })
    })).resolves.toMatchObject({ ok: true, playbackRate: 1.5 });
    await expect(bridge.executeTool({
      callId: "pause-1",
      name: "control_bilibili_player",
      arguments: { command: "pause" }
    })).resolves.toMatchObject({ ok: true, command: "pause" });
    await expect(bridge.executeTool({
      callId: "play-1",
      name: "control_bilibili_player",
      arguments: { command: "play" }
    })).resolves.toMatchObject({ ok: true, command: "play" });
    expect(video.currentTime).toBe(3725);
    expect(video.playbackRate).toBe(1.5);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("uses a subtitle search result timestamp for semantic navigation", async () => {
    const { bridge, video } = setupPlayer();
    const found = await bridge.executeTool({
      callId: "search-summary",
      name: "search_video_subtitles",
      arguments: { query: "总结" }
    });
    const item = (found.items as Array<{ from: number }>)[0];
    const result = await bridge.executeTool({
      callId: "seek-summary",
      name: "control_bilibili_player",
      arguments: { command: "seek", time: item.from }
    });
    expect(found).toMatchObject({ ok: true, total: 1 });
    expect(result).toMatchObject({ ok: true, currentTime: 3725 });
    expect(video.currentTime).toBe(3725);
  });

  it.each([
    {},
    { command: "seek" },
    { command: "seek", time: -1 },
    { command: "seek", time: Number.NaN },
    { command: "seek", time: Number.POSITIVE_INFINITY },
    { command: "seek", time: 4001 },
    { command: "seek", time: "12" },
    { command: "rate" },
    { command: "rate", rate: 1.2 },
    { command: "rate", rate: 3 },
    { command: "rate", rate: "2" },
    { command: "volume" }
  ])("rejects invalid or missing arguments without changing the player: %j", async (args) => {
    const { bridge, video, play, pause } = setupPlayer();
    video.currentTime = 12;
    const result = await bridge.executeTool({ callId: "invalid", name: "control_bilibili_player", arguments: args });
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
    expect(video.currentTime).toBe(12);
    expect(video.playbackRate).toBe(1);
    expect(play).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it("rejects a missing or unready player and reports play rejection as failure", async () => {
    const missing = createLiveToolsBridge({ getClip: () => makeClip(), getUrl: () => URL, getPlayer: () => null });
    await expect(missing.executeTool({
      callId: "missing",
      name: "control_bilibili_player",
      arguments: { command: "pause" }
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("尚未就绪") });

    const { bridge, play } = setupPlayer(0);
    await expect(bridge.executeTool({
      callId: "unready",
      name: "control_bilibili_player",
      arguments: { command: "play" }
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("尚未就绪") });
    expect(play).not.toHaveBeenCalled();

    const ready = setupPlayer();
    ready.play.mockRejectedValue(new Error("NotAllowedError"));
    await expect(ready.bridge.executeTool({
      callId: "denied",
      name: "control_bilibili_player",
      arguments: { command: "play" }
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("NotAllowedError") });
  });

  it("rejects a call stamped with the previous SPA video identity", async () => {
    const { bridge, video } = setupPlayer();
    video.currentTime = 12;
    const result = await bridge.executeTool({
      callId: "stale",
      name: "control_bilibili_player",
      arguments: { command: "seek", time: 40 },
      video: { bvid: "BV1old0000000", cid: "123", pageIndex: 2 }
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("视频已切换") });
    expect(video.currentTime).toBe(12);
  });
});
