import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState } from "../setup.js";
import { installChromeHost } from "../helpers/chrome-host.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { YOUTUBE_UNIT_CID } from "../../extension/shared/site.js";
import type {
  YoutubePageSnapshot,
  YoutubeSameOriginFetch
} from "../../extension/youtube/main-world-bridge.js";
import {
  classifySubtitleTrack,
  isAsrSubtitleTrack,
  isLoadableNativeTrack,
  isMonolingualNativeTracks,
  isPlatformAutoTrack,
  resolveSubtitleTrackOrigin
} from "../../extension/subtitle/selection.js";
import {
  BILI_AI_TRACK_SUFFIX,
  YOUTUBE_AUTO_TRACK_SUFFIX,
  formatSubtitleTrackOptionLabel,
  resolveSubtitleTrackLabel,
  shouldMarkAiSubtitleTracks
} from "../../extension/subtitle/labels.js";
import { shouldSegmentTrack } from "../../extension/subtitle/segmentation.js";
import { trackIdentity } from "../../extension/subtitle/source-key.js";
import type { SecondaryEnsureOutcome } from "../../extension/reader/secondary-subtitle.js";

let clipState: (typeof import("../../extension/core/state.js"))["clipState"];
let state: (typeof import("../../extension/core/state.js"))["state"];
let transitionReaderShell: (typeof import("../../extension/core/state.js"))["transitionReaderShell"];
let clearYoutubeGatewayCacheForTests: (typeof import("../../extension/youtube/gateway.js"))["clearYoutubeGatewayCacheForTests"];
let readYoutubePageSnapshot: (typeof import("../../extension/youtube/main-world-bridge.js"))["readYoutubePageSnapshot"];
let setYoutubeMainWorldReaderForTests: (typeof import("../../extension/youtube/main-world-bridge.js"))["setYoutubeMainWorldReaderForTests"];
let setYoutubeSameOriginFetchForTests: (typeof import("../../extension/youtube/main-world-bridge.js"))["setYoutubeSameOriginFetchForTests"];
let YOUTUBE_CAPTIONS_UNAVAILABLE_ERROR_CODE: (typeof import("../../extension/youtube/subtitle-fetcher.js"))["YOUTUBE_CAPTIONS_UNAVAILABLE_ERROR_CODE"];
let YoutubeSubtitleError: (typeof import("../../extension/youtube/subtitle-fetcher.js"))["YoutubeSubtitleError"];
let fetchYoutubeSubtitleTrackBody: (typeof import("../../extension/youtube/subtitle-fetcher.js"))["fetchYoutubeSubtitleTrackBody"];
let mapYoutubeCaptionTracks: (typeof import("../../extension/youtube/subtitle-fetcher.js"))["mapYoutubeCaptionTracks"];
let parseYoutubeGetTranscriptSubtitles: (typeof import("../../extension/youtube/subtitle-fetcher.js"))["parseYoutubeGetTranscriptSubtitles"];
let parseYoutubeJson3Subtitles: (typeof import("../../extension/youtube/subtitle-fetcher.js"))["parseYoutubeJson3Subtitles"];
let resolveYoutubeTimedtextRequestUrl: (typeof import("../../extension/youtube/subtitle-fetcher.js"))["resolveYoutubeTimedtextRequestUrl"];
let configureCommitUi: (typeof import("../../extension/subtitle/commit.js"))["configureCommitUi"];
let fetcher: typeof import("../../extension/subtitle/fetcher.js");
let loadTrackBody: (typeof import("../../extension/subtitle/body.js"))["loadTrackBody"];
let getSubtitleCacheKey: (typeof import("../../extension/subtitle/cache.js"))["getSubtitleCacheKey"];
let loadSubtitleFromCache: (typeof import("../../extension/subtitle/cache.js"))["loadSubtitleFromCache"];
let isSubtitleInHandOrInFlight: (typeof import("../../extension/subtitle/subtitle-in-hand.js"))["isSubtitleInHandOrInFlight"];
let createTranslatedTrackSession: (typeof import("../../extension/subtitle/translated-track-session.js"))["createTranslatedTrackSession"];
let ensureAsrSecondarySubtitle: (typeof import("../../extension/subtitle/asr-translation.js"))["ensureAsrSecondarySubtitle"];
let YOUTUBE_CAPTIONS_UNAVAILABLE_NOTICE: (typeof import("../../extension/reader/subtitle-notice.js"))["YOUTUBE_CAPTIONS_UNAVAILABLE_NOTICE"];
let resolveNoSubtitleNoticeText: (typeof import("../../extension/reader/subtitle-notice.js"))["resolveNoSubtitleNoticeText"];
let showNoSubtitleNotice: (typeof import("../../extension/reader/subtitle-notice.js"))["showNoSubtitleNotice"];
let ensureSecondarySubtitleLoaded: (typeof import("../../extension/reader/secondary-subtitle.js"))["ensureSecondarySubtitleLoaded"];
let resolveSecondaryTarget: (typeof import("../../extension/reader/secondary-subtitle.js"))["resolveSecondaryTarget"];
let isTranslationSecondaryScenario: (typeof import("../../extension/reader/asr-translation.js"))["isTranslationSecondaryScenario"];
let resolveAsrTranslationLang: (typeof import("../../extension/reader/asr-translation.js"))["resolveAsrTranslationLang"];
let ids: (typeof import("../../extension/reader/state.js"))["ids"];
let createViewRender: (typeof import("../../extension/reader/view-render.js"))["createViewRender"];
let getReadingSubtitlePlaceholderText: (typeof import("../../extension/subtitle/core.js"))["getReadingSubtitlePlaceholderText"];
let refreshHotComments: (typeof import("../../extension/subtitle/core.js"))["refreshHotComments"];
let downloadSubtitle: (typeof import("../../extension/subtitle/ui.js"))["downloadSubtitle"];
let subtitleTranslate: typeof import("../../extension/ai/subtitle-translate.js");
let subtitleContext: typeof import("../../extension/ai/subtitle-context.js");
let biliGateway: typeof import("../../extension/bilibili/gateway.js");

