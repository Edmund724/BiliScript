// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

function setCrossOriginLocation(url: string): void {
  (globalThis as unknown as { jsdom: { reconfigure: (opts: { url: string }) => void } }).jsdom.reconfigure({
    url
  });
}

const {
  videoApiMock,
  gatewayCoreMock,
  frameCaptureMock,
  settingsStoreMock
} = vi.hoisted(() => ({
  videoApiMock: {
    fetchVideoMeta: vi.fn(async () => {
      throw new Error("unexpected fetchVideoMeta call");
    }),
    fetchSubtitleBundle: vi.fn(async () => {
      throw new Error("unexpected fetchSubtitleBundle call");
    }),
    resolveVideoPageFromMeta: vi.fn(() => {
      throw new Error("unexpected resolveVideoPageFromMeta call");
    })
  },
  gatewayCoreMock: {
    bgFetchJson: vi.fn(async () => {
      throw new Error("unexpected bgFetchJson call");
    })
  },
  frameCaptureMock: {
    capturePageVideoFrame: vi.fn(
      async (_options?: { getVideo?: () => HTMLVideoElement | null }) => ({
        jpegBytes: new Uint8Array([1, 2, 3]),
        currentTime: 42.5
      })
    ),
    captureHistoricalVideoFrame: vi.fn(async () => [
      { jpegBytes: new Uint8Array([4, 5, 6]), currentTime: 10 }
    ])
  },
  settingsStoreMock: {
    getMergedSettings: vi.fn(async () => ({
      includeTimestampInBody: true,
      subtitleSegmentationStrategy: "off"
    }))
  }
}));

vi.mock("../../extension/bilibili/video-api.js", () => videoApiMock);
vi.mock("../../extension/bilibili/gateway-core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/gateway-core.js")>();
  return {
    ...actual,
    bgFetchJson: gatewayCoreMock.bgFetchJson
  };
});
vi.mock("../../extension/core/settings-store.js", () => settingsStoreMock);
vi.mock("../../extension/live/page-video-frame-capture.js", () => ({
  capturePageVideoFrame: frameCaptureMock.capturePageVideoFrame
}));
vi.mock("../../extension/chat/historical-video-frame.js", () => ({
  captureHistoricalVideoFrame: frameCaptureMock.captureHistoricalVideoFrame
}));

import {
  buildAiContextRef,
  buildContextKey,
  doesTabMatchContextUrl
} from "../../extension/ai/conversation.js";
import {
  YOUTUBE_CACHE_EVICTED,
  YOUTUBE_CACHE_EVICTED_MESSAGE,
  isYoutubeCacheEvictedError,
  resolveAiConversationContext,
  resolveAiConversationPageRef
} from "../../extension/ai/context-resolver.js";
import {
  ANALYSIS_FINAL_PREFIX,
  L1_INDEX_CACHE_PREFIX
} from "../../extension/ai/l1-chapter-index.js";
import { L1_INDEX_SCHEMA_VERSION } from "../../extension/ai/l1-directory.js";
import {
  createFetchedContextPayload,
  createReaderContextPayload
} from "../../extension/core/context-payload.js";
import { createInProcessContextFetch } from "../../extension/core/context-assembly.js";
import { state } from "../../extension/core/state.js";
import {
  HISTORY_STORAGE_KEY,
  readConversationHistory,
  updateConversationHistory
} from "../../extension/chat/conversation-storage.js";
import {
  clearPinnedYoutubeCacheEvicted,
  createConversationStore,
  isPinnedYoutubeCacheEvicted,
  needsConversationPageHydration,
  type CreateConversationStoreDeps,
  type StorageArea
} from "../../extension/chat/conversation-store.js";
import {
  YOUTUBE_CACHE_EVICTED_SEND_NOTICE,
  createSendGate
} from "../../extension/chat/send-gate.js";
import {
  applyConversationIdentity,
  applyLiveContextSnapshot,
  chatSessionState,
  resetChatSessionStateForTests,
  setSavedConversations
} from "../../extension/chat/chat-state.js";
import type { OrdinaryConversation } from "../../extension/chat/conversation-types.js";
import type { CreateChatTabDomainDeps } from "../../extension/chat/tab-domain.js";
import { createReaderChatLists } from "../../extension/reader/chat-lists.js";
import { buildChatTabBodyHtml } from "../../extension/reader/chat-template.js";
import { ids } from "../../extension/reader/state.js";
import { createSubtitleIdbStore, type SubtitleIdbStore } from "../../extension/subtitle/idb-store.js";
import { configureSubtitleCacheStoreForTests } from "../../extension/subtitle/store-client.js";
import { buildSubtitleSourceKey } from "../../extension/subtitle/source-key.js";
import {
  YOUTUBE_UNIT_CID,
  encodeVideoStorageBvid,
  resolveVideoStorageKey
} from "../../extension/shared/site.js";
import { createMemoryStorageArea } from "../helpers/memory-storage-area.js";

