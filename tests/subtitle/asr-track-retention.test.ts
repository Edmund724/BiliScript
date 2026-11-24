// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, setupEnvironment, setLocationUrl } from "../setup.js";
import { installChromeHost, type ChromeHost } from "../helpers/chrome-host.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import {
  clipState,
  registerSubtitleSessionBoundaryHooks,
  state
} from "../../extension/core/state.js";

const mockAsrDeps = vi.hoisted(() => ({
  providers: [
    { id: "p1", type: "openai-transcriptions", name: "Whisper", model: "whisper-1" }
  ] as Array<{ id: string; type?: string; name?: string; model?: string }>,
  runAsrPipeline: vi.fn<(...args: unknown[]) => Promise<Array<{ from: number; to: number; content: string }>>>()
}));

vi.mock("../../extension/reader/reader-bus.js", () => ({
  subscribeSubtitleRefresh: vi.fn(),
  notifyReaderPresenter: vi.fn()
}));
vi.mock("../../extension/core/ui-status.js", () => ({
  setStatus: vi.fn()
}));
vi.mock("../../extension/bilibili/gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/gateway.js")>();
  return {
    ...actual,
    fetchVideoMeta: vi.fn(),
    fetchSubtitleBundle: vi.fn(),
    contentFetchJson: vi.fn(),
    readRuntimeVideoDuration: vi.fn(() => 300)
  };
});
vi.mock("../../extension/reader/page-context.js", () => ({
  resolvePageContext: vi.fn((_url: string, meta: { defaultCid?: string; defaultDuration?: number }) => ({
    pageIndex: 1,
    cid: meta?.defaultCid || "101",
    cidSource: "test",
    pageTitle: "P1",
    duration: meta?.defaultDuration || 300
  }))
}));
vi.mock("../../extension/subtitle/core.js", () => ({
  readVideoTitle: vi.fn(() => "测试标题"),
  readVideoAuthor: vi.fn(() => "测试作者"),
  readUploadDate: vi.fn(() => "2026-01-01"),
  readVideoDescription: vi.fn(() => ""),
  refreshHotComments: vi.fn(async () => {}),
  invalidateDerived: vi.fn(),
  refreshDerivedContent: vi.fn(async () => {})
}));
vi.mock("../../extension/subtitle/commit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/subtitle/commit.js")>();
  return {
    ...actual,
    acceptSubtitle: vi.fn(actual.acceptSubtitle),
    commitNoSubtitle: vi.fn(actual.commitNoSubtitle)
  };
});
vi.mock("../../extension/asr/asr-setup.js", () => ({
  loadAsrProviderList: vi.fn(async () => mockAsrDeps.providers)
}));
vi.mock("../../extension/asr/pipeline.js", () => ({
  runAsrPipeline: (...args: unknown[]) => mockAsrDeps.runAsrPipeline(...args)
}));

import * as fetcher from "../../extension/subtitle/fetcher.js";
import {
  contentFetchJson as fetchBodyMock,
  fetchSubtitleBundle as fetchBundleMock,
  fetchVideoMeta as fetchMetaMock
} from "../../extension/bilibili/gateway.js";
import {
  getSubtitleCacheKey,
  persistAsrSubtitleToCache,
  setSubtitleCacheWriteInterceptorForTests
} from "../../extension/subtitle/cache.js";
import { createAsrPseudoTrack } from "../../extension/subtitle/selection.js";
import { acceptSubtitle, commitNoSubtitle } from "../../extension/subtitle/commit.js";

const ASR_BODY = [
  { from: 0, to: 2, content: "转写第一句" },
  { from: 3, to: 290, content: "转写收尾句" }
];
const NATIVE_BODY = [
  { from: 0, to: 2, content: "原生第一句" },
  { from: 3, to: 290, content: "原生收尾句" }
];

