import { beforeEach, describe, expect, it, vi, type MockedObject } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost, type ChromeHost } from "../helpers/chrome-host.js";
import { getSubtitleCacheKey } from "../../extension/subtitle/cache.js";
import { trackIdentity } from "../../extension/subtitle/source-key.js";

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

const GOOD_BODY = [
  { from: 0, to: 1.2, content: "First" },
  { from: 1.5, to: 290, content: "Second" }
];
const EN_TRACK = {
  id: "sub-en",
  lan: "ai-en",
  lanDoc: "English",
  subtitleUrl: "https://i0.hdslb.com/en.json"
};

function createPending<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let fetcher: typeof import("../../extension/subtitle/fetcher.js");
let commit: typeof import("../../extension/subtitle/commit.js");
let storageHost: ChromeHost;
let state: (typeof import("../../extension/core/state.js"))["state"];
let clipState: (typeof import("../../extension/core/state.js"))["clipState"];
let gateway: MockedObject<typeof import("../../extension/bilibili/gateway.js")>;
let core: MockedObject<typeof import("../../extension/subtitle/core.js")>;
let readerBus: MockedObject<typeof import("../../extension/reader/reader-bus.js")>;
let uiStatus: MockedObject<typeof import("../../extension/core/ui-status.js")>;

function secondaryCacheKey() {
  return getSubtitleCacheKey({
    bvid: state.clip.bvid,
    cid: state.clip.cid,
    identity: trackIdentity(EN_TRACK.id, EN_TRACK.subtitleUrl, EN_TRACK.lanDoc)
  });
}

async function importEpoch() {
  fetcher = await import("../../extension/subtitle/fetcher.js");
  commit = await import("../../extension/subtitle/commit.js");
  const stateModule = await import("../../extension/core/state.js");
  state = stateModule.state;
  clipState = stateModule.clipState;
  gateway = vi.mocked(await import("../../extension/bilibili/gateway.js"));
  core = vi.mocked(await import("../../extension/subtitle/core.js"));
  readerBus = vi.mocked(await import("../../extension/reader/reader-bus.js"));
  uiStatus = vi.mocked(await import("../../extension/core/ui-status.js"));

  storageHost = installChromeHost();
  gateway.contentFetchJson.mockReset();
  core.refreshHotComments.mockReset().mockResolvedValue(undefined);
  readerBus.notifyReaderPresenter.mockReset();
  uiStatus.setStatus.mockReset();
}

function acceptSecondary(runId?: number) {
  return commit.acceptSecondarySubtitle({
    body: [...GOOD_BODY].reverse(),
    subtitleId: EN_TRACK.id,
    subtitleUrl: EN_TRACK.subtitleUrl,
    ...(runId !== undefined ? { runId } : {})
  });
}

function loadSecondary(overrides: { forceRefresh?: boolean; runId?: number } = {}) {
  return fetcher.loadSecondarySubtitle(
    EN_TRACK.subtitleUrl,
    EN_TRACK.lanDoc,
    overrides.runId,
    EN_TRACK.id,
    overrides.forceRefresh
  );
}

beforeEach(async () => {
  resetModuleState();
  await importEpoch();
  clipState.setBvid("BV1test000000");
  clipState.setCid("101");
  clipState.setVideoDuration(300);
});

describe("acceptSecondarySubtitle（副轨接受事务）", () => {
  it("写副轨槽（已排序 + ready）并只发 secondary-subtitle-ready", async () => {
    await acceptSecondary();

    expect(state.clip.secondarySubtitle).toMatchObject({
      id: EN_TRACK.id,
      url: EN_TRACK.subtitleUrl,
      state: "ready"
    });
    expect(state.clip.secondarySubtitle.body.map((item) => item.content)).toEqual(["First", "Second"]);
    expect(readerBus.notifyReaderPresenter).toHaveBeenCalledTimes(1);
    expect(readerBus.notifyReaderPresenter).toHaveBeenCalledWith({ kind: "secondary-subtitle-ready" });
  });

  it("不写整片单相位、不碰主轨三项、不拉热评", async () => {
    clipState.setSubtitleFetchState("ready");
    clipState.setSelectedSubtitleId("main-zh");
    clipState.setSelectedSubtitleUrl("https://sub/zh.json");
    clipState.setSelectedSubtitleLang("中文");
    clipState.setNoSubtitleReason("asr-network");
    core.refreshHotComments.mockClear();

    await acceptSecondary();

    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.noSubtitleReason).toBe("asr-network");
    expect(state.clip.selectedSubtitleId).toBe("main-zh");
    expect(state.clip.selectedSubtitleUrl).toBe("https://sub/zh.json");
    expect(state.clip.selectedSubtitleLang).toBe("中文");
    expect(state.clip.subtitleBody).toEqual([]);
    expect(core.refreshHotComments).not.toHaveBeenCalled();
  });

  it("runId 过期 ⇒ STALE_RUN：零写入、零通知", async () => {
    clipState.setFetchRunId(2);

    await expect(acceptSecondary(1)).rejects.toMatchObject({ code: "STALE_RUN" });

    expect(state.clip.secondarySubtitle).toMatchObject({ id: "", body: [], state: "idle" });
    expect(readerBus.notifyReaderPresenter).not.toHaveBeenCalled();
  });
});