function readYoutubeFixture<T>(name: string): T {
  const fullPath = resolve(process.cwd(), "tests", "fixtures", "youtube", name);
  return JSON.parse(readFileSync(fullPath, "utf8")) as T;
}

interface RawPlayerFixture {
  videoDetails: {
    videoId: string;
    title: string;
    author: string;
    shortDescription: string;
    lengthSeconds: string;
    isLiveContent?: boolean;
    isLive?: boolean;
  };
  microformat?: {
    playerMicroformatRenderer?: {
      publishDate?: string;
      liveBroadcastDetails?: { isLiveNow?: boolean };
    };
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{
        baseUrl: string;
        languageCode: string;
        name: { simpleText?: string; runs?: Array<{ text: string }> };
        kind?: string;
        vssId?: string;
        isTranslatable?: boolean;
      }>;
    };
  };
}

interface RawInitialDataFixture {
  playerOverlays: {
    playerOverlayRenderer: {
      decoratedPlayerBarRenderer: {
        decoratedPlayerBarRenderer: {
          playerBar: {
            multiMarkersPlayerBarRenderer: {
              markersMap: Array<{
                value: {
                  chapters: Array<{
                    chapterRenderer: {
                      title: { simpleText?: string; runs?: Array<{ text: string }> };
                      timeRangeStartMillis: number;
                    };
                  }>;
                };
              }>;
            };
          };
        };
      };
    };
  };
  engagementPanels: Array<{
    engagementPanelSectionListRenderer: {
      content: {
        continuationItemRenderer: {
          continuationEndpoint: {
            getTranscriptEndpoint: { params: string };
          };
        };
      };
    };
  }>;
}

function readFixtureText(nameObj: { simpleText?: string; runs?: Array<{ text: string }> } | undefined): string {
  if (!nameObj) {
    return "";
  }
  if (typeof nameObj.simpleText === "string") {
    return nameObj.simpleText;
  }
  return (nameObj.runs || []).map((run) => run.text).join("");
}

function buildSnapshotFromFixtures(overrides: Partial<YoutubePageSnapshot> = {}): YoutubePageSnapshot {
  const player = readYoutubeFixture<RawPlayerFixture>("player-response.json");
  const initialData = readYoutubeFixture<RawInitialDataFixture>("initial-data.json");
  const rawChapters =
    initialData.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer
      .playerBar.multiMarkersPlayerBarRenderer.markersMap[0].value.chapters;
  const duration = Number(player.videoDetails.lengthSeconds) || 0;
  const captionTracks = (player.captions?.playerCaptionsTracklistRenderer?.captionTracks || []).map((track) => ({
    baseUrl: track.baseUrl,
    languageCode: track.languageCode,
    name: readFixtureText(track.name),
    ...(track.kind ? { kind: track.kind } : {}),
    ...(track.vssId ? { vssId: track.vssId } : {}),
    ...(typeof track.isTranslatable === "boolean" ? { isTranslatable: track.isTranslatable } : {})
  }));
  const chapters = rawChapters.map((item, idx) => {
    const from = Math.floor(item.chapterRenderer.timeRangeStartMillis / 1000);
    const next = rawChapters[idx + 1];
    const to = next
      ? Math.floor(next.chapterRenderer.timeRangeStartMillis / 1000)
      : duration;
    return {
      title: readFixtureText(item.chapterRenderer.title),
      from,
      to
    };
  });

  return {
    videoId: player.videoDetails.videoId,
    title: player.videoDetails.title,
    author: player.videoDetails.author,
    description: player.videoDetails.shortDescription,
    duration,
    publishDate: player.microformat?.playerMicroformatRenderer?.publishDate || "",
    isLiveContent: Boolean(player.videoDetails.isLiveContent),
    isLiveNow: Boolean(player.videoDetails.isLive || player.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow),
    captionTracks,
    chapters,
    innertubeContext: { client: { clientName: "WEB", clientVersion: "2.20260315.01.00" } },
    innertubeApiKey: "AIzaSanitizedTestKey",
    transcriptParams:
      initialData.engagementPanels[0].engagementPanelSectionListRenderer.content
        .continuationItemRenderer.continuationEndpoint.getTranscriptEndpoint.params,
    observedTimedtextUrls: [],
    ...overrides
  };
}