function makeMemoryStorage(): StorageArea & {
  data: Map<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn(async (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)]))
    ),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) {
        data.set(k, structuredClone(v));
      }
    })
  };
}

function makeYoutubeConversation(
  id: string,
  videoId = "dQw4w_9Wg-Q",
  overrides: Partial<OrdinaryConversation> = {}
): OrdinaryConversation {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  return {
    id,
    title: `YT Video ${id}`,
    contextKey: `video:youtube:${videoId}`,
    contextTitle: `YT Video ${id}`,
    contextUrl: url,
    isVideoContext: true,
    createdAt: 1_000,
    updatedAt: 2_000,
    contextRef: {
      site: "youtube",
      title: `YT Video ${id}`,
      url,
      author: "Channel",
      uploadDate: "2026-03-01",
      bvid: videoId,
      cid: YOUTUBE_UNIT_CID,
      aid: "",
      pageIndex: 1,
      pageCount: 1,
      pageTitle: "",
      subtitleLang: "English",
      selectedSubtitleId: "yt-en",
      selectedSubtitleUrl: "",
      isVideoContext: true
    },
    messages: [
      { role: "user", content: "总结这个视频" },
      { role: "assistant", content: "这是只读历史回答" }
    ],
    ...overrides
  };
}

function makeBilibiliConversation(
  id: string,
  bvid = "BV1xx411c7mD",
  cid = "101",
  overrides: Partial<OrdinaryConversation> = {}
): OrdinaryConversation {
  const url = `https://www.bilibili.com/video/${bvid}/`;
  return {
    id,
    title: `Bili Video ${id}`,
    contextKey: `video:${bvid}|${cid}`,
    contextTitle: `Bili Video ${id}`,
    contextUrl: url,
    isVideoContext: true,
    createdAt: 1_000,
    updatedAt: 3_000,
    contextRef: {
      site: "bilibili",
      title: `Bili Video ${id}`,
      url,
      author: "UP",
      uploadDate: "2026-03-01",
      bvid,
      cid,
      aid: "42",
      pageIndex: 1,
      pageCount: 2,
      pageTitle: "P1",
      subtitleLang: "中文",
      selectedSubtitleId: "sub-1",
      selectedSubtitleUrl: "https://s.example.com/1.json",
      isVideoContext: true
    },
    messages: [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好！" }
    ],
    ...overrides
  };
}

