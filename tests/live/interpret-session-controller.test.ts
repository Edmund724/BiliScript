// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { state, clipState } from "../../extension/core/state.js";
import { acceptSecondarySubtitle, acceptSubtitle } from "../../extension/subtitle/commit.js";
import {
  buildTranslationSignature,
  configureSubtitleCacheStoreForTests,
  createSubtitleIdbStore
} from "../../extension/subtitle/cache.js";
import {
  createInterpretSessionController,
  PAUSE_TIMEOUT_MS
} from "../../extension/live/interpret-session-controller.js";
import type { SubtitleBodyItem } from "../../extension/core/state.js";
import type { TranslateSubtitleTrackResult } from "../../extension/ai/subtitle-translate.js";
import type { LiveInterpretTargetLang } from "../../extension/live/interpret-subtitle-preferences.js";
import { contentEventBus } from "../../extension/shared/content-event-bus.js";

function asTrackResult(
  translations: SubtitleBodyItem[],
  items: SubtitleBodyItem[] = translations
): TranslateSubtitleTrackResult {
  return { mode: "boundary-v3", items, translations };
}

beforeEach(() => {
  resetModuleState();
  vi.useRealTimers();
  state.setSettings({ ...DEFAULT_SETTINGS });
  clipState.setBvid("BV1test000000");
  clipState.setCid("123456");
  clipState.setVideoDuration(300);
  clipState.setSubtitleBody([]);
  clipState.setSubtitleFetchState("idle");
  clipState.clearSecondarySubtitle();
  clipState.setSubtitles([]);
});

afterEach(() => {
  configureSubtitleCacheStoreForTests(null);
  vi.restoreAllMocks();
});