function makeTextFetchResponse(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body)
  };
}

function makeJsonFetchResponse(payload: unknown, status = 200) {
  const serialized = JSON.stringify(payload);
  return makeTextFetchResponse(serialized, status);
}

function assertStartedOutcome(
  outcome: SecondaryEnsureOutcome
): Extract<SecondaryEnsureOutcome, { kind: "started" }> {
  if (outcome.kind !== "started") {
    throw new Error(`Expected started secondary load outcome, got ${outcome.kind}`);
  }
  return outcome;
}

function setLocationUrl(url: string): void {
  (globalThis as unknown as { jsdom: { reconfigure: (opts: { url: string }) => void } }).jsdom.reconfigure({
    url
  });
}

beforeEach(async () => {
  setLocationUrl(NORMAL_PAGE_URL);
  resetModuleState();
  installChromeHost();

  const [
    coreStateMod,
    ytGatewayMod,
    ytBridgeMod,
    ytFetcherMod,
    commitMod,
    fetcherMod,
    bodyMod,
    cacheMod,
    inHandMod,
    sessionMod,
    asrTransMod,
    noticeMod,
    secMod,
    readerAsrMod,
    readerStateMod,
    viewRenderMod,
    coreMod,
    uiMod,
    subtitleTranslateMod,
    subtitleContextMod,
    biliGatewayMod
  ] = await Promise.all([
    import("../../extension/core/state.js"),
    import("../../extension/youtube/gateway.js"),
    import("../../extension/youtube/main-world-bridge.js"),
    import("../../extension/youtube/subtitle-fetcher.js"),
    import("../../extension/subtitle/commit.js"),
    import("../../extension/subtitle/fetcher.js"),
    import("../../extension/subtitle/body.js"),
    import("../../extension/subtitle/cache.js"),
    import("../../extension/subtitle/subtitle-in-hand.js"),
    import("../../extension/subtitle/translated-track-session.js"),
    import("../../extension/subtitle/asr-translation.js"),
    import("../../extension/reader/subtitle-notice.js"),
    import("../../extension/reader/secondary-subtitle.js"),
    import("../../extension/reader/asr-translation.js"),
    import("../../extension/reader/state.js"),
    import("../../extension/reader/view-render.js"),
    import("../../extension/subtitle/core.js"),
    import("../../extension/subtitle/ui.js"),
    import("../../extension/ai/subtitle-translate.js"),
    import("../../extension/ai/subtitle-context.js"),
    import("../../extension/bilibili/gateway.js")
  ]);

  ({ clipState, state, transitionReaderShell } = coreStateMod);
  ({ clearYoutubeGatewayCacheForTests } = ytGatewayMod);
  ({ readYoutubePageSnapshot, setYoutubeMainWorldReaderForTests, setYoutubeSameOriginFetchForTests } =
    ytBridgeMod);
  ({
    YOUTUBE_CAPTIONS_UNAVAILABLE_ERROR_CODE,
    YoutubeSubtitleError,
    fetchYoutubeSubtitleTrackBody,
    mapYoutubeCaptionTracks,
    parseYoutubeGetTranscriptSubtitles,
    parseYoutubeJson3Subtitles,
    resolveYoutubeTimedtextRequestUrl
  } = ytFetcherMod);
  ({ configureCommitUi } = commitMod);
  fetcher = fetcherMod;
  ({ loadTrackBody } = bodyMod);
  ({ getSubtitleCacheKey, loadSubtitleFromCache } = cacheMod);
  ({ isSubtitleInHandOrInFlight } = inHandMod);
  ({ createTranslatedTrackSession } = sessionMod);
  ({ ensureAsrSecondarySubtitle } = asrTransMod);
  ({ YOUTUBE_CAPTIONS_UNAVAILABLE_NOTICE, resolveNoSubtitleNoticeText, showNoSubtitleNotice } =
    noticeMod);
  ({ ensureSecondarySubtitleLoaded, resolveSecondaryTarget } = secMod);
  ({ isTranslationSecondaryScenario, resolveAsrTranslationLang } = readerAsrMod);
  ({ ids } = readerStateMod);
  ({ createViewRender } = viewRenderMod);
  ({ getReadingSubtitlePlaceholderText, refreshHotComments } = coreMod);
  ({ downloadSubtitle } = uiMod);
  subtitleTranslate = subtitleTranslateMod;
  subtitleContext = subtitleContextMod;
  biliGateway = biliGatewayMod;

  clearYoutubeGatewayCacheForTests();
  setYoutubeMainWorldReaderForTests(null);
  setYoutubeSameOriginFetchForTests(null);
  configureCommitUi({ setStatus: (message) => state.ui.setStatusText(message) });
  state.setSettings({ ...DEFAULT_SETTINGS });
});

afterEach(() => {
  setYoutubeMainWorldReaderForTests(null);
  setYoutubeSameOriginFetchForTests(null);
  setLocationUrl(NORMAL_PAGE_URL);
  vi.restoreAllMocks();
});