const NATIVE_ZH_OLD = {
  id: "sub-zh",
  lan: "zh-CN",
  lanDoc: "中文",
  subtitleUrl: "https://i0.hdslb.com/zh-old.json",
  source: "player-wbi-v2",
  origin: "bilibili" as const
};
const NATIVE_ZH_FRESH = {
  id: "sub-zh",
  lan: "zh-CN",
  lanDoc: "中文",
  subtitleUrl: "https://i0.hdslb.com/zh-fresh.json?auth=new",
  source: "player-wbi-v2",
  origin: "bilibili" as const
};
const NATIVE_EN = {
  id: "sub-en",
  lan: "en-US",
  lanDoc: "English",
  subtitleUrl: "https://i0.hdslb.com/en.json",
  source: "player-wbi-v2",
  origin: "bilibili" as const
};

let storageHost: ChromeHost;

function stubMeta(overrides: Record<string, unknown> = {}) {
  vi.mocked(fetchMetaMock).mockResolvedValue({
    aid: "100",
    title: "测试标题",
    author: "测试作者",
    description: "",
    uploadDate: "2026-01-01",
    defaultCid: "101",
    defaultDuration: 300,
    pages: [{ cid: "101", page: 1, part: "P1", duration: 300 }],
    ...overrides
  } as never);
}

beforeEach(() => {
  setupEnvironment();
  setLocationUrl(NORMAL_PAGE_URL);
  setSubtitleCacheWriteInterceptorForTests(null);
  storageHost = installChromeHost();
  state.setSettings({
    ...DEFAULT_SETTINGS,
    asrAutoFallback: true,
    activeAsrProviderId: "p1",
    asrLanguage: "zh"
  });
  chrome.storage.sync.set({
    asrAutoFallback: true,
    activeAsrProviderId: "p1",
    asrLanguage: "zh"
  });

  mockAsrDeps.providers = [
    { id: "p1", type: "openai-transcriptions", name: "Whisper", model: "whisper-1" }
  ];
  mockAsrDeps.runAsrPipeline.mockReset();

  vi.mocked(fetchBodyMock).mockReset();
  vi.mocked(fetchBundleMock).mockReset();
  vi.mocked(fetchMetaMock).mockReset();
  vi.mocked(acceptSubtitle).mockClear();
  vi.mocked(commitNoSubtitle).mockClear();
  stubMeta();
});