async function seedYoutubeCacheInIdb(
  store: SubtitleIdbStore,
  videoId: string,
  options: { trackId?: string; lang?: string } = {}
): Promise<void> {
  const trackId = options.trackId ?? "yt-en";
  const lang = options.lang ?? "English";
  const storageKey = resolveVideoStorageKey("youtube", videoId, YOUTUBE_UNIT_CID);
  const trackKey = buildSubtitleSourceKey(trackId, "", lang);
  await store.putRawTrack({
    bvid: storageKey.bvid,
    cid: storageKey.cid,
    trackKey,
    lang,
    kind: "manual-cc",
    items: [
      { from: 0, to: 10, content: "YouTube cached line one" },
      { from: 10, to: 20, content: "YouTube cached line two" }
    ]
  });

  await store.putAiArtifact({
    key: `${L1_INDEX_CACHE_PREFIX}${storageKey.bvid}_${storageKey.cid}_${trackKey}_seg1`,
    family: L1_INDEX_CACHE_PREFIX,
    bvid: storageKey.bvid,
    cid: storageKey.cid,
    payload: {
      schemaVersion: L1_INDEX_SCHEMA_VERSION,
      bvid: storageKey.bvid,
      cid: storageKey.cid,
      sourceKey: trackKey,
      subtitleSignature: "sig-yt",
      globalSummary: "Cached YT L1 summary",
      chapters: [
        {
          id: "ch-1",
          title: "开篇介绍",
          from: 0,
          to: 20,
          summary: "概述"
        }
      ],
      quotes: []
    }
  });
  await store.putAiArtifact({
    key: `${ANALYSIS_FINAL_PREFIX}${storageKey.bvid}_${storageKey.cid}_${trackKey}_sig1`,
    family: ANALYSIS_FINAL_PREFIX,
    bvid: storageKey.bvid,
    cid: storageKey.cid,
    payload: {
      overview: "Cached YT overview",
      chapters: [{ title: "概览章节", from: 0, to: 20, summary: "摘要" }],
      quotes: []
    }
  });
}

async function captureChatTabDomainDepsOnYoutube(videoId: string) {
  vi.resetModules();
  setCrossOriginLocation(`https://www.youtube.com/watch?v=${videoId}&biliscript_reader=1`);
  const chromeStub = window.chrome as unknown as {
    storage: {
      local: ReturnType<typeof createMemoryStorageArea>;
      sync: { set: ReturnType<typeof vi.fn> };
    };
  };
  chromeStub.storage.local = createMemoryStorageArea();
  chromeStub.storage.sync.set = vi.fn(async () => {});

  let capturedDeps: CreateChatTabDomainDeps | null = null;
  vi.doMock("../../extension/chat/tab-domain.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../extension/chat/tab-domain.js")>();
    return {
      ...actual,
      createChatTabDomain: (deps: CreateChatTabDomainDeps) => {
        capturedDeps = deps;
        return actual.createChatTabDomain(deps);
      }
    };
  });

  const uiRenderer = await import("../../extension/ui/ui-renderer.js");
  uiRenderer.ensureUiReady({ forceRecreate: true });
  const freshState = (await import("../../extension/core/state.js")).state;
  freshState.clip.setSite("youtube");
  freshState.clip.setBvid(videoId);
  freshState.clip.setCid(YOUTUBE_UNIT_CID);

  await import("../../extension/reader/chat-tab.js");
  const { ids: freshIds } = await import("../../extension/reader/state.js");
  const sendBtn = document.getElementById(freshIds.readingChatSendBtn) as HTMLButtonElement | null;
  return { capturedDeps: capturedDeps as CreateChatTabDomainDeps | null, sendBtn };
}

