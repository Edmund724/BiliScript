import { describe, expect, it, vi } from "vitest";
import type { MockedFunction } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";

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
vi.mock("../../extension/reader/reader-bus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/reader/reader-bus.js")>();
  return {
    ...actual,
    notifyReaderPresenter: vi.fn(actual.notifyReaderPresenter)
  };
});
vi.mock("../../extension/asr/pipeline.js", () => ({
  runAsrPipeline: vi.fn(({ onProgress }: { onProgress?: (msg: string) => void }) => {
    onProgress?.("无字幕轨，正在获取音频流…");
    return new Promise<never>(() => {});
  })
}));

const AUTHOR = "硅谷101";

describe("ASR 转写进行中：meta 行显示 UP主", () => {
  let fetcher: typeof import("../../extension/subtitle/fetcher.js");
  let state: typeof import("../../extension/core/state.js").state;
  let ids: typeof import("../../extension/reader/state.js").ids;
  let pipeline: typeof import("../../extension/asr/pipeline.js");
  let notifyReaderPresenter: MockedFunction<
    typeof import("../../extension/reader/reader-bus.js").notifyReaderPresenter
  >;

  function stubRuntimeMessages() {
    const chromeStub = globalThis.chrome as unknown as {
      runtime: { sendMessage: (message: unknown, callback?: (resp: unknown) => void) => unknown };
    };
    chromeStub.runtime.sendMessage = vi.fn((message: unknown, callback?: (resp: unknown) => void) => {
      const type = (message as { type?: string })?.type;
      if (type === "get-settings") {
        callback?.({ ok: true, settings: { asrAutoFallback: true, activeAsrProviderId: "p1", asrLanguage: "zh" } });
      } else if (type === "asr-providers-list") {
        callback?.({ providers: [{ id: "p1", name: "平台甲", model: "model-a" }] });
      } else {
        callback?.({ ok: true });
      }
      return undefined;
    });
  }

  async function setupEpoch({ openReader }: { openReader: boolean }) {
    resetModuleState();
    setLocationUrl(READER_MODE_URL);
    document.body.innerHTML = "";
    stubRuntimeMessages();

    const gateway = await import("../../extension/bilibili/gateway.js");
    vi.mocked(gateway.fetchVideoMeta).mockResolvedValue({
      aid: "123",
      title: "测试视频",
      author: AUTHOR,
      description: "",
      uploadDate: "2026-01-01",
      defaultCid: "101",
      defaultDuration: 300,
      pages: [{ cid: "101", page: 1, part: "P1", duration: 300 }]
    });
    vi.mocked(gateway.fetchSubtitleBundle).mockResolvedValue({ tracks: [], chapters: [] });

    ids = (await import("../../extension/reader/state.js")).ids;
    if (openReader) {
      mountReaderSkeleton(ids);
      mountPlayerChain();
    }
    const stateMod = await import("../../extension/core/state.js");
    state = stateMod.state;
    stateMod.transitionReaderShell(openReader ? "open" : "closed");
    await import("../../extension/reader/index.js");
    const bus = await import("../../extension/reader/reader-bus.js");
    notifyReaderPresenter = vi.mocked(bus.notifyReaderPresenter);
    notifyReaderPresenter.mockClear();
    pipeline = await import("../../extension/asr/pipeline.js");
    fetcher = await import("../../extension/subtitle/fetcher.js");
  }

  function metaNode(): HTMLElement {
    return document.getElementById(ids.readingMeta) as HTMLElement;
  }

  it("转写挂起期间：meta 行已投影 UP主（不等字幕落定）", async () => {
    await setupEpoch({ openReader: true });

    void fetcher.refreshClip();
    await vi.waitFor(() => expect(pipeline.runAsrPipeline).toHaveBeenCalled());

    expect(pipeline.runAsrPipeline).toHaveBeenCalledTimes(1);
    expect(state.clip.subtitleBody).toEqual([]);
    expect(state.clip.subtitleFetchState).toBe("loading");
    expect(metaNode().textContent).toBe(`UP主：${AUTHOR}`);
    expect(metaNode().hidden).toBe(false);
  });

  it("阅读视图未开：整轮抓取不发渲染通知（没有 DOM 宿主可投影）", async () => {
    await setupEpoch({ openReader: false });

    void fetcher.refreshClip();
    await vi.waitFor(() => expect(pipeline.runAsrPipeline).toHaveBeenCalled());

    const kinds = notifyReaderPresenter.mock.calls.map((call) => call[0].kind);
    expect(kinds).not.toContain("rerender");
    expect(kinds).not.toContain("subtitle-ready");
  });
});