describe("YouTube 主世界桥接与快照规范化（fixtures）", () => {
  it("读取标准元数据、章节、live 状态，并支持 SPA 换片 videoId 短重试", async () => {
    setLocationUrl("https://www.youtube.com/watch?v=ytDemo01234");
    const staleSnapshot = buildSnapshotFromFixtures({ videoId: "OLDVID99999", title: "Old Title" });
    const freshSnapshot = buildSnapshotFromFixtures();
    const reader = vi
      .fn<() => Promise<YoutubePageSnapshot>>()
      .mockResolvedValueOnce(staleSnapshot)
      .mockResolvedValueOnce(freshSnapshot);
    setYoutubeMainWorldReaderForTests(reader);

    const resolved = await readYoutubePageSnapshot({ retryDelayMs: 0, maxAttempts: 3 });

    expect(reader).toHaveBeenCalledTimes(2);
    expect(resolved.videoId).toBe("ytDemo01234");
    expect(resolved.title).toBe("YouTube Multisite Subtitle Demo");
    expect(resolved.author).toBe("Demo Channel");
    expect(resolved.duration).toBe(212);
    expect(resolved.publishDate).toBe("2026-03-15");
    expect(resolved.isLiveNow).toBe(false);
    expect(resolved.isLiveReplay).toBe(false);
    expect(resolved.chapters).toEqual([
      { title: "Intro", from: 0, to: 65, source: "youtube-chapters" },
      { title: "Core Pipeline", from: 65, to: 145, source: "youtube-chapters" },
      { title: "Summary", from: 145, to: 212, source: "youtube-chapters" }
    ]);
    expect(resolved.captionTracks.map((t) => t.kind)).toEqual([undefined, undefined, "asr"]);
  });

  it("已结束直播回放（isLiveContent=true && isLiveNow=false）放行，直播中（isLiveNow=true）识别标记", async () => {
    setLocationUrl("https://www.youtube.com/watch?v=ytLive12345");
    const liveFixture = readYoutubeFixture<RawPlayerFixture>("live-stream-player-response.json");

    setYoutubeMainWorldReaderForTests(async () =>
      buildSnapshotFromFixtures({
        videoId: liveFixture.videoDetails.videoId,
        title: liveFixture.videoDetails.title,
        author: liveFixture.videoDetails.author,
        duration: Number(liveFixture.videoDetails.lengthSeconds) || 0,
        isLiveContent: Boolean(liveFixture.videoDetails.isLiveContent),
        isLiveNow: Boolean(
          liveFixture.videoDetails.isLive ||
            liveFixture.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow
        ),
        captionTracks: []
      })
    );
    const liveMeta = await readYoutubePageSnapshot({ retryDelayMs: 0 });
    expect(liveMeta.isLiveContent).toBe(true);
    expect(liveMeta.isLiveNow).toBe(true);
    expect(liveMeta.isLiveReplay).toBe(false);

    setYoutubeMainWorldReaderForTests(async () =>
      buildSnapshotFromFixtures({
        videoId: "ytLive12345",
        isLiveContent: true,
        isLiveNow: false
      })
    );
    const replayMeta = await readYoutubePageSnapshot({ retryDelayMs: 0 });
    expect(replayMeta.isLiveContent).toBe(true);
    expect(replayMeta.isLiveNow).toBe(false);
    expect(replayMeta.isLiveReplay).toBe(true);
  });
});

