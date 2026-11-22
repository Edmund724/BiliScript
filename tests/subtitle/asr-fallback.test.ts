import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost, type ChromeHost } from "../helpers/chrome-host.js";
import { createAsrFallback } from "../../extension/asr/fallback.js";
import type {
  AsrFallback,
  CreateAsrFallbackDeps,
  SubtitleItem
} from "../../extension/asr/fallback.js";
import { state, clipState, transitionReaderShell } from "../../extension/core/state.js";
import { getSubtitleCacheKey, loadSubtitleFromCache, saveSubtitleToCache } from "../../extension/subtitle/cache.js";
import {
  acceptSubtitle as realAcceptSubtitle,
  commitNoSubtitle as realCommitNoSubtitle,
  configureCommitUi
} from "../../extension/subtitle/commit.js";
import { subscribeReaderPresenter } from "../../extension/reader/reader-bus.js";
import { getAsrFailureNotice } from "../../extension/core/asr-failure-notice.js";

const BVID = "BV1test000000";
const CID = "101";
const VIDEO_DURATION = 300;
const RUN_ID = 1;

const PROVIDER = {
  id: "p1",
  type: "openai-transcriptions",
  name: "本地 Whisper",
  model: "whisper-large-v3",
  supportsTimestamps: true
};

const TRANSCRIBED_BODY = [
  { from: 0, to: 1.2, content: "你好" },
  { from: 1.5, to: 2.4, content: "世界" },
  { from: 3, to: 290, content: "收尾长句" }
];

function asrCacheKey({ providerId = "p1", model = "whisper-large-v3", lang = "auto" } = {}) {
  return getSubtitleCacheKey({
    bvid: BVID,
    cid: CID,
    identity: { kind: "asr", providerId, model, lang }
  });
}

type DepsFns = Required<CreateAsrFallbackDeps>;

type Deps = { [K in keyof DepsFns]: Mock<DepsFns[K]> };

function buildDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    getSettings: vi.fn<DepsFns["getSettings"]>(async () => state.settings),
    loadProviders: vi.fn<DepsFns["loadProviders"]>(async () => [PROVIDER]),
    setStatus: vi.fn<DepsFns["setStatus"]>(),
    acceptSubtitle: vi.fn<DepsFns["acceptSubtitle"]>(realAcceptSubtitle),
    commitNoSubtitle: vi.fn<DepsFns["commitNoSubtitle"]>(realCommitNoSubtitle),
    runAsrPipeline: vi.fn<DepsFns["runAsrPipeline"]>(async () => []),
    broadcastSubtitleStatus: vi.fn<DepsFns["broadcastSubtitleStatus"]>(),
    sleepFor: vi.fn<DepsFns["sleepFor"]>(async () => {}),
    ...overrides
  };
}

let storageHost: ChromeHost;
let deps: Deps;
let fallback: AsrFallback;

beforeEach(() => {
  resetModuleState();
  storageHost = installChromeHost();

  configureCommitUi({
    setStatus: vi.fn()
  });

  clipState.setFetchRunId(RUN_ID);
  clipState.setBvid(BVID);
  clipState.setCid(CID);
  clipState.setVideoDuration(VIDEO_DURATION);
  clipState.setSubtitles([]);
  clipState.setSubtitleBody([]);
  clipState.setSubtitleFetchState("idle");
  state.settings = {
    ...state.settings,
    asrAutoFallback: true,
    activeAsrProviderId: "p1",
    asrLanguage: "auto"
  };

  deps = buildDeps();
  fallback = createAsrFallback(deps);
});

