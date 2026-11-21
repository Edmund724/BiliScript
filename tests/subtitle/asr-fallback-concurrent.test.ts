import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost, type ChromeHost } from "../helpers/chrome-host.js";
import { createAsrFallback } from "../../extension/asr/fallback.js";
import type { AsrFallback, CreateAsrFallbackDeps, SubtitleItem } from "../../extension/asr/fallback.js";
import { state, clipState } from "../../extension/core/state.js";
import {
  getSubtitleCacheKey,
  loadSubtitleFromCache,
  parseSubtitleCacheKey,
  setSubtitleCacheWriteInterceptorForTests
} from "../../extension/subtitle/cache.js";
import {
  acceptSubtitle as realAcceptSubtitle,
  commitNoSubtitle as realCommitNoSubtitle,
  configureCommitUi
} from "../../extension/subtitle/commit.js";

const BVID = "BV1test000000";
const CID = "101";
const VIDEO_DURATION = 300;

const BVID_B = "BV1other00000";
const CID_B = "202";

const PROVIDER = {
  id: "p1",
  type: "openai-transcriptions",
  name: "本地 Whisper",
  model: "whisper-large-v3",
  supportsTimestamps: true
};

const TRANSCRIBED_BODY = [
  { from: 0, to: 1.2, content: "五小时转写成果" },
  { from: 1.5, to: 290, content: "第二条" }
];

function asrCacheKey({ bvid = BVID, cid = CID } = {}) {
  return getSubtitleCacheKey({
    bvid,
    cid,
    identity: { kind: "asr", providerId: "p1", model: "whisper-large-v3", lang: "auto" }
  });
}

type DepsMock = {
  getSettings: Mock<CreateAsrFallbackDeps["getSettings"]>;
  loadProviders: Mock<CreateAsrFallbackDeps["loadProviders"]>;
  setStatus: Mock<CreateAsrFallbackDeps["setStatus"]>;
  acceptSubtitle: Mock<typeof realAcceptSubtitle>;
  commitNoSubtitle: Mock<typeof realCommitNoSubtitle>;
  runAsrPipeline: Mock<CreateAsrFallbackDeps["runAsrPipeline"]>;
  broadcastSubtitleStatus: Mock<CreateAsrFallbackDeps["broadcastSubtitleStatus"]>;
};

let storageHost: ChromeHost;
let recordedIdbWrites: Array<{ op: string; bvid: string; cid: string; trackKey?: string }> = [];
let deps: DepsMock;
let fallback: AsrFallback;

beforeEach(() => {
  resetModuleState();
  storageHost = installChromeHost();
  recordedIdbWrites = [];
  setSubtitleCacheWriteInterceptorForTests((ctx) => {
    recordedIdbWrites.push({
      op: ctx.op,
      bvid: ctx.bvid,
      cid: ctx.cid,
      trackKey: ctx.trackKey
    });
  });

  configureCommitUi({ setStatus: vi.fn() });
  const preview = document.createElement("textarea");
  preview.id = "biliscript-preview";
  document.body.appendChild(preview);

  clipState.setFetchRunId(1);
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

  deps = {
    getSettings: vi.fn<CreateAsrFallbackDeps["getSettings"]>(async () => state.settings),
    loadProviders: vi.fn<CreateAsrFallbackDeps["loadProviders"]>(async () => [PROVIDER]),
    setStatus: vi.fn<CreateAsrFallbackDeps["setStatus"]>(),
    acceptSubtitle: vi.fn(realAcceptSubtitle),
    commitNoSubtitle: vi.fn(realCommitNoSubtitle),
    runAsrPipeline: vi.fn<CreateAsrFallbackDeps["runAsrPipeline"]>(async () => []),
    broadcastSubtitleStatus: vi.fn<CreateAsrFallbackDeps["broadcastSubtitleStatus"]>()
  };
  fallback = createAsrFallback(deps);
});

function stubPendingPipeline() {
  const pending: Array<{ resolve: (body: SubtitleItem[]) => void; reject: (reason?: unknown) => void }> = [];
  deps.runAsrPipeline.mockImplementation(() => {
    return new Promise<SubtitleItem[]>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  });
  return pending;
}

function cacheKeyWriteCount(cacheKey: string) {
  const parsed = parseSubtitleCacheKey(cacheKey);
  if (!parsed || parsed.kind !== "raw") {
    return 0;
  }
  return recordedIdbWrites.filter(
    (entry) =>
      entry.op === "put-raw" &&
      entry.bvid === parsed.bvid &&
      entry.cid === parsed.cid &&
      entry.trackKey === parsed.trackKey
  ).length;
}