describe("YouTube 三级字幕采集（timedtext json3 / get_transcript / 失败错误）", () => {
  it("Tier 1：缺 pot 时从匹配当前视频的 observedTimedtextUrls 补齐，并解析 events/segs 为 { from, to, content, words? }", async () => {
    const json3Fixture = readYoutubeFixture<unknown>("timedtext-json3.json");
    const fetchMock = vi.fn<YoutubeSameOriginFetch>(async () => makeJsonFetchResponse(json3Fixture));
    const snapshot = buildSnapshotFromFixtures({
      observedTimedtextUrls: [
        "https://www.youtube.com/api/timedtext?v=OTHERVIDEO1&lang=en&pot=WRONG_POT",
        "https://www.youtube.com/api/timedtext?v=ytDemo01234&lang=en&pot=VALID_YT_POT"
      ]
    });

    const result = await fetchYoutubeSubtitleTrackBody({
      trackUrl: snapshot.captionTracks[2].baseUrl,
      videoId: snapshot.videoId,
      languageCode: "en",
      snapshot,
      fetchFn: fetchMock
    });

    expect(result.tier).toBe("timedtext");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.searchParams.get("fmt")).toBe("json3");
    expect(requestedUrl.searchParams.get("pot")).toBe("VALID_YT_POT");

    expect(result.items).toHaveLength(4);
    expect(result.items[0]).toMatchObject({
      from: 1.2,
      to: 3.4,
      content: "Hello everyone welcome back"
    });
    expect(result.items[0].words).toEqual([
      { word: "Hello", startMs: 1200, endMs: 1600, start: 1.2, end: 1.6 },
      { word: "everyone", startMs: 1600, endMs: 2100, start: 1.6, end: 2.1 },
      { word: "welcome", startMs: 2100, endMs: 2700, start: 2.1, end: 2.7 },
      { word: "back", startMs: 2700, endMs: 3400, start: 2.7, end: 3.4 }
    ]);
    expect(result.items[2]).toEqual({ from: 6.5, to: 8, content: "[Music]" });
  });

  it("Tier 2：timedtext 返回空正文（PO Token exp=xpe 门控）时同源 POST /youtubei/v1/get_transcript 解析 cueGroups", async () => {
    const transcriptFixture = readYoutubeFixture<unknown>("get-transcript.json");
    const snapshot = buildSnapshotFromFixtures();
    const fetchMock = vi
      .fn<YoutubeSameOriginFetch>()
      .mockResolvedValueOnce(makeTextFetchResponse("", 200))
      .mockResolvedValueOnce(makeJsonFetchResponse(transcriptFixture, 200));

    const result = await fetchYoutubeSubtitleTrackBody({
      trackUrl: `${snapshot.captionTracks[0].baseUrl}&exp=xpe`,
      videoId: snapshot.videoId,
      languageCode: "en",
      snapshot,
      fetchFn: fetchMock
    });

    expect(result.tier).toBe("get_transcript");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [postUrl, postInit] = fetchMock.mock.calls[1];
    expect(postUrl).toBe(
      `https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(snapshot.innertubeApiKey)}`
    );
    expect(postInit?.method).toBe("POST");
    const parsedBody = JSON.parse(String(postInit?.body || "{}")) as {
      context: { client: { clientName: string } };
      params: string;
    };
    expect(parsedBody.context.client.clientName).toBe("WEB");
    expect(parsedBody.params).toBe(snapshot.transcriptParams);
    expect(result.items).toEqual([
      { from: 1.2, to: 3.4, content: "Hello everyone welcome back" },
      { from: 3.6, to: 6, content: "today we test fallback transcript" },
      { from: 180, to: 200, content: "thanks for watching" }
    ]);
  });

  it("严禁伪装 ANDROID / IOS / MWEB InnerTube 客户端", async () => {
    const snapshot = buildSnapshotFromFixtures({
      innertubeContext: { client: { clientName: "ANDROID", clientVersion: "19.01.1" } }
    });
    const fetchMock = vi.fn(async () => makeTextFetchResponse("", 200));

    await expect(
      fetchYoutubeSubtitleTrackBody({
        trackUrl: snapshot.captionTracks[0].baseUrl,
        videoId: snapshot.videoId,
        snapshot,
        fetchFn: fetchMock
      })
    ).rejects.toMatchObject({
      code: YOUTUBE_CAPTIONS_UNAVAILABLE_ERROR_CODE
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Tier 3：timedtext 与 get_transcript 双路均不可得时抛出清晰 YOUTUBE_CAPTIONS_UNAVAILABLE 错误", async () => {
    const snapshot = buildSnapshotFromFixtures();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeTextFetchResponse("", 200))
      .mockResolvedValueOnce(makeJsonFetchResponse({}, 500));

    await expect(
      fetchYoutubeSubtitleTrackBody({
        trackUrl: snapshot.captionTracks[0].baseUrl,
        videoId: snapshot.videoId,
        snapshot,
        fetchFn: fetchMock
      })
    ).rejects.toBeInstanceOf(YoutubeSubtitleError);

    expect(
      resolveYoutubeTimedtextRequestUrl({
        baseUrl: snapshot.captionTracks[0].baseUrl,
        videoId: snapshot.videoId
      })
    ).toContain("fmt=json3");
    expect(parseYoutubeJson3Subtitles({})).toEqual([]);
    expect(parseYoutubeGetTranscriptSubtitles({})).toEqual([]);
  });
});