function stubPendingPipeline() {
  const pending: Array<{
    resolve: (body: SubtitleItem[]) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  deps.runAsrPipeline.mockImplementation(() => {
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  });
  return pending;
}

describe("maybeRunAsrFallback skip 闸门", () => {
  it("开关关闭（settings.asrAutoFallback=false）：返回 skip，快速出口先于任务发起", async () => {
    state.settings.asrAutoFallback = false;

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("skip");
    expect(deps.runAsrPipeline).not.toHaveBeenCalled();
    expect(deps.broadcastSubtitleStatus).not.toHaveBeenCalled();
    expect(deps.commitNoSubtitle).not.toHaveBeenCalled();
    expect(clipState.noSubtitleReason).toBe("asr-disabled");
  });

  it("无可用平台（loadProviders 为空）：返回 skip", async () => {
    state.settings.activeAsrProviderId = "";
    deps.loadProviders.mockResolvedValue([]);

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("skip");
    expect(deps.runAsrPipeline).not.toHaveBeenCalled();
    expect(deps.broadcastSubtitleStatus).not.toHaveBeenCalled();
    expect(clipState.noSubtitleReason).toBe("no-asr-config");
  });

  it("列表非空但 activeAsrProviderId 为空或悬空：自动回退到列表首项并执行转写", async () => {
    state.settings.activeAsrProviderId = "ghost";
    deps.loadProviders.mockResolvedValue([{ id: "other", type: "openai-transcriptions", name: "其他", model: "m1" }]);
    deps.runAsrPipeline.mockResolvedValue(TRANSCRIBED_BODY);

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("done");
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1);
  });

  it("offscreen 配置级 asr-skip：静默返回 skip，补 asr-done 终态广播解除等待标志", async () => {
    deps.runAsrPipeline.mockRejectedValue(
      Object.assign(new Error("没有激活的语音识别平台"), { code: "asr-skip" })
    );

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("skip");
    expect(deps.commitNoSubtitle).not.toHaveBeenCalled();
    expect(deps.broadcastSubtitleStatus.mock.calls.map((c) => c[0])).toEqual([
      "asr-transcribing",
      "asr-done"
    ]);
  });

  it("offscreen asr-skip 携带结构化 reason：随错误落 clipState.noSubtitleReason", async () => {
    deps.runAsrPipeline.mockRejectedValue(
      Object.assign(new Error("ASR 自动回退未开启"), { code: "asr-skip", reason: "asr-disabled" })
    );
    await expect(fallback.maybeRunAsrFallback({ runId: RUN_ID })).resolves.toBe("skip");
    expect(clipState.noSubtitleReason).toBe("asr-disabled");

    deps.runAsrPipeline.mockRejectedValue(
      Object.assign(new Error("没有激活的语音识别平台"), { code: "asr-skip", reason: "no-asr-config" })
    );
    await expect(fallback.maybeRunAsrFallback({ runId: RUN_ID })).resolves.toBe("skip");
    expect(clipState.noSubtitleReason).toBe("no-asr-config");
  });

  it("offscreen asr-skip 无 reason（config 消息失败/超时）：原因归 null（未知）", async () => {
    clipState.setNoSubtitleReason("asr-disabled");
    deps.runAsrPipeline.mockRejectedValue(
      Object.assign(new Error("get-asr-runtime-config timeout"), { code: "asr-skip" })
    );

    await expect(fallback.maybeRunAsrFallback({ runId: RUN_ID })).resolves.toBe("skip");

    expect(clipState.noSubtitleReason).toBe(null);
  });
});

