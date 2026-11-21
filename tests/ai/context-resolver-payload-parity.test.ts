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
      { from: 5, to: 200, content: "第二句" }
    ]
  }
}));

vi.mock("../../extension/bilibili/video-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/video-api.js")>();
  return {
    ...actual,
    fetchVideoMeta: vi.fn(async () => VIDEO_FACTS.meta),
    fetchSubtitleBundle: vi.fn(async () => ({
      tracks: VIDEO_FACTS.tracks,
      chapters: VIDEO_FACTS.chapters
    }))
  };
});

vi.mock("../../extension/bilibili/gateway-core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/gateway-core.js")>();
  return {
    ...actual,
    bgFetchJson: vi.fn(async () => ({ body: VIDEO_FACTS.body }))
  };
});

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
const CONTEXT_REF = {
  title: "入口标题",
  url: VIDEO_URL,
  bvid: "BV1parity0000",
  cid: "101",
  uploadDate: "2000-01-01",
  author: "入口作者",
  pageTitle: "入口分P"
};

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
    expect(network.subtitleFetchState).toBe("ready");
    expect(network.noSubtitleReason).toBe(null);
    expect(network.subtitleLang).toBe("中文");
    expect(network.selectedSubtitleId).toBe("sub-1");
    expect(network.subtitleOptions).toEqual(TRACK_OPTIONS);
  });

  it("装配链照旧补 hotComments / isVideoContext / signature（取数构造器只给热评空占位）", async () => {
    const network = await resolveAiConversationContext(CONTEXT_REF);
    expect(network.hotComments).toEqual([]);
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
    expect(snapshot.signature).toBe(computeContextStateSignature(readerPayload()));
    const { hotComments: _hot, signature: _signature, ...snapshotRest } = snapshot;
    const { hotComments: _networkHot, ...networkRest } = network;
    expect(snapshotRest).toEqual(networkRest);
  });

  it("数组守卫与缺省只保留一份：脏值输入在两条入口按同一口径收口", () => {
    const dirtyClip = readerPayload({
      ...CLIP_FACTS,
      subtitles: undefined,
      chapters: "脏值"
    } as unknown as Partial<ClipState>);
    expect(dirtyClip.subtitleOptions).toEqual([]);
    expect(dirtyClip.chapters).toEqual([]);

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
    expect(dirtyFetched.subtitleFetchState).toBe("idle");
  });
});
