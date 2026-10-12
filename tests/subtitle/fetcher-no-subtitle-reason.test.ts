// fetcher.js 无字幕原因（noSubtitleReason）与状态栏文案测试。
//
// 覆盖三块契约：
//   - resetClipState：无字幕原因与详情清空（切视频/失败清上下文不留陈旧原因）；
//     keepFetchState 参数保留当前 fetchState（586c61b 纪律：错误路径不得把
//     状态洗回 idle，见 refreshClip catch 与 sidepanel-subtitle-wait.js）。
//   - loadSubtitle 两条 ready 路径（缓存命中 / 网络成功）：ready 收尾清空原因与
//     详情，且两条路径都经字幕接受事务（commit.acceptSubtitle，vi.fn 包装真实
//     实现可观察调用）；缓存命中喂乱序 body，锁「接受事务单点稳定排序」。
//   - buildNoSubtitleStatusMessage 的文案契约已随事务迁入
//     tests/subtitle/commit.test.ts（文案属无字幕出口事务的一部分）。
// mock 结构与 fetcher-logging.test.js 相同：重依赖 mock，state/selection/
// 时长校验等轻量模块真实加载；**subtitle/cache.js 不再整体替换**——取体链已收口
// subtitle/body.js，缓存口改由内存版 chrome.storage.local 承载，于是「缓存命中」
// 「落盘内容」「坏缓存被清」都按真实键与真实落盘形状断言（原先钉死的
// "biliscript_subtitle_cache_test" 假键会掩盖键装配的回归）。
// 注意：本文件全程单一模块纪元（beforeEach 不做 vi.resetModules，只清环境），
// 保证测试断言的 clipState 与 fetcher.js（vi.mock 的 importOriginal 副本）
// 闭包内的是同一实例——resetModules 会让两者分属不同纪元、状态断言全部落空。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, setupEnvironment } from "../setup.js";
import { installChromeHost, type CacheEntry, type ChromeHost } from "../helpers/chrome-host.js";
import { clipState } from "../../extension/core/state.js";

// 顶层副作用 subscribeSubtitleRefresh(refreshClip) 需要 reader-bus 提供该函数。
vi.mock("../../extension/reader/reader-bus.js", () => ({
  subscribeSubtitleRefresh: vi.fn(),
  notifyReaderPresenter: vi.fn()
}));
// 候选03 常驻瘦身：setMessage / setStatus 已迁入 core/ui-status.js。
vi.mock("../../extension/core/ui-status.js", () => ({
  setStatus: vi.fn(),
  setMessage: vi.fn()
}));
// arch-slim-2/03：fetcher 的 fetchVideoMeta/fetchSubtitleBundle 纯直通包装已删
// （日志下沉 gateway），refreshClip 的抓取打桩改挂 gateway 的同名函数。
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
// 字幕接受事务：fetcher 静态引用的真实实现用 vi.fn 包一层（真实落 state +
// 可观察调用），保持「调用了 commit」可断言。configureCommitUi 保持真实导出
//（fetcher 模块求值期接线用）。
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
  // arch-slim-2/03：readVideoDescription 自 subtitle/ui.js 归位 core.js
  readVideoDescription: vi.fn(() => ""),
  refreshHotComments: vi.fn(async () => {}),
  refreshDerivedContent: vi.fn(async () => {})
}));

// 被测对象（真实 fetcher 模块；原部分 mock 的 fetchVideoMeta/fetchSubtitleBundle
// 直通包装已随 arch-slim-2/03 删除，打桩改挂 gateway）与被 mock 的
// gateway.fetchSubtitleBody、commit.acceptSubtitle
import * as fetcher from "../../extension/subtitle/fetcher.js";
import {
  fetchSubtitleBody as fetchBodyMock,
  fetchVideoMeta as fetchMetaMock
} from "../../extension/bilibili/gateway.js";
import { getSubtitleCacheKey } from "../../extension/subtitle/cache.js";
import { setMessage } from "../../extension/core/ui-status.js";
import { acceptSubtitle } from "../../extension/subtitle/commit.js";

// 时长合规字幕体：videoDuration=300 时 minCoverageRatio=0.22，maxTo=290 ≥ 66
const SUBTITLE_BODY = [
  { from: 0, to: 1.2, content: "你好" },
  { from: 1.5, to: 2.4, content: "世界" },
  { from: 3, to: 290, content: "收尾长句" }
];

// 内存版 chrome.storage.local（共享宿主，见 tests/helpers/chrome-host.ts；
// 形状见 subtitle/cache.js 的 { body, timestamp }）

let storageHost: ChromeHost;
let store: Map<string, CacheEntry>;