describe("refreshClip：无字幕视频重抓保留 / 重种 ASR 伪轨", () => {
  it("同视频已有 ASR 伪轨 + 缓存时再次 refreshClip 且 bundle.tracks 为空：保留 ASR 伪轨并从缓存恢复，不洗成空", async () => {
    await persistAsrSubtitleToCache({
      bvid: "BV1test000000",
      cid: "101",
      identity: { kind: "asr", providerId: "p1", model: "whisper-1", lang: "zh" },
      body: ASR_BODY
    });
    clipState.setBvid("BV1test000000");
    clipState.setCid("101");
    clipState.setVideoDuration(300);
    clipState.setSubtitles([{ ...createAsrPseudoTrack("自配平台转写（中文）") }]);
    clipState.setSelectedSubtitleId("asr");
    clipState.setSelectedSubtitleUrl("");
    clipState.setSelectedSubtitleLang("自配平台转写（中文）");
    clipState.setSubtitleBody(ASR_BODY);
    clipState.setSubtitleFetchState("ready");

    vi.mocked(fetchBundleMock).mockResolvedValue({ tracks: [], chapters: [] });
    const setSubtitlesSpy = vi.spyOn(clipState, "setSubtitles");

    await fetcher.refreshClip();

    expect(setSubtitlesSpy.mock.calls.every(([list]) => list.length > 0)).toBe(true);
    expect(state.clip.subtitles).toHaveLength(1);
    expect(state.clip.subtitles[0]).toMatchObject({ id: "asr", origin: "asr", source: "asr" });
    expect(state.clip.selectedSubtitleId).toBe("asr");
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toEqual(ASR_BODY);
    expect(mockAsrDeps.runAsrPipeline).not.toHaveBeenCalled();
    expect(commitNoSubtitle).not.toHaveBeenCalled();
  });

  it("同视频仅内存 ASR 正文（缓存未落盘）且关闭 asrAutoFallback 时重抓空轨：保留 ASR 伪轨与正文", async () => {
    chrome.storage.sync.set({ asrAutoFallback: false });
    state.setSettings({ ...state.settings, asrAutoFallback: false });
    clipState.setBvid("BV1test000000");
    clipState.setCid("101");
    clipState.setVideoDuration(300);
    clipState.setSubtitles([{ ...createAsrPseudoTrack("自配平台转写（中文）") }]);
    clipState.setSelectedSubtitleId("asr");
    clipState.setSelectedSubtitleUrl("");
    clipState.setSelectedSubtitleLang("自配平台转写（中文）");
    clipState.setSubtitleBody(ASR_BODY);
    clipState.setSubtitleFetchState("ready");

    vi.mocked(fetchBundleMock).mockResolvedValue({ tracks: [], chapters: [] });

    await fetcher.refreshClip();

    expect(state.clip.subtitles).toHaveLength(1);
    expect(state.clip.subtitles[0]).toMatchObject({ id: "asr", origin: "asr" });
    expect(state.clip.selectedSubtitleId).toBe("asr");
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toEqual(ASR_BODY);
    expect(commitNoSubtitle).not.toHaveBeenCalled();
  });

  it("刷新/回访（内存无轨但 IDB 有有效 ASR 缓存，即使关闭自动回退）：bundle.tracks 为空时重种 ASR 伪轨并恢复 ready", async () => {
    chrome.storage.sync.set({ asrAutoFallback: false });
    state.setSettings({ ...state.settings, asrAutoFallback: false });
    await persistAsrSubtitleToCache({
      bvid: "BV1test000000",
      cid: "101",
      identity: { kind: "asr", providerId: "p1", model: "whisper-1", lang: "zh" },
      body: ASR_BODY
    });
    vi.mocked(fetchBundleMock).mockResolvedValue({ tracks: [], chapters: [] });

    await fetcher.refreshClip();

    expect(state.clip.subtitles).toHaveLength(1);
    expect(state.clip.subtitles[0]).toMatchObject({
      id: "asr",
      origin: "asr",
      lanDoc: "自配平台转写（中文）"
    });
    expect(state.clip.selectedSubtitleId).toBe("asr");
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toEqual(ASR_BODY);
    expect(mockAsrDeps.runAsrPipeline).not.toHaveBeenCalled();
  });

  it("切换到不同视频（不同 bvid/cid）：不串带旧视频的内存 ASR 伪轨", async () => {
    chrome.storage.sync.set({ asrAutoFallback: false });
    state.setSettings({ ...state.settings, asrAutoFallback: false });
    clipState.setBvid("BV1oldvideo00");
    clipState.setCid("999");
    clipState.setSubtitles([{ ...createAsrPseudoTrack("自配平台转写（中文）") }]);
    clipState.setSelectedSubtitleId("asr");
    clipState.setSubtitleBody(ASR_BODY);
    clipState.setSubtitleFetchState("ready");

    setLocationUrl("https://www.bilibili.com/video/BV1newvideo00/");
    stubMeta({ defaultCid: "202" });
    vi.mocked(fetchBundleMock).mockResolvedValue({ tracks: [], chapters: [] });

    await fetcher.refreshClip();

    expect(state.clip.bvid).toBe("BV1newvideo00");
    expect(state.clip.cid).toBe("202");
    expect(state.clip.subtitles).toEqual([]);
    expect(state.clip.subtitleFetchState).toBe("empty");
    expect(commitNoSubtitle).toHaveBeenCalledTimes(1);
  });

  it("充电专属或未登录（accessBlocker）时：不保留也不重种 ASR 伪轨", async () => {
    await persistAsrSubtitleToCache({
      bvid: "BV1test000000",
      cid: "101",
      identity: { kind: "asr", providerId: "p1", model: "whisper-1", lang: "zh" },
      body: ASR_BODY
    });
    clipState.setBvid("BV1test000000");
    clipState.setCid("101");
    clipState.setSubtitles([{ ...createAsrPseudoTrack("自配平台转写（中文）") }]);
    clipState.setSelectedSubtitleId("asr");

    stubMeta({ upowerBlocked: true });
    vi.mocked(fetchBundleMock).mockResolvedValue({ tracks: [], chapters: [] });

    await fetcher.refreshClip();

    expect(state.clip.subtitles).toEqual([]);
    expect(state.clip.subtitleFetchState).toBe("empty");
    expect(state.clip.noSubtitleReason).toBe("upower-exclusive");
  });
});

