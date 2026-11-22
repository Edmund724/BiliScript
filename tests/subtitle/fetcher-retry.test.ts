import { beforeEach, describe, expect, it, vi, type MockedObject } from "vitest";
import { resetModuleState } from "../setup.js";

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
vi.mock("../../extension/subtitle/commit.js", () => ({
  configureCommitUi: vi.fn(),
  acceptSubtitle: vi.fn(async () => {}),
  commitNoSubtitle: vi.fn(async () => {})
}));
vi.mock("../../extension/asr/pipeline.js", () => ({
  runAsrPipeline: vi.fn()
}));
vi.mock("../../extension/asr/fallback.js", () => ({
  createAsrFallback: vi.fn(() => ({
    hasActiveAsrTranscribe: vi.fn(() => false),
    maybeRunAsrFallback: vi.fn(async () => "skip"),
    awaitActiveAsrTranscribe: vi.fn(async () => {})
  }))
}));

const oldTrack = { id: "sub-1", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "https://i0.hdslb.com/sub-old.json", source: "player-wbi-v2" };
const freshTrack = { id: "sub-1", lan: "zh-CN", lanDoc: "中文", subtitleUrl: "https://i0.hdslb.com/sub-fresh.json?auth_key=new", source: "player-wbi-v2" };
const goodBody = [{ from: 0, to: 200, content: "hello" }];

let fetcher: typeof import("../../extension/subtitle/fetcher.js");
let state: (typeof import("../../extension/core/state.js"))["state"];
let gateway: MockedObject<typeof import("../../extension/bilibili/gateway.js")>;
let uiStatus: MockedObject<typeof import("../../extension/core/ui-status.js")>;
let commit: MockedObject<typeof import("../../extension/subtitle/commit.js")>;
let readerBus: MockedObject<typeof import("../../extension/reader/reader-bus.js")>;

async function importEpoch() {
  fetcher = await import("../../extension/subtitle/fetcher.js");
  state = (await import("../../extension/core/state.js")).state;
  gateway = vi.mocked(await import("../../extension/bilibili/gateway.js"));
  uiStatus = vi.mocked(await import("../../extension/core/ui-status.js"));
  commit = vi.mocked(await import("../../extension/subtitle/commit.js"));
  readerBus = vi.mocked(await import("../../extension/reader/reader-bus.js"));

  gateway.fetchVideoMeta.mockReset();
  gateway.fetchSubtitleBundle.mockReset();
  gateway.contentFetchJson.mockReset();
  gateway.readRuntimeVideoDuration.mockReset().mockReturnValue(300);
  commit.acceptSubtitle.mockReset().mockResolvedValue([]);
  commit.commitNoSubtitle.mockReset().mockResolvedValue(undefined);
  uiStatus.setStatus.mockReset();
  readerBus.notifyReaderPresenter.mockReset();

  gateway.fetchVideoMeta.mockResolvedValue({
    aid: "123",
    title: "测试标题",
    author: "测试作者",
    description: "测试简介",
    uploadDate: "2026-01-01",
    defaultCid: "101",
    defaultDuration: 300,
    pages: [{ cid: "101", page: 1, part: "P1", duration: 300 }]
  });
}

beforeEach(async () => {
  resetModuleState();
  await importEpoch();
});