describe("YouTube 平台自动字幕分类、标签与自动断句", () => {
  it("kind=asr 映射为 youtube-auto（绝不归入扩展 asr），混源标注（YouTube 自动）且紧凑 trigger 保留裸语言名", () => {
    const snapshot = buildSnapshotFromFixtures();
    const mapped = mapYoutubeCaptionTracks(snapshot.captionTracks);
    const manualEn = mapped[0];
    const manualZh = mapped[1];
    const autoEn = mapped[2];

    expect(autoEn).toMatchObject({
      origin: "youtube",
      source: "youtube-auto",
      kind: "asr",
      site: "youtube",
      lan: "en",
      lanDoc: "English"
    });
    expect(autoEn.id.startsWith("asr")).toBe(false);
    expect(resolveSubtitleTrackOrigin(autoEn)).toBe("youtube");
    expect(isAsrSubtitleTrack(autoEn)).toBe(false);
    expect(classifySubtitleTrack(autoEn)).toBe("youtube-auto");
    expect(isPlatformAutoTrack(autoEn)).toBe(true);
    expect(isLoadableNativeTrack(autoEn)).toBe(true);
    expect(classifySubtitleTrack(manualEn)).toBe("manual-cc");
    expect(isPlatformAutoTrack(manualEn)).toBe(false);
    expect(isLoadableNativeTrack(manualZh)).toBe(true);

    expect(shouldMarkAiSubtitleTracks([autoEn])).toBe(false);
    expect(shouldMarkAiSubtitleTracks([manualEn, autoEn])).toBe(true);
    expect(resolveSubtitleTrackLabel(autoEn)).toBe("English");
    expect(formatSubtitleTrackOptionLabel(autoEn, true)).toBe(`English${YOUTUBE_AUTO_TRACK_SUFFIX}`);
    expect(formatSubtitleTrackOptionLabel(manualEn, true)).toBe("English");

    const biliAi = { id: "1", lan: "ai-zh", lanDoc: "中文", subtitleUrl: "https://sub/ai-zh.json" };
    expect(formatSubtitleTrackOptionLabel(biliAi, true)).toBe(`中文${BILI_AI_TRACK_SUFFIX}`);
  });

  it("shouldSegmentTrack 对 youtube-auto 或缺少标点密度的轨道触发自动断句", () => {
    const punctuatedCues = Array.from({ length: 12 }, (_, idx) => ({
      from: idx * 2,
      to: idx * 2 + 1.5,
      content: `Sentence ${idx + 1}.`
    }));
    const unpunctuatedCues = Array.from({ length: 12 }, (_, idx) => ({
      from: idx * 2,
      to: idx * 2 + 1.5,
      content: `word segment ${idx + 1}`
    }));

    expect(
      shouldSegmentTrack({
        strategy: "auto",
        selectedSubtitleId: "yt-auto-a.en",
        trackLan: "en",
        origin: "youtube",
        kind: "asr",
        source: "youtube-auto",
        items: punctuatedCues
      })
    ).toBe(true);
    expect(
      shouldSegmentTrack({
        strategy: "auto",
        selectedSubtitleId: "yt-cc-.en",
        trackLan: "en",
        origin: "youtube",
        source: "youtube-cc",
        items: punctuatedCues
      })
    ).toBe(false);
    expect(
      shouldSegmentTrack({
        strategy: "auto",
        selectedSubtitleId: "yt-cc-.en",
        trackLan: "en",
        origin: "youtube",
        source: "youtube-cc",
        items: unpunctuatedCues
      })
    ).toBe(true);
  });
});