describe("InterpretSessionController (深化命令接口与 4 端口)", () => {
  function setupTest(overrides: {
    runAsr?: (args: any) => Promise<any>;
    translateTrack?: (args: any) => Promise<TranslateSubtitleTrackResult>;
    loadCache?: (key: string) => Promise<SubtitleBodyItem[] | null>;
    saveCache?: (key: string, body: unknown[]) => Promise<any>;
    clearTranslatedCache?: (args: { bvid: string; cid: string }) => Promise<string[]>;
    resolveTranslateProvider?: () => Promise<any>;
    loadNativePrimaryTrack?: (track: { id: string; url: string; lang: string }) => Promise<void>;
    loadNativeSecondaryTrack?: (track: { id: string; url: string; lang: string }) => Promise<void>;
    currentTime?: number;
    paused?: boolean;
  } = {}) {
    const video = document.createElement("video");
    let currentTimeVal = overrides.currentTime ?? 0;
    Object.defineProperty(video, "currentTime", {
      get: () => currentTimeVal,
      set: (v: number) => {
        currentTimeVal = v;
      },
      configurable: true
    });
    let pausedVal = overrides.paused ?? false;
    Object.defineProperty(video, "paused", {
      get: () => pausedVal,
      set: (v: boolean) => {
        pausedVal = v;
      },
      configurable: true
    });

    const showNotice = vi.fn();
    const setSubtitle = vi.fn();
    const clear = vi.fn();
    const clearForSeek = vi.fn();
    const syncAppearance = vi.fn();
    const setSessionGeneration = vi.fn();
    const onStateChange = vi.fn();
    const onAvailabilityChange = vi.fn();
    const saveSettings = vi.fn();

    const runAsr = overrides.runAsr || vi.fn(async () => []);
    const translateTrack = vi.fn(
      overrides.translateTrack ||
        (async ({ items, targetLang }) => {
          const list = items || [];
          return asTrackResult(
            list.map((it: any) => ({
              from: it.from,
              to: it.to,
              content: targetLang && targetLang !== "zh" ? `[${targetLang}] ${it.content}` : `译: ${it.content}`
            })),
            list
          );
        })
    );
    const cacheStorage = new Map<string, unknown[]>();
    const loadCache =
      overrides.loadCache ||
      vi.fn(async (key: string) => (cacheStorage.get(key) as SubtitleBodyItem[] | undefined) || null);
    const saveCache =
      overrides.saveCache ||
      vi.fn(async (key: string, body: unknown[]) => {
        cacheStorage.set(key, body);
        return { ok: true };
      });
    const clearTranslatedCache = overrides.clearTranslatedCache || vi.fn(async () => []);
    const resolveTranslateProvider =
      overrides.resolveTranslateProvider ||
      vi.fn(async () => ({
        provider: {
          id: "test-ai",
          name: "Test AI",
          baseUrl: "https://api.test",
          models: ["m1"],
          enabled: true
        },
        apiKey: "sk-test",
        baseUrl: "https://api.test",
        model: "m1",
        presetId: "custom",
        isFallback: false
      }));
    const loadAsrProviders = vi.fn(async () => [
      { id: "mock-asr", name: "Mock ASR", enabled: true, hasSavedKey: true, model: "whisper-1" }
    ]);

    const controller = createInterpretSessionController({
      video: { getElement: () => video },
      overlay: {
        setSubtitle,
        clear,
        clearForSeek,
        showNotice,
        syncAppearance,
        setSessionGeneration,
        onStateChange,
        onAvailabilityChange
      },
      storage: {
        loadCache,
        saveCache,
        clearTranslatedCache,
        saveSettings
      },
      media: {
        runAsr,
        translateTrack,
        resolveTranslateProvider,
        loadAsrProviders,
        loadNativePrimaryTrack: overrides.loadNativePrimaryTrack,
        loadNativeSecondaryTrack: overrides.loadNativeSecondaryTrack
      }
    });

    const startTranslate = (
      targetLang: LiveInterpretTargetLang = "zh",
      displayMode: "bilingual" | "translation" = "bilingual"
    ) => controller.applyMode({ kind: "translate", displayMode, targetLang });

    return {
      controller,
      startTranslate,
      video,
      showNotice,
      setSubtitle,
      clear,
      clearForSeek,
      syncAppearance,
      setSessionGeneration,
      onStateChange,
      onAvailabilityChange,
      saveSettings,
      runAsr,
      translateItems: translateTrack,
      loadCache,
      saveCache,
      clearTranslatedCache,
      resolveTranslateProvider,
      cacheStorage
    };
  }

  describe("可用性检查 refreshAvailability", () => {
    it("AI 翻译平台异常时返回错误", async () => {
      const { controller } = setupTest({
        resolveTranslateProvider: vi.fn(async () => {
          throw new Error("未配置 AI 平台");
        })
      });

      const res = await controller.refreshAvailability();
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain("未配置 AI 平台");
      }
    });

    it("内存已有主轨时跳过 ASR 平台检查", async () => {
      clipState.setSubtitleBody([{ from: 0, to: 5, content: "原文" }]);
      clipState.setSubtitleFetchState("ready");

      const { controller } = setupTest();
      const res = await controller.refreshAvailability();
      expect(res.ok).toBe(true);
    });

    it("零 API Key 新用户默认走免 Key Index-Translate 通过可用性检查；切回未填 Key 自定义平台时提示配置", async () => {
      clipState.setSubtitleBody([{ from: 0, to: 5, content: "Hello" }]);
      clipState.setSubtitleFetchState("ready");

      const { resolveSubtitleTranslateProvider } = await import("../../extension/ai/subtitle-translate.js");
      let settingsState: Record<string, unknown> = {};
      const customProviders = [
        {
          id: "deepseek",
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          models: ["deepseek-chat"],
          requiresKey: true,
          hasSavedKey: false,
          enabled: true
        }
      ];

      const { controller } = setupTest({
        resolveTranslateProvider: () =>
          resolveSubtitleTranslateProvider({
            getSettings: async () => settingsState,
            loadProviders: async () => customProviders,
            loadKeys: async () => ({})
          })
      });

      const defaultRes = await controller.refreshAvailability();
      expect(defaultRes).toEqual({ ok: true });

      settingsState = { subtitleTranslateProviderId: "deepseek", subtitleTranslateModel: "deepseek-chat" };
      const customMissingKeyRes = await controller.refreshAvailability();
      expect(customMissingKeyRes.ok).toBe(false);
      if (!customMissingKeyRes.ok) {
        expect(customMissingKeyRes.error).toContain("该平台 API Key 未配置");
      }
    });

    it("缺省依赖下通过 SW asr-providers-list 与 get-settings 解析 ASR 平台，不直读 chrome.storage 密钥", async () => {
      const storageLocalGetSpy = vi.spyOn(chrome.storage.local, "get");
      const storageSyncGetSpy = vi.spyOn(chrome.storage.sync, "get");
      vi.spyOn(chrome.runtime, "sendMessage").mockImplementation(
        (message: any, callback?: (res: unknown) => void) => {
          if (message?.type === "resolve-subtitle-translate-provider") {
            callback?.({
              ok: true,
              provider: { id: "mock-ai", name: "Mock AI", baseUrl: "https://api.mock", models: ["m1"], enabled: true },
              apiKey: "sk-mock",
              model: "m1",
              isFallback: false
            });
            return undefined;
          }
          if (message?.type === "asr-providers-list") {
            callback?.({
              ok: true,
              providers: [
                { id: "asr-1", name: "ASR 1", enabled: true, hasSavedKey: false, model: "whisper-1" },
                { id: "asr-2", name: "ASR 2", enabled: true, hasSavedKey: true, model: "whisper-2" }
              ]
            });
            return undefined;
          }
          if (message?.type === "get-settings") {
            callback?.({
              ok: true,
              settings: { activeAsrProviderId: "asr-2", asrLanguage: "en" }
            });
            return undefined;
          }
          callback?.({ ok: true });
          return undefined;
        }
      );

      const controller = createInterpretSessionController();
      const res = await controller.refreshAvailability();
      expect(res).toEqual({ ok: true });
      expect(storageLocalGetSpy).not.toHaveBeenCalled();
      expect(storageSyncGetSpy).not.toHaveBeenCalled();
      controller.dispose();
    });
  });

  describe("模式切换、重启编排与跨视频自动复位", () => {
    it("原生双语 -> AI 精翻 -> 返回原生双语，以及跨视频自动复位 aiRefineMode", async () => {
      const enTrack = {
        id: "cc-en",
        lan: "en-US",
        lanDoc: "English",
        subtitleUrl: "https://sub.test/en.json",
        source: "player" as const
      };
      const zhTrack = {
        id: "cc-zh",
        lan: "zh-CN",
        lanDoc: "中文（简体）",
        subtitleUrl: "https://sub.test/zh.json",
        source: "player" as const
      };
      clipState.setSubtitles([enTrack, zhTrack] as never);
      await acceptSubtitle({
        body: [{ from: 0, to: 10, content: "Hello world" }],
        selectedSubtitleId: enTrack.id,
        selectedSubtitleUrl: enTrack.subtitleUrl,
        selectedSubtitleLang: enTrack.lanDoc,
        skipHotComments: true
      });

      const { controller, translateItems, setSubtitle } = setupTest({
        currentTime: 2,
        loadNativeSecondaryTrack: async (target) => {
          await acceptSecondarySubtitle({
            body: [{ from: 0, to: 10, content: "原生中文" }],
            subtitleId: target.id,
            subtitleUrl: target.url
          });
        }
      });

      expect(controller.getSnapshot().nativePairAvailable).toBe(true);
      expect(controller.getSnapshot().aiRefineMode).toBe("off");

      expect(await controller.applyMode("native-bilingual")).toBe(true);
      expect(controller.getSnapshot().state).toBe("connected");
      expect(translateItems).not.toHaveBeenCalled();
      expect(setSubtitle).toHaveBeenLastCalledWith("Hello world", "原生中文", expect.any(Number));

      expect(await controller.applyMode({ kind: "ai-refine", refineMode: "manual-refine" })).toBe(true);
      expect(controller.getSnapshot().aiRefineMode).toBe("manual-refine");
      await vi.waitFor(() => expect(translateItems).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(setSubtitle).toHaveBeenLastCalledWith("Hello world", "译: Hello world", expect.any(Number))
      );

      clipState.setBvid("BV1nextVideo00");
      contentEventBus.emit("host:url-change", { url: location.href });
      expect(controller.getSnapshot().state).toBe("idle");
      expect(controller.getSnapshot().aiRefineMode).toBe("off");
    });

    it("同语种切 displayMode 仅触发 syncAppearance 不重启；切换目标语种自动重启翻译", async () => {
      clipState.setSubtitleBody([{ from: 0, to: 10, content: "Hello" }]);
      clipState.setSubtitleFetchState("ready");

      const { controller, startTranslate, syncAppearance, translateItems } = setupTest({ currentTime: 2 });

      expect(await startTranslate("zh", "bilingual")).toBe(true);
      await vi.waitFor(() => expect(translateItems).toHaveBeenCalledTimes(1));
      const genAfterStart = controller.getSnapshot().generation;

      await controller.applyMode({ kind: "translate", displayMode: "translation", targetLang: "zh" });
      expect(syncAppearance).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().generation).toBe(genAfterStart);
      expect(translateItems).toHaveBeenCalledTimes(1);

      await controller.applyMode({ kind: "translate", displayMode: "bilingual", targetLang: "ja" });
      expect(controller.getSnapshot().generation).toBeGreaterThan(genAfterStart);
      await vi.waitFor(() => expect(translateItems).toHaveBeenCalledTimes(2));
      expect(translateItems.mock.calls[1]?.[0]).toMatchObject({ targetLang: "ja" });
    });
  });

  describe("缓存命中短路与签名重查", () => {
    it("主轨与副轨全命中时零网络请求挂载并渲染", async () => {
      const primaryMock: SubtitleBodyItem[] = [
        { from: 0, to: 10, content: "Hello chunk 0" },
        { from: 65, to: 75, content: "Hello chunk 1" }
      ];
      const secondaryMock: SubtitleBodyItem[] = [
        { from: 0, to: 10, content: "你好 分片 0" },
        { from: 65, to: 75, content: "你好 分片 1" }
      ];

      const { controller, startTranslate, runAsr, translateItems, setSubtitle } = setupTest({
        loadCache: vi.fn(async (key: string) => {
          if (key.includes("id_asr:")) return primaryMock;
          if (key.includes("translate-")) return secondaryMock;
          return null;
        }),
        currentTime: 5
      });

      const started = await startTranslate("zh", "bilingual");
      expect(started).toBe(true);
      expect(controller.getSnapshot().state).toBe("connected");
      expect(runAsr).not.toHaveBeenCalled();
      expect(translateItems).not.toHaveBeenCalled();

      expect(state.clip.subtitleBody).toEqual(primaryMock);
      expect(state.clip.secondarySubtitle.body).toEqual(secondaryMock);
      expect(state.clip.selectedSubtitleId).toBe("asr");
      expect(setSubtitle).toHaveBeenCalledWith("Hello chunk 0", "你好 分片 0", expect.any(Number));
    });

    it("ASR 主轨部分命中且翻译器加载后签名变化时，自动重查精确签名缓存跳过重复翻译", async () => {
      const idbStore = createSubtitleIdbStore({ indexedDB: null });
      configureSubtitleCacheStoreForTests(idbStore);

      const primaryMock: SubtitleBodyItem[] = [
        { from: 0, to: 10, content: "Chunk 0 line." },
        { from: 65, to: 75, content: "Chunk 1 line." }
      ];
      clipState.setSubtitleBody(primaryMock);
      clipState.setSubtitleFetchState("ready");

      const sourceText = primaryMock.map((i) => i.content).join("\n");
      const oldSig = buildTranslationSignature({
        model: "m1",
        protocolVersion: "boundary-v3",
        targetLang: "zh-CN",
        sourceText
      });
      const newSig = buildTranslationSignature({
        model: "m1",
        protocolVersion: "cc-json",
        targetLang: "zh-CN",
        sourceText
      });

      await idbStore.upsertTranslatedTrack({
        bvid: "BV1test000000",
        cid: "123456",
        sourceTrackKey: "asr",
        targetLang: "zh-CN",
        translationSig: oldSig,
        mode: "boundary-v3",
        items: [{ from: 0, to: 10, content: "旧签名仅分片0" }]
      });
      await idbStore.upsertTranslatedTrack({
        bvid: "BV1test000000",
        cid: "123456",
        sourceTrackKey: "asr",
        targetLang: "zh-CN",
        translationSig: newSig,
        mode: "cc-json",
        items: [
          { from: 0, to: 10, content: "新签名分片0" },
          { from: 65, to: 75, content: "新签名分片1" }
        ]
      });

      const translateSpy = vi.fn();
      vi.doMock("../../extension/ai/subtitle-translate.js", async () => {
        const actual = await vi.importActual<typeof import("../../extension/ai/subtitle-translate.js")>(
          "../../extension/ai/subtitle-translate.js"
        );
        return {
          ...actual,
          resolveSubtitleTranslateProtocolMode: () => "cc-json" as const,
          translateSubtitleTrack: translateSpy
        };
      });

      try {
        vi.resetModules();
        const freshCache = await import("../../extension/subtitle/cache.js");
        const freshState = await import("../../extension/core/state.js");
        const freshCtrl = await import("../../extension/live/interpret-session-controller.js");
        freshCache.configureSubtitleCacheStoreForTests(idbStore);
        freshState.state.setSettings({ ...DEFAULT_SETTINGS });
        freshState.clipState.setBvid("BV1test000000");
        freshState.clipState.setCid("123456");
        freshState.clipState.setSubtitleBody(primaryMock);
        freshState.clipState.setSubtitleFetchState("ready");

        const video = document.createElement("video");
        Object.defineProperty(video, "currentTime", { value: 68, writable: true, configurable: true });
        const setSubtitle = vi.fn();

        const controller = freshCtrl.createInterpretSessionController({
          video: { getElement: () => video },
          overlay: { setSubtitle, clear: vi.fn() },
          storage: { saveSettings: vi.fn() },
          media: {
            resolveTranslateProvider: vi.fn(async () => ({
              provider: { id: "test-ai", name: "Test AI", baseUrl: "https://api.test", models: ["m1"], enabled: true },
              apiKey: "sk-test",
              baseUrl: "https://api.test",
              model: "m1",
              presetId: "custom",
              isFallback: false
            })) as never,
            loadAsrProviders: vi.fn(async () => [
              { id: "mock-asr", name: "Mock ASR", enabled: true, hasSavedKey: true, model: "whisper-1" }
            ])
          }
        });

        expect(
          await controller.applyMode({ kind: "translate", displayMode: "bilingual", targetLang: "zh" })
        ).toBe(true);
        expect(translateSpy).not.toHaveBeenCalled();
        expect(setSubtitle).toHaveBeenCalledWith("Chunk 1 line.", "新签名分片1", expect.any(Number));
        controller.dispose();
      } finally {
        vi.doUnmock("../../extension/ai/subtitle-translate.js");
      }
    });

    it("主轨已就绪仅缺译文时跳过 ASR，按窗口调度 LLM 翻译", async () => {
      const primaryMock: SubtitleBodyItem[] = [
        { from: 0, to: 10, content: "Sentence 1" },
        { from: 65, to: 75, content: "Sentence 2" }
      ];
      clipState.setSubtitleBody(primaryMock);
      clipState.setSubtitleFetchState("ready");

      const { startTranslate, runAsr, translateItems } = setupTest({ currentTime: 0 });

      expect(await startTranslate("zh", "bilingual")).toBe(true);
      expect(runAsr).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(translateItems).toHaveBeenCalledTimes(2));
      expect(translateItems).toHaveBeenCalledWith(
        expect.objectContaining({ fallbackToOriginal: false })
      );
    });
  });

  describe("游标窗口推进与 Seek 重排", () => {
    it("Seek 到新分片时若已完成则零延迟立即渲染", async () => {
      const primaryMock: SubtitleBodyItem[] = [
        { from: 0, to: 10, content: "P0" },
        { from: 130, to: 140, content: "P2" }
      ];
      const secondaryMock: SubtitleBodyItem[] = [
        { from: 0, to: 10, content: "S0" },
        { from: 130, to: 140, content: "S2" }
      ];

      const { startTranslate, video, setSubtitle, clearForSeek } = setupTest({
        loadCache: vi.fn(async (key: string) => {
          if (key.includes("id_asr:")) return primaryMock;
          if (key.includes("translate-")) return secondaryMock;
          return null;
        }),
        currentTime: 0
      });

      await startTranslate("zh", "bilingual");
      expect(setSubtitle).toHaveBeenCalledWith("P0", "S0", expect.any(Number));

      video.currentTime = 135;
      video.dispatchEvent(new Event("seeking"));

      expect(clearForSeek).toHaveBeenCalled();
      expect(setSubtitle).toHaveBeenCalledWith("P2", "S2", expect.any(Number));
    });

    it("Seek 到未就绪分片时给出轻量提示并推进调度", async () => {
      clipState.setSubtitleBody([
        { from: 0, to: 10, content: "P0" },
        { from: 250, to: 260, content: "P4" }
      ]);
      clipState.setSubtitleFetchState("ready");

      const { startTranslate, video, showNotice, translateItems } = setupTest({ currentTime: 0 });

      await startTranslate("zh", "bilingual");
      translateItems.mockClear();

      video.currentTime = 255;
      video.dispatchEvent(new Event("seeking"));

      expect(showNotice).toHaveBeenCalledWith("正在转写并翻译字幕...", 2000);
      expect(translateItems).toHaveBeenCalled();
    });
  });

  describe("增量主/副轨合并与热评防重", () => {
    it("分片逐片到达时增量合入主/副轨并落盘缓存；新 ASR 主轨持久化时仅失效旧译文一次", async () => {
      let chunkCb: any = null;
      const callOrder: string[] = [];
      const saveCache = vi.fn(async () => {
        callOrder.push("saveCache");
        return { ok: true };
      });
      const clearTranslatedCache = vi.fn(async () => {
        callOrder.push("clearTranslatedCache");
        return [];
      });
      const { startTranslate, runAsr } = setupTest({
        saveCache,
        clearTranslatedCache,
        runAsr: vi.fn(async (args: any) => {
          chunkCb = args.onChunkResult;
        })
      });

      await startTranslate("zh", "bilingual");
      expect(runAsr).toHaveBeenCalled();
      expect(chunkCb).toBeDefined();

      await chunkCb(
        { index: 0, startSec: 0, durationSec: 60, result: { text: "Chunk 0 ASR" } },
        [{ from: 0, to: 10, content: "Chunk 0 ASR" }]
      );

      expect(state.clip.subtitleBody).toEqual([{ from: 0, to: 10, content: "Chunk 0 ASR" }]);
      expect(state.clip.secondarySubtitle.body).toEqual([
        { from: 0, to: 10, content: "译: Chunk 0 ASR" }
      ]);
      expect(saveCache).toHaveBeenCalledTimes(2);
      expect(clearTranslatedCache).toHaveBeenCalledTimes(1);
      expect(clearTranslatedCache).toHaveBeenCalledWith({ bvid: "BV1test000000", cid: "123456" });
      expect(callOrder).toEqual(["saveCache", "clearTranslatedCache", "saveCache"]);

      await chunkCb(
        { index: 1, startSec: 60, durationSec: 60, result: { text: "Chunk 1 ASR" } },
        [{ from: 60, to: 70, content: "Chunk 1 ASR" }]
      );
      expect(clearTranslatedCache).toHaveBeenCalledTimes(1);
    });

    it("主轨已存在（只走翻译路径）时不失效其他语言的译文缓存", async () => {
      clipState.setSubtitleBody([{ from: 0, to: 10, content: "Existing ASR" }]);
      clipState.setSubtitleFetchState("ready");
      const { startTranslate, clearTranslatedCache, saveCache } = setupTest();

      await startTranslate("ja", "bilingual");
      await vi.waitFor(() => expect(saveCache).toHaveBeenCalled());
      expect(clearTranslatedCache).not.toHaveBeenCalled();
    });
  });

  describe("中止与清理", () => {
    it("applyMode('off') 清理浮层与监听，保留已有缓存", async () => {
      const { controller, startTranslate, clear, setSubtitle, onStateChange } = setupTest();
      await startTranslate("zh", "bilingual");
      expect(controller.getSnapshot().state).toBe("connected");

      await controller.applyMode("off");
      expect(controller.getSnapshot().state).toBe("idle");
      expect(clear).toHaveBeenCalled();
      expect(setSubtitle).toHaveBeenCalledWith("", "", expect.any(Number));
      expect(onStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ state: "idle" }));
    });

    it("暂停超过 5 分钟自动关闭并提示", async () => {
      vi.useFakeTimers();
      const { controller, startTranslate, video, showNotice } = setupTest();
      await startTranslate("zh", "bilingual");

      (video as any).paused = true;
      video.dispatchEvent(new Event("pause"));

      vi.advanceTimersByTime(PAUSE_TIMEOUT_MS - 1000);
      expect(controller.getSnapshot().state).toBe("connected");

      vi.advanceTimersByTime(2000);
      expect(controller.getSnapshot().state).toBe("idle");
      expect(showNotice).toHaveBeenCalledWith("视频暂停超过 5 分钟，实时翻译已自动关闭", 6000);
    });

    it("页面切换/URL 改变自动中止当前会话", async () => {
      const { controller, startTranslate } = setupTest();
      await startTranslate("zh", "bilingual");
      expect(controller.getSnapshot().state).toBe("connected");

      clipState.setBvid("BV1newVideo999");
      contentEventBus.emit("host:url-change", { url: location.href });

      expect(controller.getSnapshot().state).toBe("idle");
    });

    it("单片翻译失败后进入 15s 冷却期并提示，期间 timeupdate 不重复风暴重试；超时后可重试", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-15T00:00:00Z"));
      clipState.setSubtitleBody([{ from: 0, to: 5, content: "Hello" }]);
      clipState.setSubtitleFetchState("ready");

      let calls = 0;
      const { startTranslate, video, showNotice, translateItems } = setupTest({
        translateTrack: async ({ items }) => {
          calls += 1;
          if (calls === 1) throw new Error("rate limit");
          const list = items || [];
          return asTrackResult(
            list.map((it: any) => ({ ...it, content: `译: ${it.content}` })),
            list
          );
        }
      });

      await startTranslate("zh", "bilingual");
      await vi.waitFor(() =>
        expect(showNotice).toHaveBeenCalledWith("当前片段字幕翻译失败，将保留原文", 3000)
      );
      expect(translateItems).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5_000);
      video.currentTime = 1;
      video.dispatchEvent(new Event("timeupdate"));
      video.currentTime = 2;
      video.dispatchEvent(new Event("timeupdate"));
      await Promise.resolve();
      expect(translateItems).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(11_000);
      video.currentTime = 3;
      video.dispatchEvent(new Event("timeupdate"));
      await vi.waitFor(() => expect(translateItems).toHaveBeenCalledTimes(2));
    });

    it("空间隙期间无主轨时节流每 2s 至多提示一次", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-15T00:00:00Z"));

      const { startTranslate, video, showNotice } = setupTest({
        runAsr: async () => new Promise(() => {})
      });
      await startTranslate("zh", "bilingual");
      showNotice.mockClear();

      video.currentTime = 1;
      video.dispatchEvent(new Event("timeupdate"));
      video.currentTime = 2;
      video.dispatchEvent(new Event("timeupdate"));
      expect(showNotice).toHaveBeenCalledTimes(1);
      expect(showNotice).toHaveBeenCalledWith("正在转写并翻译字幕...", 2000);

      vi.advanceTimersByTime(2500);
      video.currentTime = 3;
      video.dispatchEvent(new Event("timeupdate"));
      expect(showNotice).toHaveBeenCalledTimes(2);
    });
  });

  describe("流式逐句上屏与浮层防闪烁校验", () => {
    it("当前分片流式 cue 命中播放激活项时立即局部刷新浮层，后台预载分片返回不触发浮层闪烁", async () => {
      clipState.setSubtitleBody([
        { from: 0, to: 10, content: "P0-first" },
        { from: 12, to: 20, content: "P0-second" },
        { from: 65, to: 75, content: "P1-preload" }
      ]);
      clipState.setSubtitleFetchState("ready");

      const chunkResolvers = new Map<number, (result: TranslateSubtitleTrackResult) => void>();
      const cueEmitters = new Map<number, (cue: any) => void>();

      const { startTranslate, setSubtitle } = setupTest({
        currentTime: 5,
        translateTrack: ({ items, onCueReady }: any) => {
          const chunkIdx = Math.floor((items[0]?.from || 0) / 60);
          cueEmitters.set(chunkIdx, onCueReady);
          return new Promise<TranslateSubtitleTrackResult>((resolve) => {
            chunkResolvers.set(chunkIdx, resolve);
          });
        }
      });

      await startTranslate("zh", "bilingual");
      await vi.waitFor(() => expect(cueEmitters.has(0)).toBe(true));
      expect(setSubtitle).toHaveBeenLastCalledWith("P0-first", "", expect.any(Number));
      setSubtitle.mockClear();

      cueEmitters.get(0)!({
        startIndex: 1,
        endIndex: 1,
        from: 12,
        to: 20,
        text: "P0-second",
        translation: "流式译文0-后句"
      });
      expect(setSubtitle).not.toHaveBeenCalled();

      cueEmitters.get(0)!({
        startIndex: 0,
        endIndex: 0,
        from: 0,
        to: 10,
        text: "P0-first",
        translation: "流式译文0-首句"
      });
      expect(setSubtitle).toHaveBeenCalledTimes(1);
      expect(setSubtitle).toHaveBeenLastCalledWith("P0-first", "流式译文0-首句", expect.any(Number));
      setSubtitle.mockClear();

      chunkResolvers.get(0)!(
        asTrackResult([
          { from: 0, to: 10, content: "流式译文0-首句" },
          { from: 12, to: 20, content: "流式译文0-后句" }
        ])
      );
      await vi.waitFor(() => expect(cueEmitters.has(1)).toBe(true));
      setSubtitle.mockClear();

      cueEmitters.get(1)!({
        startIndex: 0,
        endIndex: 0,
        from: 65,
        to: 75,
        text: "P1-preload",
        translation: "流式译文1-预载"
      });
      expect(setSubtitle).not.toHaveBeenCalled();

      chunkResolvers.get(1)!(asTrackResult([{ from: 65, to: 75, content: "流式译文1-预载" }]));
      await Promise.resolve();
      await Promise.resolve();
      expect(setSubtitle).not.toHaveBeenCalled();
    });

    it("会话 applyMode('off') 推进代次后，迟到的流式 onCueReady 回调被拦截，不污染浮层或副轨槽", async () => {
      clipState.setSubtitleBody([{ from: 0, to: 10, content: "P0" }]);
      clipState.setSubtitleFetchState("ready");

      let staleOnCueReady: ((cue: any) => void) | undefined;
      let releaseChunk!: (result: TranslateSubtitleTrackResult) => void;

      const { controller, startTranslate, setSubtitle } = setupTest({
        currentTime: 5,
        translateTrack: ({ onCueReady }: any) => {
          staleOnCueReady = onCueReady;
          return new Promise<TranslateSubtitleTrackResult>((resolve) => {
            releaseChunk = resolve;
          });
        }
      });

      await startTranslate("zh", "bilingual");
      await vi.waitFor(() => expect(staleOnCueReady).toBeDefined());

      await controller.applyMode("off");
      setSubtitle.mockClear();

      staleOnCueReady!({
        startIndex: 0,
        endIndex: 0,
        from: 0,
        to: 10,
        text: "P0",
        translation: "过期译文"
      });
      releaseChunk(asTrackResult([{ from: 0, to: 10, content: "过期译文" }]));
      await Promise.resolve();

      expect(setSubtitle).not.toHaveBeenCalled();
      expect(state.clip.secondarySubtitle.state).toBe("idle");
    });

    it("YouTube 多语种原生轨跳过 native-pair，直接走扩展翻译链路", async () => {
      clipState.setSite("youtube");
      clipState.setBvid("ytDemo01234");
      clipState.setCid("yt");
      clipState.setSubtitles([
        {
          id: "yt-auto-a.en",
          lan: "en",
          lanDoc: "English",
          subtitleUrl: "https://www.youtube.com/api/timedtext?v=ytDemo01234&lang=en&kind=asr",
          origin: "youtube",
          kind: "asr",
          source: "youtube-auto",
          site: "youtube"
        },
        {
          id: "yt-cc-.ja",
          lan: "ja",
          lanDoc: "日本語",
          subtitleUrl: "https://www.youtube.com/api/timedtext?v=ytDemo01234&lang=ja",
          origin: "youtube",
          source: "youtube-cc",
          site: "youtube"
        }
      ]);
      clipState.setSelectedSubtitleId("yt-auto-a.en");
      clipState.setSelectedSubtitleUrl(
        "https://www.youtube.com/api/timedtext?v=ytDemo01234&lang=en&kind=asr"
      );
      clipState.setSelectedSubtitleLang("English");
      clipState.setSubtitleBody([{ from: 0, to: 10, content: "Hello YouTube" }]);
      clipState.setSubtitleFetchState("ready");

      const { startTranslate, translateItems, setSubtitle } = setupTest({ currentTime: 2 });

      expect(await startTranslate("zh", "bilingual")).toBe(true);
      await vi.waitFor(() => expect(translateItems).toHaveBeenCalled());
      expect(translateItems.mock.calls[0]?.[0]).toMatchObject({
        targetLang: "zh",
        origin: "youtube",
        kind: "asr",
        source: "youtube-auto"
      });
      await vi.waitFor(() =>
        expect(setSubtitle).toHaveBeenCalledWith("Hello YouTube", "译: Hello YouTube", expect.any(Number))
      );
    });
  });
});