describe("loadSecondarySubtitle（副轨装载）", () => {
  it("乐观写「目标 + loading」，网络到站后落 ready", async () => {
    const pending = createPending<{ body: unknown[] }>();
    gateway.contentFetchJson.mockImplementation(() => pending.promise);

    const run = loadSecondary();
    await vi.waitFor(() => expect(gateway.contentFetchJson).toHaveBeenCalledTimes(1));

    expect(state.clip.secondarySubtitle).toMatchObject({
      id: EN_TRACK.id,
      url: EN_TRACK.subtitleUrl,
      body: [],
      state: "loading"
    });

    pending.resolve({ body: GOOD_BODY });
    await expect(run).resolves.toBeUndefined();

    expect(state.clip.secondarySubtitle.state).toBe("ready");
    expect(state.clip.secondarySubtitle.body).toHaveLength(2);
  });

  it("forceRefresh=false 命中缓存 ⇒ 不打网络；forceRefresh=true 跳过缓存走网络", async () => {
    storageHost.seedCacheEntry(secondaryCacheKey(), GOOD_BODY);

    await loadSecondary();
    expect(gateway.contentFetchJson).not.toHaveBeenCalled();
    expect(state.clip.secondarySubtitle.state).toBe("ready");
    expect(state.clip.secondarySubtitle.body.map((item) => item.content)).toEqual(["First", "Second"]);

    gateway.contentFetchJson.mockResolvedValue({
      body: [
        { from: 0, to: 1.2, content: "Net" },
        { from: 1.5, to: 290, content: "Work" }
      ]
    });
    await loadSecondary({ forceRefresh: true });

    expect(gateway.contentFetchJson).toHaveBeenCalledTimes(1);
    expect(state.clip.secondarySubtitle.body.map((item) => item.content)).toEqual(["Net", "Work"]);
  });

  it("失败（网络抛错）⇒ error 态 + 保留目标 + 清 body + 上抛（不回退、不弹开关）", async () => {
    gateway.contentFetchJson.mockRejectedValue(new Error("HTTP 500"));

    await expect(loadSecondary()).rejects.toThrow("HTTP 500");

    expect(state.clip.secondarySubtitle).toMatchObject({
      id: EN_TRACK.id,
      body: [],
      state: "error"
    });
  });

  it("时长不匹配 ⇒ error 态（错轨不写进槽）", async () => {
    gateway.contentFetchJson.mockResolvedValue({ body: [{ from: 0, to: 400, content: "错轨" }] });

    await expect(loadSecondary()).rejects.toMatchObject({ code: "SUBTITLE_DURATION_MISMATCH" });
    expect(state.clip.secondarySubtitle.state).toBe("error");
    expect(state.clip.secondarySubtitle.body).toEqual([]);
  });

  it("空 body ⇒ error 态", async () => {
    gateway.contentFetchJson.mockResolvedValue({ body: [] });

    await expect(loadSecondary()).rejects.toThrow("字幕文件为空。");
    expect(state.clip.secondarySubtitle.state).toBe("error");
  });

  it("URL 为空 ⇒ 直接抛，且不产生任何乐观写入", async () => {
    await expect(fetcher.loadSecondarySubtitle("", "English", undefined, "sub-en")).rejects.toThrow(
      "字幕 URL 为空。"
    );
    expect(state.clip.secondarySubtitle.state).toBe("idle");
  });

  it("STALE_RUN 让位 ⇒ 不写 error（旧 run 的失败不污染已重置的新视频槽）", async () => {
    clipState.setFetchRunId(5);
    gateway.contentFetchJson.mockRejectedValue(
      Object.assign(new Error("stale"), { code: "STALE_RUN" })
    );

    await expect(loadSecondary({ runId: 4 })).rejects.toMatchObject({ code: "STALE_RUN" });

    expect(state.clip.secondarySubtitle.state).toBe("idle");
  });
});

describe("清场（换视频）", () => {
  it("resetClipState 清副轨槽", () => {
    clipState.applySecondarySubtitle({
      id: EN_TRACK.id,
      url: EN_TRACK.subtitleUrl,
      body: GOOD_BODY as never
    });
    expect(state.clip.secondarySubtitle.state).toBe("ready");

    fetcher.resetClipState();

    expect(state.clip.secondarySubtitle).toEqual({ id: "", url: "", body: [], state: "idle" });
  });
});