describe("YouTube fetcher / body / core / ui / reader 端到端闭环", () => {
  it("正常抓取写入 raw 11 位 videoId + cid=yt、跳过热评与 ASR、生成作者元行与导出文件名", async () => {
    const rawUnderscoreId = "_a_b-C12_34";
    setLocationUrl(`https://www.youtube.com/watch?v=${rawUnderscoreId}`);
    const json3Fixture = readYoutubeFixture<unknown>("timedtext-json3.json");
    const snapshot = buildSnapshotFromFixtures({
      videoId: rawUnderscoreId,
      captionTracks: [buildSnapshotFromFixtures().captionTracks[2]]
    });
    setYoutubeMainWorldReaderForTests(async () => snapshot);
    setYoutubeSameOriginFetchForTests(async () => makeJsonFetchResponse(json3Fixture));
    const hotCommentSpy = vi.spyOn(biliGateway, "fetchHotComments");
    const saveCacheSpy = vi.spyOn(
      await import("../../extension/subtitle/cache.js"),
      "saveSubtitleToCache"
    );

    await fetcher.refreshClip();

    expect(state.clip.site).toBe("youtube");
    expect(state.clip.bvid).toBe(rawUnderscoreId);
    expect(state.clip.cid).toBe(YOUTUBE_UNIT_CID);
    expect(state.clip.pageCount).toBe(1);
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(hotCommentSpy).not.toHaveBeenCalled();
    expect(isSubtitleInHandOrInFlight()).toBe(true);
    expect(saveCacheSpy).toHaveBeenCalled();
    const cacheKeyArg = saveCacheSpy.mock.calls[0][0];
    expect(cacheKeyArg).not.toContain("id_asr:");
    expect(state.clip.subtitleBody[0].content).toBe("Hello everyone welcome back today we test youtube captions");

    const metaEl = document.createElement("div");
    metaEl.id = ids.readingMeta;
    const subListEl = document.createElement("div");
    subListEl.id = ids.readingSubtitleList;
    const viewRoot = document.createElement("div");
    viewRoot.id = ids.readingView;
    document.body.append(viewRoot, metaEl, subListEl);

    createViewRender({ sessionProjections: [] }).render();
    expect(metaEl.textContent).toBe("作者：Demo Channel");

    clipState.setTitle("");
    const createElementSpy = vi.spyOn(document, "createElement");
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:test-yt");
    URL.revokeObjectURL = vi.fn();
    try {
      const downloaded = await downloadSubtitle({ format: "srt" });
      expect(downloaded).toBe(true);
      const anchorCall = createElementSpy.mock.results.find(
        (res) => (res.value as HTMLElement | undefined)?.tagName === "A"
      );
      expect((anchorCall?.value as HTMLAnchorElement).download).toContain(`${rawUnderscoreId}.`);
    } finally {
      URL.createObjectURL = originalCreateObjectUrl;
      URL.revokeObjectURL = originalRevokeObjectUrl;
    }

    await refreshHotComments({ refreshComments: true });
    expect(state.clip.hotComments).toEqual([]);
  });

  it("loadTrackBody 对普通 YouTube ID 完成缓存命中读写，且回落通用 <video> duration", async () => {
    setLocationUrl("https://www.youtube.com/watch?v=ytDemo01234");
    const json3Fixture = readYoutubeFixture<unknown>("timedtext-json3.json");
    const videoEl = document.createElement("video");
    Object.defineProperty(videoEl, "duration", { value: 212, configurable: true });
    document.body.appendChild(videoEl);

    const snapshot = buildSnapshotFromFixtures({
      duration: 0,
      captionTracks: [buildSnapshotFromFixtures().captionTracks[0]]
    });
    setYoutubeMainWorldReaderForTests(async () => snapshot);
    const fetchMock = vi.fn(async () => makeJsonFetchResponse(json3Fixture));
    setYoutubeSameOriginFetchForTests(fetchMock);

    await fetcher.refreshClip();

    expect(state.clip.videoDuration).toBe(212);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const cacheKey = getSubtitleCacheKey({
      bvid: "ytDemo01234",
      cid: YOUTUBE_UNIT_CID,
      identity: trackIdentity(
        state.clip.selectedSubtitleId,
        state.clip.selectedSubtitleUrl,
        state.clip.selectedSubtitleLang
      )
    });
    await expect(loadSubtitleFromCache(cacheKey)).resolves.toHaveLength(4);

    const cachedBody = await loadTrackBody({
      site: "youtube",
      bvid: "ytDemo01234",
      cid: YOUTUBE_UNIT_CID,
      videoDuration: 212,
      url: state.clip.selectedSubtitleUrl,
      lang: state.clip.selectedSubtitleLang,
      subtitleId: state.clip.selectedSubtitleId,
      transport: vi.fn()
    });
    expect(cachedBody).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("isLiveNow 直播中中止绑定并报清晰不支持提示；已结束直播回放正常放行", async () => {
    setLocationUrl("https://www.youtube.com/watch?v=ytLive12345");
    setYoutubeMainWorldReaderForTests(async () =>
      buildSnapshotFromFixtures({
        videoId: "ytLive12345",
        isLiveContent: true,
        isLiveNow: true
      })
    );

    await fetcher.refreshClip();

    expect(state.clip.subtitleFetchState).toBe("error");
    expect(state.clip.cid).toBe("");
    expect(state.clip.subtitles).toEqual([]);
    expect(state.ui.statusText).toContain("暂不支持 YouTube 直播中视频");

    const json3Fixture = readYoutubeFixture<unknown>("timedtext-json3.json");
    setYoutubeMainWorldReaderForTests(async () =>
      buildSnapshotFromFixtures({
        videoId: "ytLive12345",
        isLiveContent: true,
        isLiveNow: false,
        captionTracks: [buildSnapshotFromFixtures().captionTracks[0]]
      })
    );
    setYoutubeSameOriginFetchForTests(async () => makeJsonFetchResponse(json3Fixture));

    await fetcher.refreshClip();

    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.cid).toBe(YOUTUBE_UNIT_CID);
  });

  it("无轨道映射 youtube-no-subtitles；双路抓取失败映射 youtube-captions-unavailable 且提供 CC 开关提示", async () => {
    setLocationUrl("https://www.youtube.com/watch?v=ytDemo01234");
    setYoutubeMainWorldReaderForTests(async () =>
      buildSnapshotFromFixtures({ captionTracks: [] })
    );

    await fetcher.refreshClip();

    expect(state.clip.subtitleFetchState).toBe("empty");
    expect(state.clip.noSubtitleReason).toBe("youtube-no-subtitles");
    expect(getReadingSubtitlePlaceholderText()).toContain("未提供原生字幕或自动字幕");

    setYoutubeMainWorldReaderForTests(async () =>
      buildSnapshotFromFixtures({
        captionTracks: [buildSnapshotFromFixtures().captionTracks[0]]
      })
    );
    setYoutubeSameOriginFetchForTests(async () => makeTextFetchResponse("", 200));

    await fetcher.refreshClip();

    expect(state.clip.subtitleFetchState).toBe("empty");
    expect(state.clip.noSubtitleReason).toBe("youtube-captions-unavailable");
    expect(resolveNoSubtitleNoticeText("youtube-captions-unavailable")).toBe(
      YOUTUBE_CAPTIONS_UNAVAILABLE_NOTICE
    );

    const noticeEl = document.createElement("p");
    noticeEl.id = ids.readingSubtitleNotice;
    noticeEl.hidden = true;
    document.body.appendChild(noticeEl);
    showNoSubtitleNotice("youtube-captions-unavailable");
    expect(noticeEl.hidden).toBe(false);
    expect(noticeEl.textContent).toContain("CC");
  });

  it("跨语种原生多轨零 Token 配对（排除同语种族），单语种自动轨走 boundary-v3 与 90s 游标调度", async () => {
    setLocationUrl("https://www.youtube.com/watch?v=ytDemo01234");
    const json3Fixture = readYoutubeFixture<unknown>("timedtext-json3.json");
    const snapshot = buildSnapshotFromFixtures();
    const mapped = mapYoutubeCaptionTracks(snapshot.captionTracks);
    const manualEn = mapped[0];
    const manualZh = mapped[1];
    const autoEn = mapped[2];

    state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: true, secondarySubtitleLang: "zh-CN" });
    clipState.setSite("youtube");
    clipState.setBvid("ytDemo01234");
    clipState.setCid(YOUTUBE_UNIT_CID);
    clipState.setVideoDuration(212);
    clipState.setSubtitles([manualEn, manualZh]);
    clipState.setSelectedSubtitleId(manualEn.id);
    clipState.setSelectedSubtitleUrl(manualEn.subtitleUrl);
    clipState.setSelectedSubtitleLang(manualEn.lanDoc || "English");

    setYoutubeMainWorldReaderForTests(async () => snapshot);
    const fetchMock = vi.fn(async () => makeJsonFetchResponse(json3Fixture));
    setYoutubeSameOriginFetchForTests(fetchMock);

    const targetRes = resolveSecondaryTarget();
    expect(targetRes).toEqual({
      kind: "target",
      target: {
        id: manualZh.id,
        url: manualZh.subtitleUrl,
        lang: manualZh.lanDoc || "中文（简体）",
        origin: "youtube"
      }
    });
    const outcome = ensureSecondarySubtitleLoaded();
    expect(outcome.kind).toBe("started");
    const started = assertStartedOutcome(outcome);
    await expect(started.settled).resolves.toEqual({ error: null });
    expect(state.clip.secondarySubtitle.state).toBe("ready");
    expect(state.clip.secondarySubtitle.body).toHaveLength(4);

    const zhHant = { ...manualZh, id: "yt-cc-.zh-Hant", lan: "zh-Hant", lanDoc: "中文（繁體）" };
    clipState.setSubtitles([manualZh, zhHant]);
    clipState.setSelectedSubtitleId(manualZh.id);
    expect(isMonolingualNativeTracks([manualZh, zhHant])).toBe(true);
    expect(resolveSecondaryTarget()).toEqual({ kind: "none", reason: "no-track" });

    transitionReaderShell("open");
    clipState.setSubtitles([autoEn]);
    clipState.setSelectedSubtitleId(autoEn.id);
    clipState.setSelectedSubtitleUrl(autoEn.subtitleUrl);
    clipState.setSelectedSubtitleLang("English");
    clipState.setSubtitleBody([
      { from: 1.2, to: 3.4, content: "Hello everyone welcome back" },
      { from: 3.6, to: 6.0, content: "today we test youtube captions" }
    ]);
    clipState.setSubtitleFetchState("ready");
    clipState.clearSecondarySubtitle();

    expect(isTranslationSecondaryScenario([autoEn])).toBe(true);
    expect(resolveAsrTranslationLang()).toBe("zh");

    const autoSession = createTranslatedTrackSession({
      bvid: "ytDemo01234",
      cid: YOUTUBE_UNIT_CID,
      source: {
        isAsrSource: false,
        selectedSubtitleId: autoEn.id,
        selectedSubtitleUrl: autoEn.subtitleUrl,
        selectedSubtitleLang: "English",
        trackLan: autoEn.lan,
        origin: autoEn.origin,
        kind: autoEn.kind,
        source: autoEn.source,
        targetLang: "zh"
      },
      primaryItems: state.clip.subtitleBody
    });
    expect(autoSession.protocolMode).toBe("boundary-v3");
    expect(autoSession.legacyCacheKey).not.toContain("id_asr:");

    vi.spyOn(subtitleContext, "readCachedL1VideoIndex").mockResolvedValue(null);
    vi.spyOn(subtitleContext, "resolveRuntimeSubtitleContext").mockResolvedValue({});
    vi.spyOn(subtitleTranslate, "resolveSubtitleTranslateProvider").mockResolvedValue({
      presetId: "index-translate",
      baseUrl: "https://translate.example.invalid",
      apiKey: "",
      model: "Index-Translate-35B-A3B",
      protocol: "openai"
    } as never);
    const translateSpy = vi
      .spyOn(subtitleTranslate, "translateSubtitleTrack")
      .mockResolvedValue({
        mode: "boundary-v3",
        items: state.clip.subtitleBody,
        translations: [
          { from: 1.2, to: 3.4, content: "大家好欢迎回来" },
          { from: 3.6, to: 6.0, content: "今天我们来测试 YouTube 字幕" }
        ]
      });

    const translationRes = await ensureAsrSecondarySubtitle({
      mode: "translate",
      targetLang: "zh",
      runId: clipState.fetchRunId
    });

    expect(translationRes.kind).toBe("done");
    expect(translateSpy).toHaveBeenCalledTimes(1);
    expect(state.clip.secondarySubtitle.state).toBe("ready");
    expect(state.clip.secondarySubtitle.id).toBe(`id_${autoEn.id}_translate-zh-CN`);
    expect(state.clip.secondarySubtitle.body.map((item) => item.content)).toEqual([
      "大家好欢迎回来",
      "今天我们来测试 YouTube 字幕"
    ]);
  });
});