beforeEach(() => {
  setCrossOriginLocation("https://www.bilibili.com/video/BV1test000000/");
  resetModuleState();
  resetChatSessionStateForTests();
  clearPinnedYoutubeCacheEvicted();
  configureSubtitleCacheStoreForTests(null);
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

afterEach(() => {
  configureSubtitleCacheStoreForTests(null);
  clearPinnedYoutubeCacheEvicted();
  vi.doUnmock("../../extension/chat/tab-domain.js");
  setCrossOriginLocation("https://www.bilibili.com/video/BV1test000000/");
});

describe("跨站会话身份、contextKey 与 URL 匹配", () => {
  it("buildContextKey 对 YouTube 按 rawVideoId 生成唯一键，不折叠 /watch 且 B 站不变", () => {
    const ytKeyA = buildContextKey({
      site: "youtube",
      bvid: "ab_cd-12_ef",
      cid: YOUTUBE_UNIT_CID,
      url: "https://www.youtube.com/watch?v=ab_cd-12_ef&t=12"
    });
    const ytKeyB = buildContextKey({
      site: "youtube",
      bvid: "xyz987_6543",
      cid: YOUTUBE_UNIT_CID,
      url: "https://www.youtube.com/watch?v=xyz987_6543"
    });
    const ytKeyFromUrlOnly = buildContextKey({
      url: "https://www.youtube.com/watch?v=ab_cd-12_ef&list=PL99&index=3"
    });
    const biliKey = buildContextKey({
      bvid: "BV1xx411c7mD",
      cid: "101",
      url: "https://www.bilibili.com/video/BV1xx411c7mD/"
    });

    expect(ytKeyA).toBe("video:youtube:ab_cd-12_ef");
    expect(ytKeyB).toBe("video:youtube:xyz987_6543");
    expect(ytKeyA).not.toBe(ytKeyB);
    expect(ytKeyA).not.toBe("url:https://www.youtube.com/watch");
    expect(ytKeyFromUrlOnly).toBe(ytKeyA);
    expect(biliKey).toBe("video:BV1xx411c7mD|101");
  });

  it("buildAiContextRef 保留 site（缺省兼容 bilibili）并对 YouTube 提取 rawId 与默认 cid=yt", () => {
    const legacyRef = buildAiContextRef({
      title: "旧记录",
      bvid: "BV1old112233",
      cid: "101"
    });
    const ytRef = buildAiContextRef({
      title: "YouTube 视频",
      url: "https://www.youtube.com/watch?v=ab_cd-12_ef&si=share123&t=45"
    });

    expect(legacyRef.site).toBe("bilibili");
    expect(ytRef.site).toBe("youtube");
    expect(ytRef.bvid).toBe("ab_cd-12_ef");
    expect(ytRef.cid).toBe(YOUTUBE_UNIT_CID);
  });

  it("doesTabMatchContextUrl 对 YouTube 按视频 ID 匹配并忽略播放参数与阅读参数", () => {
    const ytUrl = "https://www.youtube.com/watch?v=ab_cd-12_ef";
    expect(
      doesTabMatchContextUrl(
        "https://www.youtube.com/watch?v=ab_cd-12_ef&t=99&list=PL1&index=2&pp=qA&si=xyz&biliscript_reader=1",
        ytUrl
      )
    ).toBe(true);
    expect(
      doesTabMatchContextUrl(
        "https://www.youtube.com/watch?v=otherVideo1",
        ytUrl
      )
    ).toBe(false);
    expect(
      doesTabMatchContextUrl(
        "https://www.bilibili.com/video/BV1xx411c7mD/",
        ytUrl
      )
    ).toBe(false);
  });

  it("createFetchedContextPayload 与 createReaderContextPayload 透传 site", () => {
    const fetched = createFetchedContextPayload({
      site: "youtube",
      bvid: "ab_cd-12_ef",
      cid: YOUTUBE_UNIT_CID,
      aid: "",
      title: "YT",
      author: "Creator",
      uploadDate: "",
      url: "https://www.youtube.com/watch?v=ab_cd-12_ef",
      pageIndex: 1,
      pageCount: 1,
      pageTitle: "",
      duration: 120,
      subtitleBody: [{ from: 0, to: 4, content: "hi" }],
      selectedSubtitleId: "yt-1",
      selectedSubtitleUrl: "",
      subtitleLang: "en",
      subtitleOptions: [],
      chapters: []
    });
    const reader = createReaderContextPayload({
      clip: {
        site: "youtube",
        bvid: "ab_cd-12_ef",
        cid: YOUTUBE_UNIT_CID,
        title: "YT",
        subtitleBody: [{ from: 0, to: 4, content: "hi" }]
      },
      settings: {},
      url: "https://www.youtube.com/watch?v=ab_cd-12_ef"
    });

    expect(fetched.site).toBe("youtube");
    expect(reader.site).toBe("youtube");
  });
});

describe("chat_images 存储键编码隔离", () => {
  it("写入含 _ 的 YouTube chat_images 时使用 yt~ 编码 storage bvid，避免污染索引且可完整回读", async () => {
    const idb = createSubtitleIdbStore({ useSharedMemoryBacking: false });
    configureSubtitleCacheStoreForTests(idb);
    const storage = makeMemoryStorage();
    const rawVideoId = "ab_cd-12_ef";
    const imgData = { mime: "image/webp", data: "QUJDREVGRw==" };
    const conv = makeYoutubeConversation("yt-img-1", rawVideoId, {
      messages: [
        { role: "user", content: "看这张图", images: [imgData] },
        { role: "assistant", content: "收到" }
      ]
    });

    await updateConversationHistory(storage, () => [conv]);
    const records = await idb.listAllChatImages();
    const expectedEncodedBvid = encodeVideoStorageBvid("youtube", rawVideoId);

    expect(records).toHaveLength(1);
    expect(records[0].bvid).toBe(expectedEncodedBvid);
    expect(records[0].bvid.startsWith("yt~")).toBe(true);
    expect(records[0].bvid).not.toContain("_");
    expect(records[0].bvid).not.toContain(":");

    const loaded = await readConversationHistory(storage);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      messages: [
        expect.objectContaining({ images: [imgData] }),
        expect.objectContaining({ content: "收到" })
      ]
    });
  });
});

