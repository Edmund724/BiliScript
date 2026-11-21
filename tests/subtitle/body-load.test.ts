import { beforeEach, describe, expect, it, vi, type MockedObject } from "vitest";
import { resetModuleState } from "../setup.js";
import { CacheWriteError } from "../../extension/core/cache-lru.js";
import { trackIdentity } from "../../extension/subtitle/source-key.js";
import type { JsonTransport } from "../../extension/bilibili/gateway-core.js";
import type { SubtitleTrack } from "../../extension/bilibili/video-api.js";

vi.mock("../../extension/subtitle/cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/subtitle/cache.js")>();
  return {
    ...actual,
    loadSubtitleFromCache: vi.fn(async () => null),
    saveSubtitleToCache: vi.fn(async () => ({ ok: true })),
    clearSubtitleCacheByKey: vi.fn(async () => {})
  };
});

const GOOD_BODY = [
  { from: 0, to: 1.2, content: "First" },
  { from: 1.5, to: 290, content: "Second" }
];
const TOO_SHORT_BODY = [{ from: 0, to: 10, content: "过短" }];
const TRACK: SubtitleTrack = {
  id: "sub-en",
  lan: "ai-en",
  lanDoc: "English",
  subtitleUrl: "https://i0.hdslb.com/en.json",
  source: "player-wbi-v2"
};

let body: typeof import("../../extension/subtitle/body.js");
let cache: MockedObject<typeof import("../../extension/subtitle/cache.js")>;
let state: (typeof import("../../extension/core/state.js"))["state"];
let transport: ReturnType<typeof vi.fn<JsonTransport>>;

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
    bvid: "BV1test000000",
    cid: "101",
    videoDuration: 300,
    url: TRACK.subtitleUrl,
    lang: TRACK.lanDoc,
    subtitleId: TRACK.id,
    forceRefresh: false,
    transport,
    ...overrides
  };
}

function expectedCacheKey() {
  return cache.getSubtitleCacheKey({
    bvid: "BV1test000000",
    cid: "101",
    identity: trackIdentity(TRACK.id, TRACK.subtitleUrl, TRACK.lanDoc)
  });
}

beforeEach(async () => {
  resetModuleState();
  body = await import("../../extension/subtitle/body.js");
  cache = vi.mocked(await import("../../extension/subtitle/cache.js"));
  state = (await import("../../extension/core/state.js")).state;
  transport = vi.fn<JsonTransport>();

  cache.loadSubtitleFromCache.mockReset().mockResolvedValue(null);
  cache.saveSubtitleToCache.mockReset().mockResolvedValue({ ok: true });
  cache.clearSubtitleCacheByKey.mockReset().mockResolvedValue(undefined);
});

describe("缓存优先与交付", () => {
  it("缓存命中且时长合规 ⇒ 交付缓存体、不打网络、不经落盘", async () => {
    cache.loadSubtitleFromCache.mockResolvedValue(GOOD_BODY);
    const exit = makeExit();

    const loaded = await body.loadTrackBody(request(), { onBody: exit.onBody, log: LOG });

    expect(loaded).toEqual(GOOD_BODY);
    expect(exit.calls).toEqual([GOOD_BODY]);
    expect(cache.loadSubtitleFromCache).toHaveBeenCalledWith(expectedCacheKey());
    expect(transport).not.toHaveBeenCalled();
    expect(cache.saveSubtitleToCache).not.toHaveBeenCalled();
  });

  it("forceRefresh=true ⇒ 跳过缓存读、走网络并落缓存", async () => {
    cache.loadSubtitleFromCache.mockResolvedValue(GOOD_BODY);
    transport.mockResolvedValue({ body: GOOD_BODY });
    const exit = makeExit();

    const loaded = await body.loadTrackBody(request({ forceRefresh: true }), { onBody: exit.onBody, log: LOG });

    expect(loaded).toEqual(GOOD_BODY);
    expect(cache.loadSubtitleFromCache).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledWith(TRACK.subtitleUrl);
    expect(cache.saveSubtitleToCache).toHaveBeenCalledWith(expectedCacheKey(), GOOD_BODY);
    expect(exit.calls).toEqual([GOOD_BODY]);
  });

  it("缓存命中但时长不匹配 ⇒ 清键后走网络重抓（坏体不进出口）", async () => {
    cache.loadSubtitleFromCache.mockResolvedValue(TOO_SHORT_BODY);
    transport.mockResolvedValue({ body: GOOD_BODY });
    const exit = makeExit();

    await body.loadTrackBody(request(), { onBody: exit.onBody, log: LOG });

    expect(cache.clearSubtitleCacheByKey).toHaveBeenCalledWith(expectedCacheKey());
    expect(exit.calls).toEqual([GOOD_BODY]);
  });

  it("缓存体为空数组 / null ⇒ 视为未命中，直走网络", async () => {
    cache.loadSubtitleFromCache.mockResolvedValue([]);
    transport.mockResolvedValue({ body: GOOD_BODY });
    const exit = makeExit();

    await body.loadTrackBody(request(), { onBody: exit.onBody, log: LOG });

    expect(cache.clearSubtitleCacheByKey).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(exit.calls).toEqual([GOOD_BODY]);
  });
});

