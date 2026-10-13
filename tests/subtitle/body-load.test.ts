// 「取体」深 module（subtitle/body.js）的直驱测试。
//
// 本文件取代的旧路径：取体流程原先只能在 fetcher.loadSubtitle /
// fetcher.loadSecondarySubtitle 里逐行核对，且必须整体替换 subtitle/cache.js
// 才能造出「缓存命中体」「写失败」这类分支。收口后取体链有了自己的 interface——
// **注入 fake 出口 + fake 缓存口**即可驱动全部分支，不需要经 refreshClip 编排，
// 也不需要 mock 任何接受事务（事务本体不在本 module 的被测面内）。
//
// 系统可能怎么坏（先列失败方式，再据此写用例）：
//   a. 缓存命中体与网络体的时长校验口径漂移 ⇒ 坏轨进 state / 好轨被拒；
//   b. 坏缓存（时长不匹配）没有清键 ⇒ 每次切轨都命中同一个坏体；
//   c. 空体 / 时长不匹配体落到出口 ⇒ 空字幕覆盖已就绪的字幕面；
//   d. 落缓存失败没有上浮 ⇒ 用户不知道「重启浏览器后需重新抓取」；
//   e. 写失败阻断了出口 ⇒ 网络已到站的字幕因为缓存盘的问题显示不出来；
//   f. 取体链自己写 state（selected 三项 / subtitleFetchState / 副轨槽）⇒ 出口
//      注入就白注入了，主副轨的落点差异重新泄漏回取体链；
//   g. runId 代次自检在出口之前丢失 ⇒ 旧 run 的正文写进新视频。
//
// 依赖处理：cache.js 部分 mock（保留真实键装配；只换读/写/清三个落盘口），
// gateway.fetchSubtitleBody（网络边界）与 core/ui-status（消息栏）mock，
// core/state 与 selection（时长校验策略）保持真实——被测的是取体链自己的口径。

import { beforeEach, describe, expect, it, vi, type MockedObject } from "vitest";
import { resetModuleState } from "../setup.js";
// 落缓存失败的真实错误类型（LRU 淘汰后重试仍失败的 distinct 错误）
import { CacheWriteError } from "../../extension/core/cache-lru.js";
// 期望键的身份构造口（与生产 body.js 同一份：三字段 → 身份）
import { trackIdentity } from "../../extension/subtitle/source-key.js";

vi.mock("../../extension/core/ui-status.js", () => ({
  setStatus: vi.fn(),
  setMessage: vi.fn()
}));
vi.mock("../../extension/bilibili/gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/gateway.js")>();
  return { ...actual, fetchSubtitleBody: vi.fn() };
});
vi.mock("../../extension/subtitle/cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/subtitle/cache.js")>();
  return {
    ...actual,
    loadSubtitleFromCache: vi.fn(async () => null),
    saveSubtitleToCache: vi.fn(async () => ({ ok: true })),
    clearSubtitleCacheByKey: vi.fn(async () => {})
  };
});

// videoDuration=300 的合规体（覆盖率门槛 0.22 ⇒ maxTo ≥ 66）
const GOOD_BODY = [
  { from: 0, to: 1.2, content: "First" },
  { from: 1.5, to: 290, content: "Second" }
];
// 过短体：maxTo=10 < 66 ⇒ too-short（坏缓存 / 坏网络体共用）
const TOO_SHORT_BODY = [{ from: 0, to: 10, content: "过短" }];
const TRACK = {
  id: "sub-en",
  lan: "ai-en",
  lanDoc: "English",
  subtitleUrl: "https://i0.hdslb.com/en.json"
};

let body: typeof import("../../extension/subtitle/body.js");
let cache: MockedObject<typeof import("../../extension/subtitle/cache.js")>;
let gateway: MockedObject<typeof import("../../extension/bilibili/gateway.js")>;
let uiStatus: MockedObject<typeof import("../../extension/core/ui-status.js")>;
let clipState: (typeof import("../../extension/core/state.js"))["clipState"];
let state: (typeof import("../../extension/core/state.js"))["state"];

// fake 出口：记录落点收到的正文（主轨事务 / 副轨事务的真实落点不在此测）
function makeExit() {
  const calls: unknown[][] = [];
  return {
    calls,
    onBody: vi.fn((received: unknown[]) => {
      calls.push(received);
    })
  };
}

const LOG = {
  cacheHit: "[BILISCRIPT] using cached subtitle",
  cacheMismatch: "[BILISCRIPT] cached subtitle duration mismatch, clearing cache"
};

function request(overrides: Partial<import("../../extension/subtitle/body.js").SubtitleBodyRequest> = {}) {
  return {
    url: TRACK.subtitleUrl,
    lang: TRACK.lanDoc,
    subtitleId: TRACK.id,
    runId: 0,
    forceRefresh: false,
    ...overrides
  };
}