describe("历史列表站点徽标与阅读模式能力门控", () => {
  it("chat-lists 为不同站点条目渲染「B 站」/「YouTube」徽标并匹配当前 YouTube 页面", () => {
    setCrossOriginLocation("https://www.youtube.com/watch?v=ab_cd-12_ef&t=15");
    state.clip.setSite("youtube");
    state.clip.setBvid("ab_cd-12_ef");
    state.clip.setCid(YOUTUBE_UNIT_CID);
    state.clip.setSubtitleBody([{ from: 0, to: 5, content: "hello" }]);
    applyLiveContextSnapshot({
      site: "youtube",
      bvid: "ab_cd-12_ef",
      cid: YOUTUBE_UNIT_CID,
      title: "YT Video c-yt",
      url: "https://www.youtube.com/watch?v=ab_cd-12_ef&t=15",
      isVideoContext: true
    });
    applyConversationIdentity({
      id: "c-bili",
      meta: {
        id: "c-bili",
        title: "Bili Video c-bili",
        createdAt: 1_000,
        updatedAt: 3_000,
        contextKey: "video:BV1xx411c7mD|101",
        contextTitle: "Bili Video c-bili",
        contextUrl: "https://www.bilibili.com/video/BV1xx411c7mD/",
        isVideoContext: true,
        pinnedContext: true
      }
    });

    const historyList = document.createElement("div");
    const historyClearBtn = document.createElement("button");
    document.body.append(historyList, historyClearBtn);

    setSavedConversations([
      makeYoutubeConversation("c-yt", "ab_cd-12_ef"),
      makeBilibiliConversation("c-bili", "BV1xx411c7mD", "101")
    ]);

    const lists = createReaderChatLists({
      historyList,
      historyClearBtn,
      applyById: vi.fn(),
      deleteById: vi.fn(async () => null),
      isTurnActive: vi.fn(() => false),
      confirmDeleteCurrent: vi.fn(async () => true),
      startNewConversation: vi.fn(async () => true),
      suggestions: { render: vi.fn(), clear: vi.fn(), isPresent: vi.fn(() => false) } as never,
      hideHistoryPopover: vi.fn()
    });

    lists.renderHistoryList();

    const ytRow = historyList.querySelector('.chat-history-item[data-id="c-yt"]')!;
    const biliRow = historyList.querySelector('.chat-history-item[data-id="c-bili"]')!;
    expect(ytRow.querySelector(".chat-history-site")?.getAttribute("data-site")).toBe("youtube");
    expect(ytRow.querySelector(".chat-history-site")?.textContent).toBe("YouTube");
    expect(ytRow.classList.contains("is-live-match")).toBe(true);
    expect(biliRow.querySelector(".chat-history-site")?.getAttribute("data-site")).toBe("bilibili");
    expect(biliRow.querySelector(".chat-history-site")?.textContent).toBe("B 站");
  });

  it("buildChatTabBodyHtml 按站点能力门控实时伴看入口", () => {
    document.body.innerHTML = buildChatTabBodyHtml("youtube");
    const ytSendBtn = document.getElementById(ids.readingChatSendBtn) as HTMLButtonElement;
    expect(ytSendBtn.classList.contains("is-live")).toBe(false);
    expect(ytSendBtn.disabled).toBe(true);
    expect(ytSendBtn.getAttribute("aria-label")).toBe("发送");

    document.body.innerHTML = buildChatTabBodyHtml("bilibili");
    const biliSendBtn = document.getElementById(ids.readingChatSendBtn) as HTMLButtonElement;
    expect(biliSendBtn.classList.contains("is-live")).toBe(true);
    expect(biliSendBtn.getAttribute("aria-label")).toBe("开启实时伴看");
  });
});

