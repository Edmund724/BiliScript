// 两路径装配对拍：网络路径（ai/context-resolver 的取数 + core/context-payload
// 的 createFetchedContextPayload）与进程内路径（clip 直喂同一工厂的
// createReaderContextPayload）在同一份视频事实下必须产出同一份 payload。
//
// 这一对拍就是「装配链单源」的验收接缝：字段清单/key 序/逐字段缺省/三个数组
// 字段的守卫（subtitleBody / subtitleOptions / chapters）只存在于工厂一处，
// 取数路径不再自带一套缺省；两条路径的签名因此必然相等。
//
// 单纪元：不使用 vi.resetModules，vi.mock 工厂闭包全程有效（同
// tests/ai/context-resolver-chapters.test.ts 的手法）。

import { describe, expect, it, vi } from "vitest";

const { VIDEO_FACTS } = vi.hoisted(() => ({
  VIDEO_FACTS: {
    meta: {
      title: "对拍视频",
      author: "UP主甲",
      uploadDate: "2026-02-03",
      aid: "42",
      defaultCid: "101",
      defaultDuration: 600,
      pages: [{ cid: "101", page: 1, part: "第一话", duration: 600 }]
    },
    tracks: [
      { id: "sub-1", subtitleUrl: "https://s.example.com/1.json", lan: "zh-CN", lanDoc: "中文" },
      { id: "sub-2", subtitleUrl: "https://s.example.com/2.json", lan: "en-US", lanDoc: "英文" }
    ],
    chapters: [
      { title: "开场", from: 0, to: 60, source: "player-view-points" },
      { title: "正文", from: 60, to: 600, source: "player-view-points" }
    ],
    body: [
      { from: 0, to: 5, content: "第一句" },
      { from: 5, to: 10, content: "第二句" }
    ]
  }
}));

vi.mock("../../extension/bilibili/gateway.js", () => ({
  fetchVideoMeta: vi.fn(async () => VIDEO_FACTS.meta),
  fetchSubtitleBundle: vi.fn(async () => ({
    tracks: VIDEO_FACTS.tracks,
    chapters: VIDEO_FACTS.chapters
  })),
  fetchSubtitleBody: vi.fn(async () => ({ body: VIDEO_FACTS.body }))
}));

// gateway 拆叶（arch-slim-2/04）：context-resolver 经 gateway-core 消费传输叶。
vi.mock("../../extension/bilibili/gateway-core.js", () => ({
  bgFetchJson: vi.fn()
}));

vi.mock("../../extension/core/settings-store.js", () => ({
  getMergedSettings: vi.fn(async () => ({ includeTimestampInBody: true }))
}));

vi.mock("../../extension/subtitle/cache.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getSubtitleCacheKey: vi.fn(() => "subtitle-cache-key"),
  loadSubtitleFromCache: vi.fn(async () => null)
}));

import { resolveAiConversationContext } from "../../extension/ai/context-resolver.js";
import {
  createReaderContextPayload,
  createFetchedContextPayload,
  computeContextStateSignature,
  type ReaderContextPayload
} from "../../extension/core/context-payload.js";
import { createInProcessContextFetch } from "../../extension/core/context-assembly.js";
import type { ChatSessionContextSnapshot } from "../../extension/chat/chat-state.js";
import type { ClipState } from "../../extension/core/state.js";

// 同一份视频事实的两种形状：网络路径吃取数事实，进程内路径吃 clip 快照。
// 两者的字段名映射（payload.subtitleLang ← clip.selectedSubtitleLang、
// payload.subtitleOptions ← clip.subtitles）由工厂的同一投影承担。
// clip.subtitles 与网络路径的轨清单同源同形（生产写入点
// subtitle/fetcher.setSubtitles(normalizeSubtitleTracks(...))），故两条路径
// 引用同一份轨条目。
const TRACK_OPTIONS = VIDEO_FACTS.tracks;

const CLIP_FACTS: Partial<ClipState> = {
  title: VIDEO_FACTS.meta.title,
  author: VIDEO_FACTS.meta.author,
  uploadDate: VIDEO_FACTS.meta.uploadDate,
  bvid: "BV1parity0000",
  cid: "101",
  aid: "42",
  pageIndex: 1,
  pageCount: 1,
  pageTitle: "第一话",
  videoDuration: 600,
  subtitleBody: VIDEO_FACTS.body,
  subtitleFetchState: "ready",
  noSubtitleReason: null,
  selectedSubtitleLang: "中文",
  selectedSubtitleId: "sub-1",
  selectedSubtitleUrl: "https://s.example.com/1.json",
  subtitles: TRACK_OPTIONS,
  chapters: VIDEO_FACTS.chapters
};

const VIDEO_URL = "https://www.bilibili.com/video/BV1parity0000/";
// 入口 ref 的元信息与真实元信息不同：两路径都必须以取数/快照事实为准，
// 不被 ref 的陈旧值带偏（ref 只作取不到事实时的回落）。
const CONTEXT_REF = {
  title: "入口标题",
  url: VIDEO_URL,
  bvid: "BV1parity0000",
  cid: "101",
  uploadDate: "2000-01-01",
  author: "入口作者",
  pageTitle: "入口分P"
};