describe("ASR 转写中并发调用（共享转写、成果落缓存）", () => {
  it("转写 pending 时第二次调用命中共享单元：不重启、成果写缓存一次、发起者让位等待者收尾", async () => {
    const pending = stubPendingPipeline();

    const first = fallback.maybeRunAsrFallback({ runId: 1 });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));

    clipState.setFetchRunId(2);
    const second = fallback.maybeRunAsrFallback({ runId: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1);

    pending[0].resolve(TRANSCRIBED_BODY);

    const [firstOutcome, secondOutcome] = await Promise.allSettled([first, second]);

    expect(cacheKeyWriteCount(asrCacheKey())).toBe(1);
    await expect(loadSubtitleFromCache(asrCacheKey())).resolves.toEqual(TRANSCRIBED_BODY);

    expect(secondOutcome.status).toBe("fulfilled");
    expect(firstOutcome.status).toBe("rejected");
    if (secondOutcome.status !== "fulfilled" || firstOutcome.status !== "rejected") {
      throw new Error("并发收尾状态与预期不符（断言失败时不会走到这里）");
    }
    expect(secondOutcome.value).toBe("done");
    expect(firstOutcome.reason).toMatchObject({ code: "STALE_RUN" });
    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toEqual(TRANSCRIBED_BODY);
    const doneCount = deps.setStatus.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("语音识别完成")).length;
    expect(doneCount).toBe(1);
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(false);
  });

  it("转写完成写入缓存后，下一次调用缓存命中、不再转写（用户单独抓取不重转）", async () => {
    const pending = stubPendingPipeline();

    const first = fallback.maybeRunAsrFallback({ runId: 1 });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));
    pending[0].resolve(TRANSCRIBED_BODY);
    await first;
    expect(cacheKeyWriteCount(asrCacheKey())).toBe(1);

    clipState.setFetchRunId(2);
    const result = await fallback.maybeRunAsrFallback({ runId: 2 });
    expect(result).toBe("done");
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1);
    const statusCalls = deps.setStatus.mock.calls.map((c) => String(c[0]));
    expect(statusCalls.some((s) => s.includes("缓存命中"))).toBe(true);
  });

  it("转写进行中走 awaitActiveAsrTranscribe（fetcher 失败兜底路径）：跟随共享转写收尾，不重复转写", async () => {
    const pending = stubPendingPipeline();

    const first = fallback.maybeRunAsrFallback({ runId: 1 });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));

    clipState.setFetchRunId(2);
    const waiter = fallback.awaitActiveAsrTranscribe({ runId: 2, bvid: BVID, cid: CID });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1);

    pending[0].resolve(TRANSCRIBED_BODY);
    await expect(waiter).resolves.toBeUndefined();
    await first.catch(() => {});

    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toEqual(TRANSCRIBED_BODY);
    expect(cacheKeyWriteCount(asrCacheKey())).toBe(1);
    const doneCount = deps.setStatus.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("语音识别完成")).length;
    expect(doneCount).toBe(1);
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(false);
  });

  it("共享转写失败时 awaitActiveAsrTranscribe 静默退出（发起者路径负责文案）", async () => {
    const pending = stubPendingPipeline();

    const first = fallback.maybeRunAsrFallback({ runId: 1 });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));

    const waiter = fallback.awaitActiveAsrTranscribe({ runId: 2, bvid: BVID, cid: CID });
    pending[0].reject(
      Object.assign(new Error("HTTP 401: {\"message\":\"Invalid token\"}"), {
        kind: "asr-auth",
        status: 401,
        detail: "{\"message\":\"Invalid token\"}"
      })
    );

    await expect(waiter).resolves.toBeUndefined();
    await expect(first).resolves.toBe("error");
    expect(deps.acceptSubtitle).not.toHaveBeenCalled();
    expect(deps.commitNoSubtitle).toHaveBeenCalledTimes(1);
    expect(state.clip.subtitleFetchState).toBe("empty");
    expect(clipState.noSubtitleReason).toBe("asr-auth");
  });
});

describe("转写与视频切换解耦（Map<cacheKey> 共享单元）", () => {
  it("两个不同视频的转写并行（Map 双记录）：A 完成只清 A 的键，成果与 UI 不串台", async () => {
    const pending = stubPendingPipeline();

    const first = fallback.maybeRunAsrFallback({ runId: 1 });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(true);

    clipState.setBvid(BVID_B);
    clipState.setCid(CID_B);
    clipState.setFetchRunId(2);
    const second = fallback.maybeRunAsrFallback({ runId: 2 });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(2));

    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(true);
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID_B, cid: CID_B })).toBe(true);

    const statusCallsBeforeA = deps.setStatus.mock.calls.length;
    pending[0].resolve(TRANSCRIBED_BODY);
    await expect(first).resolves.toBe("done");
    expect(deps.setStatus).toHaveBeenCalledTimes(statusCallsBeforeA);
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(false);
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID_B, cid: CID_B })).toBe(true);

    pending[1].resolve([{ from: 0, to: 250, content: "B 视频成果" }]);
    await expect(second).resolves.toBe("done");

    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toEqual([{ from: 0, to: 250, content: "B 视频成果" }]);
    await expect(loadSubtitleFromCache(asrCacheKey())).resolves.toEqual(TRANSCRIBED_BODY);
    await expect(loadSubtitleFromCache(asrCacheKey({ bvid: BVID_B, cid: CID_B }))).resolves.toEqual([
      { from: 0, to: 250, content: "B 视频成果" }
    ]);
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID_B, cid: CID_B })).toBe(false);
  });

  it("切走再切回原视频：共享单元命中不重启转写，新 runId 收尾自动接上", async () => {
    const pending = stubPendingPipeline();

    const first = fallback.maybeRunAsrFallback({ runId: 1 });
    await vi.waitFor(() => expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1));

    clipState.setBvid(BVID_B);
    clipState.setCid(CID_B);
    clipState.setFetchRunId(2);
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(true);

    clipState.setBvid(BVID);
    clipState.setCid(CID);
    clipState.setFetchRunId(3);
    const third = fallback.maybeRunAsrFallback({ runId: 3 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deps.runAsrPipeline).toHaveBeenCalledTimes(1);

    pending[0].resolve(TRANSCRIBED_BODY);

    await expect(third).resolves.toBe("done");
    await expect(first).rejects.toMatchObject({ code: "STALE_RUN" });

    expect(state.clip.subtitleFetchState).toBe("ready");
    expect(state.clip.subtitleBody).toEqual(TRANSCRIBED_BODY);
    expect(cacheKeyWriteCount(asrCacheKey())).toBe(1);
    expect(fallback.hasActiveAsrTranscribe({ bvid: BVID, cid: CID })).toBe(false);
  });
});
