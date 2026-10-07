// 双语副轨的装载与接受（票 bilingual-subtitles/02 + 05 的裁定，06 号票落地）。
//
// 三层锁：
//   1. 事务级——commit.acceptSecondarySubtitle：写副轨槽（目标轨身份 + 已排序 body +
//      ready）并发 "secondary-subtitle-ready"；**不写** subtitleFetchState /
//      noSubtitleReason / noSubtitleDetail / 热评 / 派生三件套；**不动**主轨 selected
//      三项（它们是 context-payload 签名键与 AI 段缓存键的输入）；runId 过期时
//      STALE_RUN 让位（零写入、零通知）。
//   2. 装载级——fetcher.loadSecondarySubtitle：乐观写「目标 + loading」早于任何 await；
//      缓存优先（forceRefresh=false）/ 网络路径；抛错（URL 空 / 空 body / 时长不匹配 /
//      网络失败）落 error 态但**保留目标**（不回退，Q3）；STALE_RUN 不写 error
//      （旧 run 的失败不得污染已重置的新视频槽）。
//   3. 清场级——resetClipState 清副轨槽（与 clip 同生命周期）。
//
// 系统可能怎么坏（先列失败方式，再据此写用例）：
//   a. 副轨写进主轨槽 / 借道 selected 三项 ⇒ AI 段缓存键与上下文签名被污染；
//   b. 副轨装载把 subtitleFetchState 写成 loading/error ⇒ 整个字幕 tab 被洗成
//      加载 / 失败面（Q9 的"副轨不阻塞主轨"直接破产）；
//   c. 副轨接受顺手拉热评 / 重建派生三件套 ⇒ 主轨消费面被动重算；
//   d. 失败把目标语言回退掉 ⇒ 与 Q4「缺轨留空、不猜」自相矛盾，副列选中态与 state 两说；
//   e. 迟到的旧 run 把 error 写进新视频槽；
//   f. 换视频不清副轨槽 ⇒ 新视频挂着上一个视频的译文（串体）。
//
// mock 结构照 tests/subtitle/reset-fetch-runid.test.ts：gateway / page-context /
// subtitle-core / ui-status / reader-bus mock 掉，state、error-helpers、commit、
// selection、cache 全部保持真实；缓存口跑在内存版 chrome.storage.local 上
//（与 tests/subtitle/asr-fallback.test.ts 同款），因此「缓存命中」是真的预置一条
// per-track 条目，而不是替换掉整个缓存模块。

import { beforeEach, describe, expect, it, vi, type MockedObject } from "vitest";
import { resetModuleState } from "../setup.js";
import { installMemoryStorage, seedCache } from "../helpers/memory-storage.js";
import { getSubtitleCacheKey } from "../../extension/subtitle/cache.js";

vi.mock("../../extension/reader/reader-bus.js", () => ({
  subscribeSubtitleRefresh: vi.fn(),
  notifyReaderPresenter: vi.fn()
}));
vi.mock("../../extension/core/ui-status.js", () => ({
  setStatus: vi.fn(),
  setMessage: vi.fn()
}));
vi.mock("../../extension/bilibili/gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/gateway.js")>();
  return {
    ...actual,
    fetchVideoMeta: vi.fn(),
    fetchSubtitleBundle: vi.fn(),
    fetchSubtitleBody: vi.fn(),
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
  refreshDerivedContent: vi.fn(async () => {})
}));

// videoDuration=300 的合规体（maxTo 290）
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
let state: (typeof import("../../extension/core/state.js"))["state"];
let clipState: (typeof import("../../extension/core/state.js"))["clipState"];
let gateway: MockedObject<typeof import("../../extension/bilibili/gateway.js")>;
let core: MockedObject<typeof import("../../extension/subtitle/core.js")>;
let readerBus: MockedObject<typeof import("../../extension/reader/reader-bus.js")>;
let uiStatus: MockedObject<typeof import("../../extension/core/ui-status.js")>;

