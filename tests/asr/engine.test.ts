import { describe, expect, it, vi } from "vitest";
import {
  createTranscriptionEngine,
  transcribeChunk
} from "../../extension/asr/engine.js";
import type { AsrTranscribeResult, TranscribeChunk, TranscribeFn } from "../../extension/asr/engine.js";
import * as errorHelpers from "../../extension/shared/error-helpers.js";

function makeChunk(index: number, extra: Partial<TranscribeChunk> & { fast?: boolean } = {}): TranscribeChunk {
  return {
    index,
    startSec: index * 600,
    durationSec: 600,
    wavBlob: new Blob([`wav-${index}`], { type: "audio/wav" }),
    ...extra
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeCountingTranscribe(delayMs = 5) {
  let active = 0;
  let peak = 0;
  const transcribe: TranscribeFn = async (chunk) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, delayMs));
    active -= 1;
    return { text: `片 ${chunk.index}` };
  };
  return { transcribe, getPeak: () => peak };
}

function makeRetryableError(message = "转写请求失败") {
  return Object.assign(new Error(message), { retryable: true });
}

describe("transcribeChunk 单片语义（镜像 pipeline transcribeChunk）", () => {
  it("返回 { ...result, durationSec }；进度经注入 transcribe 的 ctx.onProgress 透传", async () => {
    const onProgress = vi.fn();
    const transcribe = vi.fn(async (chunk, ctx) => {
      ctx.onProgress();
      ctx.onProgress();
      return { text: "你好", segments: [{ start: 0, end: 1, text: "你" }] };
    });
    const chunk = makeChunk(2, { durationSec: 1200 });

    const result = await transcribeChunk({ chunk, transcribe, onProgress });

    expect(result).toEqual({
      text: "你好",
      segments: [{ start: 0, end: 1, text: "你" }],
      durationSec: 1200
    });
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, "语音识别中 3 片…");
    expect(onProgress).toHaveBeenNthCalledWith(2, "语音识别中 3 片…");
  });

  it("可重试错误（error.retryable=true）：经 retryAsync(2, 500) 重试后成功", async () => {
    let attempts = 0;
    const transcribe = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw makeRetryableError();
      }
      return { text: "重试成功" };
    });

    const result = await transcribeChunk({ chunk: makeChunk(0), transcribe });

    expect(result).toEqual({ text: "重试成功", durationSec: 600 });
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("不可重试错误直接上抛（一次尝试，不重试）", async () => {
    const transcribe = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(transcribeChunk({ chunk: makeChunk(0), transcribe })).rejects.toThrow("boom");
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
});

