// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { SubtitleBodyItem } from "../../extension/ai/types.js";
import {
  clearVideoCache,
  loadRawSubtitleTrack,
  saveRawSubtitleTrack
} from "../../extension/subtitle/cache.js";
import { createSubtitleIdbStore } from "../../extension/subtitle/idb-store.js";
import {
  resolveActiveSubtitleStore,
  resolveDirectSubtitleStore,
  shouldRouteViaBackground
} from "../../extension/subtitle/store-client.js";
import { createSubtitleCacheHandler } from "../../extension/subtitle/subtitle-cache-handler.js";
import type {
  SubtitleCacheMessage,
  SubtitleCacheResponse
} from "../../extension/shared/messaging-protocol.js";

const BVID = "BV1rpcerr0001";
const CID = "77001";
const TRACK_KEY = "id_en_1";
const SEG_SIG = "seg_rpc_test";
const TR_SIG = "tr_rpc_test";
const AI_FAMILY = "biliscript_lvs_summary_" as const;
const AI_KEY = `${AI_FAMILY}${BVID}_${CID}_id_en_1_v1`;

const READONLY_RAW_ITEMS: readonly SubtitleBodyItem[] = Object.freeze([
  { from: 0, to: 2, content: "Hello world" },
  { from: 2.1, to: 4.5, content: "Testing RPC store client" }
]);

const READONLY_TRANSLATED_ITEMS: readonly SubtitleBodyItem[] = Object.freeze([
  { from: 0, to: 2, content: "你好世界" },
  { from: 2.1, to: 4.5, content: "测试 RPC 存储客户端" }
]);

function installFailingRuntimeSendMessage(errorMessage: string) {
  const sendMessage = vi.fn((_message: unknown, callback?: (response: unknown) => void) => {
    const runtime = globalThis.chrome.runtime as unknown as {
      lastError: { message: string } | null;
    };
    runtime.lastError = { message: errorMessage };
    try {
      callback?.(undefined);
    } finally {
      runtime.lastError = null;
    }
  });
  (globalThis.chrome.runtime as unknown as { sendMessage: typeof sendMessage }).sendMessage =
    sendMessage;
  return sendMessage;
}