describe("maybeRunAsrFallback 成功与缓存", () => {
  it("配置齐全：管线产出字幕 → 伪轨道 + ready + 写缓存 + 清理旧 ASR 变体 + asr-done 广播", async () => {
    const staleVariantKey = asrCacheKey({ providerId: "p1", model: "whisper-old" });
    await saveSubtitleToCache(staleVariantKey, [{ from: 0, to: 5, content: "旧变体" }]);
    clipState.setNoSubtitleReason("asr-empty");
    deps.runAsrPipeline.mockResolvedValue(TRANSCRIBED_BODY);

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("done");
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1);
    const pipelineArgs = deps.runAsrPipeline.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(pipelineArgs).toEqual(
      expect.objectContaining({
        bvid: BVID,
        cid: CID
      })
    );
    expect(pipelineArgs.provider).toBeUndefined();
    expect(pipelineArgs.durationSec).toBeUndefined();
    expect(pipelineArgs.runId).toBeUndefined();
    expect(pipelineArgs.isStale).toBeUndefined();

    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toEqual([
      { from: 0, to: 2.4, content: "你好世界" },
      { from: 3, to: 290, content: "收尾长句" }
    ]);
    expect(clipState.noSubtitleReason).toBe(null);
    expect(state.clip.subtitles[0]).toEqual({
      id: "asr",
      lan: "asr-zh",
      lanDoc: "自配平台转写",
      subtitleUrl: "",
      source: "asr",
      origin: "asr"
    });
    expect(state.clip.selectedSubtitleId).toBe("asr");
    expect(state.clip.selectedSubtitleLang).toBe("自配平台转写");

    expect(deps.acceptSubtitle).toHaveBeenCalledTimes(1);
    expect(deps.acceptSubtitle).toHaveBeenCalledWith({
      body: TRANSCRIBED_BODY,
      selectedSubtitleId: "asr",
      selectedSubtitleUrl: "",
      selectedSubtitleLang: "自配平台转写"
    });

    const runningStatus = deps.setStatus.mock.calls.map((c) => String(c[0]));
    expect(runningStatus.some((s) => s.includes("无字幕轨，正在使用语音转写生成字幕…"))).toBe(true);
    expect(runningStatus.some((s) => s.includes("本地 Whisper"))).toBe(false);

    const cacheKey = asrCacheKey();
    await expect(loadSubtitleFromCache(cacheKey)).resolves.toEqual(TRANSCRIBED_BODY);
    await expect(loadSubtitleFromCache(staleVariantKey)).resolves.toBeNull();

    expect(deps.broadcastSubtitleStatus.mock.calls.map((c) => c[0])).toEqual([
      "asr-transcribing",
      "asr-done"
    ]);
    const statusCalls = deps.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("语音识别完成，已生成 3 条字幕。"))).toBe(true);
  });

  it("语言档位 zh：来源串附「（中文）」，缓存键仍按 zh 档位", async () => {
    state.settings.asrLanguage = "zh";
    deps.runAsrPipeline.mockResolvedValue(TRANSCRIBED_BODY);

    await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(state.clip.selectedSubtitleLang).toBe("自配平台转写（中文）");
    expect(state.clip.subtitles[0]).toEqual({
      id: "asr",
      lan: "asr-zh",
      lanDoc: "自配平台转写（中文）",
      subtitleUrl: "",
      source: "asr",
      origin: "asr"
    });
    await expect(loadSubtitleFromCache(asrCacheKey({ lang: "zh" }))).resolves.toEqual(TRANSCRIBED_BODY);
  });

  it("阅读视图打开时收尾通知 reader-bus：subtitle-ready（通知职责在字幕接受事务内）", async () => {
    const handler = vi.fn();
    const unsubscribe = subscribeReaderPresenter(handler);
    transitionReaderShell("open");
    deps.runAsrPipeline.mockResolvedValue(TRANSCRIBED_BODY);

    await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(handler).toHaveBeenCalledWith({ kind: "subtitle-ready" });
    unsubscribe();
    transitionReaderShell("closed");
  });

  it("缓存命中（时长校验过）：不转写、不写缓存，直接 done 收尾", async () => {
    const cachedBody = [
      { from: 0, to: 1, content: "缓存句" },
      { from: 2, to: 290, content: "足够长的缓存字幕" }
    ];
    await storageHost.seedCacheEntry(asrCacheKey(), cachedBody);
    clipState.setNoSubtitleReason("asr-auth");
    clipState.setNoSubtitleDetail("（错误详情：HTTP 401）");

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("done");
    expect(deps.runAsrPipeline).not.toHaveBeenCalled();
    expect(deps.broadcastSubtitleStatus).not.toHaveBeenCalled();
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toEqual(cachedBody);
    expect(clipState.noSubtitleReason).toBe(null);
    expect(clipState.noSubtitleDetail).toBe("");
    expect(state.clip.subtitles).toEqual([
      {
        id: "asr",
        lan: "asr-zh",
        lanDoc: "自配平台转写",
        subtitleUrl: "",
        source: "asr",
        origin: "asr"
      }
    ]);
    expect(state.clip.selectedSubtitleId).toBe("asr");
    expect(state.clip.selectedSubtitleLang).toBe("自配平台转写");
    expect(deps.acceptSubtitle).toHaveBeenCalledTimes(1);
    expect(deps.acceptSubtitle).toHaveBeenCalledWith({
      body: cachedBody,
      selectedSubtitleId: "asr",
      selectedSubtitleUrl: "",
      selectedSubtitleLang: "自配平台转写"
    });
    const statusCalls = deps.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("缓存命中"))).toBe(true);
  });

  it("缓存命中但时长校验不过：清缓存并重新转写生成", async () => {
    const cacheKey = asrCacheKey();
    await storageHost.seedCacheEntry(cacheKey, [{ from: 0, to: 10, content: "过短" }]);
    deps.runAsrPipeline.mockResolvedValue(TRANSCRIBED_BODY);

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("done");
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1);
    await expect(loadSubtitleFromCache(cacheKey)).resolves.toEqual(TRANSCRIBED_BODY);
  });

  it("写缓存失败（LRU 淘汰后重试仍失败）：不阻断收尾", async () => {
    vi.mocked(globalThis.chrome.storage.local.set).mockRejectedValue(new Error("quota exceeded"));
    deps.runAsrPipeline.mockResolvedValue(TRANSCRIBED_BODY);

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("done");
    expect(state.clip.subtitleFetchState).toBe("ready");
  });
});