describe("createTranscriptionEngine 活队列调度", () => {
  it("并发上限 ≤5：12 片连续 push，峰值并发恰为 5，全部完成", async () => {
    const counting = makeCountingTranscribe(5);
    const engine = createTranscriptionEngine({ transcribe: counting.transcribe, concurrency: 5 });

    for (let i = 0; i < 12; i += 1) {
      expect(engine.push(makeChunk(i))).toBe(true);
    }
    const summary = await engine.close();

    expect(counting.getPeak()).toBeLessThanOrEqual(5);
    expect(counting.getPeak()).toBe(5);
    expect(summary).toMatchObject({ acceptedChunks: 12, completedChunks: 12, failedChunks: 0 });
  });

  it("活喂入：push 发生在部分片仍在途时——新片占满空位、超出部分排队，全部被处理", async () => {
    const gates = new Map<number, Deferred<AsrTranscribeResult>>();
    const transcribe = vi.fn(async (chunk: TranscribeChunk & { fast?: boolean }) => {
      if (chunk.fast) {
        return { text: `fast-${chunk.index}` };
      }
      const gate = makeDeferred<AsrTranscribeResult>();
      gates.set(chunk.index, gate);
      return gate.promise;
    });
    const delivered: Array<{ index: number; text: string }> = [];
    const engine = createTranscriptionEngine({
      transcribe,
      concurrency: 5,
      onChunkResult: (chunk, result) => delivered.push({ index: chunk.index, text: result.text })
    });

    engine.push(makeChunk(0));
    engine.push(makeChunk(1));
    engine.push(makeChunk(2));
    expect(transcribe).toHaveBeenCalledTimes(3);

    engine.push(makeChunk(3, { fast: true }));
    engine.push(makeChunk(4, { fast: true }));
    engine.push(makeChunk(5, { fast: true }));
    expect(transcribe).toHaveBeenCalledTimes(5);

    for (const gate of gates.values()) {
      gate.resolve({ text: "slow" });
    }
    const summary = await engine.close();

    expect(transcribe).toHaveBeenCalledTimes(6);
    expect(summary).toMatchObject({ acceptedChunks: 6, completedChunks: 6, failedChunks: 0 });
    expect(delivered).toHaveLength(6);
  });

  it("close 是流结束标记：在途 + 排队片全部消化后才 resolve", async () => {
    let gatedCount = 0;
    const gates: Array<Deferred<AsrTranscribeResult>> = [];
    const transcribe = vi.fn(async () => {
      if (gatedCount < 5) {
        gatedCount += 1;
        const gate = makeDeferred<AsrTranscribeResult>();
        gates.push(gate);
        return gate.promise;
      }
      return { text: "late" };
    });
    const engine = createTranscriptionEngine({ transcribe });

    for (let i = 0; i < 7; i += 1) {
      engine.push(makeChunk(i));
    }
    const closing = engine.close();
    gates.forEach((gate) => gate.resolve({ text: "t" }));

    const summary = await closing;
    expect(transcribe).toHaveBeenCalledTimes(7);
    expect(summary).toMatchObject({ acceptedChunks: 7, completedChunks: 7, droppedByAbort: 0 });
  });

  it("close 后 push 拒绝；close 幂等；空引擎 close 立即返回零汇总", async () => {
    const transcribe = vi.fn(async () => ({ text: "x" }));
    const engine = createTranscriptionEngine({ transcribe });

    const empty = await engine.close();
    expect(empty).toEqual({
      acceptedChunks: 0,
      completedChunks: 0,
      failedChunks: 0,
      droppedByAbort: 0,
      failures: [],
      representativeFailure: null,
      aborted: false
    });
    expect(engine.push(makeChunk(0))).toBe(false);
    expect(transcribe).not.toHaveBeenCalled();

    const again = await engine.close();
    expect(again).toBe(empty);
  });
});

describe("失败计数（Q8a）与逐片交付", () => {
  it("可重试错误重试成功不计失败；重试耗尽仍失败 → 跳过并计 failedChunks", async () => {
    const transcribe = vi.fn(async () => {
      throw makeRetryableError("HTTP 503");
    });
    const engine = createTranscriptionEngine({ transcribe });

    engine.push(makeChunk(0));
    const summary = await engine.close();

    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(summary.completedChunks).toBe(0);
    expect(summary.failedChunks).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].chunk.index).toBe(0);
    expect(summary.failures[0].error).toMatchObject({ message: "HTTP 503", retryable: true });
  });

  it("不可重试错误：该片一次尝试即跳过计 failed，失败片的 chunk 数据不影响其余片", async () => {
    const transcribe = vi.fn(async (chunk) => {
      if (chunk.index === 1) {
        throw new Error("平台 baseUrl 未配置");
      }
      return { text: `文本 ${chunk.index}` };
    });
    const delivered: Array<{ index: number; text: string }> = [];
    const engine = createTranscriptionEngine({
      transcribe,
      onChunkResult: (chunk, result) => delivered.push({ index: chunk.index, text: result.text })
    });

    [0, 1, 2, 3].forEach((i) => engine.push(makeChunk(i)));
    const summary = await engine.close();

    expect(transcribe).toHaveBeenCalledTimes(4);
    expect(summary).toMatchObject({ acceptedChunks: 4, completedChunks: 3, failedChunks: 1 });
    expect(summary.failures[0].chunk.index).toBe(1);
    const byIndex = [...delivered].sort((a, b) => a.index - b.index);
    expect(byIndex.map((d) => d.index)).toEqual([0, 2, 3]);
    expect(byIndex.map((d) => d.text)).toEqual(["文本 0", "文本 2", "文本 3"]);
  });

  it("逐片交付按完成顺序回调（非 push 顺序），次数 = 成功片数；交付回调抛错不影响调度", async () => {
    const gates: Array<Deferred<AsrTranscribeResult>> = [];
    const transcribe = vi.fn(async () => {
      const gate = makeDeferred<AsrTranscribeResult>();
      gates.push(gate);
      return gate.promise;
    });
    const deliveryAttempts: number[] = [];
    const delivered: Array<{ index: number; text: string }> = [];
    const engine = createTranscriptionEngine({
      transcribe,
      onChunkResult: (chunk, result) => {
        deliveryAttempts.push(chunk.index);
        if (deliveryAttempts.length === 1) {
          throw new Error("port 已断开");
        }
        delivered.push({ index: chunk.index, text: result.text });
      }
    });

    [0, 1, 2].forEach((i) => engine.push(makeChunk(i)));
    await new Promise((r) => setTimeout(r, 0));
    gates[2].resolve({ text: "C" });
    gates[0].resolve({ text: "A" });
    gates[1].resolve({ text: "B" });
    const summary = await engine.close();

    expect(deliveryAttempts).toEqual([2, 0, 1]);
    expect(delivered).toEqual([
      { index: 0, text: "A" },
      { index: 1, text: "B" }
    ]);
    expect(summary.completedChunks).toBe(3);
    expect(summary.failedChunks).toBe(0);
  });
});

