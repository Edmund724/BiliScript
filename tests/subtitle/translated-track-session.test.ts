// 60 秒分块译文副轨会话（subtitle/translated-track-session.ts）接口测试：
// 直接穿过 createTranslatedTrackSession seam，以内存 IndexedDB 替身与注入的翻译/协议适配器验证：
//   1. ASR 伪轨与原生 CC 源轨的身份/槽位/签名/遗留键装配一致；
//   2. reconfigure 切换协议/模型/术语后重新命中对应签名缓存；
//   3. 相邻分块缺失（chunkIndex - 1 为空）时，previousLines 回溯更早已完成分块的双语前情；
//   4. 流式 onCueReady 即时聚合上屏与 1500ms 防抖写入，flush() 立即落盘；
//   5. invalidateChunk / setPrimaryChunk 递增修订版，拦截旧版迟到流式与终态写入；
//   6. 分块异常回滚流式缓冲而不污染已完成分块，isStale 拦截过期会话写入。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import type { SubtitleBodyItem } from "../../extension/ai/types.js";
import type { SubtitleIdbStore } from "../../extension/subtitle/cache.js";
import type {
  TranslateSessionChunkInput,
  TranslatedTrackTranslateInput
} from "../../extension/subtitle/translated-track-session.js";

let idbStore: SubtitleIdbStore;
let state: (typeof import("../../extension/core/state.js"))["state"];
let clipState: (typeof import("../../extension/core/state.js"))["clipState"];
let buildTranslationSignature: (typeof import("../../extension/subtitle/cache.js"))["buildTranslationSignature"];
let configureSubtitleCacheStoreForTests: (typeof import("../../extension/subtitle/cache.js"))["configureSubtitleCacheStoreForTests"];
let loadTranslatedSubtitleTrack: (typeof import("../../extension/subtitle/cache.js"))["loadTranslatedSubtitleTrack"];
let createTranslatedTrackSession: (typeof import("../../extension/subtitle/translated-track-session.js"))["createTranslatedTrackSession"];

beforeEach(async () => {
  resetModuleState();
  vi.useFakeTimers();
  const stateMod = await import("../../extension/core/state.js");
  const cacheMod = await import("../../extension/subtitle/cache.js");
  const sessionMod = await import("../../extension/subtitle/translated-track-session.js");
  state = stateMod.state;
  clipState = stateMod.clipState;
  buildTranslationSignature = cacheMod.buildTranslationSignature;
  configureSubtitleCacheStoreForTests = cacheMod.configureSubtitleCacheStoreForTests;
  loadTranslatedSubtitleTrack = cacheMod.loadTranslatedSubtitleTrack;
  createTranslatedTrackSession = sessionMod.createTranslatedTrackSession;

  idbStore = cacheMod.createSubtitleIdbStore({ indexedDB: null });
  configureSubtitleCacheStoreForTests(idbStore);
  state.setSettings({ ...DEFAULT_SETTINGS, subtitleTranslateModel: "Index-Translate-35B-A3B" });
  clipState.setBvid("BV1session01");
  clipState.setCid("100");
  clipState.setFetchRunId(1);
});

