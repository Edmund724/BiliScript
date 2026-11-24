// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState } from "../setup.js";

function setCrossOriginLocation(url: string): void {
  (globalThis as unknown as { jsdom: { reconfigure: (opts: { url: string }) => void } }).jsdom.reconfigure({
    url
  });
}
import {
  YOUTUBE_STORAGE_KEY_PREFIX,
  YOUTUBE_UNIT_CID,
  cleanYoutubeWatchUrl,
  decodeVideoStorageBvid,
  detectActiveSite,
  detectSiteFromUrl,
  encodeVideoStorageBvid,
  extractYoutubeVideoId,
  getSiteCapabilities,
  isEncodedYoutubeStorageBvid,
  isToastEligibleHostPage,
  isYoutubeAutoOpenEligible,
  isYoutubeWatchPage,
  normalizeSiteId,
  resolveVideoStorageKey
} from "../../extension/shared/site.js";
import {
  buildCanonicalVideoUrl,
  buildReaderModeUrl,
  cleanVideoUrl,
  computeCurrentClipSignature,
  extractVideoId,
  isAutoOpenEligible,
  isSupportedBilibiliPage,
  isSupportedPage,
  isSupportedVideoPage,
  stripReaderModeUrl
} from "../../extension/bilibili/video-id-shared.js";

const YT_ID = "dQw4w9WgXcQ";
const YT_UNDERSCORE_ID = "aB_1-cD2eFg";
const YT_WATCH_URL = `https://www.youtube.com/watch?v=${YT_ID}`;
const YT_NOISY_URL = `https://www.youtube.com/watch?v=${YT_ID}&t=42s&si=share123&pp=ygU%3D#top`;
const YT_PLAYLIST_URL = `https://www.youtube.com/watch?v=${YT_ID}&list=PL123456&index=2`;

beforeEach(() => {
  resetModuleState();
});

afterEach(() => {
  setCrossOriginLocation(NORMAL_PAGE_URL);
});

describe("站点归一化与能力表（SiteCapabilities）", () => {
  it("normalizeSiteId 缺省与未知值均回落 bilibili", () => {
    expect(normalizeSiteId(undefined)).toBe("bilibili");
    expect(normalizeSiteId(null)).toBe("bilibili");
    expect(normalizeSiteId("")).toBe("bilibili");
    expect(normalizeSiteId("vimeo")).toBe("bilibili");
    expect(normalizeSiteId("bilibili")).toBe("bilibili");
    expect(normalizeSiteId("youtube")).toBe("youtube");
    expect(normalizeSiteId(" YouTube ")).toBe("youtube");
  });

  it("bilibili 全部 10 项能力为 true；youtube 开放 supportsCurrentFrameCapture 与 supportsPlayerQuickAiButton", () => {
    expect(getSiteCapabilities("bilibili")).toEqual({
      supportsAsr: true,
      supportsLiveCompanion: true,
      supportsPlayerInterpretOverlay: true,
      supportsPlayerQuickAiButton: true,
      supportsExtraPlaybackRates: true,
      supportsCurrentFrameCapture: true,
      supportsHistoricalFrameCapture: true,
      supportsHotComments: true,
      supportsAgentBridge: true,
      supportsMultiPage: true
    });
    expect(getSiteCapabilities("youtube")).toEqual({
      supportsAsr: false,
      supportsLiveCompanion: false,
      supportsPlayerInterpretOverlay: false,
      supportsPlayerQuickAiButton: true,
      supportsExtraPlaybackRates: false,
      supportsCurrentFrameCapture: true,
      supportsHistoricalFrameCapture: false,
      supportsHotComments: false,
      supportsAgentBridge: false,
      supportsMultiPage: false
    });
  });

  it("detectSiteFromUrl 与 detectActiveSite 按当前 URL 区分站点", () => {
    expect(detectSiteFromUrl(YT_WATCH_URL)).toBe("youtube");
    expect(detectSiteFromUrl("https://www.youtube.com/")).toBe("youtube");
    expect(detectSiteFromUrl("https://www.bilibili.com/video/BV1abc/")).toBe("bilibili");
    expect(detectSiteFromUrl("invalid-url")).toBe("bilibili");

    setCrossOriginLocation(YT_WATCH_URL);
    expect(detectActiveSite()).toBe("youtube");

    setCrossOriginLocation("https://www.bilibili.com/video/BV1abc/");
    expect(detectActiveSite()).toBe("bilibili");
  });
});

