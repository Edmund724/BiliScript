import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createLiveToolsBridge } from "../../extension/live/live-tools-bridge.js";
import { runVideoBackendTask } from "../../extension/live/video-backend-task.js";
import type { ClipState } from "../../extension/core/state.js";

const URL = "https://www.bilibili.com/video/BV1test000000/?p=2";

const READY_ANALYSIS = {
  summary: "全片简介",
  chapters: [{ from: 0, to: 40, title: "开场", summary: "介绍原理" }],
  quotes: [{ from: 10, content: "连接建立后才有工具调用" }]
};

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
      ],
      overview: null
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

  it("matches multi-part videos in watchlater playlist without explicit p query param", async () => {
    const watchlaterUrl = "https://www.bilibili.com/list/watchlater?bvid=BV1test000000&oid=123";
    const bridge = createLiveToolsBridge({
      getClip: () => makeClip({ pageIndex: 2, cid: "123" }),
      getUrl: () => watchlaterUrl
    });
    const context = bridge.getVideoContext();
    expect(context).not.toBeNull();
    expect(context?.pageIndex).toBe(2);
    expect(context?.bvid).toBe("BV1test000000");

    const result = await bridge.executeTool({
      callId: "c-wl",
      name: "search_video_subtitles",
      arguments: { query: "开场" },
      video: { bvid: "BV1test000000", cid: "123", pageIndex: 2 }
    });
    expect(result.ok).toBe(true);
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

  it("seeks to the second point from timestamped facts injected by a backend summary", async () => {
    const { bridge, video } = setupPlayer();
    let injectedFacts = "";
    await runVideoBackendTask({
      taskId: "summary-seek",
      objective: "总结全片核心内容",
      signal: new AbortController().signal,
      onSilentProgress: (facts) => {
        injectedFacts += facts;
      },
      onSpokenResult: () => {}
    }, {
      getClip: () => makeClip(),
      resolveProvider: async () => ({ baseUrl: "https://api.example.com", model: "text-model" }),
      runOverviewAnalysis: async () => ({
        summary: "三点总结",
        chapters: [
          { from: 0, to: 300, title: "第一点", summary: "开场" },
          { from: 300, to: 600, title: "第二点", summary: "核心实现" },
          { from: 600, to: 900, title: "第三点", summary: "总结" }
        ],
        quotes: []
      })
    });

    expect(injectedFacts).toContain("### [5:00] 第二点");
    const result = await bridge.executeTool({
      callId: "seek-second-point",
      name: "control_bilibili_player",
      arguments: { command: "seek", time: 300 }
    });
    expect(result).toMatchObject({ ok: true, currentTime: 300, message: "已跳转到 5:00" });
    expect(video.currentTime).toBe(300);
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
  it("carries the reader overview snapshot with coverage and stable status text", () => {
    const bridge = createLiveToolsBridge({
      getClip: () => makeClip(),
      getUrl: () => URL,
      getOverview: () => ({
        phase: "ready",
        analysis: {
          summary: "全片简介",
          chapters: [{ from: 0, to: 40, title: "开场", summary: "介绍原理" }],
          quotes: [{ from: 10, content: "连接建立后才有工具调用" }]
        },
        errorText: ""
      })
    });

    const context = bridge.getVideoContext();
    expect(context?.overview).toMatchObject({
      phase: "ready",
      coverage: "complete",
      summary: "全片简介",
      chapters: [{ time: "0:00", title: "开场", summary: "介绍原理" }],
      quotes: [{ time: "0:10", content: "连接建立后才有工具调用" }]
    });
  });

  it("marks partial overviews incomplete and keeps the failed ranges in context", () => {
    const bridge = createLiveToolsBridge({
      getClip: () => makeClip(),
      getUrl: () => URL,
      getOverview: () => ({
        phase: "partial",
        analysis: { ...READY_ANALYSIS, failedRanges: [{ from: 120, to: 300 }] },
        errorText: ""
      })
    });

    const overview = bridge.getVideoContext()?.overview;
    expect(overview?.coverage).toBe("partial");
    expect(overview?.statusText).toContain("覆盖不完整");
    expect(overview?.failedRanges).toEqual([{ from: 120, to: 300 }]);
  });

  it("never carries full subtitles alongside the overview", () => {
    const bridge = createLiveToolsBridge({
      getClip: () => makeClip(),
      getUrl: () => URL,
      getOverview: () => ({ phase: "ready", analysis: READY_ANALYSIS, errorText: "" })
    });

    expect(JSON.stringify(bridge.getVideoContext())).not.toContain("WebSocket 建立连接");
  });

  describe("summarize_video", () => {
    const videoIdentity = { bvid: "BV1test000000", cid: "123", pageIndex: 2 };

    it("returns cached overview immediately when already ready without calling ensureOverview", async () => {
      const ensureOverview = vi.fn();
      const bridge = createLiveToolsBridge({
        getClip: () => makeClip(),
        getUrl: () => URL,
        getOverview: () => ({ phase: "ready", analysis: READY_ANALYSIS, errorText: "" }),
        ensureOverview
      });

      const res = await bridge.executeTool({
        callId: "call-cached",
        name: "summarize_video",
        arguments: {},
        video: videoIdentity
      });

      expect(ensureOverview).not.toHaveBeenCalled();
      expect(res).toEqual({
        ok: true,
        video: videoIdentity,
        coverage: "complete",
        summary: "全片简介",
        chapters: [{ from: 0, to: 40, time: "0:00", title: "开场", summary: "介绍原理" }],
        quotes: [{ from: 10, time: "0:10", content: "连接建立后才有工具调用" }]
      });
    });

    it("summarizes multi-part video in watchlater playlist without explicit p param", async () => {
      const watchlaterUrl = "https://www.bilibili.com/list/watchlater?bvid=BV1test000000&oid=123";
      const wlIdentity = { bvid: "BV1test000000", cid: "123", pageIndex: 2 };
      let overviewSource: any = { phase: "idle", analysis: null, errorText: "" };
      const ensureOverview = vi.fn(async () => {
        overviewSource = { phase: "ready", analysis: READY_ANALYSIS, errorText: "" };
        return overviewSource;
      });

      const bridge = createLiveToolsBridge({
        getClip: () => makeClip({ pageIndex: 2, cid: "123" }),
        getUrl: () => watchlaterUrl,
        getOverview: () => overviewSource,
        ensureOverview
      });

      const res = await bridge.executeTool({
        callId: "call-wl-summary",
        name: "summarize_video",
        arguments: {},
        video: wlIdentity
      });

      expect(ensureOverview).toHaveBeenCalledTimes(1);
      expect(res.ok).toBe(true);
      expect(res.video).toEqual(wlIdentity);
      expect(res.coverage).toBe("complete");
      expect(res.summary).toBe("全片简介");
    });

    it("returns cached partial overview with explicit failed ranges and partial coverage", async () => {
      const bridge = createLiveToolsBridge({
        getClip: () => makeClip(),
        getUrl: () => URL,
        getOverview: () => ({
          phase: "partial",
          analysis: {
            ...READY_ANALYSIS,
            failedRanges: [{ from: 100, to: 200 }],
            summaryFailed: true
          },
          errorText: ""
        })
      });

      const res = await bridge.executeTool({
        callId: "call-partial",
        name: "summarize_video",
        arguments: {},
        video: videoIdentity
      });

      expect(res).toEqual({
        ok: true,
        video: videoIdentity,
        coverage: "partial",
        summary: "全片简介",
        chapters: [{ from: 0, to: 40, time: "0:00", title: "开场", summary: "介绍原理" }],
        quotes: [{ from: 10, time: "0:10", content: "连接建立后才有工具调用" }],
        failedRanges: [{ from: 100, to: 200 }],
        summaryFailed: true
      });
    });

    it("triggers and awaits ensureOverview when overview is not yet generated", async () => {
      let overviewSource: any = { phase: "idle", analysis: null, errorText: "" };
      const ensureOverview = vi.fn(async () => {
        overviewSource = { phase: "ready", analysis: READY_ANALYSIS, errorText: "" };
        return overviewSource;
      });

      const bridge = createLiveToolsBridge({
        getClip: () => makeClip(),
        getUrl: () => URL,
        getOverview: () => overviewSource,
        ensureOverview
      });

      const res = await bridge.executeTool({
        callId: "call-gen",
        name: "summarize_video",
        arguments: {},
        video: videoIdentity
      });

      expect(ensureOverview).toHaveBeenCalledTimes(1);
      expect(res.ok).toBe(true);
      expect(res.coverage).toBe("complete");
      expect(res.summary).toBe("全片简介");
    });

    it("returns cached overview immediately even if subtitle is currently loading", async () => {
      const ensureOverview = vi.fn();
      const bridge = createLiveToolsBridge({
        getClip: () => makeClip({ subtitleFetchState: "loading" }),
        getUrl: () => URL,
        getOverview: () => ({ phase: "ready", analysis: READY_ANALYSIS, errorText: "" }),
        ensureOverview
      });

      const res = await bridge.executeTool({
        callId: "call-cached-loading",
        name: "summarize_video",
        arguments: {},
        video: videoIdentity
      });

      expect(ensureOverview).not.toHaveBeenCalled();
      expect(res.ok).toBe(true);
      expect(res.coverage).toBe("complete");
      expect(res.summary).toBe("全片简介");
    });

    it("reuses concurrent in-flight generation without starting second task", async () => {
      let resolvePromise: any;
      const pending = new Promise<any>((resolve) => {
        resolvePromise = resolve;
      });
      const ensureOverview = vi.fn(() => pending);

      const bridge = createLiveToolsBridge({
        getClip: () => makeClip(),
        getUrl: () => URL,
        getOverview: () => ({ phase: "idle", analysis: null, errorText: "" }),
        ensureOverview
      });

      const p1 = bridge.executeTool({
        callId: "call-1",
        name: "summarize_video",
        arguments: {},
        video: videoIdentity
      });
      const p2 = bridge.executeTool({
        callId: "call-2",
        name: "summarize_video",
        arguments: {},
        video: videoIdentity
      });

      resolvePromise({ phase: "ready", analysis: READY_ANALYSIS, errorText: "" });
      const [res1, res2] = await Promise.all([p1, p2]);

      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);
      expect(res1.summary).toBe("全片简介");
      expect(res2.summary).toBe("全片简介");
      expect(ensureOverview).toHaveBeenCalledTimes(2); // bridge passes to ensureOverview, coordinator deduplicates
    });

    it("passes forceRefresh: true when retrying from previous error or cancelled phase", async () => {
      const ensureOverview = vi.fn(async (_opts?: { forceRefresh?: boolean }) => ({
        phase: "ready",
        analysis: READY_ANALYSIS,
        errorText: ""
      }));

      const bridge = createLiveToolsBridge({
        getClip: () => makeClip(),
        getUrl: () => URL,
        getOverview: () => ({ phase: "cancelled", analysis: null, errorText: "已取消" }),
        ensureOverview
      });

      const res = await bridge.executeTool({
        callId: "call-retry",
        name: "summarize_video",
        arguments: {},
        video: videoIdentity
      });

      expect(ensureOverview).toHaveBeenCalledWith({ forceRefresh: true });
      expect(res.ok).toBe(true);
      expect(res.coverage).toBe("complete");
    });

    it("returns error without triggering when subtitle is loading, error, or empty", async () => {
      const ensureOverview = vi.fn();
      const loadingBridge = createLiveToolsBridge({
        getClip: () => makeClip({ subtitleFetchState: "loading" }),
        getUrl: () => URL,
        ensureOverview
      });
      const loadingRes = await loadingBridge.executeTool({
        callId: "c1",
        name: "summarize_video",
        arguments: {},
        video: videoIdentity
      });
      expect(loadingRes.ok).toBe(false);
      expect(loadingRes.error).toContain("字幕仍在加载");

      const emptyBridge = createLiveToolsBridge({
        getClip: () => makeClip({ subtitleBody: [] }),
        getUrl: () => URL,
        ensureOverview
      });
      const emptyRes = await emptyBridge.executeTool({
        callId: "c2",
        name: "summarize_video",
        arguments: {},
        video: videoIdentity
      });
      expect(emptyRes.ok).toBe(false);
      expect(emptyRes.error).toContain("没有可用字幕");
      expect(ensureOverview).not.toHaveBeenCalled();
    });

    it("returns clear failure when cost guard is declined / cancelled", async () => {
      const ensureOverview = vi.fn(async () => ({
        phase: "cancelled",
        analysis: null,
        errorText: "费用确认已取消，未生成全片概览"
      }));

      const bridge = createLiveToolsBridge({
        getClip: () => makeClip(),
        getUrl: () => URL,
        ensureOverview
      });

      const res = await bridge.executeTool({
        callId: "c3",
        name: "summarize_video",
        arguments: {},
        video: videoIdentity
      });

      expect(res.ok).toBe(false);
      expect(res.error).toContain("取消");
    });

    it("drops late overview and returns error when video switched during generation", async () => {
      let currentUrl = URL;
      let clip = makeClip();
      const ensureOverview = vi.fn(async () => {
        // 模拟生成期间发生换片
        currentUrl = "https://www.bilibili.com/video/BV1other000000/?p=1";
        clip = makeClip({ bvid: "BV1other000000", cid: "999", pageIndex: 1 });
        return { phase: "ready", analysis: READY_ANALYSIS, errorText: "" };
      });

      const bridge = createLiveToolsBridge({
        getClip: () => clip,
        getUrl: () => currentUrl,
        ensureOverview
      });

      const res = await bridge.executeTool({
        callId: "c4",
        name: "summarize_video",
        arguments: {},
        video: videoIdentity
      });

      expect(res.ok).toBe(false);
      expect(res.error).toContain("视频已切换");
    });

    it("initializes text tool host on demand when chat/reader DOM does not exist and returns summary", async () => {
      const { state } = await import("../../extension/core/state.js");
      const { createLiveToolsBridge: createFreshBridge } = await import("../../extension/live/live-tools-bridge.js");
      Object.assign(state.clip, makeClip());

      const sendMessageMock = globalThis.chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
      sendMessageMock.mockImplementation((message: Record<string, unknown>, callback?: (resp: unknown) => void) => {
        if (message?.type === "resolve-ai-provider") {
          callback?.({
            ok: true,
            provider: {
              id: "prov-1",
              presetId: "custom",
              name: "测试文本模型",
              baseUrl: "https://api.example.com/v1",
              model: "text-model",
              enabled: true,
              hasSavedKey: true
            },
            apiKey: "sk-test"
          });
          return undefined;
        }
        callback?.({ ok: true });
        return undefined;
      });

      const analysisModule = await import("../../extension/ai/analysis.js");
      const runOverviewSpy = vi.spyOn(analysisModule, "runOverviewAnalysis").mockResolvedValue(READY_ANALYSIS);

      expect(document.getElementById("biliscript-reading-view")).toBeNull();
      expect(document.getElementById("biliscript-chat-messages")).toBeNull();

      const bridge = createFreshBridge({
        getUrl: () => URL
      });

      const res = await bridge.executeTool({
        callId: "call-on-demand",
        name: "summarize_video",
        arguments: {},
        video: videoIdentity
      });

      expect(runOverviewSpy).toHaveBeenCalledTimes(1);
      expect(res).toMatchObject({
        ok: true,
        video: videoIdentity,
        coverage: "complete",
        summary: "全片简介"
      });
      // 不创建文摘面板或对话 DOM
      expect(document.getElementById("biliscript-reading-view")).toBeNull();
      expect(document.getElementById("biliscript-chat-messages")).toBeNull();
      // 概览快照已同步进上下文
      expect(bridge.getVideoContext()?.overview?.summary).toBe("全片简介");
    });

    it("returns explicit failure when text model provider is unavailable without throwing", async () => {
      const { state } = await import("../../extension/core/state.js");
      const { createLiveToolsBridge: createFreshBridge } = await import("../../extension/live/live-tools-bridge.js");
      Object.assign(state.clip, makeClip());

      const sendMessageMock = globalThis.chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
      sendMessageMock.mockImplementation((message: Record<string, unknown>, callback?: (resp: unknown) => void) => {
        if (message?.type === "resolve-ai-provider") {
          callback?.({
            ok: false,
            error: "还没有配置 AI 平台，请先在插件设置中添加并启用。"
          });
          return undefined;
        }
        callback?.({ ok: true });
        return undefined;
      });

      const bridge = createFreshBridge({
        getUrl: () => URL
      });

      const res = await bridge.executeTool({
        callId: "call-no-provider",
        name: "summarize_video",
        arguments: {},
        video: videoIdentity
      });

      expect(res).toEqual({
        ok: false,
        error: expect.stringContaining("还没有配置 AI 平台")
      });
      expect(document.getElementById("biliscript-reading-view")).toBeNull();
    });
  });

});
