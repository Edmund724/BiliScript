import { beforeEach, describe, expect, it, vi, type MockedObject } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost } from "../helpers/chrome-host.js";

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
  { from: 0, to: 1.2, content: "第一条" },
  { from: 1.5, to: 290, content: "第二条" }
];
const TRACK = {
  id: "sub-1",
  lan: "zh-CN",
  lanDoc: "中文",
  subtitleUrl: "https://i0.hdslb.com/sub.json",
  source: "player-wbi-v2"
};

function createPending<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let fetcher: typeof import("../../extension/subtitle/fetcher.js");
let cache: typeof import("../../extension/subtitle/cache.js");
let state: (typeof import("../../extension/core/state.js"))["state"];
let clipState: (typeof import("../../extension/core/state.js"))["clipState"];
let gateway: MockedObject<typeof import("../../extension/bilibili/gateway.js")>;
let uiStatus: MockedObject<typeof import("../../extension/core/ui-status.js")>;
let core: MockedObject<typeof import("../../extension/subtitle/core.js")>;

async function importEpoch() {
  cache = await import("../../extension/subtitle/cache.js");
  cache.setSubtitleCacheWriteInterceptorForTests(null);
  fetcher = await import("../../extension/subtitle/fetcher.js");
  const stateModule = await import("../../extension/core/state.js");
  state = stateModule.state;
  clipState = stateModule.clipState;
  gateway = vi.mocked(await import("../../extension/bilibili/gateway.js"));
  uiStatus = vi.mocked(await import("../../extension/core/ui-status.js"));
  core = vi.mocked(await import("../../extension/subtitle/core.js"));

  gateway.fetchVideoMeta.mockReset().mockResolvedValue({
    aid: "123",
    title: "测试标题",
    author: "测试作者",
    description: "测试简介",
    uploadDate: "2026-01-01",
    defaultCid: "101",
    defaultDuration: 300,
    pages: [{ cid: "101", page: 1, part: "P1", duration: 300 }]
  });
  gateway.fetchSubtitleBundle.mockReset().mockResolvedValue({ tracks: [TRACK], chapters: [] });
  gateway.contentFetchJson.mockReset();
  gateway.readRuntimeVideoDuration.mockReset().mockReturnValue(300);
  installChromeHost();
  uiStatus.setStatus.mockReset();
  core.refreshHotComments.mockReset().mockResolvedValue(undefined);
  core.refreshDerivedContent.mockReset().mockResolvedValue(undefined);
}

beforeEach(async () => {
  resetModuleState();
  await importEpoch();
});

describe("事务级 runId 自检（commit.acceptSubtitle / commitNoSubtitle）", () => {
  it("代次已被推进（runId 过期）→ STALE_RUN 让位：零 state 写入、零派生刷新、零通知", async () => {
    clipState.setFetchRunId(2);

    await expect(
      accept({
        runId: 1
      })
    ).rejects.toMatchObject({ code: "STALE_RUN" });

    expect(state.clip.selectedSubtitleId).toBe("");
    expect(state.clip.selectedSubtitleUrl).toBe("");
    expect(state.clip.selectedSubtitleLang).toBe("");
    expect(state.clip.subtitleBody).toEqual([]);
    expect(state.clip.subtitleFetchState).toBe("idle");
    expect(core.refreshHotComments).not.toHaveBeenCalled();
    const { notifyReaderPresenter } = await import("../../extension/reader/reader-bus.js");
    expect(notifyReaderPresenter).not.toHaveBeenCalled();
  });

  it("runId 与当前代次一致 → 正常提交（ready + 派生刷新 + 通知）", async () => {
    clipState.setFetchRunId(2);

    await accept({ runId: 2 });

    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody.map((item) => item.content)).toEqual(["第一条", "第二条"]);
    expect(core.refreshHotComments).toHaveBeenCalledTimes(1);
  });

  it("未传 runId → 不校验直接提交（asr/fallback 收尾路径行为不变）", async () => {
    clipState.setFetchRunId(7);

    await accept({});

    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toHaveLength(2);
  });

  it("commitNoSubtitle 同型：代次已被推进 → STALE_RUN 且 state 不动；当前代次 → 正常落 empty", async () => {
    const { commitNoSubtitle, configureCommitUi } = await import("../../extension/subtitle/commit.js");
    configureCommitUi({ setStatus: uiStatus.setStatus });

    clipState.setSubtitleFetchState("ready");
    clipState.setSubtitleBody(GOOD_BODY);
    clipState.setFetchRunId(3);

    await expect(commitNoSubtitle({ runId: 2 })).rejects.toMatchObject({ code: "STALE_RUN" });
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toEqual(GOOD_BODY);

    await expect(commitNoSubtitle({ runId: 3 })).resolves.toBeUndefined();
    expect(state.clip.subtitleFetchState).toBe("empty");
    expect(state.clip.subtitleBody).toEqual([]);
  });
});

function accept({ runId }: { runId?: number }) {
  return import("../../extension/subtitle/commit.js").then(({ acceptSubtitle }) =>
    acceptSubtitle({
      body: [...GOOD_BODY].reverse(),
      selectedSubtitleId: "sub-1",
      selectedSubtitleUrl: TRACK.subtitleUrl,
      selectedSubtitleLang: "中文",
      ...(runId !== undefined ? { runId } : {})
    })
  );
}

describe("resetClipState × 在飞 refreshClip 竞态（端到端）", () => {
  async function driveRefreshClipToCommitWindow() {
    clipState.setFetchRunId(1);
    clipState.setVideoDuration(300);
    const bodyPending = createPending<{ body: unknown[] }>();
    gateway.contentFetchJson.mockImplementation(() => bodyPending.promise);
    const dataWritePending = createPending<void>();
    let dataWriteStarted = false;
    cache.setSubtitleCacheWriteInterceptorForTests(async ({ op }) => {
      if (op === "put-raw") {
        dataWriteStarted = true;
        await dataWritePending.promise;
      }
    });
    const run = fetcher.refreshClip();
    await vi.waitFor(() => expect(gateway.contentFetchJson).toHaveBeenCalledTimes(1));
    bodyPending.resolve({ body: GOOD_BODY });
    await vi.waitFor(() => expect(dataWriteStarted).toBe(true));
    return { run, dataWritePending };
  }

  it("reset+递增插队后旧字幕到站：事务门口 STALE_RUN 让位，state 保持 reset 干净态", async () => {
    const { run, dataWritePending } = await driveRefreshClipToCommitWindow();

    clipState.setFetchRunId(clipState.fetchRunId + 1);
    fetcher.resetClipState();

    dataWritePending.resolve();
    await expect(run).resolves.toBeUndefined();

    expect(state.clip.subtitleBody).toEqual([]);
    expect(state.clip.subtitleFetchState).toBe("idle");
    expect(state.clip.selectedSubtitleId).toBe("");
    expect(state.clip.selectedSubtitleUrl).toBe("");
    expect(state.clip.title).toBe("");
    const statusTexts = uiStatus.setStatus.mock.calls.map((call) => String(call[0]));
    expect(statusTexts.some((text) => text.includes("抓取失败"))).toBe(false);
  });

  it("对照组：同一链路无 reset 插队时正常提交（证明竞态用例 red-capable）", async () => {
    const { run, dataWritePending } = await driveRefreshClipToCommitWindow();

    dataWritePending.resolve();
    await expect(run).resolves.toBeUndefined();

    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody.map((item) => item.content)).toEqual(["第一条", "第二条"]);
    expect(state.clip.selectedSubtitleId).toBe("sub-1");
  });
});