describe("YouTube URL 路由与净化边界", () => {
  it.each([
    [YT_WATCH_URL, YT_ID],
    [YT_NOISY_URL, YT_ID],
    [YT_PLAYLIST_URL, YT_ID],
    [`https://www.youtube.com/watch?v=${YT_UNDERSCORE_ID}`, YT_UNDERSCORE_ID]
  ])("合法桌面 watch 页提取 11 位 videoId：%s", (url, expectedId) => {
    expect(extractYoutubeVideoId(url)).toBe(expectedId);
    expect(isYoutubeWatchPage(url)).toBe(true);
    expect(isSupportedPage(url)).toBe(true);
    expect(isSupportedVideoPage(url)).toBe(true);
    expect(isSupportedBilibiliPage(url)).toBe(false);
    expect(extractVideoId(url)).toBe(expectedId);
  });

  it.each([
    "https://www.youtube.com/",
    "https://www.youtube.com/results?search_query=ai",
    "https://www.youtube.com/@OpenAI",
    "https://www.youtube.com/channel/UC12345",
    `https://www.youtube.com/shorts/${YT_ID}`,
    `https://www.youtube.com/embed/${YT_ID}`,
    `https://m.youtube.com/watch?v=${YT_ID}`,
    `https://youtu.be/${YT_ID}`,
    `http://www.youtube.com/watch?v=${YT_ID}`,
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=tooLong12345",
    "https://www.youtube.com/watch?v=invalid!char",
    "https://www.youtube.com/watch"
  ])("非桌面 watch 页或非法 v 参数一律排除：%s", (url) => {
    expect(extractYoutubeVideoId(url)).toBe("");
    expect(isYoutubeWatchPage(url)).toBe(false);
    expect(isSupportedPage(url)).toBe(false);
    expect(isSupportedVideoPage(url)).toBe(false);
  });

  it("isYoutubeAutoOpenEligible 与 isAutoOpenEligible 对 &list= 播单排除", () => {
    expect(isYoutubeAutoOpenEligible(YT_WATCH_URL)).toBe(true);
    expect(isYoutubeAutoOpenEligible(YT_NOISY_URL)).toBe(true);
    expect(isAutoOpenEligible(YT_WATCH_URL)).toBe(true);
    expect(isYoutubeAutoOpenEligible(YT_PLAYLIST_URL)).toBe(false);
    expect(isAutoOpenEligible(YT_PLAYLIST_URL)).toBe(false);
    expect(isYoutubeAutoOpenEligible(`${YT_WATCH_URL}&list=`)).toBe(false);
    expect(isYoutubeAutoOpenEligible(`https://www.youtube.com/shorts/${YT_ID}`)).toBe(false);
  });

  it("cleanYoutubeWatchUrl、cleanVideoUrl、buildReaderModeUrl 与 buildCanonicalVideoUrl 兼容双站", () => {
    expect(cleanYoutubeWatchUrl(YT_NOISY_URL)).toBe(YT_WATCH_URL);
    expect(cleanVideoUrl(YT_NOISY_URL)).toBe(YT_WATCH_URL);
    expect(cleanVideoUrl(YT_PLAYLIST_URL)).toBe(YT_WATCH_URL);
    expect(cleanYoutubeWatchUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/shorts/dQw4w9WgXcQ"
    );

    const readerUrl = buildReaderModeUrl(YT_NOISY_URL);
    expect(readerUrl).toBe(`${YT_WATCH_URL}&biliscript_reader=1`);
    expect(buildReaderModeUrl(readerUrl)).toBe(readerUrl);
    expect(stripReaderModeUrl(readerUrl)).toBe(YT_WATCH_URL);

    expect(buildCanonicalVideoUrl(YT_UNDERSCORE_ID, 1, "youtube")).toBe(
      `https://www.youtube.com/watch?v=${YT_UNDERSCORE_ID}`
    );
    expect(buildCanonicalVideoUrl(`yt~aB~u1-cD2eFg`, 1, "youtube")).toBe(
      `https://www.youtube.com/watch?v=${YT_UNDERSCORE_ID}`
    );
    expect(buildCanonicalVideoUrl("BV1xx411c7mD", 2)).toBe(
      "https://www.bilibili.com/video/BV1xx411c7mD/?p=2"
    );
  });

  it("computeCurrentClipSignature 在 YouTube 返回 youtube|<id>|yt，B 站保持 <bvid>|<page>", () => {
    expect(computeCurrentClipSignature(YT_NOISY_URL)).toBe(`youtube|${YT_ID}|yt`);
    expect(computeCurrentClipSignature("https://www.youtube.com/")).toBe("youtube||yt");
    expect(computeCurrentClipSignature("https://www.bilibili.com/video/BV1abc/?p=3")).toBe(
      "BV1abc|3"
    );
  });

  it("isToastEligibleHostPage 仅对 www.bilibili.com 与 www.youtube.com 返回 true", () => {
    expect(isToastEligibleHostPage("https://www.bilibili.com/")).toBe(true);
    expect(isToastEligibleHostPage("https://www.youtube.com/")).toBe(true);
    expect(isToastEligibleHostPage("https://www.youtube.com/shorts/abc")).toBe(true);
    expect(isToastEligibleHostPage("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(false);
    expect(isToastEligibleHostPage("https://space.bilibili.com/1")).toBe(false);
    expect(isToastEligibleHostPage("https://example.com/")).toBe(false);
  });
});

describe("不含 _ 与 : 的双射存储键编码", () => {
  it("YOUTUBE_UNIT_CID 与 YOUTUBE_STORAGE_KEY_PREFIX 常量符合契约", () => {
    expect(YOUTUBE_UNIT_CID).toBe("yt");
    expect(YOUTUBE_STORAGE_KEY_PREFIX).toBe("yt~");
  });

  it.each([
    YT_ID,
    YT_UNDERSCORE_ID,
    "a_b_c",
    "~t~u",
    "~_~",
    "_~",
    "__ab~~cd__"
  ])("encode/decode 对 YouTube ID 保持双射且不含 _ 与 :：%s", (rawId) => {
    const encoded = encodeVideoStorageBvid("youtube", rawId);
    expect(encoded.startsWith("yt~")).toBe(true);
    expect(encoded).not.toContain("_");
    expect(encoded).not.toContain(":");
    expect(isEncodedYoutubeStorageBvid(encoded)).toBe(true);
    expect(encodeVideoStorageBvid("youtube", encoded)).toBe(encoded);
    expect(decodeVideoStorageBvid(encoded)).toBe(rawId);
  });

  it("bilibili 键原样透传；resolveVideoStorageKey 为 youtube 固定配 cid: yt", () => {
    expect(encodeVideoStorageBvid("bilibili", "BV1xx_411c")).toBe("BV1xx_411c");
    expect(isEncodedYoutubeStorageBvid("BV1xx_411c")).toBe(false);
    expect(decodeVideoStorageBvid("BV1xx_411c")).toBe("BV1xx_411c");

    expect(resolveVideoStorageKey("youtube", YT_UNDERSCORE_ID, "99999")).toEqual({
      site: "youtube",
      bvid: "yt~aB~u1-cD2eFg",
      cid: "yt"
    });
    expect(resolveVideoStorageKey("bilibili", "BV1abc", 12345)).toEqual({
      site: "bilibili",
      bvid: "BV1abc",
      cid: "12345"
    });
  });
});

describe("core/state 原位 site 字段与双实例共享", () => {
  it("state.clip.site 默认由 detectActiveSite() 初始化并跨实例同步", async () => {
    setCrossOriginLocation(YT_WATCH_URL);
    const resident = await import("../../extension/core/state.js");
    vi.resetModules();
    const lazy = await import("../../extension/core/state.js");

    expect(resident.state.clip.site).toBe("youtube");
    expect(lazy.state.clip.site).toBe("youtube");

    resident.clipState.setSite("bilibili");
    expect(lazy.state.clip.site).toBe("bilibili");

    lazy.clipState.setSite("youtube");
    expect(resident.state.clip.site).toBe("youtube");
  });
});
