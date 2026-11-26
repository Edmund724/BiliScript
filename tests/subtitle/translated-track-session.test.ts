import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import type { SubtitleBodyItem } from "../../extension/ai/types.js";
import type { TranslateSubtitleTrackResult } from "../../extension/ai/subtitle-translate.js";
import type { SubtitleIdbStore } from "../../extension/subtitle/cache.js";
import type {
  TranslateSessionChunkInput,
  TranslatedTrackTranslateInput
} from "../../extension/subtitle/translated-track-session.js";

function asTrackResult(
  translations: SubtitleBodyItem[],
  items: SubtitleBodyItem[] = translations
): TranslateSubtitleTrackResult {
  return { mode: "boundary-v3", items, translations };
}

let idbStore: SubtitleIdbStore;
let state: (typeof import("../../extension/core/state.js"))["state"];
let clipState: (typeof import("../../extension/core/state.js"))["clipState"];
let buildTranslationSignature: (typeof import("../../extension/subtitle/cache.js"))["buildTranslationSignature"];
let configureSubtitleCacheStoreForTests: (typeof import("../../extension/subtitle/cache.js"))["configureSubtitleCacheStoreForTests"];
let loadTranslatedSubtitleTrack: (typeof import("../../extension/subtitle/cache.js"))["loadTranslatedSubtitleTrack"];
let createTranslatedTrackSession: (typeof import("../../extension/subtitle/translated-track-session.js"))["createTranslatedTrackSession"];
let resolveTranslatedTrackSource: (typeof import("../../extension/subtitle/translated-track-session.js"))["resolveTranslatedTrackSource"];

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
  resolveTranslatedTrackSource = sessionMod.resolveTranslatedTrackSource;

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