beforeEach(async () => {
  resetModuleState();
  body = await import("../../extension/subtitle/body.js");
  cache = vi.mocked(await import("../../extension/subtitle/cache.js"));
  gateway = vi.mocked(await import("../../extension/bilibili/gateway.js"));
  uiStatus = vi.mocked(await import("../../extension/core/ui-status.js"));
  const stateModule = await import("../../extension/core/state.js");
  clipState = stateModule.clipState;
  state = stateModule.state;

  clipState.setBvid("BV1test000000");
  clipState.setCid("101");
  clipState.setVideoDuration(300);
  clipState.setFetchRunId(7);
  cache.loadSubtitleFromCache.mockReset().mockResolvedValue(null);
  cache.saveSubtitleToCache.mockReset().mockResolvedValue({ ok: true });
  cache.clearSubtitleCacheByKey.mockReset().mockResolvedValue(undefined);
  gateway.fetchSubtitleBody.mockReset();
  uiStatus.setMessage.mockReset();
});

// 与生产一致的键（保留真实键装配：三字段经键位叶构造身份，断言落盘口拿到的是这个键）
function expectedCacheKey() {
  return cache.getSubtitleCacheKey({
    bvid: "BV1test000000",
    cid: "101",
    identity: trackIdentity(TRACK.id, TRACK.subtitleUrl, TRACK.lanDoc)
  });
}

describe("缓存优先与交付", () => {
  it("缓存命中且时长合规 ⇒ 交付缓存体、不打网络、不经落盘", async () => {
    cache.loadSubtitleFromCache.mockResolvedValue(GOOD_BODY);
    const exit = makeExit();

    await body.loadTrackBody(request({ runId: 7 }), { onBody: exit.onBody, log: LOG });

    expect(exit.calls).toEqual([GOOD_BODY]);
    expect(cache.loadSubtitleFromCache).toHaveBeenCalledWith(expectedCacheKey());
    expect(gateway.fetchSubtitleBody).not.toHaveBeenCalled();
    expect(cache.saveSubtitleToCache).not.toHaveBeenCalled();
  });

  it("forceRefresh=true ⇒ 跳过缓存读、走网络并落缓存", async () => {
    cache.loadSubtitleFromCache.mockResolvedValue(GOOD_BODY);
    gateway.fetchSubtitleBody.mockResolvedValue({ body: GOOD_BODY });
    const exit = makeExit();

    await body.loadTrackBody(request({ runId: 7, forceRefresh: true }), { onBody: exit.onBody, log: LOG });

    expect(cache.loadSubtitleFromCache).not.toHaveBeenCalled();
    expect(gateway.fetchSubtitleBody).toHaveBeenCalledWith(TRACK.subtitleUrl);
    expect(cache.saveSubtitleToCache).toHaveBeenCalledWith(expectedCacheKey(), GOOD_BODY);
    expect(exit.calls).toEqual([GOOD_BODY]);
  });

  it("缓存命中但时长不匹配 ⇒ 清键后走网络重抓（坏体不进出口）", async () => {
    cache.loadSubtitleFromCache.mockResolvedValue(TOO_SHORT_BODY);
    gateway.fetchSubtitleBody.mockResolvedValue({ body: GOOD_BODY });
    const exit = makeExit();

    await body.loadTrackBody(request({ runId: 7 }), { onBody: exit.onBody, log: LOG });

    expect(cache.clearSubtitleCacheByKey).toHaveBeenCalledWith(expectedCacheKey());
    expect(exit.calls).toEqual([GOOD_BODY]);
  });

  it("缓存体为空数组 / null ⇒ 视为未命中，直走网络", async () => {
    cache.loadSubtitleFromCache.mockResolvedValue([]);
    gateway.fetchSubtitleBody.mockResolvedValue({ body: GOOD_BODY });
    const exit = makeExit();

    await body.loadTrackBody(request({ runId: 7 }), { onBody: exit.onBody, log: LOG });

    expect(cache.clearSubtitleCacheByKey).not.toHaveBeenCalled();
    expect(gateway.fetchSubtitleBody).toHaveBeenCalledTimes(1);
    expect(exit.calls).toEqual([GOOD_BODY]);
  });
});

describe("网络体的拒绝口径（零出口调用）", () => {
  it("空体 ⇒ 抛「字幕文件为空。」，出口零调用、不落缓存", async () => {
    gateway.fetchSubtitleBody.mockResolvedValue({ body: [] });
    const exit = makeExit();

    await expect(body.loadTrackBody(request({ runId: 7 }), { onBody: exit.onBody, log: LOG })).rejects.toThrow(
      "字幕文件为空。"
    );

    expect(exit.calls).toEqual([]);
    expect(cache.saveSubtitleToCache).not.toHaveBeenCalled();
  });

  it("时长不匹配 ⇒ SUBTITLE_DURATION_MISMATCH（带 details），出口零调用、不落缓存", async () => {
    gateway.fetchSubtitleBody.mockResolvedValue({ body: TOO_SHORT_BODY });
    const exit = makeExit();

    await expect(body.loadTrackBody(request({ runId: 7 }), { onBody: exit.onBody, log: LOG })).rejects.toMatchObject({
      code: "SUBTITLE_DURATION_MISMATCH",
      details: { ok: false, reason: "too-short" }
    });

    expect(exit.calls).toEqual([]);
    expect(cache.saveSubtitleToCache).not.toHaveBeenCalled();
  });
});