describe("网络体的拒绝口径（零出口调用）", () => {
  it("空体 ⇒ 抛「字幕文件为空。」，出口零调用、不落缓存", async () => {
    transport.mockResolvedValue({ body: [] });
    const exit = makeExit();

    await expect(body.loadTrackBody(request(), { onBody: exit.onBody, log: LOG })).rejects.toThrow(
      "字幕文件为空。"
    );

    expect(exit.calls).toEqual([]);
    expect(cache.saveSubtitleToCache).not.toHaveBeenCalled();
  });

  it("时长不匹配 ⇒ SUBTITLE_DURATION_MISMATCH（带 details），出口零调用、不落缓存", async () => {
    transport.mockResolvedValue({ body: TOO_SHORT_BODY });
    const exit = makeExit();

    await expect(body.loadTrackBody(request(), { onBody: exit.onBody, log: LOG })).rejects.toMatchObject({
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
    transport.mockResolvedValue({ body: GOOD_BODY });
    cache.saveSubtitleToCache.mockImplementation(async () => {
      order.push("save");
      return { ok: true };
    });
    const exit = makeExit();
    exit.onBody.mockImplementation((received: unknown[]) => {
      order.push("exit");
      exit.calls.push(received);
    });
    const onCacheSaveFailed = vi.fn();

    await body.loadTrackBody(request({ forceRefresh: true, onCacheSaveFailed }), { onBody: exit.onBody, log: LOG });

    expect(order).toEqual(["save", "exit"]);
    expect(onCacheSaveFailed).not.toHaveBeenCalled();
  });

  it("写失败（淘汰后重试仍失败）⇒ 触发 onCacheSaveFailed，且不阻断出口", async () => {
    transport.mockResolvedValue({ body: GOOD_BODY });
    cache.saveSubtitleToCache.mockResolvedValue({ ok: false, error: new CacheWriteError("quota") });
    const exit = makeExit();
    const onCacheSaveFailed = vi.fn();

    await body.loadTrackBody(request({ forceRefresh: true, onCacheSaveFailed }), { onBody: exit.onBody, log: LOG });

    expect(onCacheSaveFailed).toHaveBeenCalledTimes(1);
    expect(exit.calls).toEqual([GOOD_BODY]);
  });
});

describe("checkActive 活跃校验（出口门）", () => {
  it("网络到站后 checkActive 抛错 ⇒ 中止落缓存与出口", async () => {
    transport.mockResolvedValue({ body: GOOD_BODY });
    const exit = makeExit();
    const staleError = Object.assign(new Error("stale"), { code: "STALE_RUN" });

    await expect(
      body.loadTrackBody(
        request({
          forceRefresh: true,
          checkActive: () => {
            throw staleError;
          }
        }),
        { onBody: exit.onBody, log: LOG }
      )
    ).rejects.toMatchObject({ code: "STALE_RUN" });

    expect(exit.calls).toEqual([]);
    expect(cache.saveSubtitleToCache).not.toHaveBeenCalled();
  });

  it("缓存命中后 checkActive 抛错 ⇒ 出口零调用", async () => {
    cache.loadSubtitleFromCache.mockResolvedValue(GOOD_BODY);
    const exit = makeExit();
    const staleError = Object.assign(new Error("stale"), { code: "STALE_RUN" });

    await expect(
      body.loadTrackBody(
        request({
          checkActive: () => {
            throw staleError;
          }
        }),
        { onBody: exit.onBody, log: LOG }
      )
    ).rejects.toMatchObject({ code: "STALE_RUN" });

    expect(exit.calls).toEqual([]);
  });
});

describe("出口是参数（取体链不认识任何接受事务或 state）", () => {
  it("同一份正文换出口即换落点，且取体链自己不写 state", async () => {
    transport.mockResolvedValue({ body: GOOD_BODY });
    const mainExit = makeExit();
    const secondaryExit = makeExit();

    await body.loadTrackBody(request({ forceRefresh: true }), { onBody: mainExit.onBody, log: LOG });
    await body.loadTrackBody(request({ forceRefresh: true }), {
      onBody: secondaryExit.onBody,
      log: {
        cacheHit: "[BILISCRIPT] using cached secondary subtitle",
        cacheMismatch: "[BILISCRIPT] cached secondary subtitle duration mismatch, clearing cache"
      }
    });

    expect(mainExit.calls).toEqual([GOOD_BODY]);
    expect(secondaryExit.calls).toEqual([GOOD_BODY]);
    expect(state.clip.selectedSubtitleId).toBe("");
    expect(state.clip.selectedSubtitleUrl).toBe("");
    expect(state.clip.selectedSubtitleLang).toBe("");
    expect(state.clip.subtitleBody).toEqual([]);
    expect(state.clip.subtitleFetchState).toBe("idle");
    expect(state.clip.secondarySubtitle).toMatchObject({ id: "", body: [], state: "idle" });
  });
});

describe("loadPreferredNativeSubtitle（选轨与候选回退）", () => {
  const ZH_TRACK: SubtitleTrack = {
    id: "sub-zh",
    lan: "zh-CN",
    lanDoc: "中文",
    subtitleUrl: "https://i0.hdslb.com/zh.json",
    source: "player-wbi-v2"
  };

  it("首选轨时长不匹配时自动回退下一候选轨并落缓存", async () => {
    transport
      .mockResolvedValueOnce({ body: TOO_SHORT_BODY })
      .mockResolvedValueOnce({ body: GOOD_BODY });

    const loaded = await body.loadPreferredNativeSubtitle({
      tracks: [TRACK, ZH_TRACK],
      bvid: "BV1test000000",
      cid: "101",
      videoDuration: 300,
      transport
    });

    expect(loaded?.track.id).toBe("sub-en");
    expect(loaded?.body).toEqual(GOOD_BODY);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0][0]).toBe(ZH_TRACK.subtitleUrl);
    expect(transport.mock.calls[1][0]).toBe(TRACK.subtitleUrl);
  });

  it("无可用轨时返回 null", async () => {
    const loaded = await body.loadPreferredNativeSubtitle({
      tracks: [],
      bvid: "BV1test000000",
      cid: "101",
      videoDuration: 300,
      transport
    });
    expect(loaded).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });
});
