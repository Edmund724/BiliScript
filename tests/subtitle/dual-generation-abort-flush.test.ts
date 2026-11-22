import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost } from "../helpers/chrome-host.js";
import { state, clipState, triggerSubtitleSessionBoundary } from "../../extension/core/state.js";
import {
  buildTranslationSignature,
  configureSubtitleCacheStoreForTests,
  createSubtitleIdbStore,
  getSubtitlePageCacheRecord,
  loadTranslatedSubtitleTrack,
  type SubtitleIdbStore
} from "../../extension/subtitle/cache.js";
import { buildSubtitleSourceKey } from "../../extension/subtitle/source-key.js";
import {
  createInterpretSessionController,
  type InterpretSessionController
} from "../../extension/live/interpret-session-controller.js";
import type { TranslateSubtitleTrackResult } from "../../extension/ai/subtitle-translate.js";
import { createOffscreenChunkHost } from "../../extension/asr/offscreen-bridge.page.js";
import { loadSubtitle } from "../../extension/subtitle/fetcher.js";
import { configureCommitUi } from "../../extension/subtitle/commit.js";
import * as gateway from "../../extension/bilibili/gateway.js";

function createVideoStub(currentTime = 1): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "currentTime", { value: currentTime, writable: true, configurable: true });
  Object.defineProperty(video, "paused", { value: false, writable: true, configurable: true });
  return video;
}

function installFakeRuntimePort() {
  const disconnectedPorts: string[] = [];
  const disconnect = vi.fn(() => {
    disconnectedPorts.push("asr-decode");
  });
  const onMessageListeners: Array<(msg: unknown) => void> = [];
  const onDisconnectListeners: Array<() => void> = [];
  chrome.runtime.connect = vi.fn(() => ({
    name: "asr-decode",
    onMessage: { addListener: (cb: (msg: unknown) => void) => onMessageListeners.push(cb) },
    onDisconnect: { addListener: (cb: () => void) => onDisconnectListeners.push(cb) },
    postMessage: vi.fn(),
    disconnect
  })) as unknown as typeof chrome.runtime.connect;
  return { disconnectedPorts, disconnect };
}

function createDeferredPromise<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface SessionCaptureBag {
  asrSignal?: AbortSignal | null;
  translateSignal?: AbortSignal | null;
  onChunkResult?: (record: any, items: any[]) => unknown;
  onCueReady?: (cue: any) => void;
  offscreenHostPromise?: Promise<unknown>;
}

let controller: InterpretSessionController | null = null;
let idbStore: SubtitleIdbStore;

beforeEach(() => {
  resetModuleState();
  vi.useFakeTimers();
  installChromeHost();
  idbStore = createSubtitleIdbStore({ indexedDB: null });
  configureSubtitleCacheStoreForTests(idbStore);
  configureCommitUi({ setStatus: vi.fn() });
  clipState.setBvid("BV1switch001");
  clipState.setCid("101");
  clipState.setVideoDuration(300);
  clipState.setSubtitles([]);
  clipState.setSubtitleBody([]);
  clipState.setSubtitleFetchState("idle");
  clipState.clearSecondarySubtitle();
  state.setSettings({
    ...state.settings,
    liveInterpretTargetLang: "zh",
    liveInterpretDisplayMode: "bilingual",
    subtitleTranslateModel: "Index-Translate-35B-A3B"
  });
});

