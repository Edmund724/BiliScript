// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, setupEnvironment } from "../setup.js";
import { installChromeHost, type CacheEntry, type ChromeHost } from "../helpers/chrome-host.js";
import { clipState } from "../../extension/core/state.js";

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
vi.mock("../../extension/subtitle/commit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/subtitle/commit.js")>();
  return {
    ...actual,
    acceptSubtitle: vi.fn(actual.acceptSubtitle),
    commitNoSubtitle: vi.fn(actual.commitNoSubtitle)
  };
});

vi.mock("../../extension/reader/page-context.js", () => ({
  resolvePageContext: vi.fn(() => ({ pageIndex: 1, cid: "101", cidSource: "test", pageTitle: "P1", duration: 300 }))
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

import * as fetcher from "../../extension/subtitle/fetcher.js";
import {
  contentFetchJson as fetchBodyMock,
  fetchSubtitleBundle as fetchBundleMock,
  fetchVideoMeta as fetchMetaMock
} from "../../extension/bilibili/gateway.js";
import {
  getSubtitleCacheKey,
  loadSubtitleFromCache,
  setSubtitleCacheWriteInterceptorForTests
} from "../../extension/subtitle/cache.js";
import { trackIdentity } from "../../extension/subtitle/source-key.js";
import { acceptSubtitle, commitNoSubtitle } from "../../extension/subtitle/commit.js";

const SUBTITLE_BODY = [
  { from: 0, to: 1.2, content: "你好" },
  { from: 1.5, to: 2.4, content: "世界" },
  { from: 3, to: 290, content: "收尾长句" }
];

let storageHost: ChromeHost;

function subtitleCacheKey() {
  return getSubtitleCacheKey({
    bvid: clipState.bvid,
    cid: clipState.cid,
    identity: trackIdentity("track-1", "https://example.com/sub.json", "中文")
  });
}

beforeEach(() => {
  setupEnvironment();
  history.replaceState({}, "", NORMAL_PAGE_URL);
  document.body.innerHTML = "";
  const preview = document.createElement("textarea");
  preview.id = "biliscript-preview";
  document.body.appendChild(preview);

  clipState.setBvid("BV1test000000");
  clipState.setCid("101");
  clipState.setVideoDuration(300);
  clipState.setFetchRunId(0);

  setSubtitleCacheWriteInterceptorForTests(null);
  storageHost = installChromeHost();
  vi.mocked(fetchBodyMock).mockReset();
  vi.mocked(fetchBundleMock).mockReset();
  vi.mocked(fetchMetaMock).mockReset();
  vi.mocked(acceptSubtitle).mockClear();
  vi.mocked(commitNoSubtitle).mockClear();
});

describe("noSubtitleReason 清除点", () => {
  it("resetClipState：无字幕原因与详情清空", () => {
    clipState.setSubtitleFetchState("empty");
    clipState.setNoSubtitleReason("asr-empty");
    clipState.setNoSubtitleDetail("（错误详情：HTTP 402）");
    expect(clipState.noSubtitleReason).toBe("asr-empty");

    fetcher.resetClipState();

    expect(clipState.noSubtitleReason).toBe(null);
    expect(clipState.noSubtitleDetail).toBe("");
    expect(clipState.subtitleFetchState).toBe("idle");
  });

  it("resetClipState({ keepFetchState: true })：保留当前 fetchState（586c61b：错误路径不得洗回 idle）", () => {
    clipState.setSubtitleFetchState("loading");

    fetcher.resetClipState({ keepFetchState: true });

    expect(clipState.subtitleFetchState).toBe("loading");
    expect(clipState.subtitleBody).toEqual([]);
    expect(clipState.noSubtitleReason).toBe(null);
    expect(clipState.noSubtitleDetail).toBe("");
    expect(clipState.subtitles).toEqual([]);
  });

  it("loadSubtitle 缓存命中 ready：陈旧原因与详情清空，且经字幕接受事务（乱序缓存条目被稳定排序）", async () => {
    clipState.setNoSubtitleReason("no-asr-config");
    clipState.setNoSubtitleDetail("（错误详情：HTTP 404）");
    const unsortedBody = [SUBTITLE_BODY[2], SUBTITLE_BODY[0], SUBTITLE_BODY[1]];
    await storageHost.seedCacheEntry(subtitleCacheKey(), unsortedBody);

    await fetcher.loadSubtitle("https://example.com/sub.json", "中文", 0, "track-1", false);

    expect(clipState.subtitleFetchState).toBe("ready");
    expect(clipState.subtitleBody).toEqual(SUBTITLE_BODY);
    expect(clipState.noSubtitleReason).toBe(null);
    expect(clipState.noSubtitleDetail).toBe("");
    expect(acceptSubtitle).toHaveBeenCalledTimes(1);
    expect(acceptSubtitle).toHaveBeenCalledWith({
      body: unsortedBody,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文",
      runId: 0
    });
    expect(fetchBodyMock).not.toHaveBeenCalled();
  });

  it("loadSubtitle 网络成功 ready：陈旧原因与详情清空，且经字幕接受事务", async () => {
    clipState.setNoSubtitleReason("asr-auth");
    clipState.setNoSubtitleDetail("（错误详情：HTTP 401）");
    vi.mocked(fetchBodyMock).mockResolvedValue({ body: SUBTITLE_BODY });

    await fetcher.loadSubtitle("https://example.com/sub.json", "中文", 0, "track-1", true);

    expect(clipState.subtitleFetchState).toBe("ready");
    expect(clipState.subtitleBody).toEqual(SUBTITLE_BODY);
    expect(clipState.noSubtitleReason).toBe(null);
    expect(clipState.noSubtitleDetail).toBe("");
    expect(acceptSubtitle).toHaveBeenCalledTimes(1);
    expect(acceptSubtitle).toHaveBeenCalledWith({
      body: SUBTITLE_BODY,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文",
      runId: 0
    });
    expect(fetchBodyMock).toHaveBeenCalledWith("https://example.com/sub.json");
  });
});

describe("loadSubtitle 缓存边界行为（重构前后不变）", () => {
  it("网络成功但缓存写失败（LRU 淘汰后重试仍失败）：接受事务照常收尾", async () => {
    const attemptedOps: Array<{ op: string; bvid: string; cid: string }> = [];
    setSubtitleCacheWriteInterceptorForTests(({ op, bvid, cid }) => {
      attemptedOps.push({ op, bvid, cid });
      throw new Error("quota exceeded");
    });
    vi.mocked(fetchBodyMock).mockResolvedValue({ body: SUBTITLE_BODY });

    await fetcher.loadSubtitle("https://example.com/sub.json", "中文", 0, "track-1", true);
    setSubtitleCacheWriteInterceptorForTests(null);

    expect(acceptSubtitle).toHaveBeenCalledTimes(1);
    expect(clipState.subtitleFetchState).toBe("ready");
    expect(attemptedOps).toContainEqual({
      op: "put-raw",
      bvid: clipState.bvid,
      cid: clipState.cid
    });
  });

  it("缓存命中但时长不匹配：清缓存后走网络重抓", async () => {
    await storageHost.seedCacheEntry(subtitleCacheKey(), [{ from: 0, to: 10, content: "过短" }]);
    vi.mocked(fetchBodyMock).mockResolvedValue({ body: SUBTITLE_BODY });

    await fetcher.loadSubtitle("https://example.com/sub.json", "中文", 0, "track-1", false);

    expect(clipState.subtitleBody).toEqual(SUBTITLE_BODY);
    expect(clipState.subtitleFetchState).toBe("ready");
    expect(fetchBodyMock).toHaveBeenCalledWith("https://example.com/sub.json");
    await expect(loadSubtitleFromCache(subtitleCacheKey())).resolves.toEqual(SUBTITLE_BODY);
  });

  it("缓存命中但时长不匹配 + 网络也失败：坏缓存被清掉，盘上不留坏体", async () => {
    clipState.setSubtitleFetchState("loading");
    clipState.setSubtitleBody([]);
    await storageHost.seedCacheEntry(subtitleCacheKey(), [{ from: 0, to: 10, content: "过短" }]);
    vi.mocked(fetchBodyMock).mockRejectedValue(new Error("HTTP 500"));

    await expect(
      fetcher.loadSubtitle("https://example.com/sub.json", "中文", 0, "track-1", false)
    ).rejects.toThrow("HTTP 500");

    expect(storageHost.hasEntry(subtitleCacheKey())).toBe(false);
    await expect(loadSubtitleFromCache(subtitleCacheKey())).resolves.toBeNull();
    expect(clipState.subtitleBody).toEqual([]);
  });
});

describe("充电专属视频（upowerBlocked）：无字幕时跳过 ASR 直接给出专属原因", () => {
  it("meta 标记 upowerBlocked=true 且无 CC 字幕时：直接以 upower-exclusive 提交无字幕，清空旧详情", async () => {
    clipState.setNoSubtitleReason("asr-unknown");
    clipState.setNoSubtitleDetail("（错误详情：旧错误）");
    vi.mocked(fetchMetaMock).mockResolvedValue({
      aid: "100",
      title: "充电专属测试",
      author: "UP主",
      description: "",
      uploadDate: "2026-01-01",
      defaultCid: "101",
      defaultDuration: 300,
      pages: [{ cid: "101", page: 1, part: "P1", duration: 300 }],
      upowerBlocked: true
    });
    vi.mocked(fetchBundleMock).mockResolvedValue({
      tracks: [],
      chapters: []
    });

    await fetcher.refreshClip();

    expect(commitNoSubtitle).toHaveBeenCalledTimes(1);
    expect(commitNoSubtitle).toHaveBeenCalledWith({
      noSubtitleReason: "upower-exclusive",
      runId: 1
    });
    expect(clipState.subtitleFetchState).toBe("empty");
    expect(clipState.noSubtitleReason).toBe("upower-exclusive");
    expect(clipState.noSubtitleDetail).toBe("");
  });
});

describe("未登录 B 站（loginRequired）：无字幕时优先提示登录，不落入语音平台未配置", () => {
  it("bundle 标记 loginRequired=true 且无 CC 字幕时：直接以 bili-login-required 提交无字幕，清空旧详情", async () => {
    clipState.setNoSubtitleReason("no-asr-config");
    clipState.setNoSubtitleDetail("（错误详情：旧错误）");
    vi.mocked(fetchMetaMock).mockResolvedValue({
      aid: "100",
      title: "未登录测试",
      author: "UP主",
      description: "",
      uploadDate: "2026-01-01",
      defaultCid: "101",
      defaultDuration: 300,
      pages: [{ cid: "101", page: 1, part: "P1", duration: 300 }]
    });
    vi.mocked(fetchBundleMock).mockResolvedValue({
      tracks: [],
      chapters: [],
      loginRequired: true
    });

    await fetcher.refreshClip();

    expect(commitNoSubtitle).toHaveBeenCalledTimes(1);
    expect(commitNoSubtitle).toHaveBeenCalledWith({
      noSubtitleReason: "bili-login-required",
      runId: 1
    });
    expect(clipState.subtitleFetchState).toBe("empty");
    expect(clipState.noSubtitleReason).toBe("bili-login-required");
    expect(clipState.noSubtitleDetail).toBe("");
  });

  it("bundle 标记 loginRequired=true 但已有可用字幕轨时：正常加载字幕轨，不报未登录", async () => {
    vi.mocked(fetchMetaMock).mockResolvedValue({
      aid: "100",
      title: "未登录但有轨测试",
      author: "UP主",
      description: "",
      uploadDate: "2026-01-01",
      defaultCid: "101",
      defaultDuration: 300,
      pages: [{ cid: "101", page: 1, part: "P1", duration: 300 }]
    });
    vi.mocked(fetchBundleMock).mockResolvedValue({
      tracks: [
        {
          id: "track-1",
          lan: "zh-CN",
          lanDoc: "中文",
          subtitleUrl: "https://example.com/sub.json",
          source: "player-v2"
        }
      ],
      chapters: [],
      loginRequired: true
    });
    vi.mocked(fetchBodyMock).mockResolvedValue({ body: SUBTITLE_BODY });

    await fetcher.refreshClip();

    expect(commitNoSubtitle).not.toHaveBeenCalled();
    expect(acceptSubtitle).toHaveBeenCalledTimes(1);
    expect(clipState.subtitleFetchState).toBe("ready");
    expect(clipState.noSubtitleReason).toBe(null);
  });
});

describe("586c61b 回归：refreshClip 错误路径的 fetchState 保持 error", () => {
  it("抓取失败收尾 resetClipState({ keepFetchState: true }) 后 fetchState 为 error（不被洗回 idle）", async () => {
    clipState.setSubtitleFetchState("loading");
    vi.mocked(fetchMetaMock).mockRejectedValue(new Error("meta down"));

    await expect(fetcher.refreshClip()).resolves.toBeUndefined();

    expect(clipState.subtitleFetchState).toBe("error");
    expect(clipState.bvid).toBe("");
    expect(clipState.subtitleBody).toEqual([]);
    expect(clipState.noSubtitleReason).toBe(null);
  });
});