describe("YouTube IDB 水合、分P守卫与缓存淘汰只读守卫", () => {
  it("needsConversationPageHydration、hydrateConversationPage 与 resolveAiConversationPageRef 不对 YouTube 触发 B 站分P水合", async () => {
    const ytConv = makeYoutubeConversation("c-yt", "ab_cd-12_ef");
    const biliConv = makeBilibiliConversation("c-bili", "BV1xx411c7mD", "101");

    expect(needsConversationPageHydration(ytConv)).toBe(false);
    expect(needsConversationPageHydration(biliConv)).toBe(true);

    const resolveRefSpy = vi.fn(async () => ({}));
    const storage = makeMemoryStorage();
    await storage.set({ [HISTORY_STORAGE_KEY]: [ytConv] });

    const store = createConversationStore({
      loadContextState: vi.fn(async () => false),
      resolveAiConversationRef: resolveRefSpy,
      onConversationChanged: vi.fn(),
      onStreamInterrupted: vi.fn(),
      onContextNotice: vi.fn(),
      storage
    });

    await store.loadAll();
    expect(resolveRefSpy).not.toHaveBeenCalled();

    const pageRef = await resolveAiConversationPageRef(ytConv.contextRef);
    expect(pageRef).toEqual({
      url: "https://www.youtube.com/watch?v=ab_cd-12_ef",
      bvid: "ab_cd-12_ef",
      cid: YOUTUBE_UNIT_CID,
      pageIndex: 1,
      pageTitle: ""
    });
    expect(videoApiMock.fetchVideoMeta).not.toHaveBeenCalled();
  });

  it("resolveAiConversationContext 命中扩展源 IDB 时直接恢复字幕与 L1/概览章节且不发网络请求", async () => {
    const idb = createSubtitleIdbStore({ useSharedMemoryBacking: false });
    configureSubtitleCacheStoreForTests(idb);
    const rawVideoId = "ab_cd-12_ef";
    await seedYoutubeCacheInIdb(idb, rawVideoId);

    const resolved = await resolveAiConversationContext(
      makeYoutubeConversation("c-yt", rawVideoId).contextRef
    );

    expect(resolved.site).toBe("youtube");
    expect(resolved.bvid).toBe(rawVideoId);
    expect(resolved.cid).toBe(YOUTUBE_UNIT_CID);
    expect(resolved.isVideoContext).toBe(true);
    expect(resolved.subtitleBody).toHaveLength(2);
    expect(resolved.l1Index?.globalSummary).toBe("Cached YT L1 summary");
    expect(resolved.chapters).toEqual([{ title: "概览章节", from: 0, to: 20, summary: "摘要" }]);
    expect(videoApiMock.fetchVideoMeta).not.toHaveBeenCalled();
    expect(videoApiMock.fetchSubtitleBundle).not.toHaveBeenCalled();
    expect(gatewayCoreMock.bgFetchJson).not.toHaveBeenCalled();
  });

  it("YouTube 本地缓存被淘汰时：历史浏览保持完整只读，仅在发起追问时由 send-gate 阻断并提示重开原页", async () => {
    const idb = createSubtitleIdbStore({ useSharedMemoryBacking: false });
    configureSubtitleCacheStoreForTests(idb);
    const rawVideoId = "ab_cd-12_ef";
    const ytConv = makeYoutubeConversation("c-yt-evicted", rawVideoId);
    const storageKey = resolveVideoStorageKey("youtube", rawVideoId, YOUTUBE_UNIT_CID);

    await seedYoutubeCacheInIdb(idb, rawVideoId);
    await idb.clearVideo(storageKey.bvid, storageKey.cid);

    const capturedError = await resolveAiConversationContext(ytConv.contextRef).catch((error) => error);
    expect(isYoutubeCacheEvictedError(capturedError)).toBe(true);
    expect((capturedError as { code?: string }).code).toBe(YOUTUBE_CACHE_EVICTED);
    expect((capturedError as Error).message).toBe(YOUTUBE_CACHE_EVICTED_MESSAGE);

    const storage = makeMemoryStorage();
    await storage.set({ [HISTORY_STORAGE_KEY]: [ytConv] });
    const notices: Array<{ kind: string; message?: string }> = [];

    let liveLoaded = false;
    const loadContextState = vi.fn(async (_opts?: unknown) => liveLoaded);
    const storeDeps: CreateConversationStoreDeps = {
      loadContextState,
      resolveAiConversationRef: async (ref) =>
        (await resolveAiConversationContext(ref)) as Record<string, unknown>,
      onConversationChanged: vi.fn(),
      onStreamInterrupted: vi.fn(),
      onContextNotice: (notice) => notices.push(notice),
      storage
    };
    const store = createConversationStore(storeDeps);

    await store.loadAll();
    store.applyById(ytConv.id);
    await store.hydratePinned({ silent: true });

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "总结这个视频" },
      { role: "assistant", content: "这是只读历史回答" }
    ]);
    expect(notices.some((n) => n.kind === "error")).toBe(false);
    expect(isPinnedYoutubeCacheEvicted(chatSessionState.currentConversationMeta)).toBe(true);

    const showContextNotice = vi.fn();
    const gate = createSendGate({
      loadContextState: async (opts) => Boolean(await loadContextState(opts)),
      hydratePinned: (opts) => store.hydratePinned(opts),
      showContextNotice,
      removeContextNotice: vi.fn(),
      replayInFlight: vi.fn(async () => {}),
      isSessionClosed: () => false,
      isReaderTranscribing: () => false,
      asrNotice: null,
      pageBvid: () => "",
      clip: () => state.clip,
      startSubtitleFetch: vi.fn(async () => false),
      subscribeStatusPhase: () => () => {}
    });

    const outcome = await gate.ensureContextForSend();
    expect(outcome).toEqual({ pass: false, kind: "read-failed" });
    expect(notices.some((n) => n.kind === "error")).toBe(false);
    expect(showContextNotice).toHaveBeenCalledWith(
      YOUTUBE_CACHE_EVICTED_SEND_NOTICE,
      0,
      expect.objectContaining({
        placement: "input",
        action: expect.objectContaining({ label: "打开原视频" })
      })
    );

    liveLoaded = true;
    applyLiveContextSnapshot({
      site: "youtube",
      bvid: rawVideoId,
      cid: YOUTUBE_UNIT_CID,
      title: ytConv.title,
      url: ytConv.contextUrl,
      subtitleBody: [{ from: 0, to: 5, content: "Reloaded YouTube subtitle" }],
      isVideoContext: true
    });

    const healedOutcome = await gate.ensureContextForSend();
    expect(healedOutcome).toEqual({ pass: true });
    expect(isPinnedYoutubeCacheEvicted(chatSessionState.currentConversationMeta)).toBe(false);
    expect(chatSessionState.contextData?.subtitleBody).toEqual([
      { from: 0, to: 5, content: "Reloaded YouTube subtitle" }
    ]);
  });
});

