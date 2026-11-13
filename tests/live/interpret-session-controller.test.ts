import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { state, clipState } from "../../extension/core/state.js";
import {
  createInterpretSessionController,
  PAUSE_TIMEOUT_MS
} from "../../extension/live/interpret-session-controller.js";
import type { SubtitleBodyItem } from "../../extension/core/state.js";
import { BILISCRIPT_URL_CHANGE_EVENT } from "../../extension/core/url-watcher.js";

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
    loadCache?: (key: string) => Promise<unknown[] | null>;
    saveCache?: (key: string, body: unknown[]) => Promise<any>;
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
    const loadCache = overrides.loadCache || vi.fn(async (key: string) => cacheStorage.get(key) || null);
    const saveCache = overrides.saveCache || vi.fn(async (key: string, body: unknown[]) => {
      cacheStorage.set(key, body);
      return { ok: true };
    });
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

      // 零网络调用
      expect(runAsr).not.toHaveBeenCalled();
      expect(translateItems).not.toHaveBeenCalled();

      // 状态已安装
      expect(state.clip.subtitleBody).toEqual(primaryMock);
      expect(state.clip.secondarySubtitle.body).toEqual(secondaryMock);
      expect(state.clip.selectedSubtitleId).toBe("asr");

      // 播放器时间轴当前行渲染
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
      expect(runAsr).not.toHaveBeenCalled(); // 跳过 ASR
      // 窗口 [0, 1, 2] 内有两个分片需要翻译
      expect(translateItems).toHaveBeenCalledTimes(2);
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

      // 用户 Seek 到 135 秒（分片 2）
      video.currentTime = 135;
      video.dispatchEvent(new Event("seeking"));

      expect(clearSubtitlesOnSeek).toHaveBeenCalled();
      expect(setSubtitle).toHaveBeenCalledWith("P2", "S2");
    });

    it("Seek 到未就绪分片时给出轻量提示并推进调度", async () => {
      // 分片 0 在 0s，分片 4 在 250s（初始窗口 [0, 1, 2] 之外）
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

      // Seek 到未就绪的分片 4（255 秒）
      video.currentTime = 255;
      video.dispatchEvent(new Event("seeking"));

      expect(showNotice).toHaveBeenCalledWith("正在转写并翻译字幕...", 2000);
      expect(translateItems).toHaveBeenCalled();
    });
  });

  describe("增量主/副轨合并与热评防重", () => {
    it("分片逐片到达时增量合入主/副轨并落盘缓存，不重复触发热评", async () => {
      let chunkCb: any = null;
      const { controller, runAsr, saveCache } = setupTest({
        runAsr: vi.fn(async (args: any) => {
          chunkCb = args.onChunkResult;
        })
      });

      await controller.start();
      expect(runAsr).toHaveBeenCalled();
      expect(chunkCb).toBeDefined();

      // 分片 0 到达
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
      expect(saveCache).toHaveBeenCalledTimes(2); // primary and secondary
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

      // 切换视频
      clipState.setBvid("BV1newVideo999");
      window.dispatchEvent(new Event(BILISCRIPT_URL_CHANGE_EVENT));

      expect(controller.getState()).toBe("idle");
    });
  });
});
