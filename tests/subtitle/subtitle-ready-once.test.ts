import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";

vi.mock("../../extension/bilibili/gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/gateway.js")>();
  return {
    ...actual,
    fetchVideoMeta: vi.fn(),
    fetchSubtitleBundle: vi.fn(),
    readRuntimeVideoDuration: vi.fn(() => 300),
    contentFetchJson: vi.fn()
  };
});
vi.mock("../../extension/reader/page-context.js", () => ({
  resolvePageContext: vi.fn(() => ({ pageIndex: 1, cid: "101", cidSource: "test", pageTitle: "P1", duration: 300 }))
}));
vi.mock("../../extension/subtitle/core.js", () => ({
  readVideoTitle: vi.fn(() => ""),
  readVideoAuthor: vi.fn(() => ""),
  readUploadDate: vi.fn(() => ""),
  readVideoDescription: vi.fn(() => ""),
  refreshHotComments: vi.fn(async () => {}),
  invalidateDerived: vi.fn(),
  refreshDerivedContent: vi.fn(async () => {})
}));
vi.mock("../../extension/core/runtime.js", () => ({
  getSettings: vi.fn(async () => ({}))
}));
vi.mock("../../extension/shared/messaging.js", () => ({
  sendRuntimeMessage: vi.fn(async () => null)
}));
vi.mock("../../extension/reader/reader-bus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/reader/reader-bus.js")>();
  return {
    ...actual,
    notifyReaderPresenter: vi.fn(actual.notifyReaderPresenter)
  };
});

describe("字幕就绪通知全程恰一次（链级防回焊锁）", () => {
  let fetcher: typeof import("../../extension/subtitle/fetcher.js");
  let state: typeof import("../../extension/core/state.js").state;
  let notifyReaderPresenter: MockedFunction<
    typeof import("../../extension/reader/reader-bus.js").notifyReaderPresenter
  >;

  beforeEach(async () => {
    resetModuleState();
    setLocationUrl(READER_MODE_URL);
    const gateway = await import("../../extension/bilibili/gateway.js");
    vi.mocked(gateway.fetchVideoMeta).mockResolvedValue({
      aid: "aid1",
      title: "测试视频",
      author: "UP",
      uploadDate: "2026-01-01",
      description: "",
      pages: [{ cid: "101", page: 1, part: "P1", duration: 300 }],
      defaultCid: "101",
      defaultDuration: 300
    });
    vi.mocked(gateway.fetchSubtitleBundle).mockResolvedValue({
      tracks: [
        {
          id: "s1",
          lan: "zh-CN",
          lanDoc: "中文（自动）",
          subtitleUrl: "https://fake.subtitle/url.json",
          source: ""
        }
      ],
      chapters: []
    });
    vi.mocked(gateway.contentFetchJson).mockResolvedValue({
      body: [
        { from: 0, to: 140, content: "大家好" },
        { from: 140, to: 280, content: "开始今天的话题" }
      ]
    });
    const bus = await import("../../extension/reader/reader-bus.js");
    notifyReaderPresenter = vi.mocked(bus.notifyReaderPresenter);
    notifyReaderPresenter.mockClear();
    const stateMod = await import("../../extension/core/state.js");
    state = stateMod.state;
    stateMod.transitionReaderShell("open");
    fetcher = await import("../../extension/subtitle/fetcher.js");
  });

  it("refreshClip 网络新抓全程只 emit 一次 subtitle-ready", async () => {
    await fetcher.refreshClip();

    const readyCalls = notifyReaderPresenter.mock.calls.filter((call) => call[0].kind === "subtitle-ready");
    expect(readyCalls).toHaveLength(1);
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toHaveLength(2);
  });
});