describe("refreshClip：B 站原生轨与缓存 ASR 伪轨共存", () => {
  it("首次进入有 B 站原生轨且本地有 ASR 缓存：默认选原生轨（不干扰普通有轨行为），轨列保留 ASR 供切换", async () => {
    await persistAsrSubtitleToCache({
      bvid: "BV1test000000",
      cid: "101",
      identity: { kind: "asr", providerId: "p1", model: "whisper-1", lang: "zh" },
      body: ASR_BODY
    });
    vi.mocked(fetchBundleMock).mockResolvedValue({
      tracks: [NATIVE_ZH_OLD, NATIVE_EN],
      chapters: []
    });
    vi.mocked(fetchBodyMock).mockResolvedValue({ body: NATIVE_BODY });

    await fetcher.refreshClip();

    expect(state.clip.selectedSubtitleId).toBe("sub-zh");
    expect(state.clip.subtitleBody).toEqual(NATIVE_BODY);
    expect(state.clip.subtitles.map((t) => t.id)).toEqual(["sub-zh", "sub-en", "asr"]);
  });

  it("混源视频原生轨遇 HTTP 403：仍正常走 retryWithFreshBundle 重试且保留 ASR 伪轨", async () => {
    await persistAsrSubtitleToCache({
      bvid: "BV1test000000",
      cid: "101",
      identity: { kind: "asr", providerId: "p1", model: "whisper-1", lang: "zh" },
      body: ASR_BODY
    });
    vi.mocked(fetchBundleMock)
      .mockResolvedValueOnce({ tracks: [NATIVE_ZH_OLD], chapters: [] })
      .mockResolvedValueOnce({ tracks: [NATIVE_ZH_FRESH], chapters: [] });
    vi.mocked(fetchBodyMock)
      .mockRejectedValueOnce(new Error("HTTP 403"))
      .mockResolvedValueOnce({ body: NATIVE_BODY });

    await fetcher.refreshClip();

    expect(fetchBundleMock).toHaveBeenCalledTimes(2);
    expect(state.clip.selectedSubtitleId).toBe("sub-zh");
    expect(state.clip.selectedSubtitleUrl).toBe(NATIVE_ZH_FRESH.subtitleUrl);
    expect(state.clip.subtitles.map((t) => t.id)).toEqual(["sub-zh", "asr"]);
  });
});