afterEach(() => {
  configureSubtitleCacheStoreForTests(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createTranslatedTrackSession seam", () => {
  it("ASR 伪轨与原生 CC 源轨各自装配正确的槽位 id、sourceKey 与缓存键", () => {
    const asrSession = createTranslatedTrackSession({
      bvid: "BV1session01",
      cid: "100",
      source: { isAsrSource: true, targetLang: "en" }
    });
    expect(asrSession.slotId).toBe("translate-en");
    expect(asrSession.sourceKey).toBe("asr");
    expect(asrSession.canonicalTargetLang).toBe("en-US");
    expect(asrSession.legacyCacheKey).toBe(
      "biliscript_subtitle_cache_BV1session01_100_id_translate-en"
    );
    expect(asrSession.protocolMode).toBe("boundary-v3");

    const ccSession = createTranslatedTrackSession({
      bvid: "BV1session01",
      cid: "100",
      primaryItems: [{ from: 0, to: 3, content: "Hello world." }],
      source: {
        isAsrSource: false,
        selectedSubtitleId: "cc-en",
        selectedSubtitleUrl: "https://sub.test/cc-en.json",
        selectedSubtitleLang: "English",
        trackLan: "en-US",
        targetLang: "zh"
      }
    });
    expect(ccSession.slotId).toBe("id_cc-en_translate-zh-CN");
    expect(ccSession.sourceKey).toBe("id_cc-en");
    expect(ccSession.canonicalTargetLang).toBe("zh-CN");
    expect(ccSession.legacyCacheKey).toBe(
      "biliscript_subtitle_cache_BV1session01_100_id_cc-en_translate-zh-CN"
    );
    expect(ccSession.protocolMode).toBe("cc-json");
  });

  it("reconfigure 更新模型与协议后重新计算签名并命中对应缓存", async () => {
    const primary: SubtitleBodyItem[] = [{ from: 0, to: 4, content: "Line one." }];
    const expectedSig = buildTranslationSignature({
      model: "gpt-4o-mini",
      protocolVersion: "boundary-v3",
      targetLang: "zh-CN",
      sourceText: "Line one."
    });
    await idbStore.upsertTranslatedTrack({
      bvid: "BV1session01",
      cid: "100",
      sourceTrackKey: "id_cc-en",
      targetLang: "zh-CN",
      translationSig: expectedSig,
      mode: "boundary-v3",
      items: [{ from: 0, to: 4, content: "第一句精翻" }]
    });

    const session = createTranslatedTrackSession({
      bvid: "BV1session01",
      cid: "100",
      primaryItems: primary,
      source: {
        isAsrSource: false,
        selectedSubtitleId: "cc-en",
        trackLan: "en-US",
        targetLang: "zh"
      }
    });
    expect(await session.loadCached()).toEqual([]);

    const changed = session.reconfigure({
      model: "gpt-4o-mini",
      resolveProtocolMode: () => "boundary-v3"
    });
    expect(changed).toBe(true);
    expect(session.protocolMode).toBe("boundary-v3");
    expect(session.translationSig).toBe(expectedSig);
    expect(await session.loadCached()).toEqual([{ from: 0, to: 4, content: "第一句精翻" }]);
  });

  it("相邻前一片（chunkIndex - 1）缺失时，previousLines 回溯取更早已完成分块的双语前情", async () => {
    const chunk0: SubtitleBodyItem[] = [
      { from: 2, to: 5, content: "First sentence" },
      { from: 10, to: 14, content: "Second sentence" },
      { from: 20, to: 25, content: "Third sentence" }
    ];
    // chunk 1 (60-120s) 无字幕，直接跳到 chunk 2 (120-180s)
    const chunk2: SubtitleBodyItem[] = [{ from: 125, to: 130, content: "Later sentence" }];

    const capturedInputs: TranslatedTrackTranslateInput[] = [];
    const session = createTranslatedTrackSession(
      {
        bvid: "BV1session01",
        cid: "100",
        primaryItems: [...chunk0, ...chunk2],
        source: { isAsrSource: true, targetLang: "zh" }
      },
      {
        translateItems: async (input) => {
          capturedInputs.push(input);
          return input.items.map((item) => ({
            ...item,
            content: `译:${item.content}`
          }));
        }
      }
    );

    await session.translateChunk({
      chunkIndex: 0,
      chunkFromSec: 0,
      chunkToSec: 60,
      items: chunk0
    });
    await session.translateChunk({
      chunkIndex: 2,
      chunkFromSec: 120,
      chunkToSec: 180,
      items: chunk2
    });

    expect(capturedInputs).toHaveLength(2);
    expect(capturedInputs[0].previousLines).toBeUndefined();
    expect(capturedInputs[1].previousLines).toEqual([
      { original: "Second sentence", translation: "译:Second sentence" },
      { original: "Third sentence", translation: "译:Third sentence" }
    ]);
  });

  it("流式 onCueReady 即时聚合上屏与防抖缓冲，flush() 立即将流式句落入 IndexedDB", async () => {
    const streamingUpdates: Array<{ count: number; cueText: string }> = [];
    let emitCue!: NonNullable<TranslatedTrackTranslateInput["onCueReady"]>;
    let resolveTranslate!: (items: SubtitleBodyItem[]) => void;

    const session = createTranslatedTrackSession(
      {
        bvid: "BV1session01",
        cid: "100",
        primaryItems: [{ from: 0, to: 5, content: "Hello" }],
        source: { isAsrSource: true, targetLang: "zh" }
      },
      {
        translateItems: async (input) => {
          emitCue = input.onCueReady!;
          return new Promise<SubtitleBodyItem[]>((resolve) => {
            resolveTranslate = resolve;
          });
        },
        onStreamingUpdate: ({ items, cue }) => {
          streamingUpdates.push({ count: items.length, cueText: cue.content });
        }
      }
    );

    const pending = session.translateChunk({
      chunkIndex: 0,
      chunkFromSec: 0,
      chunkToSec: 60,
      items: [{ from: 0, to: 5, content: "Hello" }]
    });

    await vi.advanceTimersByTimeAsync(10);
    emitCue({
      startIndex: 0,
      endIndex: 0,
      from: 0,
      to: 5,
      text: "Hello",
      translation: "你好"
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(streamingUpdates).toEqual([{ count: 1, cueText: "你好" }]);
    expect(session.getSecondaryItems()).toEqual([{ from: 0, to: 5, content: "你好" }]);
    expect(clipState.secondarySubtitle.body).toEqual([{ from: 0, to: 5, content: "你好" }]);

    // 未满 1500ms 防抖阈值前尚未落盘
    const pageBeforeFlush = await idbStore.getPageRecord("BV1session01", "100");
    expect(pageBeforeFlush?.translatedTracks ?? {}).toEqual({});

    await session.flush();
    expect(
      await loadTranslatedSubtitleTrack({
        bvid: "BV1session01",
        cid: "100",
        sourceTrackKey: "asr",
        targetLang: "zh-CN",
        translationSig: session.translationSig
      })
    ).toEqual([{ from: 0, to: 5, content: "你好" }]);

    resolveTranslate([{ from: 0, to: 5, content: "你好" }]);
    await pending;
  });

  it("invalidateChunk 与 setPrimaryChunk 递增修订版，拦截旧版流式与完成写入", async () => {
    let emitCue!: NonNullable<TranslatedTrackTranslateInput["onCueReady"]>;
    let resolveFirst!: (items: SubtitleBodyItem[]) => void;

    const session = createTranslatedTrackSession(
      {
        bvid: "BV1session01",
        cid: "100",
        source: { isAsrSource: true, targetLang: "zh" }
      },
      {
        translateItems: async (input) => {
          emitCue = input.onCueReady!;
          return new Promise<SubtitleBodyItem[]>((resolve) => {
            resolveFirst = resolve;
          });
        }
      }
    );

    session.setPrimaryChunk(0, [{ from: 0, to: 4, content: "Draft ASR" }]);
    const firstRun = session.translateChunk({
      chunkIndex: 0,
      chunkFromSec: 0,
      chunkToSec: 60,
      items: session.getPrimaryChunk(0)
    });

    await vi.advanceTimersByTimeAsync(10);
    session.invalidateChunk(0);
    session.setPrimaryChunk(0, [{ from: 0, to: 4, content: "Smoothed ASR" }]);

    emitCue({
      startIndex: 0,
      endIndex: 0,
      from: 0,
      to: 4,
      text: "Draft ASR",
      translation: "旧修订版流式译文"
    });
    expect(session.getSecondaryItems()).toEqual([]);

    resolveFirst([{ from: 0, to: 4, content: "旧修订版终态" }]);
    const firstResult = await firstRun;
    expect(firstResult).toEqual({ status: "stale-revision", items: [] });
    expect(session.isChunkDone(0)).toBe(false);
    expect(session.getSecondaryItems()).toEqual([]);
    expect(clipState.secondarySubtitle.body).toEqual([]);
    await expect(
      loadTranslatedSubtitleTrack({
        bvid: "BV1session01",
        cid: "100",
        sourceTrackKey: "asr",
        targetLang: "zh-CN",
        translationSig: session.translationSig
      })
    ).resolves.toBeNull();
  });

  it("首分块流式输出后失败时，clipState.secondarySubtitle.body 与会话均回滚为空", async () => {
    const session = createTranslatedTrackSession(
      {
        bvid: "BV1session01",
        cid: "100",
        primaryItems: [{ from: 0, to: 4, content: "Chunk 0" }],
        source: { isAsrSource: true, targetLang: "zh" }
      },
      {
        translateItems: async (input) => {
          input.onCueReady?.({
            startIndex: 0,
            endIndex: 0,
            from: 0,
            to: 4,
            text: "Chunk 0",
            translation: "首块半成品"
          });
          throw new Error("500 upstream error");
        }
      }
    );

    await expect(
      session.translateChunk({
        chunkIndex: 0,
        chunkFromSec: 0,
        chunkToSec: 60,
        items: session.getPrimaryChunk(0)
      })
    ).rejects.toThrow("500 upstream error");

    expect(session.getSecondaryItems()).toEqual([]);
    expect(clipState.secondarySubtitle.body).toEqual([]);
    await session.flush();
    await expect(
      loadTranslatedSubtitleTrack({
        bvid: "BV1session01",
        cid: "100",
        sourceTrackKey: "asr",
        targetLang: "zh-CN",
        translationSig: session.translationSig
      })
    ).resolves.toBeNull();
  });

  it("分块失败时回滚当前分块流式缓冲并保留已完成分块；isStale 拦截过期会话写入", async () => {
    let stale = false;
    let callCount = 0;

    const session = createTranslatedTrackSession(
      {
        bvid: "BV1session01",
        cid: "100",
        primaryItems: [
          { from: 0, to: 4, content: "Chunk 0" },
          { from: 60, to: 64, content: "Chunk 1" },
          { from: 120, to: 124, content: "Chunk 2" }
        ],
        source: { isAsrSource: true, targetLang: "zh" },
        isStale: () => stale
      },
      {
        translateItems: async (input) => {
          callCount += 1;
          if (callCount === 1) {
            return [{ from: 0, to: 4, content: "第零块" }];
          }
          if (callCount === 2) {
            input.onCueReady?.({
              startIndex: 0,
              endIndex: 0,
              from: 60,
              to: 64,
              text: "Chunk 1",
              translation: "半成品流式"
            });
            throw new Error("429 rate limit");
          }
          stale = true;
          input.onCueReady?.({
            startIndex: 0,
            endIndex: 0,
            from: 120,
            to: 124,
            text: "Chunk 2",
            translation: "过期不应写入"
          });
          return [{ from: 120, to: 124, content: "过期不应写入" }];
        }
      }
    );

    const run = (chunk: TranslateSessionChunkInput) => session.translateChunk(chunk);

    await run({ chunkIndex: 0, chunkFromSec: 0, chunkToSec: 60, items: session.getPrimaryChunk(0) });
    await expect(
      run({ chunkIndex: 1, chunkFromSec: 60, chunkToSec: 120, items: session.getPrimaryChunk(1) })
    ).rejects.toThrow("429 rate limit");

    expect(session.isChunkDone(0)).toBe(true);
    expect(session.isChunkDone(1)).toBe(false);
    expect(session.getSecondaryItems()).toEqual([{ from: 0, to: 4, content: "第零块" }]);

    const staleRes = await run({
      chunkIndex: 2,
      chunkFromSec: 120,
      chunkToSec: 180,
      items: session.getPrimaryChunk(2)
    });
    expect(staleRes.status).toBe("aborted");
    expect(session.getSecondaryItems()).toEqual([{ from: 0, to: 4, content: "第零块" }]);
    expect(clipState.secondarySubtitle.body).toEqual([{ from: 0, to: 4, content: "第零块" }]);
  });
});