describe("retryWithFreshBundle：签名 URL 失效重试链（经 refreshClip 驱动）", () => {
  it("HTTP 403 触发：重取 bundle → 按原偏好重选同 id 轨 → 用新签名 URL 重试一次后成功", async () => {
    gateway.fetchSubtitleBundle
      .mockResolvedValueOnce({ tracks: [oldTrack], chapters: [] })
      .mockResolvedValueOnce({ tracks: [freshTrack], chapters: [] });
    gateway.contentFetchJson
      .mockRejectedValueOnce(new Error("HTTP 403"))
      .mockResolvedValueOnce({ body: goodBody });

    await expect(fetcher.refreshClip()).resolves.toBeUndefined();

    expect(gateway.fetchSubtitleBundle).toHaveBeenCalledTimes(2);
    expect(gateway.contentFetchJson).toHaveBeenCalledTimes(2);
    expect(gateway.fetchSubtitleBundle).toHaveBeenLastCalledWith(
      gateway.contentFetchJson,
      expect.objectContaining({ bvid: "BV1test000000", cid: "101", aid: "123" })
    );
    expect(gateway.contentFetchJson.mock.calls[0][0]).toBe(oldTrack.subtitleUrl);
    expect(gateway.contentFetchJson.mock.calls[1][0]).toBe(freshTrack.subtitleUrl);
    expect(commit.acceptSubtitle).toHaveBeenCalledTimes(1);
    expect(commit.acceptSubtitle).toHaveBeenCalledWith(
      expect.objectContaining({
        body: goodBody,
        selectedSubtitleId: "sub-1",
        selectedSubtitleUrl: freshTrack.subtitleUrl,
        selectedSubtitleLang: "中文"
      })
    );
  });

  it("SUBTITLE_DURATION_MISMATCH 触发：时长不匹配的 body 落到重试，新 bundle 重载成功", async () => {
    gateway.fetchSubtitleBundle
      .mockResolvedValueOnce({ tracks: [oldTrack], chapters: [] })
      .mockResolvedValueOnce({ tracks: [freshTrack], chapters: [] });
    gateway.contentFetchJson
      .mockResolvedValueOnce({ body: [{ from: 0, to: 10, content: "short" }] })
      .mockResolvedValueOnce({ body: goodBody });

    await expect(fetcher.refreshClip()).resolves.toBeUndefined();

    expect(gateway.fetchSubtitleBundle).toHaveBeenCalledTimes(2);
    expect(gateway.contentFetchJson).toHaveBeenCalledTimes(2);
    expect(commit.acceptSubtitle).toHaveBeenCalledTimes(1);
  });

  it("重试仍失败：只重试一次，原始错误上抛并由 refreshClip 错误路径收尾", async () => {
    gateway.fetchSubtitleBundle.mockResolvedValue({ tracks: [oldTrack], chapters: [] });
    gateway.contentFetchJson.mockRejectedValue(new Error("HTTP 403"));

    await expect(fetcher.refreshClip()).resolves.toBeUndefined();

    expect(gateway.fetchSubtitleBundle).toHaveBeenCalledTimes(2);
    expect(gateway.contentFetchJson).toHaveBeenCalledTimes(2);
    expect(uiStatus.setStatus).toHaveBeenLastCalledWith("抓取失败：HTTP 403");
    expect(state.clip.subtitleFetchState).toBe("error");
    expect(state.clip.noSubtitleReason).toBe(null);
  });

  it("重抓 bundle 无任何轨道：无合适轨，抛触发重试的原始错误，不再尝试加载 body", async () => {
    gateway.fetchSubtitleBundle
      .mockResolvedValueOnce({ tracks: [oldTrack], chapters: [] })
      .mockResolvedValueOnce({ tracks: [], chapters: [] });
    gateway.contentFetchJson.mockRejectedValue(new Error("HTTP 403"));

    await expect(fetcher.refreshClip()).resolves.toBeUndefined();

    expect(gateway.fetchSubtitleBundle).toHaveBeenCalledTimes(2);
    expect(gateway.contentFetchJson).toHaveBeenCalledTimes(1);
    expect(uiStatus.setStatus).toHaveBeenLastCalledWith("抓取失败：HTTP 403");
    expect(state.clip.subtitleFetchState).toBe("error");
  });

  it("非重试类错误（无 HTTP 特征）不走重试链：bundle 只抓一次直接进错误路径", async () => {
    gateway.fetchSubtitleBundle.mockResolvedValue({ tracks: [oldTrack], chapters: [] });
    gateway.contentFetchJson.mockRejectedValue(new Error("字幕文件为空。"));

    await expect(fetcher.refreshClip()).resolves.toBeUndefined();

    expect(gateway.fetchSubtitleBundle).toHaveBeenCalledTimes(1);
    expect(gateway.contentFetchJson).toHaveBeenCalledTimes(1);
    expect(uiStatus.setStatus).toHaveBeenLastCalledWith("抓取失败：字幕文件为空。");
    expect(state.clip.subtitleFetchState).toBe("error");
  });

  it("refreshClip 默认命中本地字幕缓存；显式 forceRefresh: true 才绕过缓存走网络", async () => {
    gateway.fetchSubtitleBundle.mockResolvedValue({ tracks: [oldTrack], chapters: [] });
    gateway.contentFetchJson.mockResolvedValue({ body: goodBody });

    await expect(fetcher.refreshClip()).resolves.toBeUndefined();
    expect(gateway.contentFetchJson).toHaveBeenCalledTimes(1);

    await expect(fetcher.refreshClip()).resolves.toBeUndefined();
    expect(gateway.contentFetchJson).toHaveBeenCalledTimes(1);

    await expect(fetcher.refreshClip({ forceRefresh: true })).resolves.toBeUndefined();
    expect(gateway.contentFetchJson).toHaveBeenCalledTimes(2);
  });
});