describe("loadAsrSubtitle：显式切回 ASR 伪轨（缓存 / 重建 / 失败不破坏原轨）", () => {
  it("从 B 站轨切到 ASR 伪轨：触发 source-track-switch 边界并优先命中 ASR 缓存", async () => {
    const cacheKey = getSubtitleCacheKey({
      bvid: "BV1test000000",
      cid: "101",
      identity: { kind: "asr", providerId: "p1", model: "whisper-1", lang: "zh" }
    });
    await storageHost.seedCacheEntry(cacheKey, ASR_BODY);

    clipState.setBvid("BV1test000000");
    clipState.setCid("101");
    clipState.setVideoDuration(300);
    clipState.setSubtitles([NATIVE_ZH_OLD, { ...createAsrPseudoTrack("自配平台转写（中文）") }]);
    clipState.setSelectedSubtitleId(NATIVE_ZH_OLD.id);
    clipState.setSelectedSubtitleUrl(NATIVE_ZH_OLD.subtitleUrl);
    clipState.setSelectedSubtitleLang(NATIVE_ZH_OLD.lanDoc);
    clipState.setSubtitleBody(NATIVE_BODY);
    clipState.setSubtitleFetchState("ready");

    const boundaryReasons: string[] = [];
    const unregister = registerSubtitleSessionBoundaryHooks({
      onAbortAndClear: (snapshot) => {
        boundaryReasons.push(snapshot.reason);
      }
    });

    await fetcher.loadAsrSubtitle({
      runId: clipState.fetchRunId,
      sourceLabel: "自配平台转写（中文）",
      allowTranscribe: true
    });
    unregister();

    expect(boundaryReasons).toEqual(["source-track-switch"]);
    expect(state.clip.selectedSubtitleId).toBe("asr");
    expect(state.clip.selectedSubtitleUrl).toBe("");
    expect(state.clip.subtitleBody).toEqual(ASR_BODY);
    expect(mockAsrDeps.runAsrPipeline).not.toHaveBeenCalled();
  });

  it("缓存缺失但配置了 ASR provider（即使自动回退关闭）：切回 ASR 伪轨主动触发转写并落盘", async () => {
    state.setSettings({ ...state.settings, asrAutoFallback: false });
    mockAsrDeps.runAsrPipeline.mockResolvedValue(ASR_BODY);

    clipState.setBvid("BV1test000000");
    clipState.setCid("101");
    clipState.setVideoDuration(300);
    clipState.setSubtitles([NATIVE_ZH_OLD, { ...createAsrPseudoTrack("自配平台转写（中文）") }]);
    clipState.setSelectedSubtitleId(NATIVE_ZH_OLD.id);
    clipState.setSelectedSubtitleUrl(NATIVE_ZH_OLD.subtitleUrl);
    clipState.setSubtitleBody(NATIVE_BODY);
    clipState.setSubtitleFetchState("ready");

    await fetcher.loadAsrSubtitle({
      runId: clipState.fetchRunId,
      sourceLabel: "自配平台转写（中文）",
      allowTranscribe: true
    });

    expect(mockAsrDeps.runAsrPipeline).toHaveBeenCalledTimes(1);
    expect(state.clip.selectedSubtitleId).toBe("asr");
    expect(state.clip.subtitleBody).toEqual(ASR_BODY);
    expect(state.clip.subtitles.map((t) => t.id)).toEqual([NATIVE_ZH_OLD.id, "asr"]);
  });

  it("缓存缺失且无可用 ASR provider：抛错且不调 commitNoSubtitle，保留当前已读 B 站轨", async () => {
    mockAsrDeps.providers = [];
    clipState.setBvid("BV1test000000");
    clipState.setCid("101");
    clipState.setVideoDuration(300);
    clipState.setSubtitles([NATIVE_ZH_OLD, { ...createAsrPseudoTrack("自配平台转写（中文）") }]);
    clipState.setSelectedSubtitleId(NATIVE_ZH_OLD.id);
    clipState.setSelectedSubtitleUrl(NATIVE_ZH_OLD.subtitleUrl);
    clipState.setSubtitleBody(NATIVE_BODY);
    clipState.setSubtitleFetchState("ready");

    await expect(
      fetcher.loadAsrSubtitle({
        runId: clipState.fetchRunId,
        sourceLabel: "自配平台转写（中文）",
        allowTranscribe: true
      })
    ).rejects.toThrow("未配置语音转写服务且无本地缓存");

    expect(commitNoSubtitle).not.toHaveBeenCalled();
    expect(state.clip.selectedSubtitleId).toBe(NATIVE_ZH_OLD.id);
    expect(state.clip.subtitleBody).toEqual(NATIVE_BODY);
    expect(state.clip.subtitleFetchState).toBe("ready");
  });
});
