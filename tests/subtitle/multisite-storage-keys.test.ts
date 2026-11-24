// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost } from "../helpers/chrome-host.js";
import {
  YOUTUBE_UNIT_CID,
  encodeVideoStorageBvid
} from "../../extension/shared/site.js";
import {
  buildSubtitlePageId,
  createSubtitleIdbStore,
  parseAiArtifactKey,
  type SubtitleTrackStorageKind
} from "../../extension/subtitle/idb-store.js";
import {
  clearVideoCache,
  configureSubtitleCacheStoreForTests,
  flushSubtitleCache,
  getSubtitleCacheKey,
  getSubtitlePageCacheRecord,
  loadRawSubtitleTrack,
  loadSegmentedSubtitleTrack,
  loadSubtitleFromCache,
  loadTranslatedSubtitleTrack,
  parseSubtitleCacheKey,
  saveRawSubtitleTrack,
  saveSegmentedSubtitleTrack,
  saveTranslatedSubtitleTrack,
  scheduleTranslatedTrackWrite
} from "../../extension/subtitle/cache.js";
import { createAiArtifactFamily } from "../../extension/subtitle/ai-artifact-cache.js";
import { createSubtitleCacheHandler } from "../../extension/subtitle/subtitle-cache-handler.js";
import { trackIdentity } from "../../extension/subtitle/source-key.js";
import {
  buildSegmentSummaryCacheKey,
  getSegmentSummaryKey,
  loadStoredL1Index,
  loadStoredSegmentSummaries,
  saveSegmentSummary,
  segmentCacheKeyStringFields
} from "../../extension/ai/segment-cache.js";
import { projectSegmentCacheContext } from "../../extension/ai/segment-cache-key-fields.js";
import { createSegmentCacheHandler } from "../../extension/ai/segment-cache-handler.js";
import { loadL1IndexViaProxy, segmentCacheProxy } from "../../extension/ai/segment-cache-proxy.js";
import {
  buildAnalysisFinalCacheKey,
  buildClipOverviewIdentity,
  buildL1IndexCacheKey,
  buildL1VideoIndex,
  clearL1IndexMemoryCache,
  loadAnalysisFinal,
  loadL1Index,
  readCachedClipOverviewArtifacts,
  saveAnalysisFinal,
  saveL1Index
} from "../../extension/ai/l1-chapter-index.js";
import type {
  SegmentCacheMessage,
  SegmentCacheResponse,
  SendResponse,
  SubtitleCacheMessage,
  SubtitleCacheResponse
} from "../../extension/shared/messaging-protocol.js";

const YT_ID_LEADING_UNDERSCORE = "_a_b-C12_34";
const YT_ID_LEADING_HYPHEN = "-_987654321";
const BILI_ID = "BV1multi724A";
const BILI_CID = "987654321";

const YT_ENCODED_A = encodeVideoStorageBvid("youtube", YT_ID_LEADING_UNDERSCORE);
const YT_ENCODED_B = encodeVideoStorageBvid("youtube", YT_ID_LEADING_HYPHEN);

function callSegmentHandler(
  handler: ReturnType<typeof createSegmentCacheHandler>,
  message: SegmentCacheMessage
): Promise<SegmentCacheResponse> {
  return new Promise<SegmentCacheResponse>((resolve) =>
    handler(message, {}, resolve as SendResponse)
  );
}

function createYoutubeRpcBridge(
  handler: ReturnType<typeof createSubtitleCacheHandler>,
  rpcOps: string[]
) {
  return vi.fn((message: unknown, callback?: (response: SubtitleCacheResponse) => void) => {
    const msg = message as SubtitleCacheMessage;
    if (msg?.type === "subtitle-cache") {
      rpcOps.push(msg.op);
      handler(msg, {}, (response) => callback?.(response));
      return;
    }
    callback?.({ ok: false });
  });
}

function createSegmentProxyTransport(handler: ReturnType<typeof createSegmentCacheHandler>) {
  return vi.fn((message: unknown) => callSegmentHandler(handler, message as SegmentCacheMessage));
}