afterEach(() => {
  controller?.dispose();
  controller = null;
  configureSubtitleCacheStoreForTests(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SPA 切集与中途切轨的双代数级联清理与立即 flush", () => {
  it("SPA 分 P 切换：立即 flush 未满 1500ms 流式句进 IDB、递增双代数令牌、级联 abort 翻译/ASR/Offscreen 端口并清叠层", async () => {
    const portSpy = installFakeRuntimePort();
    const cleanupSpy = vi.fn(async () => ({ ok: true as const }));
    const offscreenHost = createOffscreenChunkHost({
      prepare: async () => ({ ok: true as const, ruleId: 77 }),
      cleanup: cleanupSpy
    });

    const capture: SessionCaptureBag = {};
    const pendingTranslate = createDeferredPromise<TranslateSubtitleTrackResult>();

    const setSubtitle = vi.fn();
    const clearSubtitles = vi.fn();
    const video = createVideoStub(1);

    controller = createInterpretSessionController({
      getVideoElement: () => video,
      setSubtitle,
      clearSubtitles,
      resolveTranslateProvider: async () => ({
        provider: {
          id: "builtin",
          name: "Index-Translate",
          baseUrl: "https://index-translate.bilibili.com/v1",
          models: ["Index-Translate-35B-A3B"],
          hasSavedKey: false,
          enabled: true
        },
        apiKey: "",
        baseUrl: "https://index-translate.bilibili.com/v1",
        model: "Index-Translate-35B-A3B",
        presetId: "bilibili-index-translate",
        isFallback: false
      }),
      loadAsrProviders: async () => [{ id: "asr-1", enabled: true, hasSavedKey: true, model: "whisper-1" }],
      runAsr: async ({ signal, onChunkResult }) => {
        capture.asrSignal = signal;
        capture.onChunkResult = onChunkResult;
        capture.offscreenHostPromise = offscreenHost({
          audioUrl: "https://cdn.example.com/audio.m4s",
          signal
        });
        await capture.offscreenHostPromise.catch(() => {});
      },
      translateTrack: async ({ signal, onCueReady }) => {
        capture.translateSignal = signal;
        capture.onCueReady = onCueReady;
        onCueReady?.({
          startIndex: 0,
          endIndex: 0,
          from: 0,
          to: 5,
          text: "First ASR sentence",
          translation: "第一句流式译文"
        });
        return pendingTranslate.promise;
      }
    });
    chrome.storage.sync.get = vi.fn(async () => ({ activeAsrProviderId: "asr-1", asrLanguage: "en" })) as unknown as typeof chrome.storage.sync.get;

    const versionsBefore = {
      acquisitionVersion: clipState.acquisitionVersion,
      processingVersion: clipState.processingVersion
    };

    const started = await controller.start();
    expect(started).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(capture.asrSignal).toBeTruthy();

    void capture.onChunkResult?.(
      { index: 0, startSec: 0, durationSec: 60 },
      [{ from: 0, to: 5, content: "First ASR sentence" }]
    );
    await vi.advanceTimersByTimeAsync(200);

    expect(capture.onCueReady).toBeDefined();
    expect(setSubtitle).toHaveBeenCalledWith("", "第一句流式译文");

    const pageBeforeFlush = await idbStore.getPageRecord("BV1switch001", "101");
    expect(pageBeforeFlush?.translatedTracks ?? {}).toEqual({});

    setSubtitle.mockClear();
    clearSubtitles.mockClear();

    await triggerSubtitleSessionBoundary("clip-switch");
    clipState.setCid("102");
    clipState.setSubtitleBody([]);

    expect(clipState.acquisitionVersion).toBe(versionsBefore.acquisitionVersion + 1);
    expect(clipState.processingVersion).toBe(versionsBefore.processingVersion + 1);
    expect(capture.asrSignal?.aborted).toBe(true);
    expect(capture.translateSignal?.aborted).toBe(true);
    expect(portSpy.disconnect).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledWith(77);
    expect(clearSubtitles).toHaveBeenCalled();
    expect(setSubtitle).toHaveBeenLastCalledWith("", "");
    expect(controller.getState()).toBe("idle");

    const expectedSig = buildTranslationSignature({
      model: "Index-Translate-35B-A3B",
      protocolVersion: "boundary-v3",
      targetLang: "zh-CN"
    });
    await expect(
      loadTranslatedSubtitleTrack({
        bvid: "BV1switch001",
        cid: "101",
        sourceTrackKey: "asr",
        targetLang: "zh-CN",
        translationSig: expectedSig
      })
    ).resolves.toEqual([{ from: 0, to: 5, content: "第一句流式译文" }]);

    setSubtitle.mockClear();
    capture.onCueReady?.({
      startIndex: 1,
      endIndex: 1,
      from: 5,
      to: 10,
      text: "Stale cue from cid 101",
      translation: "污染旧译文"
    });
    pendingTranslate.resolve({
      mode: "boundary-v3",
      items: [{ from: 0, to: 5, content: "First ASR sentence" }],
      translations: [{ from: 0, to: 5, content: "第一句流式译文" }]
    });
    await capture.offscreenHostPromise?.catch(() => {});
    await Promise.resolve();

    expect(setSubtitle).not.toHaveBeenCalled();
    await expect(getSubtitlePageCacheRecord("BV1switch001", "102")).resolves.toBeNull();
  });

  it("多语言菜单中途切换源字幕轨：先 flush en-US 流式分块进 IndexedDB、递增双令牌、中止旧轨翻译并隔离 ja-JP", async () => {
    const enBody = [
      { from: 0, to: 4, content: "English line one." },
      { from: 4, to: 8, content: "English line two." }
    ];
    const jaBody = [
      { from: 0, to: 4, content: "日本語の字幕一。" },
      { from: 4, to: 300, content: "日本語の字幕二。" }
    ];

    clipState.setSubtitles([
      { id: "cc-en", lan: "en-US", lanDoc: "英语（美国）", subtitleUrl: "https://sub.test/en.json" },
      { id: "cc-ja", lan: "ja-JP", lanDoc: "日语", subtitleUrl: "https://sub.test/ja.json" }
    ]);
    clipState.setSelectedSubtitleId("cc-en");
    clipState.setSelectedSubtitleUrl("https://sub.test/en.json");
    clipState.setSelectedSubtitleLang("英语（美国）");
    clipState.setSubtitleBody(enBody);
    clipState.setSubtitleFetchState("ready");

    vi.spyOn(gateway, "contentFetchJson").mockResolvedValue({ body: jaBody });

    const capture: SessionCaptureBag = {};
    const pendingEnTranslate = createDeferredPromise<TranslateSubtitleTrackResult>();
    const setSubtitle = vi.fn();
    const clearSubtitles = vi.fn();
    const video = createVideoStub(1);

    controller = createInterpretSessionController({
      getVideoElement: () => video,
      getAiRefineMode: () => "manual-refine",
      setSubtitle,
      clearSubtitles,
      resolveTranslateProvider: async () => ({
        provider: {
          id: "builtin",
          name: "Index-Translate",
          baseUrl: "https://index-translate.bilibili.com/v1",
          models: ["Index-Translate-35B-A3B"],
          hasSavedKey: false,
          enabled: true
        },
        apiKey: "",
        baseUrl: "https://index-translate.bilibili.com/v1",
        model: "Index-Translate-35B-A3B",
        presetId: "bilibili-index-translate",
        isFallback: false
      }),
      translateTrack: async ({ signal, onCueReady }) => {
        capture.translateSignal = signal;
        capture.onCueReady = onCueReady;
        onCueReady?.({
          startIndex: 0,
          endIndex: 0,
          from: 0,
          to: 4,
          text: "English line one.",
          translation: "英文第一句精翻"
        });
        return pendingEnTranslate.promise;
      }
    });

    const versionsBefore = {
      acquisitionVersion: clipState.acquisitionVersion,
      processingVersion: clipState.processingVersion
    };

    const started = await controller.start();
    expect(started).toBe(true);
    await vi.advanceTimersByTimeAsync(150);

    expect(capture.onCueReady).toBeDefined();
    expect(setSubtitle).toHaveBeenCalledWith("English line one.", "英文第一句精翻");

    setSubtitle.mockClear();
    clearSubtitles.mockClear();

    await loadSubtitle("https://sub.test/ja.json", "日语", clipState.fetchRunId, "cc-ja");

    expect(clipState.acquisitionVersion).toBe(versionsBefore.acquisitionVersion + 1);
    expect(clipState.processingVersion).toBe(versionsBefore.processingVersion + 1);
    expect(capture.translateSignal?.aborted).toBe(true);
    expect(clearSubtitles).toHaveBeenCalled();
    expect(setSubtitle).toHaveBeenLastCalledWith("", "");
    expect(clipState.selectedSubtitleId).toBe("cc-ja");
    expect(clipState.subtitleBody).toEqual(jaBody);

    const enSourceKey = buildSubtitleSourceKey("cc-en", "https://sub.test/en.json", "英语（美国）");
    const enSig = buildTranslationSignature({
      model: "Index-Translate-35B-A3B",
      protocolVersion: "cc-json",
      targetLang: "zh-CN",
      sourceText: enBody.map((item) => item.content).join("\n")
    });
    await expect(
      loadTranslatedSubtitleTrack({
        bvid: "BV1switch001",
        cid: "101",
        sourceTrackKey: enSourceKey,
        targetLang: "zh-CN",
        translationSig: enSig
      })
    ).resolves.toEqual([{ from: 0, to: 4, content: "英文第一句精翻" }]);

    const jaSourceKey = buildSubtitleSourceKey("cc-ja", "https://sub.test/ja.json", "日语");
    capture.onCueReady?.({
      startIndex: 1,
      endIndex: 1,
      from: 4,
      to: 8,
      text: "English line two.",
      translation: "脏数据第二句"
    });
    pendingEnTranslate.resolve({
      mode: "cc-json",
      items: enBody,
      translations: [{ from: 0, to: 4, content: "英文第一句精翻" }]
    });
    await Promise.resolve();

    await expect(
      loadTranslatedSubtitleTrack({
        bvid: "BV1switch001",
        cid: "101",
        sourceTrackKey: jaSourceKey,
        targetLang: "zh-CN"
      })
    ).resolves.toBeNull();
  });
});