describe("代表失败（representativeFailure：首个不可重试失败优先）", () => {
  it("无失败 → null", async () => {
    const engine = createTranscriptionEngine({ transcribe: async () => ({ text: "x" }) });
    engine.push(makeChunk(0));
    const summary = await engine.close();

    expect(summary.failures).toEqual([]);
    expect(summary.representativeFailure).toBeNull();
  });

  it("只有可重试失败 → 取首个失败（没有更好的候选）", async () => {
    const engine = createTranscriptionEngine({
      transcribe: async () => {
        throw makeHttpErrorForSummary(500, "internal error");
      }
    });
    engine.push(makeChunk(0));
    const summary = await engine.close();

    expect(summary.failures).toHaveLength(1);
    expect(summary.representativeFailure).toBe(summary.failures[0]);
  });

  it("首个可重试失败在前、不可重试失败在后 → 取后者（401 不被网络抖动淹没）", async () => {
    const transcribe = vi.fn(async (chunk: TranscribeChunk) => {
      if (chunk.index === 0) {
        throw makeHttpErrorForSummary(503, "service unavailable");
      }
      throw makeHttpErrorForSummary(401, "invalid api key");
    });
    const engine = createTranscriptionEngine({ transcribe });

    engine.push(makeChunk(0));
    engine.push(makeChunk(1));
    const summary = await engine.close();

    expect(summary.failures.map((f) => f.chunk.index)).toEqual([1, 0]);
    expect(summary.failures[0].error).toMatchObject({ status: 401 });
    expect(summary.failures[1].error).toMatchObject({ status: 503 });
    expect(summary.failedChunks).toBe(2);
    expect(summary.representativeFailure?.chunk.index).toBe(1);
    expect(summary.representativeFailure?.error).toMatchObject({ status: 401 });
  });

  it("不可重试失败（无状态码的配置类错误）同样优先于在前的可重试失败", async () => {
    const engine = createTranscriptionEngine({
      transcribe: async (chunk) => {
        if (chunk.index === 0) {
          throw makeHttpErrorForSummary(429, "rate limited");
        }
        throw Object.assign(new Error("平台 baseUrl 未配置"), { kind: "no-asr-config" });
      }
    });

    engine.push(makeChunk(0));
    engine.push(makeChunk(1));
    const summary = await engine.close();

    expect(summary.failures.map((f) => f.chunk.index)).toEqual([1, 0]);
    expect(summary.representativeFailure?.chunk.index).toBe(1);
    expect(summary.representativeFailure?.error).toMatchObject({ kind: "no-asr-config" });
  });
});

function makeHttpErrorForSummary(status: number, detail = "") {
  return Object.assign(new Error(`HTTP ${status}${detail ? `: ${detail}` : ""}`), { status });
}