describe("maybeRunAsrFallback 空结果与失败", () => {
  it("纯空结果（failedChunks=0，无人声）：原因 asr-empty、detail 清空、asr-done 广播，不写缓存", async () => {
    clipState.setNoSubtitleDetail("（错误详情：HTTP 401）");
    deps.runAsrPipeline.mockResolvedValue([]);

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("empty");
    expect(deps.broadcastSubtitleStatus).toHaveBeenCalledWith("asr-done");
    expect(deps.commitNoSubtitle).not.toHaveBeenCalled();
    expect(storageHost.hasEntry(asrCacheKey())).toBe(false);
    expect(clipState.noSubtitleReason).toBe("asr-empty");
    expect(clipState.noSubtitleDetail).toBe("");
    const statusCalls = deps.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("未识别到语音内容"))).toBe(false);
  });

  it("管线失败（带 kind）：按 kind 归类 reason、无字幕出口逆事务，文案由出口统一拼", async () => {
    clipState.setSelectedSubtitleId("asr");
    clipState.setSubtitleBody(TRANSCRIBED_BODY);
    deps.runAsrPipeline.mockRejectedValue(
      Object.assign(new Error("HTTP 401: {\"message\":\"Invalid token\"}"), { kind: "asr-auth" })
    );

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("error");
    const statusCalls = deps.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("语音识别失败："))).toBe(false);
    expect(deps.broadcastSubtitleStatus).toHaveBeenCalledWith("asr-failed");
    expect(deps.commitNoSubtitle).toHaveBeenCalledTimes(1);
    expect(deps.commitNoSubtitle).toHaveBeenCalledWith({ noSubtitleReason: "asr-auth" });
    expect(state.clip.subtitleFetchState).toBe("empty");
    expect(state.clip.subtitleBody).toEqual([]);
    expect(state.clip.selectedSubtitleId).toBe("");
    expect(clipState.noSubtitleReason).toBe("asr-auth");
    expect(clipState.noSubtitleDetail).toBe("");
  });

  it("管线失败只带 kind（无 status/detail）：归类照旧，详情位空串", async () => {
    deps.runAsrPipeline.mockRejectedValue(Object.assign(new Error("boom"), { kind: "asr-media" }));

    await expect(fallback.maybeRunAsrFallback({ runId: RUN_ID })).resolves.toBe("error");

    expect(clipState.noSubtitleReason).toBe("asr-media");
    expect(clipState.noSubtitleDetail).toBe("");
  });

  it("管线失败未携带 kind：归 asr-unknown（不退回已删除的 asr-failed）", async () => {
    deps.runAsrPipeline.mockRejectedValue(new Error("音频解码失败"));

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("error");
    expect(deps.commitNoSubtitle).toHaveBeenCalledWith({ noSubtitleReason: "asr-unknown" });
    expect(clipState.noSubtitleReason).toBe("asr-unknown");
    expect(clipState.noSubtitleDetail).toBe("");
  });

  it("空串 failedKind 不当作类别读：归 asr-unknown 只因「没有失败信号」，状态码/报文不随之出现", async () => {
    deps.runAsrPipeline.mockImplementation(async ({ onAttemptOutcome }) => {
      onAttemptOutcome?.({
        totalChunks: 3,
        failedChunks: 3,
        elapsedMs: 61000,
        failedKind: "",
        failedStatus: 401,
        failedDetail: "{\"message\":\"Invalid token\"}"
      });
      return [];
    });

    await expect(fallback.maybeRunAsrFallback({ runId: RUN_ID })).resolves.toBe("empty");

    expect(clipState.noSubtitleReason).toBe("asr-unknown");
    expect(clipState.noSubtitleDetail).toBe("");
  });

  it("非空未知 failedKind 仍归 asr-unknown，但状态码照读（详情行出现）——空串用例的反面对照", async () => {
    deps.runAsrPipeline.mockImplementation(async ({ onAttemptOutcome }) => {
      onAttemptOutcome?.({
        totalChunks: 3,
        failedChunks: 3,
        elapsedMs: 61000,
        failedKind: "asr-not-a-known-kind",
        failedStatus: 401,
        failedDetail: "{\"message\":\"Invalid token\"}"
      });
      return [];
    });

    await expect(fallback.maybeRunAsrFallback({ runId: RUN_ID })).resolves.toBe("empty");

    expect(clipState.noSubtitleReason).toBe("asr-unknown");
    expect(clipState.noSubtitleDetail).toContain("HTTP 401");
  });

  it("管线失败的可展示状态码非 401（kind 缺失但带 status）：reason 与详情都不猜状态码", async () => {
    deps.runAsrPipeline.mockRejectedValue(
      Object.assign(new Error("HTTP 500"), { status: 500, detail: "internal error" })
    );

    await expect(fallback.maybeRunAsrFallback({ runId: RUN_ID })).resolves.toBe("error");

    expect(clipState.noSubtitleReason).toBe("asr-unknown");
    expect(clipState.noSubtitleDetail).toBe("");
  });

  it("同一视频内的失败原因不清：第二次失败覆盖 reason/detail，不被 reset", async () => {
    deps.runAsrPipeline.mockImplementation(async ({ onAttemptOutcome }) => {
      onAttemptOutcome?.({
        totalChunks: 3,
        failedChunks: 3,
        elapsedMs: 61000,
        failedKind: "asr-auth",
        failedStatus: 401,
        failedDetail: "{\"message\":\"Invalid token\"}"
      });
      return [];
    });
    await expect(fallback.maybeRunAsrFallback({ runId: RUN_ID })).resolves.toBe("empty");
    expect(clipState.noSubtitleReason).toBe("asr-auth");
    expect(clipState.noSubtitleDetail).toContain("HTTP 401");

    clipState.setFetchRunId(2);
    deps.runAsrPipeline.mockRejectedValue(
      Object.assign(new Error("HTTP 429"), { kind: "asr-ratelimit" })
    );
    await expect(fallback.maybeRunAsrFallback({ runId: 2 })).resolves.toBe("error");

    expect(clipState.noSubtitleReason).toBe("asr-ratelimit");
    expect(clipState.noSubtitleDetail).toBe("");
  });

  it("stale run（转写中切换视频）：任务不中止、缓存照落、asr-done 照发、UI 零写入", async () => {
    const pending = stubPendingPipeline();
    const promise = fallback.maybeRunAsrFallback({ runId: RUN_ID });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));

    const statusCallsAtSwitch = deps.setStatus.mock.calls.length;
    const acceptCallsAtSwitch = deps.acceptSubtitle.mock.calls.length;

    clipState.setBvid("BV1other");
    clipState.setFetchRunId(2);
    pending[0].resolve(TRANSCRIBED_BODY);

    await expect(promise).resolves.toBe("done");

    await expect(loadSubtitleFromCache(asrCacheKey())).resolves.toEqual(TRANSCRIBED_BODY);
    expect(deps.broadcastSubtitleStatus.mock.calls.map((c) => c[0])).toEqual([
      "asr-transcribing",
      "asr-done"
    ]);
    expect(deps.setStatus).toHaveBeenCalledTimes(statusCallsAtSwitch);
    expect(deps.acceptSubtitle).toHaveBeenCalledTimes(acceptCallsAtSwitch);
    expect(deps.commitNoSubtitle).not.toHaveBeenCalled();
    expect(state.clip.subtitleFetchState).toBe("idle");
  });

  it("stale run（切视频后空结果到站）：asr-done 照发、UI 零写入，调用方静默让位", async () => {
    const pending = stubPendingPipeline();
    const promise = fallback.maybeRunAsrFallback({ runId: RUN_ID });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));

    const statusCallsAtSwitch = deps.setStatus.mock.calls.length;
    clipState.setBvid("BV1other");
    clipState.setFetchRunId(2);
    pending[0].resolve([]);

    await expect(promise).rejects.toMatchObject({ code: "STALE_RUN" });

    expect(deps.broadcastSubtitleStatus.mock.calls.map((c) => c[0])).toEqual([
      "asr-transcribing",
      "asr-done"
    ]);
    expect(deps.setStatus).toHaveBeenCalledTimes(statusCallsAtSwitch);
    expect(deps.commitNoSubtitle).not.toHaveBeenCalled();
    expect(storageHost.hasEntry(asrCacheKey())).toBe(false);
  });

  it("stale run（切视频后失败到站）：asr-failed 照发、UI 零写入", async () => {
    const pending = stubPendingPipeline();
    const promise = fallback.maybeRunAsrFallback({ runId: RUN_ID });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));

    const statusCallsAtSwitch = deps.setStatus.mock.calls.length;
    clipState.setBvid("BV1other");
    clipState.setFetchRunId(2);
    pending[0].reject(new Error("音频解码失败"));

    await expect(promise).rejects.toMatchObject({ code: "STALE_RUN" });

    expect(deps.broadcastSubtitleStatus.mock.calls.map((c) => c[0])).toEqual([
      "asr-transcribing",
      "asr-failed"
    ]);
    expect(deps.setStatus).toHaveBeenCalledTimes(statusCallsAtSwitch);
    expect(deps.commitNoSubtitle).not.toHaveBeenCalled();
  });

  it("stale 进度门控：转写中切视频，onProgress 不再触发 setStatus", async () => {
    let progress: ((message: string) => void) | undefined;
    let resolvePipeline: ((body: SubtitleItem[]) => void) | undefined;
    deps.runAsrPipeline.mockImplementation(
      ({ onProgress }) =>
        new Promise((resolve) => {
          progress = onProgress;
          resolvePipeline = resolve;
        })
    );
    const promise = fallback.maybeRunAsrFallback({ runId: RUN_ID });
    await vi.waitFor(() => expect(progress).toBeTruthy());

    progress!("语音识别中 1 片…");
    const callsAfterFresh = deps.setStatus.mock.calls.length;
    expect(String(deps.setStatus.mock.calls[callsAfterFresh - 1][0])).toContain("语音识别中 1 片…");

    clipState.setBvid("BV1other");
    clipState.setFetchRunId(2);
    progress!("语音识别中 2 片…");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.setStatus.mock.calls.length).toBe(callsAfterFresh);

    resolvePipeline!(TRANSCRIBED_BODY);
    await expect(promise).resolves.toBe("done");
    await expect(loadSubtitleFromCache(asrCacheKey())).resolves.toEqual(TRANSCRIBED_BODY);
  });

  it("非 stale 的 runId 过期（未发起转写前的守卫）：直接抛 STALE_RUN", async () => {
    await expect(fallback.maybeRunAsrFallback({ runId: 999 })).rejects.toMatchObject({
      code: "STALE_RUN"
    });
    expect(deps.runAsrPipeline).not.toHaveBeenCalled();
    expect(deps.broadcastSubtitleStatus).not.toHaveBeenCalled();
  });
});