// 进程内路径的入口：state.clip 直喂 createReaderContextPayload。
function readerPayload(clip: Partial<ClipState> = CLIP_FACTS): ReaderContextPayload {
  return createReaderContextPayload({
    clip,
    settings: { includeTimestampInBody: true },
    url: VIDEO_URL
  });
}

describe("AiContext 装配链单源：两路径对拍", () => {
  it("同一份视频事实喂网络路径与进程内路径：payload 逐字段相等", async () => {
    const network = await resolveAiConversationContext(CONTEXT_REF);

    expect(network).toEqual({ ...readerPayload(), isVideoContext: true });
  });

  it("签名相等：同一事实下 computeContextStateSignature 两条路径同值", async () => {
    const network = await resolveAiConversationContext(CONTEXT_REF);
    const inProcess = readerPayload();

    expect(computeContextStateSignature(network as ChatSessionContextSnapshot)).toBe(
      computeContextStateSignature(inProcess)
    );
  });

  it("网络路径快照订正分 P 事实并落定字幕状态：pageCount / pageIndex / ready / noSubtitleReason=null", async () => {
    const network = await resolveAiConversationContext(CONTEXT_REF);

    expect(network.pageCount).toBe(VIDEO_FACTS.meta.pages.length);
    expect(network.pageIndex).toBe(1);
    // 取数路径只在正文非空时交付（空正文在取数侧失败抛出），快照因此恒 ready
    expect(network.subtitleFetchState).toBe("ready");
    expect(network.noSubtitleReason).toBe(null);
    // 轨身份三元组来自选中的轨（ref 偏好 id 命中），与进程内路径同源同形
    expect(network.subtitleLang).toBe("中文");
    expect(network.selectedSubtitleId).toBe("sub-1");
    expect(network.subtitleOptions).toEqual(TRACK_OPTIONS);
  });

  it("装配链照旧补 hotComments / isVideoContext / signature（取数构造器只给热评空占位）", async () => {
    const network = await resolveAiConversationContext(CONTEXT_REF);
    // 取数构造器不拉热评（字段齐全的空占位；网络热评另票接通）
    expect(network.hotComments).toEqual([]);
    // isVideoContext 不在 payload 单源内，由装配链补写
    expect(Object.keys(readerPayload())).not.toContain("isVideoContext");

    const HOT_COMMENTS = [{ uname: "热评君", message: "前方高能" }];
    const fetchContext = createInProcessContextFetch({
      clip: () => CLIP_FACTS,
      settings: () => ({ includeTimestampInBody: true }),
      url: () => VIDEO_URL,
      fetchHotComments: async () => HOT_COMMENTS
    });
    const outcome = await fetchContext({ forceRefresh: true, ifSignature: "" });
    expect(outcome.kind).toBe("payload");

    const snapshot = (outcome as { payload: ChatSessionContextSnapshot }).payload;
    expect(snapshot.hotComments).toEqual(HOT_COMMENTS);
    expect(snapshot.isVideoContext).toBe(true);
    // 签名由装配链从同一工厂产物算出（与把同事实交给纯签名单函数同值）
    expect(snapshot.signature).toBe(computeContextStateSignature(readerPayload()));
    // 装配链补写之后，除热评（网络路径恒空）与签名（现算）外与网络路径逐字段相等
    const { hotComments: _hot, signature: _signature, ...snapshotRest } = snapshot;
    const { hotComments: _networkHot, ...networkRest } = network;
    expect(snapshotRest).toEqual(networkRest);
  });

  it("数组守卫与缺省只保留一份：脏值输入在两条入口按同一口径收口", () => {
    // 进程内入口（clip 形状）：非数组的数组型字段一律折算为空数组
    const dirtyClip = readerPayload({
      ...CLIP_FACTS,
      subtitles: undefined,
      chapters: "脏值"
    } as unknown as Partial<ClipState>);
    expect(dirtyClip.subtitleOptions).toEqual([]);
    expect(dirtyClip.chapters).toEqual([]);

    // 取数入口（事实形状）：同一份工厂投影，同一套守卫
    const dirtyFetched = createFetchedContextPayload({
      bvid: "BV1parity0000",
      cid: "101",
      aid: "42",
      title: "对拍视频",
      author: "UP主甲",
      uploadDate: "2026-02-03",
      url: VIDEO_URL,
      pageIndex: 1,
      pageCount: 0,
      pageTitle: "",
      duration: 0,
      subtitleBody: undefined as unknown as ReaderContextPayload["subtitleBody"],
      selectedSubtitleId: "",
      selectedSubtitleUrl: "",
      subtitleLang: "",
      subtitleOptions: undefined as unknown as ReaderContextPayload["subtitleOptions"],      chapters: undefined as unknown as ReaderContextPayload["chapters"],
      settings: { includeTimestampInBody: true }
    });
    expect(dirtyFetched.subtitleBody).toEqual([]);
    expect(dirtyFetched.subtitleOptions).toEqual([]);
    expect(dirtyFetched.chapters).toEqual([]);
    // 同一取数口径：无正文 ⇒ idle（正文非空才是 ready）
    expect(dirtyFetched.subtitleFetchState).toBe("idle");
  });
});