describe("context-assembly 跨站装配与 chat-tab 运行时门控", () => {
  it("createInProcessContextFetch 在 YouTube 页跳过热评并透传 site=\"youtube\"", async () => {
    const fetchHotComments = vi.fn(async () => [{ uname: "u", like: 1, message: "m" }]);
    const fetchContext = createInProcessContextFetch({
      url: () => "https://www.youtube.com/watch?v=ab_cd-12_ef",
      clip: () => ({
        site: "youtube",
        bvid: "ab_cd-12_ef",
        cid: YOUTUBE_UNIT_CID,
        title: "YT",
        subtitleBody: [{ from: 0, to: 5, content: "hello" }]
      }),
      fetchHotComments
    });

    const outcome = await fetchContext({ forceRefresh: true, ifSignature: "" });
    expect(fetchHotComments).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("payload");
    expect((outcome as { payload: { site?: string } }).payload.site).toBe("youtube");
  });

  it("chat-tab 在 YouTube 下隐藏伴看按钮状态、使用 extractVideoId 识别 pageBvid，并仅拒绝历史时间点截帧", async () => {
    const rawVideoId = "ab_cd-12_ef";
    const { capturedDeps, sendBtn } = await captureChatTabDomainDepsOnYoutube(rawVideoId);

    expect(sendBtn?.classList.contains("is-live")).toBe(false);
    expect(capturedDeps).not.toBeNull();

    const typedDeps = capturedDeps!;
    expect(typedDeps.pageBvid()).toBe(rawVideoId);
    expect(typedDeps.isLiveActive?.()).toBe(false);
    expect(typedDeps.captureCurrentVideoFrame).toBeDefined();

    const liveFrame = await typedDeps.captureCurrentVideoFrame!(undefined);
    expect(frameCaptureMock.capturePageVideoFrame).toHaveBeenCalledTimes(1);
    expect(liveFrame).toEqual({
      image: { mime: "image/jpeg", data: "AQID" },
      currentTime: 42.5
    });

    await expect(typedDeps.captureCurrentVideoFrame!(12)).rejects.toThrow("当前站点不支持历史时间点截帧");
    expect(frameCaptureMock.captureHistoricalVideoFrame).not.toHaveBeenCalled();
  });

  it("chat-tab 在 YouTube 下读取主播放器播放游标并向 capturePageVideoFrame 透传站点感知 getVideo", async () => {
    const rawVideoId = "ab_cd-12_ef";
    const { capturedDeps } = await captureChatTabDomainDepsOnYoutube(rawVideoId);
    const { state: activeState } = await import("../../extension/core/state.js");
    const typedDeps = capturedDeps!;

    const ytHost = document.createElement("div");
    ytHost.innerHTML = `
      <ytd-video-preview><video id="yt-preview-video"></video></ytd-video-preview>
      <div id="movie_player"><video id="yt-main-video" class="html5-main-video"></video></div>
    `;
    document.body.appendChild(ytHost);
    const previewVideo = document.getElementById("yt-preview-video") as HTMLVideoElement;
    const mainVideo = document.getElementById("yt-main-video") as HTMLVideoElement;
    previewVideo.getBoundingClientRect = () => ({ width: 900, height: 500 } as DOMRect);
    mainVideo.getBoundingClientRect = () => ({ width: 640, height: 360 } as DOMRect);
    Object.defineProperty(previewVideo, "currentTime", { value: 999, configurable: true });
    Object.defineProperty(mainVideo, "currentTime", { value: 37.5, configurable: true });

    activeState.reader.readingVideoEl = null;
    expect(typedDeps.getPlaybackCursorSeconds?.()).toBe(37.5);

    await typedDeps.captureCurrentVideoFrame!(undefined);
    const captureOptions = frameCaptureMock.capturePageVideoFrame.mock.calls.at(-1)?.[0] as
      | { getVideo?: () => HTMLVideoElement | null }
      | undefined;
    expect(typeof captureOptions?.getVideo).toBe("function");
    expect(captureOptions?.getVideo?.()).toBe(mainVideo);

    const connectedBoundVideo = document.createElement("video");
    Object.defineProperty(connectedBoundVideo, "currentTime", { value: 88.25, configurable: true });
    document.body.appendChild(connectedBoundVideo);
    activeState.reader.readingVideoEl = connectedBoundVideo;

    expect(typedDeps.getPlaybackCursorSeconds?.()).toBe(88.25);
    expect(captureOptions?.getVideo?.()).toBe(connectedBoundVideo);
  });
});