describe("中止探针", () => {
  it("isAborted 置真后不再发起新转写，排队片丢弃清点，close 如实返回", async () => {
    let aborted = false;
    const gates: Array<Deferred<AsrTranscribeResult>> = [];
    const transcribe = vi.fn(async () => {
      const gate = makeDeferred<AsrTranscribeResult>();
      gates.push(gate);
      return gate.promise;
    });
    const delivered: number[] = [];
    const engine = createTranscriptionEngine({
      transcribe,
      concurrency: 5,
      isAborted: () => aborted,
      onChunkResult: (chunk) => delivered.push(chunk.index)
    });

    for (let i = 0; i < 8; i += 1) {
      engine.push(makeChunk(i));
    }
    expect(transcribe).toHaveBeenCalledTimes(5);

    aborted = true;
    expect(engine.push(makeChunk(8))).toBe(false);

    gates.forEach((gate) => gate.resolve({ text: "在途完成" }));
    const summary = await engine.close();

    expect(transcribe).toHaveBeenCalledTimes(5);
    expect(summary).toEqual({
      acceptedChunks: 8,
      completedChunks: 5,
      failedChunks: 0,
      droppedByAbort: 3,
      failures: [],
      representativeFailure: null,
      aborted: true
    });
    expect(delivered).toHaveLength(5);
  });

  it("在途片失败 + 中止并存：计数如实（completed + failed + dropped = accepted）", async () => {
    let aborted = false;
    const gates: Array<{ index: number; gate: Deferred<AsrTranscribeResult> }> = [];
    const transcribe = vi.fn(async (chunk) => {
      const gate = makeDeferred<AsrTranscribeResult>();
      gates.push({ index: chunk.index, gate });
      return gate.promise;
    });
    const engine = createTranscriptionEngine({
      transcribe,
      concurrency: 5,
      isAborted: () => aborted
    });

    for (let i = 0; i < 7; i += 1) {
      engine.push(makeChunk(i));
    }
    aborted = true;
    gates.forEach(({ index, gate }) => {
      if (index === 2) {
        gate.reject(new Error("boom"));
      } else {
        gate.resolve({ text: "t" });
      }
    });
    const summary = await engine.close();

    expect(transcribe).toHaveBeenCalledTimes(5);
    expect(summary.acceptedChunks).toBe(7);
    expect(summary.completedChunks).toBe(4);
    expect(summary.failedChunks).toBe(1);
    expect(summary.droppedByAbort).toBe(2);
    expect(summary.aborted).toBe(true);
  });

  it("首片不可重试失败即置位 isAborted：排队片一个都不启动，全部计入 droppedByAbort", async () => {
    const gate = makeDeferred<AsrTranscribeResult>();
    let aborted = false;
    const started: number[] = [];
    const transcribe = vi.fn(async (chunk: TranscribeChunk) => {
      started.push(chunk.index);
      await gate.promise;
      aborted = true;
      throw makeHttpErrorForSummary(401, "invalid api key");
    });
    const engine = createTranscriptionEngine({
      transcribe,
      concurrency: 1,
      isAborted: () => aborted
    });

    for (let i = 0; i < 10; i += 1) {
      expect(engine.push(makeChunk(i))).toBe(true);
    }
    expect(transcribe).toHaveBeenCalledTimes(1);

    gate.resolve({ text: "不会用到" });
    const summary = await engine.close();

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(started).toEqual([0]);
    expect(summary.acceptedChunks).toBe(10);
    expect(summary.failedChunks).toBe(1);
    expect(summary.completedChunks).toBe(0);
    expect(summary.droppedByAbort).toBe(9);
    expect(summary.aborted).toBe(true);
    expect(summary.representativeFailure?.error).toMatchObject({ status: 401 });
  });

  it("中止置位后 push 立即拒绝：不再接受新片（上游切片据此停止新增工作）", async () => {
    let aborted = false;
    const engine = createTranscriptionEngine({
      transcribe: async () => {
        aborted = true;
        throw makeHttpErrorForSummary(403, "forbidden");
      },
      concurrency: 1,
      isAborted: () => aborted
    });

    engine.push(makeChunk(0));
    await vi.waitFor(() => expect(aborted).toBe(true));

    expect(engine.push(makeChunk(1))).toBe(false);
    const summary = await engine.close();
    expect(summary.acceptedChunks).toBe(1);
    expect(summary.droppedByAbort).toBe(0);
  });
});