describe("subtitle store-client SW RPC 错误语义与类型对齐", () => {
  beforeEach(() => {
    resetModuleState();
    expect(shouldRouteViaBackground()).toBe(true);
  });

  afterEach(() => {
    resetModuleState();
  });

  it("RPC 通信错误时字幕读写删方法显式暴露失败，不再静默回落 fallbackStore", async () => {
    const fallbackStore = resolveDirectSubtitleStore();
    await fallbackStore.putRawTrack({
      bvid: BVID,
      cid: CID,
      trackKey: TRACK_KEY,
      lang: "en-US",
      kind: "manual-cc",
      items: READONLY_RAW_ITEMS
    });
    await fallbackStore.putSegmentedTrack({
      bvid: BVID,
      cid: CID,
      trackKey: TRACK_KEY,
      segmentationSig: SEG_SIG,
      items: READONLY_RAW_ITEMS
    });
    await fallbackStore.upsertTranslatedTrack({
      bvid: BVID,
      cid: CID,
      sourceTrackKey: TRACK_KEY,
      targetLang: "zh-CN",
      translationSig: TR_SIG,
      items: READONLY_TRANSLATED_ITEMS
    });

    installFailingRuntimeSendMessage("Extension context invalidated");
    const rpcStore = resolveActiveSubtitleStore();

    await expect(rpcStore.getPageRecord(BVID, CID)).rejects.toThrow("Extension context invalidated");
    await expect(rpcStore.getRawTrack(BVID, CID, TRACK_KEY)).rejects.toThrow(
      "Extension context invalidated"
    );
    await expect(rpcStore.getSegmentedTrack(BVID, CID, TRACK_KEY, SEG_SIG)).rejects.toThrow(
      "Extension context invalidated"
    );
    await expect(
      rpcStore.getTranslatedTrack(BVID, CID, TRACK_KEY, "zh-CN", TR_SIG)
    ).rejects.toThrow("Extension context invalidated");

    const rawWrite = await rpcStore.putRawTrack({
      bvid: BVID,
      cid: "new-cid",
      trackKey: "new-track",
      items: READONLY_RAW_ITEMS
    });
    expect(rawWrite.ok).toBe(false);
    expect(rawWrite.error?.message).toBe("Extension context invalidated");
    await expect(fallbackStore.getRawTrack(BVID, "new-cid", "new-track")).resolves.toBeNull();

    const segWrite = await rpcStore.putSegmentedTrack({
      bvid: BVID,
      cid: "new-cid",
      trackKey: "new-track",
      segmentationSig: SEG_SIG,
      items: READONLY_RAW_ITEMS
    });
    expect(segWrite.ok).toBe(false);
    expect(segWrite.error?.message).toBe("Extension context invalidated");
    await expect(
      fallbackStore.getSegmentedTrack(BVID, "new-cid", "new-track", SEG_SIG)
    ).resolves.toBeNull();

    const trWrite = await rpcStore.upsertTranslatedTrack({
      bvid: BVID,
      cid: "new-cid",
      sourceTrackKey: "new-track",
      targetLang: "zh-CN",
      translationSig: TR_SIG,
      items: READONLY_TRANSLATED_ITEMS
    });
    expect(trWrite.ok).toBe(false);
    expect(trWrite.error?.message).toBe("Extension context invalidated");
    await expect(
      fallbackStore.getTranslatedTrack(BVID, "new-cid", "new-track", "zh-CN", TR_SIG)
    ).resolves.toBeNull();

    await expect(
      rpcStore.deleteTrackEntry({ bvid: BVID, cid: CID, tier: "rawTracks", key: TRACK_KEY })
    ).rejects.toThrow("Extension context invalidated");
    await expect(
      rpcStore.pruneAsrVariants({ bvid: BVID, cid: CID })
    ).rejects.toThrow("Extension context invalidated");
    await expect(
      rpcStore.clearTranslatedTracksForPage({ bvid: BVID, cid: CID, sourceTrackKey: TRACK_KEY })
    ).rejects.toThrow("Extension context invalidated");
    await expect(rpcStore.clearVideo(BVID, CID)).rejects.toThrow("Extension context invalidated");

    await expect(fallbackStore.getRawTrack(BVID, CID, TRACK_KEY)).resolves.toEqual(
      READONLY_RAW_ITEMS
    );
    await expect(
      fallbackStore.getTranslatedTrack(BVID, CID, TRACK_KEY, "zh-CN", TR_SIG)
    ).resolves.toEqual(READONLY_TRANSLATED_ITEMS);
  });

  it("RPC 通信错误时 AI 产物方法显式暴露失败，不再静默回落 fallbackStore", async () => {
    const fallbackStore = resolveDirectSubtitleStore();
    await fallbackStore.putAiArtifact({
      key: AI_KEY,
      family: AI_FAMILY,
      bvid: BVID,
      cid: CID,
      payload: { text: "fallback summary" }
    });

    installFailingRuntimeSendMessage("Could not establish connection");
    const rpcStore = resolveActiveSubtitleStore();

    await expect(rpcStore.getAiArtifact(AI_KEY)).rejects.toThrow("Could not establish connection");
    await expect(rpcStore.getAiArtifactsMany([AI_KEY])).rejects.toThrow(
      "Could not establish connection"
    );
    await expect(rpcStore.listAiArtifactsByFamilyBvid(AI_FAMILY, BVID)).rejects.toThrow(
      "Could not establish connection"
    );
    await expect(rpcStore.deleteAiArtifact(AI_KEY)).rejects.toThrow(
      "Could not establish connection"
    );

    const newKey = `${AI_FAMILY}${BVID}_${CID}_id_en_1_v2`;
    const aiWrite = await rpcStore.putAiArtifact({
      key: newKey,
      family: AI_FAMILY,
      bvid: BVID,
      cid: CID,
      payload: { text: "should not fall back" }
    });
    expect(aiWrite.ok).toBe(false);
    expect(aiWrite.evictedKeys).toEqual([]);
    expect(aiWrite.error?.message).toBe("Could not establish connection");
    await expect(fallbackStore.getAiArtifact(newKey)).resolves.toBeNull();
    await expect(fallbackStore.getAiArtifact(AI_KEY)).resolves.not.toBeNull();
  });

  it("SW 返回 handled 且 ok:false 时读删方法抛出远端错误、写方法返回失败结果", async () => {
    const fallbackStore = resolveDirectSubtitleStore();
    await fallbackStore.putRawTrack({
      bvid: BVID,
      cid: CID,
      trackKey: TRACK_KEY,
      items: READONLY_RAW_ITEMS
    });

    const sendMessage = vi.fn(
      (_message: unknown, callback?: (response: SubtitleCacheResponse) => void) => {
        callback?.({ ok: false, handled: true, error: "IDB transaction aborted" });
      }
    );
    (globalThis.chrome.runtime as unknown as { sendMessage: typeof sendMessage }).sendMessage =
      sendMessage;

    const rpcStore = resolveActiveSubtitleStore();
    await expect(rpcStore.getRawTrack(BVID, CID, TRACK_KEY)).rejects.toThrow(
      "IDB transaction aborted"
    );
    await expect(rpcStore.getAiArtifact(AI_KEY)).rejects.toThrow("IDB transaction aborted");
    await expect(rpcStore.clearVideo(BVID, CID)).rejects.toThrow("IDB transaction aborted");

    const writeRes = await rpcStore.putRawTrack({
      bvid: BVID,
      cid: CID,
      trackKey: "t2",
      items: READONLY_RAW_ITEMS
    });
    expect(writeRes.ok).toBe(false);
    expect(writeRes.error?.message).toBe("IDB transaction aborted");
  });

  it("仅在无 SW 托管（unhandled）时按既定策略回落 fallbackStore", async () => {
    const sendMessage = vi.fn((_message: unknown, callback?: (response: unknown) => void) => {
      callback?.({ ok: true });
    });
    (globalThis.chrome.runtime as unknown as { sendMessage: typeof sendMessage }).sendMessage =
      sendMessage;

    const rpcStore = resolveActiveSubtitleStore();
    const fallbackStore = resolveDirectSubtitleStore();

    const writeRes = await rpcStore.putRawTrack({
      bvid: BVID,
      cid: CID,
      trackKey: TRACK_KEY,
      items: READONLY_RAW_ITEMS
    });
    expect(writeRes.ok).toBe(true);
    await expect(rpcStore.getRawTrack(BVID, CID, TRACK_KEY)).resolves.toEqual(READONLY_RAW_ITEMS);
    await expect(fallbackStore.getRawTrack(BVID, CID, TRACK_KEY)).resolves.toEqual(
      READONLY_RAW_ITEMS
    );
  });

  it("对齐 readonly SubtitleBodyItem[] 后经 SW RPC 读写三层字幕与 AI 产物正常落盘", async () => {
    const remoteStore = createSubtitleIdbStore({ indexedDB: null });
    const handler = createSubtitleCacheHandler(remoteStore);
    const sendMessage = vi.fn(
      (message: unknown, callback?: (response: SubtitleCacheResponse) => void) => {
        handler(message as SubtitleCacheMessage, {}, (resp) => callback?.(resp));
      }
    );
    (globalThis.chrome.runtime as unknown as { sendMessage: typeof sendMessage }).sendMessage =
      sendMessage;

    const rpcStore = resolveActiveSubtitleStore();
    const fallbackStore = resolveDirectSubtitleStore();

    await expect(
      rpcStore.putRawTrack({
        bvid: BVID,
        cid: CID,
        trackKey: TRACK_KEY,
        lang: "en-US",
        kind: "manual-cc",
        items: READONLY_RAW_ITEMS
      })
    ).resolves.toMatchObject({ ok: true });

    await expect(
      rpcStore.putSegmentedTrack({
        bvid: BVID,
        cid: CID,
        trackKey: TRACK_KEY,
        segmentationSig: SEG_SIG,
        items: READONLY_RAW_ITEMS
      })
    ).resolves.toMatchObject({ ok: true });

    await expect(
      rpcStore.upsertTranslatedTrack({
        bvid: BVID,
        cid: CID,
        sourceTrackKey: TRACK_KEY,
        targetLang: "zh-CN",
        translationSig: TR_SIG,
        items: READONLY_TRANSLATED_ITEMS
      })
    ).resolves.toMatchObject({ ok: true });

    await expect(rpcStore.getRawTrack(BVID, CID, TRACK_KEY)).resolves.toEqual(READONLY_RAW_ITEMS);
    await expect(rpcStore.getSegmentedTrack(BVID, CID, TRACK_KEY, SEG_SIG)).resolves.toEqual(
      READONLY_RAW_ITEMS
    );
    await expect(
      rpcStore.getTranslatedTrack(BVID, CID, TRACK_KEY, "zh-CN", TR_SIG)
    ).resolves.toEqual(READONLY_TRANSLATED_ITEMS);
    await expect(fallbackStore.getPageRecord(BVID, CID)).resolves.toBeNull();
  });

  it("SW RPC 报错时上层 cache.ts 入口安全兜底而不引发未捕获异常", async () => {
    installFailingRuntimeSendMessage("SW terminated");

    await expect(
      loadRawSubtitleTrack({ bvid: BVID, cid: CID, trackKey: TRACK_KEY })
    ).resolves.toBeNull();

    const saveRes = await saveRawSubtitleTrack({
      bvid: BVID,
      cid: CID,
      trackKey: TRACK_KEY,
      items: READONLY_RAW_ITEMS
    });
    expect(saveRes).toMatchObject({
      ok: false,
      error: expect.objectContaining({
        message: expect.stringContaining("SW terminated")
      })
    });

    await expect(clearVideoCache(BVID, CID)).resolves.toEqual({
      removedPageIds: [],
      removedArtifactKeys: [],
      removedLegacyKeys: []
    });
  });
});