describe("TranslatedTrackSession deepened interface", () => {
  it("resolveTranslatedTrackSource 统一归一 ASR 伪轨与原生 CC 源轨的槽位、缓存键与协议", () => {
    const asrSession = createTranslatedTrackSession({
      bvid: "BV1session01",
      cid: "100",
      source: resolveTranslatedTrackSource({ isAsrSource: true }, "en")
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
      source: resolveTranslatedTrackSource(
        {
          selectedSubtitleId: "cc-en",
          selectedSubtitleUrl: "https://sub.test/cc-en.json",
          selectedSubtitleLang: "English",
          tracks: [
            {
              id: "cc-en",
              lan: "en-US",
              lanDoc: "English",
              subtitleUrl: "https://sub.test/cc-en.json"
            }
          ]
        },
        "zh"
      )
    });
    expect(ccSession.slotId).toBe("id_cc-en_translate-zh-CN");
    expect(ccSession.sourceKey).toBe("id_cc-en");
    expect(ccSession.canonicalTargetLang).toBe("zh-CN");
    expect(ccSession.legacyCacheKey).toBe(
      "biliscript_subtitle_cache_BV1session01_100_id_cc-en_translate-zh-CN"
    );
    expect(ccSession.protocolMode).toBe("cc-json");
  });

  it("hydrate 缓存全命中时零加载翻译器、写入副轨槽并支持 querySecondaryLine 查询", async () => {
    const primary: SubtitleBodyItem[] = [
      { from: 0, to: 4, content: "Hello world." },
      { from: 5, to: 9, content: "Second line." }
    ];
    const source = resolveTranslatedTrackSource(
      {
        selectedSubtitleId: "cc-en",
        selectedSubtitleUrl: "https://sub.test/cc-en.json",
        tracks: [{ id: "cc-en", lan: "en-US", subtitleUrl: "https://sub.test/cc-en.json" }]
      },
      "zh"
    );
    const expectedSig = buildTranslationSignature({
      model: "Index-Translate-35B-A3B",
      protocolVersion: "cc-json",
      targetLang: "zh-CN",
      sourceText: primary.map((item) => item.content).join("\n")
    });
    await idbStore.upsertTranslatedTrack({
      bvid: "BV1session01",
      cid: "100",
      sourceTrackKey: "id_cc-en",
      targetLang: "zh-CN",
      translationSig: expectedSig,
      mode: "cc-json",
      items: [
        { from: 0, to: 4, content: "你好世界。" },
        { from: 5.5, to: 9, content: "第二句。" }
      ]
    });

    const loadTranslator = vi.fn();
    const session = createTranslatedTrackSession({
      bvid: "BV1session01",
      cid: "100",
      primaryItems: primary,
      source
    });

    const hydrated = await session.hydrate({
      mode: "translate",
      loadTranslator,
      acceptOnHit: true
    });

    expect(hydrated.status).toBe("ready");
    expect(hydrated.pendingChunks).toEqual([]);
    expect(loadTranslator).not.toHaveBeenCalled();
    expect(clipState.secondarySubtitle.state).toBe("ready");
    expect(session.querySecondaryLine(2)).toBe("你好世界。");
    expect(session.querySecondaryLine(5.1, { from: 5, to: 9 })).toBe("第二句。");
  });

  it("hydrate 在签名变化时自动重查缓存并直接就绪，无需重复翻译", async () => {
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
      source: resolveTranslatedTrackSource(
        {
          selectedSubtitleId: "cc-en",
          tracks: [{ id: "cc-en", lan: "en-US", subtitleUrl: "https://sub.test/cc-en.json" }]
        },
        "zh"
      )
    });

    const cacheOnlyRes = await session.hydrate({ mode: "cache-only" });
    expect(cacheOnlyRes.status).toBe("pending");
    expect(clipState.secondarySubtitle.state).toBe("idle");

    const hydrated = await session.hydrate({
      mode: "translate",
      acceptOnHit: true,
      loadTranslator: async () => ({
        model: "gpt-4o-mini",
        resolveProtocolMode: () => "boundary-v3"
      })
    });

    expect(hydrated.status).toBe("ready");
    expect(hydrated.sigChanged).toBe(true);
    expect(session.protocolMode).toBe("boundary-v3");
    expect(session.translationSig).toBe(expectedSig);
    expect(session.querySecondaryLine(1)).toBe("第一句精翻");
    expect(clipState.secondarySubtitle.body).toEqual([{ from: 0, to: 4, content: "第一句精翻" }]);
  });

  it("youtube-auto 轨经 resolveTranslatedTrackSource + hydrate + translateChunk 保持 boundary-v3 与元数据透传", async () => {
    const { resolveSubtitleTranslateProtocolMode } = await import(
      "../../extension/ai/subtitle-translate.js"
    );
    const primary: SubtitleBodyItem[] = [
      { from: 0, to: 3, content: "Hello world." },
      { from: 3, to: 6, content: "How are you?" }
    ];
    const capturedProtocolInputs: Array<{
      selectedSubtitleId?: string;
      origin?: string;
      kind?: string;
      source?: string;
    }> = [];
    const capturedTranslateInputs: TranslatedTrackTranslateInput[] = [];

    const session = createTranslatedTrackSession({
      bvid: "ytAutoId01",
      cid: "yt",
      primaryItems: primary,
      source: resolveTranslatedTrackSource(
        {
          track: {
            id: "custom-yt-track",
            subtitleUrl: "https://www.youtube.com/api/timedtext?v=ytAutoId01",
            lan: "en",
            lanDoc: "English",
            origin: "youtube",
            kind: "asr",
            source: "youtube-auto"
          }
        },
        "zh"
      )
    });

    expect(session.protocolMode).toBe("boundary-v3");
    const sigBefore = session.translationSig;

    const hydrated = await session.hydrate({
      mode: "translate",
      protocolItems: primary,
      loadTranslator: async () => ({
        resolveProtocolMode: (input) => {
          capturedProtocolInputs.push({
            selectedSubtitleId: input.selectedSubtitleId,
            origin: input.origin,
            kind: input.kind,
            source: input.source
          });
          return resolveSubtitleTranslateProtocolMode(input);
        },
        translateTrack: async (input) => {
          capturedTranslateInputs.push(input);
          return asTrackResult(
            input.items.map((item) => ({ ...item, content: `译:${item.content}` })),
            input.items
          );
        }
      })
    });

    expect(hydrated.status).toBe("pending");
    expect(hydrated.sigChanged).toBe(false);
    expect(session.protocolMode).toBe("boundary-v3");
    expect(session.translationSig).toBe(sigBefore);
    expect(capturedProtocolInputs).toEqual([
      {
        selectedSubtitleId: "custom-yt-track",
        origin: "youtube",
        kind: "asr",
        source: "youtube-auto"
      }
    ]);

    await session.translateChunk({
      chunkIndex: 0,
      chunkFromSec: 0,
      chunkToSec: 60
    });
    expect(capturedTranslateInputs).toHaveLength(1);
    expect(capturedTranslateInputs[0]).toMatchObject({
      selectedSubtitleId: "custom-yt-track",
      origin: "youtube",
      kind: "asr",
      source: "youtube-auto"
    });
    expect(session.querySecondaryLine(1)).toBe("译:Hello world.");
  });

  it("相邻前一片（chunkIndex - 1）缺失时，previousLines 回溯取更早已完成分块的双语前情", async () => {
    const chunk0: SubtitleBodyItem[] = [
      { from: 2, to: 5, content: "First sentence" },
      { from: 10, to: 14, content: "Second sentence" },
      { from: 20, to: 25, content: "Third sentence" }
    ];
    const chunk2: SubtitleBodyItem[] = [{ from: 125, to: 130, content: "Later sentence" }];

    const capturedInputs: TranslatedTrackTranslateInput[] = [];
    const session = createTranslatedTrackSession(
      {
        bvid: "BV1session01",
        cid: "100",
        primaryItems: [...chunk0, ...chunk2],
        source: resolveTranslatedTrackSource({ isAsrSource: true }, "zh")
      },
      {
        translateTrack: async (input) => {
          capturedInputs.push(input);
          return asTrackResult(
            input.items.map((item) => ({
              ...item,
              content: `译:${item.content}`
            })),
            input.items
          );
        }
      }
    );

    await session.translateChunk({ chunkIndex: 0, chunkFromSec: 0, chunkToSec: 60 });
    await session.translateChunk({ chunkIndex: 2, chunkFromSec: 120, chunkToSec: 180 });

    expect(capturedInputs).toHaveLength(2);
    expect(capturedInputs[0].previousLines).toBeUndefined();
    expect(capturedInputs[1].previousLines).toEqual([
      { original: "Second sentence", translation: "译:Second sentence" },
      { original: "Third sentence", translation: "译:Third sentence" }
    ]);
  });

  it("流式 onCueReady 即时更新 querySecondaryLine 与防抖缓冲，flush() 立即落入 IndexedDB", async () => {
    const streamingUpdates: Array<{ count: number; cueText: string }> = [];
    let emitCue!: NonNullable<TranslatedTrackTranslateInput["onCueReady"]>;
    let resolveTranslate!: (result: TranslateSubtitleTrackResult) => void;

    const session = createTranslatedTrackSession(
      {
        bvid: "BV1session01",
        cid: "100",
        primaryItems: [{ from: 0, to: 5, content: "Hello" }],
        source: resolveTranslatedTrackSource({ isAsrSource: true }, "zh")
      },
      {
        translateTrack: async (input) => {
          emitCue = input.onCueReady!;
          return new Promise<TranslateSubtitleTrackResult>((resolve) => {
            resolveTranslate = resolve;
          });
        },
        onStreamingUpdate: ({ items, cue }) => {
          streamingUpdates.push({ count: items.length, cueText: cue.content });
        }
      }
    );

    const pending = session.translateChunk({ chunkIndex: 0, chunkFromSec: 0, chunkToSec: 60 });

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
    expect(session.querySecondaryLine(2)).toBe("你好");
    expect(clipState.secondarySubtitle.body).toEqual([{ from: 0, to: 5, content: "你好" }]);

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

    resolveTranslate(asTrackResult([{ from: 0, to: 5, content: "你好" }]));
    await pending;
  });

  it("invalidateChunk 与 setPrimaryChunk 递增修订版，拦截旧版流式与完成写入", async () => {
    let emitCue!: NonNullable<TranslatedTrackTranslateInput["onCueReady"]>;
    let resolveFirst!: (result: TranslateSubtitleTrackResult) => void;

    const session = createTranslatedTrackSession(
      {
        bvid: "BV1session01",
        cid: "100",
        source: resolveTranslatedTrackSource({ isAsrSource: true }, "zh")
      },
      {
        translateTrack: async (input) => {
          emitCue = input.onCueReady!;
          return new Promise<TranslateSubtitleTrackResult>((resolve) => {
            resolveFirst = resolve;
          });
        }
      }
    );

    session.setPrimaryChunk(0, [{ from: 0, to: 4, content: "Draft ASR" }]);
    const firstRun = session.translateChunk({ chunkIndex: 0, chunkFromSec: 0, chunkToSec: 60 });

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
    expect(session.querySecondaryLine(2)).toBe("");

    resolveFirst(asTrackResult([{ from: 0, to: 4, content: "旧修订版终态" }]));
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

  it("分块失败时回滚当前分块流式缓冲并保持 querySecondaryLine 与已完成分块一致；isStale 拦截过期写入", async () => {
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
        source: resolveTranslatedTrackSource({ isAsrSource: true }, "zh"),
        isStale: () => stale
      },
      {
        translateTrack: async (input) => {
          callCount += 1;
          if (callCount === 1) {
            return asTrackResult([{ from: 0, to: 4, content: "第零块" }]);
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
          return asTrackResult([{ from: 120, to: 124, content: "过期不应写入" }]);
        }
      }
    );

    const run = (chunk: TranslateSessionChunkInput) => session.translateChunk(chunk);

    await run({ chunkIndex: 0, chunkFromSec: 0, chunkToSec: 60 });
    await expect(
      run({ chunkIndex: 1, chunkFromSec: 60, chunkToSec: 120 })
    ).rejects.toThrow("429 rate limit");

    expect(session.isChunkDone(0)).toBe(true);
    expect(session.isChunkDone(1)).toBe(false);
    expect(session.querySecondaryLine(2)).toBe("第零块");
    expect(session.querySecondaryLine(62, { from: 60, to: 64 })).toBe("");

    const staleRes = await run({ chunkIndex: 2, chunkFromSec: 120, chunkToSec: 180 });
    expect(staleRes.status).toBe("aborted");
    expect(session.getSecondaryItems()).toEqual([{ from: 0, to: 4, content: "第零块" }]);
    expect(clipState.secondarySubtitle.body).toEqual([{ from: 0, to: 4, content: "第零块" }]);
  });

  it("首分块流式输出后失败时，副轨槽、缓存与 querySecondaryLine 均回滚为空", async () => {
    const session = createTranslatedTrackSession(
      {
        bvid: "BV1session01",
        cid: "100",
        primaryItems: [{ from: 0, to: 4, content: "Chunk 0" }],
        source: resolveTranslatedTrackSource({ isAsrSource: true }, "zh")
      },
      {
        translateTrack: async (input) => {
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
      session.translateChunk({ chunkIndex: 0, chunkFromSec: 0, chunkToSec: 60 })
    ).rejects.toThrow("500 upstream error");

    expect(session.querySecondaryLine(2)).toBe("");
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

  it("流式 acceptSecondarySubtitle 与回滚持久化：STALE_RUN 静默忽略，非 STALE_RUN 错误记 logWarn", async () => {
    const logging = await import("../../extension/shared/logging.js");
    logging.registerDebugGate(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      let emitCue!: NonNullable<TranslatedTrackTranslateInput["onCueReady"]>;
      let resolveTranslate!: (result: TranslateSubtitleTrackResult) => void;

      const staleStreamSession = createTranslatedTrackSession(
        {
          bvid: "BV1session01",
          cid: "100",
          runId: 1,
          primaryItems: [{ from: 0, to: 5, content: "Hello" }],
          source: resolveTranslatedTrackSource({ isAsrSource: true }, "zh")
        },
        {
          translateTrack: async (input) => {
            emitCue = input.onCueReady!;
            return new Promise<TranslateSubtitleTrackResult>((resolve) => {
              resolveTranslate = resolve;
            });
          }
        }
      );

      const p1 = staleStreamSession.translateChunk({ chunkIndex: 0, chunkFromSec: 0, chunkToSec: 60 });
      await vi.advanceTimersByTimeAsync(10);
      clipState.setFetchRunId(2);
      emitCue({
        startIndex: 0,
        endIndex: 0,
        from: 0,
        to: 5,
        text: "Hello",
        translation: "你好"
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(warnSpy).not.toHaveBeenCalled();

      clipState.setFetchRunId(1);
      const staleRollbackSession = createTranslatedTrackSession(
        {
          bvid: "BV1session01",
          cid: "100",
          runId: 1,
          primaryItems: [{ from: 0, to: 5, content: "Hello" }],
          source: resolveTranslatedTrackSource({ isAsrSource: true }, "zh")
        },
        {
          translateTrack: async (input) => {
            input.onCueReady?.({
              startIndex: 0,
              endIndex: 0,
              from: 0,
              to: 5,
              text: "Hello",
              translation: "半成品"
            });
            clipState.setFetchRunId(2);
            throw new Error("translate failed after run switched");
          }
        }
      );

      await expect(
        staleRollbackSession.translateChunk({ chunkIndex: 0, chunkFromSec: 0, chunkToSec: 60 })
      ).rejects.toThrow("translate failed after run switched");
      expect(warnSpy).not.toHaveBeenCalled();

      resolveTranslate(asTrackResult([]));
      await p1.catch(() => {});

      vi.resetModules();
      vi.doMock("../../extension/subtitle/commit.js", async (importOriginal) => {
        const actual = await importOriginal<typeof import("../../extension/subtitle/commit.js")>();
        return {
          ...actual,
          acceptSecondarySubtitle: vi
            .fn()
            .mockRejectedValueOnce(new Error("streaming slot write failed"))
            .mockRejectedValueOnce(new Error("rollback slot write failed"))
        };
      });
      const freshStateMod = await import("../../extension/core/state.js");
      const freshCacheMod = await import("../../extension/subtitle/cache.js");
      const freshSessionMod = await import("../../extension/subtitle/translated-track-session.js");
      const freshLogging = await import("../../extension/shared/logging.js");
      freshLogging.registerDebugGate(() => true);

      freshCacheMod.configureSubtitleCacheStoreForTests(idbStore);
      freshStateMod.state.setSettings({ ...DEFAULT_SETTINGS, subtitleTranslateModel: "Index-Translate-35B-A3B" });
      freshStateMod.clipState.setBvid("BV1session01");
      freshStateMod.clipState.setCid("100");
      freshStateMod.clipState.setFetchRunId(1);

      const errSession = freshSessionMod.createTranslatedTrackSession(
        {
          bvid: "BV1session01",
          cid: "100",
          runId: 1,
          primaryItems: [{ from: 0, to: 5, content: "Hello" }],
          source: freshSessionMod.resolveTranslatedTrackSource({ isAsrSource: true }, "zh")
        },
        {
          translateTrack: async (input) => {
            input.onCueReady?.({
              startIndex: 0,
              endIndex: 0,
              from: 0,
              to: 5,
              text: "Hello",
              translation: "半成品"
            });
            await vi.advanceTimersByTimeAsync(10);
            throw new Error("500 upstream error");
          }
        }
      );

      await expect(
        errSession.translateChunk({ chunkIndex: 0, chunkFromSec: 0, chunkToSec: 60 })
      ).rejects.toThrow("500 upstream error");

      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenNthCalledWith(
        1,
        "[BILISCRIPT] failed to accept streaming secondary subtitle",
        expect.objectContaining({
          bvid: "BV1session01",
          cid: "100",
          chunkIndex: 0,
          error: expect.objectContaining({ message: "streaming slot write failed" })
        })
      );
      expect(warnSpy).toHaveBeenNthCalledWith(
        2,
        "[BILISCRIPT] failed to rollback translated subtitle chunk",
        expect.objectContaining({
          bvid: "BV1session01",
          cid: "100",
          chunkIndex: 0,
          error: expect.objectContaining({ message: "rollback slot write failed" })
        })
      );

      warnSpy.mockClear();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const upsertSpy = vi
        .spyOn(idbStore, "upsertTranslatedTrack")
        .mockRejectedValueOnce(new Error("idb rollback disk full"));
      try {
        await expect(
          errSession.translateChunk({ chunkIndex: 0, chunkFromSec: 0, chunkToSec: 60 })
        ).rejects.toThrow("500 upstream error");

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          "[BILISCRIPT] failed to rollback translated subtitle cache",
          expect.objectContaining({
            bvid: "BV1session01",
            cid: "100",
            chunkIndex: 0,
            error: expect.objectContaining({ message: "idb rollback disk full" })
          })
        );
      } finally {
        upsertSpy.mockRestore();
        errorSpy.mockRestore();
      }
    } finally {
      vi.doUnmock("../../extension/subtitle/commit.js");
      warnSpy.mockRestore();
      logging.registerDebugGate(() => false);
    }
  });
});