// 本文件固定用的那条轨的真实 per-track 缓存键（键装配走真实实现）
function subtitleCacheKey() {
  return getSubtitleCacheKey({
    bvid: clipState.bvid,
    cid: clipState.cid,
    subtitleId: "track-1",
    subtitleUrl: "https://example.com/sub.json",
    lang: "中文"
  });
}


beforeEach(() => {
  // 单一模块纪元：只重置环境与 DOM，不 resetModules（理由见文件头注释）
  setupEnvironment();
  history.replaceState({}, "", NORMAL_PAGE_URL);
  document.body.innerHTML = "";
  // resetClipState（真实代码）通过 byId("biliscript-preview") 写空值，需该 DOM 节点
  const preview = document.createElement("textarea");
  preview.id = "biliscript-preview";
  document.body.appendChild(preview);

  clipState.setBvid("BV1test000000");
  clipState.setCid("101");
  clipState.setVideoDuration(300);
  clipState.setFetchRunId(0);

  // 单一纪元下 mock 实现会跨用例保留：显式归位，避免用例间相互污染。
  // 缓存口每次装一台新的宿主（清掉上一条用例的键面）；既有用例按盘上内容直读（Map 语义）。
  storageHost = installChromeHost();
  store = storageHost.map as unknown as Map<string, CacheEntry>;
  vi.mocked(fetchBodyMock).mockReset();
  vi.mocked(setMessage).mockClear();
  vi.mocked(acceptSubtitle).mockClear();
});

// buildNoSubtitleStatusMessage 的文案契约已随无字幕出口事务迁至
// tests/subtitle/commit.test.ts（fetcher 不再导出该函数）。