describe("maybeRunAsrFallback 整轮自动重试", () => {
  it("空 + 存在片失败（failedChunks>0）：自动重试一次，重试成功收尾 done", async () => {
    let calls = 0;
    deps.runAsrPipeline.mockImplementation(async ({ onAttemptOutcome }) => {
      calls += 1;
      if (calls === 1) {
        onAttemptOutcome?.({ totalChunks: 3, failedChunks: 3, elapsedMs: 1200 });
        return [];
      }
      onAttemptOutcome?.({ totalChunks: 3, failedChunks: 0, elapsedMs: 1800 });
      return TRANSCRIBED_BODY;
    });

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("done");
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(2);
    expect(deps.sleepFor).toHaveBeenCalledTimes(1);
    expect(deps.sleepFor).toHaveBeenCalledWith(2000);
    await expect(loadSubtitleFromCache(asrCacheKey())).resolves.toEqual(TRANSCRIBED_BODY);
    expect(state.clip.subtitleBody).toEqual([
      { from: 0, to: 2.4, content: "你好世界" },
      { from: 3, to: 290, content: "收尾长句" }
    ]);
    expect(clipState.noSubtitleReason).toBe(null);
    expect(deps.broadcastSubtitleStatus.mock.calls.map((c) => c[0])).toEqual([
      "asr-transcribing",
      "asr-done"
    ]);
    const statusCalls = deps.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("正在自动重试"))).toBe(true);
    expect(statusCalls.some((s) => s.includes("语音识别完成，已生成 3 条字幕。"))).toBe(true);
  });

  it("自动重试后仍空（failedChunks>0，带 kind）：终态 empty、按 kind 归类、asr-done 只广播一次", async () => {
    deps.runAsrPipeline.mockImplementation(async ({ onAttemptOutcome }) => {
      onAttemptOutcome?.({
        totalChunks: 3,
        failedChunks: 3,
        elapsedMs: 1500,
        failedKind: "asr-auth",
        failedStatus: 401,
        failedDetail: "{\"message\":\"Invalid token\"}"
      });
      return [];
    });

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("empty");
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(2);
    expect(clipState.noSubtitleReason).toBe("asr-auth");
    expect(clipState.noSubtitleDetail).toBe(
      getAsrFailureNotice("asr-auth", { status: 401, detail: "{\"message\":\"Invalid token\"}" }).detail
    );
    expect(deps.broadcastSubtitleStatus.mock.calls.map((c) => c[0])).toEqual([
      "asr-transcribing",
      "asr-done"
    ]);
    expect(deps.commitNoSubtitle).not.toHaveBeenCalled();
    const statusCalls = deps.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("正在自动重试"))).toBe(true);
    expect(statusCalls.some((s) => s.includes("片转写未成功"))).toBe(false);
    expect(storageHost.hasEntry(asrCacheKey())).toBe(false);
  });

  it("自动重试后仍空（failedChunks>0，无 kind）：归 asr-unknown、detail 清空", async () => {
    deps.runAsrPipeline.mockImplementation(async ({ onAttemptOutcome }) => {
      clipState.setNoSubtitleDetail("（错误详情：HTTP 999）");
      onAttemptOutcome?.({ totalChunks: 3, failedChunks: 3, elapsedMs: 1500 });
      return [];
    });

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("empty");
    expect(clipState.noSubtitleReason).toBe("asr-unknown");
    expect(clipState.noSubtitleDetail).toBe("");
  });

  it("存在片失败但非快速失败（elapsed 超阈值）：不自动重试，按 kind 归类", async () => {
    deps.runAsrPipeline.mockImplementation(async ({ onAttemptOutcome }) => {
      onAttemptOutcome?.({ totalChunks: 5, failedChunks: 5, elapsedMs: 61000, failedKind: "asr-server" });
      return [];
    });

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("empty");
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1);
    expect(deps.sleepFor).not.toHaveBeenCalled();
    expect(clipState.noSubtitleReason).toBe("asr-server");
  });

  it("纯空结果（failedChunks=0，无人声）：不自动重试，原因 asr-empty（文案出口不在本路径）", async () => {
    deps.runAsrPipeline.mockImplementation(async ({ onAttemptOutcome }) => {
      onAttemptOutcome?.({ totalChunks: 3, failedChunks: 0, elapsedMs: 4000 });
      return [];
    });

    const result = await fallback.maybeRunAsrFallback({ runId: RUN_ID });

    expect(result).toBe("empty");
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1);
    expect(deps.sleepFor).not.toHaveBeenCalled();
    expect(clipState.noSubtitleReason).toBe("asr-empty");
    expect(clipState.noSubtitleDetail).toBe("");
    const statusCalls = deps.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("未识别到语音内容"))).toBe(false);
  });

  it("重试窗口内切视频：重试照跑、终态静默让位（asr-done 广播 + 零 UI 写入）", async () => {
    const deferred: Array<(body: SubtitleItem[]) => void> = [];
    deps.runAsrPipeline.mockImplementation(({ onAttemptOutcome }) => {
      onAttemptOutcome?.({ totalChunks: 3, failedChunks: 3, elapsedMs: 1000 });
      return new Promise((resolve) => {
        deferred.push(resolve);
      });
    });
    const promise = fallback.maybeRunAsrFallback({ runId: RUN_ID });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));

    deferred[0]([]);
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(2));
    expect(deps.sleepFor).toHaveBeenCalledTimes(1);

    const statusCallsAtSwitch = deps.setStatus.mock.calls.length;
    clipState.setBvid("BV1other");
    clipState.setFetchRunId(2);
    deferred[1]([]);

    await expect(promise).rejects.toMatchObject({ code: "STALE_RUN" });
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(2);
    expect(deps.broadcastSubtitleStatus.mock.calls.map((c) => c[0])).toEqual([
      "asr-transcribing",
      "asr-done"
    ]);
    expect(deps.setStatus).toHaveBeenCalledTimes(statusCallsAtSwitch);
    expect(deps.commitNoSubtitle).not.toHaveBeenCalled();
  });
});