describe("落缓存与写失败上浮", () => {
  it("落缓存成功 ⇒ 出口在落盘之后收到正文", async () => {
    const order: string[] = [];
    gateway.fetchSubtitleBody.mockResolvedValue({ body: GOOD_BODY });
    cache.saveSubtitleToCache.mockImplementation(async () => {
      order.push("save");
      return { ok: true };
    });
    const exit = makeExit();
    exit.onBody.mockImplementation((received: unknown[]) => {
      order.push("exit");
      exit.calls.push(received);
    });

    await body.loadTrackBody(request({ runId: 7, forceRefresh: true }), { onBody: exit.onBody, log: LOG });

    expect(order).toEqual(["save", "exit"]);
    expect(uiStatus.setMessage).not.toHaveBeenCalled();
  });

  it("写失败（淘汰后重试仍失败）⇒ 消息栏一次性上浮，且不阻断出口", async () => {
    gateway.fetchSubtitleBody.mockResolvedValue({ body: GOOD_BODY });
    cache.saveSubtitleToCache.mockResolvedValue({ ok: false, error: new CacheWriteError("quota") });
    const exit = makeExit();

    await body.loadTrackBody(request({ runId: 7, forceRefresh: true }), { onBody: exit.onBody, log: LOG });

    expect(uiStatus.setMessage).toHaveBeenCalledWith(
      "字幕已加载，但本地缓存写入失败（已自动清理旧缓存仍失败），重启浏览器后需重新抓取。"
    );
    expect(exit.calls).toEqual([GOOD_BODY]);
  });
});

describe("runId 代次自检（出口门）", () => {
  it("网络到站时代次已被推进 ⇒ STALE_RUN，出口零调用", async () => {
    gateway.fetchSubtitleBody.mockResolvedValue({ body: GOOD_BODY });
    const exit = makeExit();

    await expect(
      body.loadTrackBody(request({ runId: 6, forceRefresh: true }), { onBody: exit.onBody, log: LOG })
    ).rejects.toMatchObject({ code: "STALE_RUN" });

    expect(exit.calls).toEqual([]);
    // 网络体先被校验，但自检在落缓存与出口之前 ⇒ 旧 run 不污染盘也不落 state
    expect(cache.saveSubtitleToCache).not.toHaveBeenCalled();
  });

  it("缓存命中时代次已被推进 ⇒ STALE_RUN，出口零调用", async () => {
    cache.loadSubtitleFromCache.mockResolvedValue(GOOD_BODY);
    const exit = makeExit();

    await expect(body.loadTrackBody(request({ runId: 6 }), { onBody: exit.onBody, log: LOG })).rejects.toMatchObject({
      code: "STALE_RUN"
    });

    expect(exit.calls).toEqual([]);
  });

  it("未传 runId ⇒ 不做代次自检（出口照常收到正文）", async () => {
    gateway.fetchSubtitleBody.mockResolvedValue({ body: GOOD_BODY });
    const exit = makeExit();

    await body.loadTrackBody(request({ runId: undefined, forceRefresh: true }), { onBody: exit.onBody, log: LOG });

    expect(exit.calls).toEqual([GOOD_BODY]);
  });
});

describe("出口是参数（取体链不认识任何接受事务）", () => {
  it("同一份正文换出口即换落点，且取体链自己不写 state", async () => {
    gateway.fetchSubtitleBody.mockResolvedValue({ body: GOOD_BODY });
    const mainExit = makeExit();
    const secondaryExit = makeExit();

    await body.loadTrackBody(request({ runId: 7, forceRefresh: true }), { onBody: mainExit.onBody, log: LOG });
    await body.loadTrackBody(request({ runId: 7, forceRefresh: true }), {
      onBody: secondaryExit.onBody,
      log: { cacheHit: "[BILISCRIPT] using cached secondary subtitle", cacheMismatch: "[BILISCRIPT] cached secondary subtitle duration mismatch, clearing cache" }
    });

    expect(mainExit.calls).toEqual([GOOD_BODY]);
    expect(secondaryExit.calls).toEqual([GOOD_BODY]);
    // 取体链零 state 写入：主轨三项 / 整片相位 / 副轨槽全部停在原地
    expect(state.clip.selectedSubtitleId).toBe("");
    expect(state.clip.selectedSubtitleUrl).toBe("");
    expect(state.clip.selectedSubtitleLang).toBe("");
    expect(state.clip.subtitleBody).toEqual([]);
    expect(state.clip.subtitleFetchState).toBe("idle");
    expect(state.clip.secondarySubtitle).toMatchObject({ id: "", body: [], state: "idle" });
  });
});