describe("多站点存储键编码与解析（YouTube yt~ 幂等隔离 + B 站零迁移）", () => {
  beforeEach(() => {
    resetModuleState();
    configureSubtitleCacheStoreForTests(null);
    clearL1IndexMemoryCache();
    installChromeHost();
  });

  afterEach(() => {
    configureSubtitleCacheStoreForTests(null);
    clearL1IndexMemoryCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("YouTube 11 位含前导/中间 _ 与 - 的 ID 编码无 _/:，支持可选 site、cid='yt' 推断且绝不二次编码", () => {
    expect(YT_ENCODED_A).toBe("yt~~ua~ub-C12~u34");
    expect(YT_ENCODED_B).toBe("yt~-~u987654321");
    expect(YT_ENCODED_A).not.toMatch(/[_:]/);
    expect(YT_ENCODED_B).not.toMatch(/[_:]/);

    const track = trackIdentity("yt_auto.en", "", "en");
    const byCid = getSubtitleCacheKey({
      bvid: YT_ID_LEADING_UNDERSCORE,
      cid: YOUTUBE_UNIT_CID,
      identity: track
    });
    const bySite = getSubtitleCacheKey({
      bvid: YT_ID_LEADING_UNDERSCORE,
      cid: "ignored-cid",
      site: "youtube",
      identity: track
    });
    const byPreEncoded = getSubtitleCacheKey({
      bvid: YT_ENCODED_A,
      cid: YOUTUBE_UNIT_CID,
      site: "youtube",
      identity: track
    });

    expect(byCid).toBe(`biliscript_subtitle_cache_${YT_ENCODED_A}_yt_id_yt_auto.en`);
    expect(bySite).toBe(byCid);
    expect(byPreEncoded).toBe(byCid);

    const biliKey = getSubtitleCacheKey({
      bvid: BILI_ID,
      cid: BILI_CID,
      identity: trackIdentity("8811", "", "zh-CN")
    });
    expect(biliKey).toBe(`biliscript_subtitle_cache_${BILI_ID}_${BILI_CID}_id_8811`);
  });

  it("parseSubtitleCacheKey 与 parseAiArtifactKey 兼容 B 站旧键与 yt~ 键（含带 _ 的 trackKey 与译文键）", () => {
    expect(
      parseSubtitleCacheKey(`biliscript_subtitle_cache_${YT_ENCODED_A}_yt_id_yt_manual_1`)
    ).toEqual({
      kind: "raw",
      bvid: YT_ENCODED_A,
      cid: "yt",
      trackKey: "id_yt_manual_1"
    });

    expect(
      parseSubtitleCacheKey(
        `biliscript_subtitle_cache_${YT_ENCODED_B}_yt_id_a.en_translate-zh-CN`
      )
    ).toEqual({
      kind: "translated",
      bvid: YT_ENCODED_B,
      cid: "yt",
      sourceTrackKey: "id_a.en",
      targetLang: "zh-CN"
    });

    expect(
      parseSubtitleCacheKey(`biliscript_subtitle_cache_${BILI_ID}_${BILI_CID}_id_77`)
    ).toEqual({
      kind: "raw",
      bvid: BILI_ID,
      cid: BILI_CID,
      trackKey: "id_77"
    });

    expect(parseAiArtifactKey(`biliscript_lvs_l1_index_${YT_ENCODED_A}_yt_id_en_sig1`)).toEqual({
      family: "biliscript_lvs_l1_index_",
      bvid: YT_ENCODED_A,
      cid: "yt"
    });
    expect(parseAiArtifactKey(`biliscript_lvs_summary_${YT_ENCODED_B}`)).toEqual({
      family: "biliscript_lvs_summary_",
      bvid: YT_ENCODED_B,
      cid: "yt"
    });
    expect(parseAiArtifactKey(`biliscript_lvs_analysis_final_${BILI_ID}_${BILI_CID}_id_1_s`)).toEqual({
      family: "biliscript_lvs_analysis_final_",
      bvid: BILI_ID,
      cid: BILI_CID
    });
  });
});

describe("IDB 字幕缓存、youtube-auto 与跨站零串扰读写", () => {
  beforeEach(() => {
    resetModuleState();
    configureSubtitleCacheStoreForTests(null);
    clearL1IndexMemoryCache();
    installChromeHost();
  });

  afterEach(() => {
    configureSubtitleCacheStoreForTests(null);
    clearL1IndexMemoryCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("混合读写 YouTube（_a_b-C12_34、-_987654321）与 B 站字幕三层缓存及 chat_images，零串扰", async () => {
    const store = createSubtitleIdbStore({ indexedDB: null });
    configureSubtitleCacheStoreForTests(store);

    const ytAutoKind: SubtitleTrackStorageKind = "youtube-auto";
    const ytItemsA = [{ from: 0, to: 3, content: "YouTube A raw" }];
    const ytItemsB = [{ from: 0, to: 3, content: "YouTube B raw" }];
    const biliItems = [{ from: 0, to: 3, content: "B站原生字幕" }];

    await saveRawSubtitleTrack({
      bvid: YT_ID_LEADING_UNDERSCORE,
      cid: YOUTUBE_UNIT_CID,
      site: "youtube",
      trackKey: "id_a.en",
      lang: "en",
      kind: ytAutoKind,
      items: ytItemsA
    });
    await saveRawSubtitleTrack({
      bvid: YT_ID_LEADING_HYPHEN,
      cid: YOUTUBE_UNIT_CID,
      trackKey: "id_a.en",
      lang: "en",
      kind: ytAutoKind,
      items: ytItemsB
    });
    await saveRawSubtitleTrack({
      bvid: BILI_ID,
      cid: BILI_CID,
      trackKey: "id_a.en",
      lang: "zh-CN",
      kind: "bili-ai",
      items: biliItems
    });

    await saveSegmentedSubtitleTrack({
      bvid: YT_ID_LEADING_UNDERSCORE,
      cid: YOUTUBE_UNIT_CID,
      trackKey: "id_a.en",
      segmentationSig: "seg_yt1",
      items: [{ from: 0, to: 3, content: "YouTube A segmented" }]
    });
    await saveTranslatedSubtitleTrack({
      bvid: YT_ID_LEADING_UNDERSCORE,
      cid: YOUTUBE_UNIT_CID,
      sourceTrackKey: "id_a.en",
      targetLang: "zh-CN",
      translationSig: "tr_yt1",
      mode: "boundary-v3",
      items: [{ from: 0, to: 3, content: "YouTube A 中文译文" }]
    });

    expect(
      await loadRawSubtitleTrack({
        bvid: YT_ID_LEADING_UNDERSCORE,
        cid: YOUTUBE_UNIT_CID,
        trackKey: "id_a.en"
      })
    ).toEqual(ytItemsA);
    expect(
      await loadRawSubtitleTrack({
        bvid: YT_ID_LEADING_HYPHEN,
        cid: YOUTUBE_UNIT_CID,
        site: "youtube",
        trackKey: "id_a.en"
      })
    ).toEqual(ytItemsB);
    expect(
      await loadRawSubtitleTrack({
        bvid: BILI_ID,
        cid: BILI_CID,
        trackKey: "id_a.en"
      })
    ).toEqual(biliItems);

    expect(
      await loadSegmentedSubtitleTrack({
        bvid: YT_ID_LEADING_UNDERSCORE,
        cid: YOUTUBE_UNIT_CID,
        trackKey: "id_a.en",
        segmentationSig: "seg_yt1"
      })
    ).toEqual([{ from: 0, to: 3, content: "YouTube A segmented" }]);
    expect(
      await loadTranslatedSubtitleTrack({
        bvid: YT_ID_LEADING_UNDERSCORE,
        cid: YOUTUBE_UNIT_CID,
        sourceTrackKey: "id_a.en",
        targetLang: "zh-CN",
        translationSig: "tr_yt1"
      })
    ).toEqual([{ from: 0, to: 3, content: "YouTube A 中文译文" }]);

    const pageA = await getSubtitlePageCacheRecord(YT_ID_LEADING_UNDERSCORE, YOUTUBE_UNIT_CID);
    expect(pageA).toMatchObject({
      id: `${YT_ENCODED_A}:yt`,
      bvid: YT_ENCODED_A,
      cid: "yt"
    });
    expect(pageA?.rawTracks["id_a.en"]?.kind).toBe("youtube-auto");

    const cacheKeyA = getSubtitleCacheKey({
      bvid: YT_ID_LEADING_UNDERSCORE,
      cid: YOUTUBE_UNIT_CID,
      identity: trackIdentity("a.en", "", "en")
    });
    expect(await loadSubtitleFromCache(cacheKeyA)).toEqual(ytItemsA);

    await store.putChatImage({
      id: "img_yt_a",
      conversationId: "conv_yt_a",
      bvid: YT_ID_LEADING_UNDERSCORE,
      cid: YOUTUBE_UNIT_CID,
      site: "youtube",
      mime: "image/png",
      data: "QUFB"
    });
    await store.putChatImage({
      id: "img_bili",
      conversationId: "conv_bili",
      bvid: BILI_ID,
      mime: "image/png",
      data: "QkJC"
    });
    expect((await store.getChatImage("img_yt_a"))?.bvid).toBe(YT_ENCODED_A);
    expect((await store.getChatImage("img_bili"))?.bvid).toBe(BILI_ID);

    const cleared = await clearVideoCache(YT_ID_LEADING_UNDERSCORE, YOUTUBE_UNIT_CID, "youtube");
    expect(cleared.removedPageIds).toEqual([`${YT_ENCODED_A}:yt`]);
    expect(
      await loadRawSubtitleTrack({
        bvid: YT_ID_LEADING_UNDERSCORE,
        cid: YOUTUBE_UNIT_CID,
        trackKey: "id_a.en"
      })
    ).toBeNull();
    expect(
      await loadRawSubtitleTrack({
        bvid: YT_ID_LEADING_HYPHEN,
        cid: YOUTUBE_UNIT_CID,
        trackKey: "id_a.en"
      })
    ).toEqual(ytItemsB);
    expect(
      await loadRawSubtitleTrack({
        bvid: BILI_ID,
        cid: BILI_CID,
        trackKey: "id_a.en"
      })
    ).toEqual(biliItems);
  });

  it("YouTube 内容脚本页通过 subtitle-cache SW RPC 读写与清缓存，不触发网页源 indexedDB", async () => {
    const pageIndexedDbOpen = vi.fn(() => {
      throw new Error("forbidden: content script must not touch page indexedDB");
    });
    vi.stubGlobal("indexedDB", { open: pageIndexedDbOpen });
    Object.defineProperty(window, "location", {
      value: new URL(`https://www.youtube.com/watch?v=${YT_ID_LEADING_UNDERSCORE}`),
      configurable: true
    });

    const remoteStore = createSubtitleIdbStore({ indexedDB: null });
    const handler = createSubtitleCacheHandler(remoteStore);
    const rpcOps: string[] = [];
    const sendMessage = createYoutubeRpcBridge(handler, rpcOps);
    (globalThis.chrome.runtime as unknown as { sendMessage: typeof sendMessage }).sendMessage =
      sendMessage;

    await saveRawSubtitleTrack({
      bvid: YT_ID_LEADING_UNDERSCORE,
      cid: YOUTUBE_UNIT_CID,
      site: "youtube",
      trackKey: "id_a.en",
      kind: "youtube-auto",
      items: [{ from: 1, to: 4, content: "RPC YouTube caption" }]
    });

    vi.useFakeTimers();
    scheduleTranslatedTrackWrite({
      bvid: YT_ID_LEADING_UNDERSCORE,
      cid: YOUTUBE_UNIT_CID,
      site: "youtube",
      sourceTrackKey: "id_a.en",
      targetLang: "zh-CN",
      translationSig: "tr_rpc",
      items: [{ from: 1, to: 4, content: "RPC YouTube 译文" }]
    });
    await flushSubtitleCache({
      bvid: YT_ID_LEADING_UNDERSCORE,
      cid: YOUTUBE_UNIT_CID,
      site: "youtube"
    });
    vi.useRealTimers();

    expect(
      await loadRawSubtitleTrack({
        bvid: YT_ID_LEADING_UNDERSCORE,
        cid: YOUTUBE_UNIT_CID,
        trackKey: "id_a.en"
      })
    ).toEqual([{ from: 1, to: 4, content: "RPC YouTube caption" }]);
    expect(
      await loadTranslatedSubtitleTrack({
        bvid: YT_ID_LEADING_UNDERSCORE,
        cid: YOUTUBE_UNIT_CID,
        sourceTrackKey: "id_a.en",
        targetLang: "zh-CN",
        translationSig: "tr_rpc"
      })
    ).toEqual([{ from: 1, to: 4, content: "RPC YouTube 译文" }]);
    expect(await remoteStore.getPageRecord(YT_ID_LEADING_UNDERSCORE, YOUTUBE_UNIT_CID)).toMatchObject({
      id: buildSubtitlePageId(YT_ID_LEADING_UNDERSCORE, YOUTUBE_UNIT_CID, "youtube"),
      bvid: YT_ENCODED_A,
      cid: "yt"
    });

    await clearVideoCache(YT_ID_LEADING_UNDERSCORE, undefined, "youtube");
    expect(await remoteStore.getPageRecord(YT_ID_LEADING_UNDERSCORE, YOUTUBE_UNIT_CID)).toBeNull();
    expect(rpcOps).toEqual(["put-raw", "upsert-translated", "get-raw", "get-translated", "clear-video"]);
    expect(pageIndexedDbOpen).not.toHaveBeenCalled();
  });
});

describe("AI 产物、segment 缓存、L1 索引与跨站 LRU 淘汰（零串扰、零分裂）", () => {
  beforeEach(() => {
    resetModuleState();
    configureSubtitleCacheStoreForTests(null);
    clearL1IndexMemoryCache();
    installChromeHost();
  });

  afterEach(() => {
    configureSubtitleCacheStoreForTests(null);
    clearL1IndexMemoryCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("createAiArtifactFamily.save 直接传递结构化 { bvid, cid } 写 IDB，不依赖反拆 _ 字符串", async () => {
    const store = createSubtitleIdbStore({ indexedDB: null });
    configureSubtitleCacheStoreForTests(store);

    const family = createAiArtifactFamily<{ text: string }>({
      family: "biliscript_lvs_analysis_final_",
      payloadField: "analysis",
      toSourceKey: (id) => `id_${String(id || "")}`
    });

    const structuredKey = `biliscript_lvs_analysis_final_custom_key_with_underscores`;
    const saveRes = await family.save(
      structuredKey,
      { text: "结构化写入" },
      { bvid: YT_ID_LEADING_UNDERSCORE, cid: YOUTUBE_UNIT_CID, site: "youtube" }
    );
    expect(saveRes).toEqual({ ok: true });

    const stored = await store.getAiArtifact<{ text: string }>(structuredKey);
    expect(stored).toMatchObject({
      key: structuredKey,
      family: "biliscript_lvs_analysis_final_",
      bvid: YT_ENCODED_A,
      cid: "yt",
      payload: { text: "结构化写入" }
    });
  });

  it("segment-cache*、l1-chapter-index 与 proxy/handler 跨站读写与查询全链隔离且不二次编码", async () => {
    const store = createSubtitleIdbStore({ indexedDB: null });
    configureSubtitleCacheStoreForTests(store);

    const ytContext = {
      site: "youtube" as const,
      bvid: YT_ID_LEADING_UNDERSCORE,
      cid: YOUTUBE_UNIT_CID,
      selectedSubtitleId: "a.en",
      selectedSubtitleUrl: "https://www.youtube.com/api/timedtext?v=_a_b-C12_34&lang=en",
      subtitleLang: "en",
      description: "0:00 Intro\n1:00 Deep Dive",
      subtitleBody: [
        { from: 0, to: 10, content: "Welcome everyone" },
        { from: 60, to: 70, content: "Main architecture" }
      ]
    };

    const strFields = segmentCacheKeyStringFields(ytContext);
    expect(strFields.bvid).toBe(YT_ENCODED_A);
    expect(strFields.cid).toBe("yt");
    expect(segmentCacheKeyStringFields({ bvid: YT_ENCODED_A, cid: "yt", site: "youtube" }).bvid).toBe(
      YT_ENCODED_A
    );

    const projected = projectSegmentCacheContext(ytContext);
    expect(projected).toEqual({
      bvid: YT_ID_LEADING_UNDERSCORE,
      cid: YOUTUBE_UNIT_CID,
      selectedSubtitleId: "a.en",
      selectedSubtitleUrl: "https://www.youtube.com/api/timedtext?v=_a_b-C12_34&lang=en",
      subtitleLang: "en",
      site: "youtube"
    });

    const summaryKey = buildSegmentSummaryCacheKey(ytContext, 0);
    expect(summaryKey).toBe(`biliscript_lvs_summary_${YT_ENCODED_A}_yt_id_a.en_0`);
    expect(
      getSegmentSummaryKey({
        bvid: YT_ENCODED_A,
        cid: "yt",
        site: "youtube",
        subtitleId: "a.en",
        segmentIndex: 0
      })
    ).toBe(summaryKey);

    const handler = createSegmentCacheHandler();
    (globalThis.chrome.runtime as unknown as { sendMessage: unknown }).sendMessage =
      createSegmentProxyTransport(handler);

    expect(
      await segmentCacheProxy.saveSummary({
        context: ytContext,
        segmentIndex: 0,
        budgetScale: 1,
        summary: "第0段摘要"
      })
    ).toEqual({ ok: true });
    expect(
      await segmentCacheProxy.saveSummary({
        context: ytContext,
        segmentIndex: 1,
        budgetScale: 1,
        summary: "第1段摘要"
      })
    ).toEqual({ ok: true });
    expect(
      await segmentCacheProxy.loadSummary({
        context: ytContext,
        segmentIndex: 0,
        budgetScale: 1
      })
    ).toBe("第0段摘要");
    expect(
      await segmentCacheProxy.loadStoredSummaries({
        context: ytContext,
        budgetScale: 1
      })
    ).toEqual(["第0段摘要", "第1段摘要"]);
    expect(
      await loadStoredSegmentSummaries({
        bvid: YT_ID_LEADING_UNDERSCORE,
        cid: YOUTUBE_UNIT_CID,
        site: "youtube",
        subtitleId: "a.en"
      })
    ).toEqual(["第0段摘要", "第1段摘要"]);

    const identityFromRaw = buildClipOverviewIdentity(ytContext);
    const identityFromSiteOnly = buildClipOverviewIdentity({
      ...ytContext,
      cid: ""
    });
    expect(identityFromRaw.hasCacheIdentity).toBe(true);
    expect(identityFromRaw.bvid).toBe(YT_ENCODED_A);
    expect(identityFromRaw.cid).toBe("yt");
    expect(identityFromRaw.finalKey).toBe(
      buildAnalysisFinalCacheKey(ytContext, identityFromRaw.signature)
    );
    expect(identityFromSiteOnly).toEqual(identityFromRaw);

    const analysis = {
      summary: "YouTube 概览摘要",
      chapters: [{ from: 0, to: 60, title: "Intro", summary: "Opening" }],
      quotes: [{ from: 60, content: "Main architecture" }]
    };
    const l1Record = buildL1VideoIndex({
      bvid: identityFromRaw.bvid,
      cid: identityFromRaw.cid,
      subtitleId: "a.en",
      subtitleLang: "en",
      subtitleSignature: identityFromRaw.signature,
      globalSummary: "L1 概览"
    });
    expect((await saveAnalysisFinal(identityFromRaw.finalKey, analysis)).ok).toBe(true);
    expect((await saveL1Index(identityFromRaw.l1Key, l1Record)).ok).toBe(true);

    clearL1IndexMemoryCache();
    expect(await readCachedClipOverviewArtifacts(ytContext)).toEqual({
      analysisFinal: analysis,
      l1Index: l1Record
    });
    expect(await loadL1IndexViaProxy({ context: ytContext })).toEqual(l1Record);
    expect(
      await loadStoredL1Index({
        bvid: YT_ID_LEADING_UNDERSCORE,
        cid: YOUTUBE_UNIT_CID,
        subtitleId: "a.en"
      })
    ).toEqual(l1Record);
    expect(await loadAnalysisFinal(identityFromRaw.finalKey)).toEqual(analysis);
    expect(await loadL1Index(identityFromRaw.l1Key)).toEqual(l1Record);
  });

  it("混合站点 LRU 淘汰：subtitle_pages 2 条上限与 ai_artifacts 按视频数 2 视频上限均零分裂、零串扰", async () => {
    let clock = 1000;
    const store = createSubtitleIdbStore({
      indexedDB: null,
      maxEntries: 2,
      aiArtifactKeepVideos: {
        biliscript_lvs_summary_: 2
      },
      now: () => {
        clock += 100;
        return clock;
      }
    });
    configureSubtitleCacheStoreForTests(store);

    await store.putRawTrack({
      bvid: YT_ID_LEADING_UNDERSCORE,
      cid: YOUTUBE_UNIT_CID,
      site: "youtube",
      trackKey: "id_en",
      kind: "youtube-auto",
      items: [{ from: 0, to: 2, content: "yt A" }]
    });
    await store.putRawTrack({
      bvid: BILI_ID,
      cid: BILI_CID,
      site: "bilibili",
      trackKey: "id_zh",
      kind: "manual-cc",
      items: [{ from: 0, to: 2, content: "bili" }]
    });
    await store.putAiArtifact({
      key: buildL1IndexCacheKey({
        bvid: BILI_ID,
        cid: BILI_CID,
        subtitleId: "zh",
        subtitleSignature: "sig_b"
      }),
      bvid: BILI_ID,
      cid: BILI_CID,
      payload: { ok: "bili" }
    });

    await store.getRawTrack(YT_ID_LEADING_UNDERSCORE, YOUTUBE_UNIT_CID, "id_en");

    const evictPageRes = await store.putRawTrack({
      bvid: YT_ID_LEADING_HYPHEN,
      cid: YOUTUBE_UNIT_CID,
      trackKey: "id_en",
      kind: "youtube-auto",
      items: [{ from: 0, to: 2, content: "yt B" }]
    });
    expect(evictPageRes.evictedIds).toEqual([`${BILI_ID}:${BILI_CID}`]);
    expect(evictPageRes.evictedArtifactKeys).toEqual([
      `biliscript_lvs_l1_index_${BILI_ID}_${BILI_CID}_id_zh_sig_b`
    ]);
    expect(await store.getRawTrack(YT_ID_LEADING_UNDERSCORE, YOUTUBE_UNIT_CID, "id_en")).toEqual([
      { from: 0, to: 2, content: "yt A" }
    ]);
    expect(await store.getRawTrack(YT_ID_LEADING_HYPHEN, YOUTUBE_UNIT_CID, "id_en")).toEqual([
      { from: 0, to: 2, content: "yt B" }
    ]);
    expect(await store.getRawTrack(BILI_ID, BILI_CID, "id_zh")).toBeNull();

    const ytAKey0 = getSegmentSummaryKey({
      bvid: YT_ID_LEADING_UNDERSCORE,
      cid: YOUTUBE_UNIT_CID,
      subtitleId: "id1",
      segmentIndex: 0
    });
    const ytAKey1 = getSegmentSummaryKey({
      bvid: YT_ID_LEADING_UNDERSCORE,
      cid: YOUTUBE_UNIT_CID,
      subtitleId: "id1",
      segmentIndex: 1
    });
    const biliSegKey = getSegmentSummaryKey({
      bvid: BILI_ID,
      cid: BILI_CID,
      subtitleId: "id1",
      segmentIndex: 0
    });
    const ytBKey0 = getSegmentSummaryKey({
      bvid: YT_ID_LEADING_HYPHEN,
      cid: YOUTUBE_UNIT_CID,
      subtitleId: "id1",
      segmentIndex: 0
    });

    await saveSegmentSummary(ytAKey0, "yt A seg 0", {
      bvid: YT_ID_LEADING_UNDERSCORE,
      cid: YOUTUBE_UNIT_CID,
      site: "youtube"
    });
    await saveSegmentSummary(ytAKey1, "yt A seg 1", {
      bvid: YT_ID_LEADING_UNDERSCORE,
      cid: YOUTUBE_UNIT_CID,
      site: "youtube"
    });
    await saveSegmentSummary(biliSegKey, "bili seg 0", {
      bvid: BILI_ID,
      cid: BILI_CID,
      site: "bilibili"
    });

    await store.getAiArtifact(ytAKey0);

    const writeYtB = await store.putAiArtifact({
      key: ytBKey0,
      family: "biliscript_lvs_summary_",
      bvid: YT_ID_LEADING_HYPHEN,
      cid: YOUTUBE_UNIT_CID,
      site: "youtube",
      payload: "yt B seg 0"
    });
    expect(writeYtB.ok).toBe(true);
    expect(writeYtB.evictedKeys).toEqual([biliSegKey]);

    expect((await store.getAiArtifact(ytAKey0))?.payload).toBe("yt A seg 0");
    expect((await store.getAiArtifact(ytAKey1))?.payload).toBe("yt A seg 1");
    expect((await store.getAiArtifact(ytBKey0))?.payload).toBe("yt B seg 0");
    expect(await store.getAiArtifact(biliSegKey)).toBeNull();
  });
});