describe("工厂单元导出", () => {
  it("hasActiveAsrTranscribe：无转写为 false，发起后为 true，完成清理后回到 false", async () => {
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(false);

    const pending = stubPendingPipeline();
    const promise = fallback.maybeRunAsrFallback({ runId: RUN_ID });
    await vi.waitFor(() =>
      expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(true)
    );

    pending[0].resolve(TRANSCRIBED_BODY);
    await promise;
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(false);
  });

  it("awaitActiveAsrTranscribe：无进行中转写时静默返回，不触碰 UI", async () => {
    await expect(
      fallback.awaitActiveAsrTranscribe({ runId: RUN_ID, bvid: BVID, cid: CID })
    ).resolves.toBeUndefined();
    expect(deps.setStatus).not.toHaveBeenCalled();
    expect(deps.broadcastSubtitleStatus).not.toHaveBeenCalled();
  });

  it("awaitActiveAsrTranscribe 空结果（带 kind）：写原因与详情，并经状态栏出完整文案", async () => {
    const pending = stubPendingPipeline();
    const first = fallback.maybeRunAsrFallback({ runId: RUN_ID });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));

    const waiter = fallback.awaitActiveAsrTranscribe({ runId: RUN_ID, bvid: BVID, cid: CID });
    pending[0].resolve([]);
    await expect(waiter).resolves.toBeUndefined();
    await first;

    expect(clipState.noSubtitleReason).toBe("asr-empty");
    expect(clipState.noSubtitleDetail).toBe("");
    const statusCalls = deps.setStatus.mock.calls.map((c) => String(c[0]));
    expect(
      statusCalls.some((s) => s.includes("当前视频无字幕。") && s.includes("未识别到语音内容"))
    ).toBe(true);
    expect(deps.broadcastSubtitleStatus).toHaveBeenCalledWith("asr-done");
  });
});
