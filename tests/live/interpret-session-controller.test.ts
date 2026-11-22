import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { state, clipState } from "../../extension/core/state.js";
import {
  createInterpretSessionController,
  PAUSE_TIMEOUT_MS
} from "../../extension/live/interpret-session-controller.js";
import type { SubtitleBodyItem } from "../../extension/core/state.js";
import { contentEventBus } from "../../extension/shared/content-event-bus.js";

beforeEach(() => {
  resetModuleState();
  vi.useRealTimers();
  clipState.setBvid("BV1test000000");
  clipState.setCid("123456");
  clipState.setVideoDuration(300);
  clipState.setSubtitleBody([]);
  clipState.setSubtitleFetchState("idle");
  clipState.clearSecondarySubtitle();
  clipState.setSubtitles([]);
});

describe("InterpretSessionController (游标滑动窗口 ASR + LLM 逐句翻译管线)", () => {
  function setupTest(overrides: {
    runAsr?: (args: any) => Promise<any>;
    translateItems?: (args: any) => Promise<SubtitleBodyItem[]>;
    loadCache?: (key: string) => Promise<SubtitleBodyItem[] | null>;
    saveCache?: (key: string, body: unknown[]) => Promise<any>;
    clearTranslatedCache?: (args: { bvid: string; cid: string }) => Promise<string[]>;
    resolveTranslateProvider?: () => Promise<any>;
    currentTime?: number;
    paused?: boolean;
    targetLang?: string;
    displayMode?: "auto" | "translation" | "bilingual";
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
    const clearSubtitles = vi.fn();
    const clearSubtitlesOnSeek = vi.fn();
    const onStateChange = vi.fn();
    const onAvailabilityChange = vi.fn();

    const runAsr = overrides.runAsr || vi.fn(async () => []);
    const translateItems = vi.fn(overrides.translateItems || (async ({ items }) => {
      return (items || []).map((it: any) => ({
        from: it.from,
        to: it.to,
        content: `译: ${it.content}`
      }));
    }));
    const cacheStorage = new Map<string, unknown[]>();
    const loadCache = overrides.loadCache || vi.fn(async (key: string) => (cacheStorage.get(key) as SubtitleBodyItem[] | undefined) || null);
    const saveCache = overrides.saveCache || vi.fn(async (key: string, body: unknown[]) => {
      cacheStorage.set(key, body);
      return { ok: true };
    });
    const clearTranslatedCache = overrides.clearTranslatedCache || vi.fn(async () => []);
    const resolveTranslateProvider = overrides.resolveTranslateProvider || vi.fn(async () => ({
      provider: { id: "test-ai", name: "Test AI", baseUrl: "https://api.test", models: ["m1"], enabled: true },
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
      getVideoElement: () => video,
      getTargetLang: () => overrides.targetLang || "zh",
      getDisplayMode: () => overrides.displayMode || "bilingual",
      showNotice,
      setSubtitle,
      clearSubtitles,
      clearSubtitlesOnSeek,
      onStateChange,
      onAvailabilityChange,
      runAsr,
      translateItems,
      loadCache,
      saveCache,
      clearTranslatedCache,
      resolveTranslateProvider,
      loadAsrProviders
    });

    return {
      controller,
      video,
      showNotice,
      setSubtitle,
      clearSubtitles,
      clearSubtitlesOnSeek,
      onStateChange,
      onAvailabilityChange,
      runAsr,
      translateItems,
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
        { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-chat"], requiresKey: true, hasSavedKey: false, enabled: true }
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

  describe("缓存命中短路", () => {
    it("主轨与副轨全命中时零网络请求挂载并渲染", async () => {
      const primaryMock: SubtitleBodyItem[] = [
        { from: 0, to: 10, content: "Hello chunk 0" },
        { from: 65, to: 75, content: "Hello chunk 1" }
      ];
      const secondaryMock: SubtitleBodyItem[] = [
        { from: 0, to: 10, content: "你好 分片 0" },
        { from: 65, to: 75, content: "你好 分片 1" }
      ];

      const { controller, runAsr, translateItems, setSubtitle } = setupTest({
        loadCache: vi.fn(async (key: string) => {
          if (key.includes("id_asr:")) return primaryMock;
          if (key.includes("translate-")) return secondaryMock;
          return null;
        }),
        currentTime: 5
      });

      const started = await controller.start();
      expect(started).toBe(true);
      expect(controller.getState()).toBe("connected");

      expect(runAsr).not.toHaveBeenCalled();
      expect(translateItems).not.toHaveBeenCalled();

      expect(state.clip.subtitleBody).toEqual(primaryMock);
      expect(state.clip.secondarySubtitle.body).toEqual(secondaryMock);
      expect(state.clip.selectedSubtitleId).toBe("asr");

      expect(setSubtitle).toHaveBeenCalledWith("Hello chunk 0", "你好 分片 0");
    });

    it("主轨已就绪仅缺译文时跳过 ASR，按窗口调度 LLM 翻译", async () => {
      const primaryMock: SubtitleBodyItem[] = [
        { from: 0, to: 10, content: "Sentence 1" },
        { from: 65, to: 75, content: "Sentence 2" }
      ];
      clipState.setSubtitleBody(primaryMock);
      clipState.setSubtitleFetchState("ready");

      const { controller, runAsr, translateItems } = setupTest({
        currentTime: 0
      });

      const started = await controller.start();
      expect(started).toBe(true);
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

      const { controller, video, setSubtitle, clearSubtitlesOnSeek } = setupTest({
        loadCache: vi.fn(async (key: string) => {
          if (key.includes("id_asr:")) return primaryMock;
          if (key.includes("translate-")) return secondaryMock;
          return null;
        }),
        currentTime: 0
      });

      await controller.start();
      expect(setSubtitle).toHaveBeenCalledWith("P0", "S0");

      video.currentTime = 135;
      video.dispatchEvent(new Event("seeking"));

      expect(clearSubtitlesOnSeek).toHaveBeenCalled();
      expect(setSubtitle).toHaveBeenCalledWith("P2", "S2");
    });

    it("Seek 到未就绪分片时给出轻量提示并推进调度", async () => {
      clipState.setSubtitleBody([
        { from: 0, to: 10, content: "P0" },
        { from: 250, to: 260, content: "P4" }
      ]);
      clipState.setSubtitleFetchState("ready");

      const { controller, video, showNotice, translateItems } = setupTest({
        currentTime: 0
      });

      await controller.start();
      translateItems.mockClear();

      video.currentTime = 255;
      video.dispatchEvent(new Event("seeking"));

      expect(showNotice).toHaveBeenCalledWith("正在转写并翻译字幕...", 2000);
      expect(translateItems).toHaveBeenCalled();
    });
  });

  describe("增量主/副轨合并与热评防重", () => {
    it("分片逐片到达时增量合入主/副轨并落盘缓存，不重复触发热评；新 ASR 主轨持久化时仅失效旧译文一次", async () => {
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
      const { controller, runAsr } = setupTest({
        saveCache,
        clearTranslatedCache,
        runAsr: vi.fn(async (args: any) => {
          chunkCb = args.onChunkResult;
        })
      });

      await controller.start();
      expect(runAsr).toHaveBeenCalled();
      expect(chunkCb).toBeDefined();

      await chunkCb(
        { index: 0, startSec: 0, durationSec: 60, result: { text: "Chunk 0 ASR" } },
        [{ from: 0, to: 10, content: "Chunk 0 ASR" }]
      );

      expect(state.clip.subtitleBody).toEqual([
        { from: 0, to: 10, content: "Chunk 0 ASR" }
      ]);
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
      const { controller, clearTranslatedCache, saveCache } = setupTest({
        targetLang: "ja"
      });

      await controller.start();
      await vi.waitFor(() => expect(saveCache).toHaveBeenCalled());
      expect(clearTranslatedCache).not.toHaveBeenCalled();
    });
  });

  describe("中止与清理", () => {
    it("手动 stop 清理浮层与监听，保留已有缓存", async () => {
      const { controller, clearSubtitles, setSubtitle, onStateChange } = setupTest();
      await controller.start();
      expect(controller.getState()).toBe("connected");

      await controller.stop();
      expect(controller.getState()).toBe("idle");
      expect(clearSubtitles).toHaveBeenCalled();
      expect(setSubtitle).toHaveBeenCalledWith("", "");
      expect(onStateChange).toHaveBeenCalledWith("idle");
    });

    it("暂停超过 5 分钟自动关闭并提示", async () => {
      vi.useFakeTimers();
      const { controller, video, showNotice } = setupTest();
      await controller.start();

      (video as any).paused = true;
      video.dispatchEvent(new Event("pause"));

      vi.advanceTimersByTime(PAUSE_TIMEOUT_MS - 1000);
      expect(controller.getState()).toBe("connected");

      vi.advanceTimersByTime(2000);
      expect(controller.getState()).toBe("idle");
      expect(showNotice).toHaveBeenCalledWith(
        "视频暂停超过 5 分钟，实时翻译已自动关闭",
        6000
      );
    });

    it("页面切换/URL 改变自动中止当前会话", async () => {
      const { controller } = setupTest();
      await controller.start();
      expect(controller.getState()).toBe("connected");

      clipState.setBvid("BV1newVideo999");
      contentEventBus.emit("host:url-change", { url: location.href });

      expect(controller.getState()).toBe("idle");
    });

    it("单片翻译失败后进入 15s 冷却期并提示，期间 timeupdate 不重复风暴重试；超时后可重试", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-15T00:00:00Z"));
      clipState.setSubtitleBody([
        { from: 0, to: 5, content: "Hello" }
      ]);
      clipState.setSubtitleFetchState("ready");

      let calls = 0;
      const { controller, video, showNotice, translateItems } = setupTest({
        translateItems: async ({ items }) => {
          calls += 1;
          if (calls === 1) throw new Error("rate limit");
          return (items || []).map((it: any) => ({ ...it, content: `译: ${it.content}` }));
        }
      });

      await controller.start();
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

    it("空间隙期间有主轨时不显示转写提示；无主轨时节流每 2s 至多提示一次", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-15T00:00:00Z"));

      const { controller, video, showNotice } = setupTest({
        runAsr: async () => new Promise(() => {})
      });
      await controller.start();
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

      const chunkResolvers = new Map<number, (items: SubtitleBodyItem[]) => void>();
      const cueEmitters = new Map<number, (cue: any) => void>();

      const { controller, setSubtitle } = setupTest({
        currentTime: 5,
        translateItems: ({ items, onCueReady }: any) => {
          const chunkIdx = Math.floor((items[0]?.from || 0) / 60);
          cueEmitters.set(chunkIdx, onCueReady);
          return new Promise<SubtitleBodyItem[]>((resolve) => {
            chunkResolvers.set(chunkIdx, resolve);
          });
        }
      });

      await controller.start();
      await vi.waitFor(() => expect(cueEmitters.has(0)).toBe(true));
      expect(setSubtitle).toHaveBeenLastCalledWith("P0-first", "");
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
      expect(setSubtitle).toHaveBeenLastCalledWith("P0-first", "流式译文0-首句");
      setSubtitle.mockClear();

      chunkResolvers.get(0)!([
        { from: 0, to: 10, content: "流式译文0-首句" },
        { from: 12, to: 20, content: "流式译文0-后句" }
      ]);
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

      chunkResolvers.get(1)!([{ from: 65, to: 75, content: "流式译文1-预载" }]);
      await Promise.resolve();
      await Promise.resolve();
      expect(setSubtitle).not.toHaveBeenCalled();
    });

    it("会话 stop 推进代次后，迟到的流式 onCueReady 回调被拦截，不污染浮层或副轨槽", async () => {
      clipState.setSubtitleBody([{ from: 0, to: 10, content: "P0" }]);
      clipState.setSubtitleFetchState("ready");

      let staleOnCueReady: ((cue: any) => void) | undefined;
      let releaseChunk!: (items: SubtitleBodyItem[]) => void;

      const { controller, setSubtitle } = setupTest({
        currentTime: 5,
        translateItems: ({ onCueReady }: any) => {
          staleOnCueReady = onCueReady;
          return new Promise<SubtitleBodyItem[]>((resolve) => {
            releaseChunk = resolve;
          });
        }
      });

      await controller.start();
      await vi.waitFor(() => expect(staleOnCueReady).toBeDefined());

      await controller.stop();
      setSubtitle.mockClear();

      staleOnCueReady!({
        startIndex: 0,
        endIndex: 0,
        from: 0,
        to: 10,
        text: "P0",
        translation: "过期译文"
      });
      releaseChunk([{ from: 0, to: 10, content: "过期译文" }]);
      await Promise.resolve();

      expect(setSubtitle).not.toHaveBeenCalled();
      expect(state.clip.secondarySubtitle.state).toBe("idle");
    });
  });
});