describe("HTTP 状态码重试判定（isRetryableNetworkError 按状态收紧）", () => {
  function makeHttpError(status: number, detail = "") {
    return Object.assign(new Error(`HTTP ${status}${detail ? `: ${detail}` : ""}`), { status });
  }

  it("401：确定性鉴权失败，经 retryAsync 一次尝试即跳过计 failed（不重试）", async () => {
    const transcribe = vi.fn(async () => {
      throw makeHttpError(401, "invalid api key");
    });
    const engine = createTranscriptionEngine({ transcribe });

    engine.push(makeChunk(0));
    const summary = await engine.close();

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(summary.completedChunks).toBe(0);
    expect(summary.failedChunks).toBe(1);
    expect(summary.failures[0].error).toMatchObject({
      message: "HTTP 401: invalid api key",
      status: 401
    });
  });

  it("429：限流可重试，重试一次后成功", async () => {
    let attempts = 0;
    const transcribe = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw makeHttpError(429);
      }
      return { text: "限流重试成功" };
    });

    const result = await transcribeChunk({ chunk: makeChunk(0), transcribe });

    expect(result).toEqual({ text: "限流重试成功", durationSec: 600 });
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("500：服务端错误可重试，耗尽 retries=2（共 3 次尝试）计 failed", async () => {
    const transcribe = vi.fn(async () => {
      throw makeHttpError(500, "internal error");
    });
    const engine = createTranscriptionEngine({ transcribe });

    engine.push(makeChunk(0));
    const summary = await engine.close();

    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(summary.completedChunks).toBe(0);
    expect(summary.failedChunks).toBe(1);
    expect(summary.failures[0].error).toMatchObject({ message: "HTTP 500: internal error", status: 500 });
  });

  it("400：参数类确定性失败，不重试一次尝试即失败", async () => {
    const transcribe = vi.fn(async () => {
      throw makeHttpError(400, "bad request");
    });
    const engine = createTranscriptionEngine({ transcribe });

    engine.push(makeChunk(0));
    const summary = await engine.close();

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(summary.failedChunks).toBe(1);
  });

  it("无 status 的错误维持消息启发式：网关 'HTTP 404' 消息仍判可重试（其他域行为不回退）", () => {
    expect(errorHelpers.isRetryableNetworkError(new Error("HTTP 404"))).toBe(true);
    expect(errorHelpers.isRetryableNetworkError(new Error("请求失败：502"))).toBe(true);
    expect(errorHelpers.isRetryableNetworkError({ message: "响应体不是合法 JSON", status: -1 })).toBe(false);
  });
});

describe("maxPendingChunks（待处理分片上限）", () => {
  function blockedTranscribe() {
    const deferred = makeDeferred<AsrTranscribeResult>();
    const transcribe = vi.fn(() => deferred.promise);
    return { transcribe, release: () => deferred.resolve({ text: "完成" }) };
  }

  it("排队深度达上限：push 返回 false，超限片不被接受、不进调度、不计数", async () => {
    const { transcribe, release } = blockedTranscribe();
    const engine = createTranscriptionEngine({ transcribe, concurrency: 1, maxPendingChunks: 2 });

    expect(engine.push(makeChunk(0))).toBe(true);
    expect(engine.push(makeChunk(1))).toBe(true);
    expect(engine.push(makeChunk(2))).toBe(true);
    expect(engine.push(makeChunk(3))).toBe(false);
    expect(engine.push(makeChunk(4))).toBe(false);

    release();
    const summary = await engine.close();

    expect(summary.acceptedChunks).toBe(3);
    expect(summary.completedChunks).toBe(3);
    expect(transcribe).toHaveBeenCalledTimes(3);
  });

  it("上限只按排队深度计：在途片完成腾出额度后 push 恢复接受", async () => {
    const { transcribe, release } = blockedTranscribe();
    const engine = createTranscriptionEngine({ transcribe, concurrency: 1, maxPendingChunks: 1 });

    expect(engine.push(makeChunk(0))).toBe(true);
    expect(engine.push(makeChunk(1))).toBe(true);
    expect(engine.push(makeChunk(2))).toBe(false);

    release();
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));

    expect(engine.push(makeChunk(2))).toBe(true);
  });

  it("maxPendingChunks <=0 表示不设上限（默认走 ASR_MAX_PENDING_CHUNKS 常量）", async () => {
    const { transcribe, release } = blockedTranscribe();
    const engine = createTranscriptionEngine({ transcribe, concurrency: 1, maxPendingChunks: 0 });

    for (let i = 0; i < 30; i += 1) {
      expect(engine.push(makeChunk(i))).toBe(true);
    }
    release();
    const summary = await engine.close();
    expect(summary.acceptedChunks).toBe(30);
  });
});