// 副轨的 per-track 缓存键（真实键装配，与装载器算出的键同一份实现）；缓存口由
// 共享的内存 storage 宿主承载（tests/helpers/memory-storage.ts）。
function secondaryCacheKey() {
  return getSubtitleCacheKey({
    bvid: state.clip.bvid,
    cid: state.clip.cid,
    subtitleId: EN_TRACK.id,
    subtitleUrl: EN_TRACK.subtitleUrl,
    lang: EN_TRACK.lanDoc
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

  installMemoryStorage();
  gateway.fetchSubtitleBody.mockReset();
  core.refreshHotComments.mockReset().mockResolvedValue(undefined);
  readerBus.notifyReaderPresenter.mockReset();
  uiStatus.setStatus.mockReset();
  uiStatus.setMessage.mockReset();
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
    expect(readerBus.notifyReaderPresenter).toHaveBeenCalledWith("secondary-subtitle-ready");
  });

  it("不写整片单相位、不碰主轨三项、不拉热评", async () => {
    clipState.setSubtitleFetchState("ready");
    clipState.setSelectedSubtitleId("main-zh");
    clipState.setSelectedSubtitleUrl("https://sub/zh.json");
    clipState.setSelectedSubtitleLang("中文");
    clipState.setNoSubtitleReason("asr-network");
    core.refreshHotComments.mockClear();

    await acceptSecondary();

    // 副轨不阻塞主轨：整片相位与无字幕归因逐字不动
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.noSubtitleReason).toBe("asr-network");
    // 主轨三项逐字节不变（它们是 context-payload 签名键与 AI 段缓存键的输入）
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
    gateway.fetchSubtitleBody.mockImplementation(() => pending.promise);

    const run = loadSecondary();
    await vi.waitFor(() => expect(gateway.fetchSubtitleBody).toHaveBeenCalledTimes(1));

    // await 之前就已乐观写入：副列选中态与列表占位立刻反映用户的选择
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
    await seedCache(secondaryCacheKey(), GOOD_BODY);

    await loadSecondary();
    expect(gateway.fetchSubtitleBody).not.toHaveBeenCalled();
    expect(state.clip.secondarySubtitle.state).toBe("ready");
    expect(state.clip.secondarySubtitle.body.map((item) => item.content)).toEqual(["First", "Second"]);

    // 盘上仍是那条缓存体；forceRefresh 必须无视它取网络新体（内容可区分，证明真的绕过）
    gateway.fetchSubtitleBody.mockResolvedValue({
      body: [
        { from: 0, to: 1.2, content: "Net" },
        { from: 1.5, to: 290, content: "Work" }
      ]
    });
    await loadSecondary({ forceRefresh: true });

    expect(gateway.fetchSubtitleBody).toHaveBeenCalledTimes(1);
    expect(state.clip.secondarySubtitle.body.map((item) => item.content)).toEqual(["Net", "Work"]);
  });

  it("失败（网络抛错）⇒ error 态 + 保留目标 + 清 body + 上抛（不回退、不弹开关）", async () => {
    gateway.fetchSubtitleBody.mockRejectedValue(new Error("HTTP 500"));

    await expect(loadSecondary()).rejects.toThrow("HTTP 500");

    expect(state.clip.secondarySubtitle).toMatchObject({
      id: EN_TRACK.id,
      body: [],
      state: "error"
    });
  });

  it("时长不匹配 ⇒ error 态（错轨不写进槽）", async () => {
    gateway.fetchSubtitleBody.mockResolvedValue({ body: [{ from: 0, to: 400, content: "错轨" }] });

    await expect(loadSecondary()).rejects.toMatchObject({ code: "SUBTITLE_DURATION_MISMATCH" });
    expect(state.clip.secondarySubtitle.state).toBe("error");
    expect(state.clip.secondarySubtitle.body).toEqual([]);
  });

  it("空 body ⇒ error 态", async () => {
    gateway.fetchSubtitleBody.mockResolvedValue({ body: [] });

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
    gateway.fetchSubtitleBody.mockRejectedValue(
      Object.assign(new Error("stale"), { code: "STALE_RUN" })
    );

    await expect(loadSecondary({ runId: 4 })).rejects.toMatchObject({ code: "STALE_RUN" });

    // 代次自检先于乐观写入 ⇒ 连 loading 都不该落下
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