describe("noSubtitleReason 清除点", () => {
  it("resetClipState：陈旧原因与详情清空", () => {
    clipState.setSubtitleFetchState("empty");
    clipState.setNoSubtitleReason("asr-empty");
    clipState.setNoSubtitleDetail("（错误详情：HTTP 402）");
    expect(clipState.noSubtitleReason).toBe("asr-empty");

    fetcher.resetClipState();

    expect(clipState.noSubtitleReason).toBe(null);
    // 切视频即清详情：下一个视频不得继承上一个视频的报文明细
    expect(clipState.noSubtitleDetail).toBe("");
    expect(clipState.subtitleFetchState).toBe("idle");
  });

  it("resetClipState({ keepFetchState: true })：保留当前 fetchState（586c61b：错误路径不得洗回 idle）", () => {
    clipState.setSubtitleFetchState("loading");

    fetcher.resetClipState({ keepFetchState: true });

    // 其余字段照常全清，仅 fetchState 保留给调用方覆写（refreshClip catch 写 error）
    expect(clipState.subtitleFetchState).toBe("loading");
    expect(clipState.subtitleBody).toEqual([]);
    expect(clipState.noSubtitleReason).toBe(null);
    expect(clipState.noSubtitleDetail).toBe("");
    expect(clipState.subtitles).toEqual([]);
  });

  it("loadSubtitle 缓存命中 ready：陈旧原因与详情清空，且经字幕接受事务（乱序缓存条目被稳定排序）", async () => {
    clipState.setNoSubtitleReason("no-asr-config");
    clipState.setNoSubtitleDetail("（错误详情：HTTP 404）");
    // 旧缓存条目可能无序：接受事务单点负责排序（findActiveSubtitleIndex 二分依赖）
    const unsortedBody = [SUBTITLE_BODY[2], SUBTITLE_BODY[0], SUBTITLE_BODY[1]];
    await storageHost.seedCacheEntry(subtitleCacheKey(), unsortedBody);

    await fetcher.loadSubtitle("https://example.com/sub.json", "中文", 0, "track-1", false);

    expect(clipState.subtitleFetchState).toBe("ready");
    expect(clipState.subtitleBody).toEqual(SUBTITLE_BODY);
    expect(clipState.noSubtitleReason).toBe(null);
    expect(clipState.noSubtitleDetail).toBe("");
    // 调用了 commit.acceptSubtitle（fetcher 不再手抄接受序列）；runId 随行
    // 供事务提交前自检代次（M23 runId 协调）
    expect(acceptSubtitle).toHaveBeenCalledTimes(1);
    expect(acceptSubtitle).toHaveBeenCalledWith({
      body: unsortedBody,
      selectedSubtitleId: "track-1",
      selectedSubtitleUrl: "https://example.com/sub.json",
      selectedSubtitleLang: "中文",
      runId: 0
    });
    // 缓存命中不发网络请求
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

// 缓存口是内存 storage，每条用例自己预置键面（beforeEach 已换新 storage）
describe("loadSubtitle 缓存边界行为（重构前后不变）", () => {
  it("网络成功但缓存写失败（LRU 淘汰后重试仍失败）：setMessage 一次性上浮，接受事务照常收尾", async () => {
    // 只有这条正文键的落盘失败（LRU 索引/清单照常写）：writeWithEviction 淘汰后
    // 重试仍失败 → { ok: false }。索引也一起失败的话根本走不到正文写入那一步。
    vi.mocked(globalThis.chrome.storage.local.set).mockImplementation(async (entries) => {
      const record = entries as Record<string, unknown>;
      if (subtitleCacheKey() in record) {
        throw new Error("quota exceeded");
      }
      for (const [key, value] of Object.entries(record)) {
        store.set(key, value as CacheEntry);
      }
    });
    vi.mocked(fetchBodyMock).mockResolvedValue({ body: SUBTITLE_BODY });

    await fetcher.loadSubtitle("https://example.com/sub.json", "中文", 0, "track-1", true);

    expect(setMessage).toHaveBeenCalledWith(
      "字幕已加载，但本地缓存写入失败（已自动清理旧缓存仍失败），重启浏览器后需重新抓取。"
    );
    // 缓存失败不阻断主流程：接受事务照常落位
    expect(acceptSubtitle).toHaveBeenCalledTimes(1);
    expect(clipState.subtitleFetchState).toBe("ready");
    // 写盘试图落的正是这条真实键与这次的网络体（键装配 + 写入载荷一起被钉住）
    const attemptedBody = vi
      .mocked(globalThis.chrome.storage.local.set)
      .mock.calls.map(([entries]) => (entries as Record<string, CacheEntry>)[subtitleCacheKey()])
      .find((entry) => entry && Array.isArray(entry.body))?.body;
    expect(attemptedBody).toEqual(SUBTITLE_BODY);
  });

  it("缓存命中但时长不匹配：清缓存后走网络重抓", async () => {
    // 过短字幕：videoDuration=300、maxTo=10 < 66 → too-short
    await storageHost.seedCacheEntry(subtitleCacheKey(), [{ from: 0, to: 10, content: "过短" }]);
    vi.mocked(fetchBodyMock).mockResolvedValue({ body: SUBTITLE_BODY });

    await fetcher.loadSubtitle("https://example.com/sub.json", "中文", 0, "track-1", false);

    // 时长不匹配的缓存条目不进 state；网络重抓经接受事务落位，盘上被换成好体
    expect(clipState.subtitleBody).toEqual(SUBTITLE_BODY);
    expect(clipState.subtitleFetchState).toBe("ready");
    expect(fetchBodyMock).toHaveBeenCalledWith("https://example.com/sub.json");
    expect(store.get(subtitleCacheKey())?.body).toEqual(SUBTITLE_BODY);
  });

  it("缓存命中但时长不匹配 + 网络也失败：坏缓存被清掉，盘上不留坏体", async () => {
    // 单一纪元：state 跨用例保留，先摆一个已知基线
    clipState.setSubtitleFetchState("loading");
    clipState.setSubtitleBody([]);
    await storageHost.seedCacheEntry(subtitleCacheKey(), [{ from: 0, to: 10, content: "过短" }]);
    vi.mocked(fetchBodyMock).mockRejectedValue(new Error("HTTP 500"));

    await expect(
      fetcher.loadSubtitle("https://example.com/sub.json", "中文", 0, "track-1", false)
    ).rejects.toThrow("HTTP 500");

    expect(store.has(subtitleCacheKey())).toBe(false);
    expect(clipState.subtitleBody).toEqual([]);
  });
});

describe("586c61b 回归：refreshClip 错误路径的 fetchState 保持 error", () => {
  it("抓取失败收尾 resetClipState({ keepFetchState: true }) 后 fetchState 为 error（不被洗回 idle）", async () => {
    // 单一模块纪元（见文件头注释）：断言的 clipState 与 fetcher 闭包内同一实例。
    // fetchVideoMeta 抛错 → refreshClip catch → 无活动转写 → keepFetchState
    // reset + 一次写 error。若 reset 把状态洗回 idle，等待转写的 sidepanel
    // 轮询会误判"非转写中"提前放行空字幕（586c61b 原始 bug）。
    clipState.setSubtitleFetchState("loading");
    // arch-slim-2/03：直通包装删除后，refreshClip 经 gateway.fetchVideoMeta 抓取。
    vi.mocked(fetchMetaMock).mockRejectedValue(new Error("meta down"));

    await expect(fetcher.refreshClip()).resolves.toBeUndefined();

    expect(clipState.subtitleFetchState).toBe("error");
    // 其余上下文照常清空（reset 的全清语义不变）
    expect(clipState.bvid).toBe("");
    expect(clipState.subtitleBody).toEqual([]);
    // ASR fallback 模块装载失败会被降级为「无活动转写」继续原错误处理；
    // 无论装载成败，最终文案都是抓取失败提示
    expect(clipState.noSubtitleReason).toBe(null);
  });
});
