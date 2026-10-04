// 无字幕轨走 ASR 转写时，面板 header 的 meta 行（`UP主：…`）不得空着。
//
// 先列本链的失败面：
//   1. 转写要跑几分钟到几小时，整轮抓取期间没有任何渲染通知——`subtitle-ready`
//      只在转写收尾才发，reset 后的空 meta 会一直留在 header（用户报障原案：
//      「转写字幕的时候，up主的名字应该已经可以看到了」）。视频身份（作者/分P）
//      在 resolveClipMeta 就已落 state，此时就该按当前 state 重投影一次。
//   2. 反向：阅读视图未开时不得发通知——没有 DOM 宿主，重渲既无意义又会留下
//      「为旧视频投影」的口子。
//
// 链级测试（fetcher 真实 refreshClip → 无字幕出口 → 真实 asr/fallback → 管线
// 挂起）：reader 域与 reader-bus 保持真实（订阅与投影是真实闭环），只 mock 网络
// 边界（gateway / page-context）、字幕缓存落盘口与 ASR 管线本身。

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
vi.mock("../../extension/subtitle/cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/subtitle/cache.js")>();
  return {
    ...actual,
    getSubtitleCacheKey: vi.fn(() => "biliscript_subtitle_cache_asr_meta_test"),
    loadSubtitleFromCache: vi.fn(async () => null),
    saveSubtitleToCache: vi.fn(async () => ({ ok: true })),
    clearSubtitleCacheByKey: vi.fn(async () => {}),
    clearStaleAsrSubtitleCache: vi.fn(async () => {})
  };
});
// 通知口包一层计数（真实实现仍转发）：既让 reader 侧订阅照常收到，又可断言
// 通知序列。subscribeReaderPresenter 保持真实导出（订阅闭环不可 mock）。
vi.mock("../../extension/reader/reader-bus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/reader/reader-bus.js")>();
  return {
    ...actual,
    notifyReaderPresenter: vi.fn(actual.notifyReaderPresenter)
  };
});
// ASR 管线挂起 = 「转写进行中」；onProgress 先打一句与真机一致的状态文案。
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

  // 真实 sendRuntimeMessage → background 的应答桩：get-settings 给回退开关与
  // 激活平台，asr-providers-list 给 provider 元数据（页面侧无 Key）。
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
    // 无字幕轨 → 走 ASR 回退（转写挂起，整轮抓取不落定）
    vi.mocked(gateway.fetchSubtitleBundle).mockResolvedValue({ tracks: [], chapters: [] });

    ids = (await import("../../extension/reader/state.js")).ids;
    if (openReader) {
      mountReaderSkeleton(ids);
      mountPlayerChain();
    }
    state = (await import("../../extension/core/state.js")).state;
    state.reader.setViewOpen(openReader);
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

    // 断言点即用户报障时的画面：转写还在跑、字幕一条没出，meta 行却已有名字
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

    const kinds = notifyReaderPresenter.mock.calls.map((call) => call[0]);
    expect(kinds).not.toContain("rerender");
    expect(kinds).not.toContain("subtitle-ready");
  });
});
