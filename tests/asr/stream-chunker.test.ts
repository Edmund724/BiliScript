// stream-chunker.js 测试：流式逐段解码 → 按片 WAV 输出的编排正确性。
// 与 chunker.buildWavChunks（生产切片语义）逐片比对：
//   - 片索引 / startSec / durationSec / 边界与基准一致（整秒片长严格一致）；
//   - 逐片 PCM 内容与基准完全一致（同一 encodeWav 输入 → 同一输出）；
//   - 内存有界性由实现保证（每满一片即 onChunk 交出，不持有历史）。
// 解码器注入合成段（固定值采样），不依赖真实 AudioContext。

import { describe, expect, it } from "vitest";
import { streamWavChunks } from "../../extension/asr/stream-chunker.js";
import { buildWavChunks, makeDecodedBuffer } from "../../extension/asr/chunker.js";
import type { WavChunk } from "../../extension/asr/chunker.js";
import { ASR_PENDING_CHUNKS_LIMIT_MESSAGE } from "../../extension/asr/protocol.js";

const RATE = 16000;
const FILL = 0.25;

// 合成段：把 [0, totalSec) 按 segSec 切段（最后一段截短），值恒 FILL。
function makeSegments(totalSec: number, segSec: number): Float32Array[] {
  const segs = [];
  for (let s = 0; s < totalSec; s += segSec) {
    const len = Math.min(segSec, totalSec - s) * RATE;
    const a = new Float32Array(len);
    a.fill(FILL);
    segs.push(a);
  }
  return segs;
}

// 基准：全量 mono → 生产切片语义（buildWavChunks）
function baselineChunks(totalSec: number, chunkSec: number): WavChunk[] {
  const mono = new Float32Array(totalSec * RATE);
  mono.fill(FILL);
  return buildWavChunks(
    makeDecodedBuffer(mono, { sampleRate: RATE, diagnostic: { durationSec: totalSec, peak: FILL } }),
    { chunkSeconds: chunkSec }
  );
}

// WAV Blob → 16bit PCM 样本（与 encodeWav 写回的字节逐位比较）
async function wavPcm16(blob: Blob): Promise<Int16Array> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const out = new Int16Array((buf.length - 44) / 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getInt16(44 + i * 2, true);
  }
  return out;
}

// 大数组紧凑比较：长度 + 校验和 + 抽样点（全量 toEqual 会生成巨型 diff 把
// vitest worker 的 V8 堆打爆）
function expectPcmMatches(got: Int16Array, want: Int16Array) {
  expect(got.length).toBe(want.length);
  if (got.length === 0) return;
  let gotSum = 0;
  let wantSum = 0;
  for (let i = 0; i < got.length; i += 1) {
    gotSum = (gotSum + got[i]) | 0;
    wantSum = (wantSum + want[i]) | 0;
  }
  expect(gotSum).toBe(wantSum);
  const step = Math.max(1, Math.floor(got.length / 64));
  for (let k = 0; k < got.length; k += step) {
    expect(got[k]).toBe(want[k]);
  }
  expect(got[got.length - 1]).toBe(want[want.length - 1]);
}

function collectStream(segments: Float32Array[], { chunkSeconds, segmentsIn = segments }: { chunkSeconds: number; segmentsIn?: Float32Array[] }) {
  const out: WavChunk[] = [];
  return {
    out,
    promise: streamWavChunks(segmentsIn, {
      chunkSeconds,
      decodeSegment: (seg) => Promise.resolve(seg as Float32Array), // 段即 16k mono 裸数组
      onChunk: async (chunk) => {
        out.push(chunk);
      }
    })
  };
}

describe("streamWavChunks 与 buildWavChunks 基准一致", () => {
  it("整秒片长（1200s）、段边界不齐片边界：片数/起止/内容与基准一致", async () => {
    // 1500s / 每段 200s：8 段，段边界不与片边界对齐，验证段内跨片拼接
    //（全量级 4h 用例由 .scratch/asr-4h-mem harness 在真实 Chrome 验证）
    const totalSec = 1500;
    const chunkSec = 1200;
    const segSec = 200;
    const { out, promise } = collectStream(makeSegments(totalSec, segSec), { chunkSeconds: chunkSec });
    const meta = await promise;

    const baseline = baselineChunks(totalSec, chunkSec);
    expect(meta.totalChunks).toBe(baseline.length);
    expect(out.length).toBe(baseline.length);
    for (let i = 0; i < baseline.length; i += 1) {
      expect(out[i].index).toBe(baseline[i].index);
      expect(out[i].startSec).toBeCloseTo(baseline[i].startSec, 6);
      expect(out[i].durationSec).toBeCloseTo(baseline[i].durationSec, 6);
      expect(out[i].overlapLeadSec).toBeCloseTo(baseline[i].overlapLeadSec, 6);
      const got = await wavPcm16(out[i].wavBlob);
      const want = await wavPcm16(baseline[i].wavBlob);
      expectPcmMatches(got, want);
    }
    expect(meta.totalDurationSec).toBeCloseTo(totalSec, 6);
  }, 60000);

  it("非整除无静音时长：启用 1.5s 微重叠，边界与基准一致", async () => {
    const totalSec = 1250; // 首片 1200s，次片回退 1.5s 从 1198.5s 起切 51.5s
    const chunkSec = 1200;
    const segSec = 30;
    const { out, promise } = collectStream(makeSegments(totalSec, segSec), { chunkSeconds: chunkSec });
    const meta = await promise;

    const baseline = baselineChunks(totalSec, chunkSec);
    expect(meta.totalChunks).toBe(2);
    expect(out.length).toBe(2);
    expect(out[0].overlapLeadSec).toBe(0);
    expect(out[1].startSec).toBeCloseTo(1198.5, 6);
    expect(out[1].durationSec).toBeCloseTo(51.5, 6);
    expect(out[1].overlapLeadSec).toBeCloseTo(1.5, 6);
    for (let i = 0; i < 2; i += 1) {
      const got = await wavPcm16(out[i].wavBlob);
      const want = await wavPcm16(baseline[i].wavBlob);
      expectPcmMatches(got, want);
    }
  });

  it("chunkSeconds <= 0：不切，整段一片（与 decideChunks 语义一致）", async () => {
    const totalSec = 500;
    const { out, promise } = collectStream(makeSegments(totalSec, 60), { chunkSeconds: 0 });
    const meta = await promise;
    expect(meta.totalChunks).toBe(1);
    expect(out[0].durationSec).toBeCloseTo(totalSec, 6);
    const want = await wavPcm16(baselineChunks(totalSec, totalSec)[0].wavBlob);
    const got = await wavPcm16(out[0].wavBlob);
    expect(got.length).toBe(want.length);
  });

  it("全静音段：抛「疑似静音」错误（文案与 chunker 前置校验逐字同源）", async () => {
    const segments = makeSegments(240, 60).map((seg) => {
      const z = new Float32Array(seg.length);
      z.fill(0);
      return z;
    });
    await expect(
      streamWavChunks(segments, {
        chunkSeconds: 1200,
        decodeSegment: (seg) => Promise.resolve(seg as Float32Array),
        onChunk: async () => {}
      })
    ).rejects.toThrow("音频解码失败：解码结果疑似静音（时长 240s、峰值幅度 0）");
  });

  it("空段输入：totalChunks 为 0，不抛错", async () => {
    const { promise } = collectStream([], { chunkSeconds: 1200 });
    const meta = await promise;
    expect(meta.totalChunks).toBe(0);
  });

  it("段解码成功但产出空数组（零片产出）：不抛静音/零时长错，整体失败归调用方", async () => {
    const { promise } = collectStream([new Float32Array(0), new Float32Array(0)], { chunkSeconds: 1200 });
    const meta = await promise;
    expect(meta.totalChunks).toBe(0);
    expect(meta.totalDurationSec).toBe(0);
  });

  it("片间偶发 onChunk 中异步等待（base64 编码耗时）不改变输出顺序", async () => {
    const totalSec = 2440; // 两片 + 残余 40s
    const segments = makeSegments(totalSec, 45);
    const out: WavChunk[] = [];
    let call = 0;
    await streamWavChunks(segments, {
      chunkSeconds: 1200,
      decodeSegment: (seg) => Promise.resolve(seg as Float32Array),
      onChunk: async (chunk) => {
        call += 1;
        await new Promise((r) => setTimeout(r, 3));
        out.push(chunk);
      }
    });
    expect(out.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(out[1].startSec).toBeCloseTo(1198.5, 6);
    expect(out[1].overlapLeadSec).toBeCloseTo(1.5, 6);
    expect(out[2].startSec).toBeCloseTo(2397, 6);
    expect(out[2].durationSec).toBeCloseTo(43, 6);
    expect(out[2].overlapLeadSec).toBeCloseTo(1.5, 6);
  });
});

describe("合成波形 RMS 静音波谷软切分与微重叠", () => {
  function makeSpeechWave(totalSec: number, amplitude = 0.35, freqHz = 220): Float32Array {
    const len = Math.round(totalSec * RATE);
    const wave = new Float32Array(len);
    for (let i = 0; i < len; i += 1) {
      wave[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / RATE);
    }
    return wave;
  }

  function splitIntoSegments(wave: Float32Array, segSec: number): Float32Array[] {
    const segSamples = Math.round(segSec * RATE);
    const out: Float32Array[] = [];
    for (let off = 0; off < wave.length; off += segSamples) {
      out.push(wave.subarray(off, Math.min(wave.length, off + segSamples)));
    }
    return out;
  }

  it("56.2s 处插入 300ms 静音段（以 56.2s 为中心或起点）→ 在 56.2s 附近精准软切且下片 startSec 严丝合缝", async () => {
    const wave = makeSpeechWave(80, 0.35, 220);
    // [56.05s, 56.35s] 为以 56.2s 为中心的 300ms 全零静音
    wave.fill(0, Math.round(56.05 * RATE), Math.round(56.35 * RATE));

    const { out, promise } = collectStream(splitIntoSegments(wave, 17), { chunkSeconds: 60 });
    const meta = await promise;

    expect(meta.totalChunks).toBe(2);
    expect(out).toHaveLength(2);
    expect(out[0].startSec).toBe(0);
    expect(Math.abs(out[0].durationSec - 56.2)).toBeLessThanOrEqual(0.03);
    expect(out[0].overlapLeadSec).toBe(0);
    expect(out[1].overlapLeadSec).toBe(0);
    expect(out[1].startSec).toBeCloseTo(out[0].startSec + out[0].durationSec, 9);
    expect(out[1].startSec + out[1].durationSec).toBeCloseTo(80, 6);

    const baseline = buildWavChunks(makeDecodedBuffer(wave, { sampleRate: RATE }), { chunkSeconds: 60 });
    expect(baseline).toHaveLength(2);
    expectPcmMatches(await wavPcm16(out[0].wavBlob), await wavPcm16(baseline[0].wavBlob));
    expectPcmMatches(await wavPcm16(out[1].wavBlob), await wavPcm16(baseline[1].wavBlob));

    // 另一构造：从 56.2s 起插入 300ms 低底噪（RMS = 0.012 > 0.008 但低于中位能量 15%）
    const noisyWave = makeSpeechWave(80, 0.4, 240);
    const valleyStart = Math.round(56.2 * RATE);
    const valleyEnd = Math.round(56.5 * RATE);
    for (let i = valleyStart; i < valleyEnd; i += 1) {
      noisyWave[i] = 0.012 * Math.sin((2 * Math.PI * 100 * i) / RATE);
    }
    const { out: noisyOut, promise: noisyPromise } = collectStream(splitIntoSegments(noisyWave, 20), {
      chunkSeconds: 60
    });
    await noisyPromise;
    expect(noisyOut).toHaveLength(2);
    expect(noisyOut[0].durationSec).toBeGreaterThanOrEqual(56.2);
    expect(noisyOut[0].durationSec).toBeLessThanOrEqual(56.5);
    expect(noisyOut[0].overlapLeadSec).toBe(0);
    expect(noisyOut[1].overlapLeadSec).toBe(0);
    expect(noisyOut[1].startSec).toBeCloseTo(noisyOut[0].durationSec, 9);
  });

  it("全程满幅正弦波无静音 → 自动回退 1.5s 重叠，且整除片长不产出纯重叠幽灵尾片", async () => {
    const fullSine80 = makeSpeechWave(80, 1.0, 440);
    const { out, promise } = collectStream(splitIntoSegments(fullSine80, 23), { chunkSeconds: 60 });
    const meta = await promise;

    expect(meta.totalChunks).toBe(2);
    expect(out[0].startSec).toBe(0);
    expect(out[0].durationSec).toBeCloseTo(60, 6);
    expect(out[0].overlapLeadSec).toBe(0);
    expect(out[1].startSec).toBeCloseTo(58.5, 6);
    expect(out[1].durationSec).toBeCloseTo(21.5, 6);
    expect(out[1].overlapLeadSec).toBeCloseTo(1.5, 6);

    // 验证重叠区 [58.5s, 60s] 的采样字节逐位相等
    const pcm0 = await wavPcm16(out[0].wavBlob);
    const pcm1 = await wavPcm16(out[1].wavBlob);
    const overlapSamples = Math.round(1.5 * RATE);
    expectPcmMatches(pcm0.subarray(pcm0.length - overlapSamples), pcm1.subarray(0, overlapSamples));

    // 恰好 60s 整时长：只产 1 片，不产生多余的 [58.5s, 60s] 纯重叠幽灵片
    const exact60 = makeSpeechWave(60, 1.0, 440);
    const { out: out60, promise: promise60 } = collectStream(splitIntoSegments(exact60, 30), { chunkSeconds: 60 });
    await promise60;
    expect(out60).toHaveLength(1);
    expect(out60[0]).toMatchObject({ index: 0, startSec: 0, durationSec: 60, overlapLeadSec: 0 });
  });
});

// ===== 段级解码降级（Q8a）：单个 ADTS 段解码失败 → 重试 1 次 → 仍失败跳过
// 计数继续；全部段失败（零片产出）才算整体失败。decodeSegment 全部 fake。 =====

// 解码器 fake：failures 集合内的段下标抛错（可编程每次调用的行为）。
function makeFailingDecoder({ failAt, failTimes = Infinity, abortAt = -1, abortSentinel }: {
  failAt: number[];
  failTimes?: number;
  abortAt?: number;
  abortSentinel?: unknown;
}) {
  const calls = new Map<number, number>(); // segmentIndex → 调用次数
  const decodeSegment = async (seg: unknown) => {
    const index = (seg as { __index: number }).__index;
    const count = (calls.get(index) || 0) + 1;
    calls.set(index, count);
    if (index === abortAt) {
      throw abortSentinel;
    }
    if (failAt.includes(index) && count <= failTimes) {
      throw new Error(`音频解码失败：段 ${index} 损坏`);
    }
    return seg as Float32Array;
  };
  return { decodeSegment, calls };
}

// 给段打上下标（fake 解码器据此决定失败/中止）
function tagSegments(segments: Float32Array[]): Array<Float32Array & { __index: number }> {
  return segments.map((seg, __index) => Object.assign(seg, { __index }));
}

describe("段级解码降级（Q8a）", () => {
  it("默认（无 decodeRetries/skip）：段解码失败直接上抛（现状语义不变）", async () => {
    const segments = tagSegments(makeSegments(600, 200)); // 3 段
    const decoder = makeFailingDecoder({ failAt: [1] });
    await expect(
      streamWavChunks(segments, {
        chunkSeconds: 1200,
        decodeSegment: decoder.decodeSegment,
        onChunk: async () => {}
      })
    ).rejects.toThrow(/段 1 损坏/);
  });

  it("decodeRetries=1：首次失败重试成功 → 不跳过、片产出正常", async () => {
    const segments = tagSegments(makeSegments(600, 200));
    // 段 1 第一次失败、第二次成功
    const decoder = makeFailingDecoder({ failAt: [1], failTimes: 1 });
    const out: WavChunk[] = [];
    const meta = await streamWavChunks(segments, {
      chunkSeconds: 1200,
      decodeSegment: decoder.decodeSegment,
      onChunk: async (chunk) => {
        out.push(chunk);
      },
      decodeRetries: 1
    });
    expect(decoder.calls.get(1)).toBe(2); // 重试 1 次
    expect(meta.totalChunks).toBe(1);
    expect(meta.skippedSegments).toBe(0);
    expect(out).toHaveLength(1);
  });

  it("decodeRetries=1 + skipFailedSegments：重试仍失败 → 跳过该段计数，后续段继续", async () => {
    const segments = tagSegments(makeSegments(600, 200));
    const decoder = makeFailingDecoder({ failAt: [1] }); // 段 1 恒失败
    const out: WavChunk[] = [];
    const meta = await streamWavChunks(segments, {
      chunkSeconds: 1200,
      decodeSegment: decoder.decodeSegment,
      onChunk: async (chunk) => {
        out.push(chunk);
      },
      decodeRetries: 1,
      skipFailedSegments: true
    });
    // 段 1 重试 1 次后跳过；段 0/2 的采样拼成一片
    expect(decoder.calls.get(1)).toBe(2);
    expect(meta.skippedSegments).toBe(1);
    expect(meta.totalChunks).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0].durationSec).toBeCloseTo(400, 6); // 200s × 2 段
  });

  it("全部段失败（零片产出）→ totalChunks 0，不抛错（整体失败由调用方判定）", async () => {
    const segments = tagSegments(makeSegments(600, 200));
    const decoder = makeFailingDecoder({ failAt: [0, 1, 2] });
    const meta = await streamWavChunks(segments, {
      chunkSeconds: 1200,
      decodeSegment: decoder.decodeSegment,
      onChunk: async () => {},
      decodeRetries: 1,
      skipFailedSegments: true
    });
    expect(meta.totalChunks).toBe(0);
    expect(meta.skippedSegments).toBe(3);
  });

  it("isAbortError 命中：不重试不跳过，直接向上传播（断连取消优先于降级）", async () => {
    const segments = tagSegments(makeSegments(600, 200));
    const abortSentinel = Object.freeze({ asrAborted: true });
    const decoder = makeFailingDecoder({ failAt: [], abortAt: 1, abortSentinel });
    await expect(
      streamWavChunks(segments, {
        chunkSeconds: 1200,
        decodeSegment: decoder.decodeSegment,
        onChunk: async () => {},
        decodeRetries: 1,
        skipFailedSegments: true,
        isAbortError: (error) => error === abortSentinel
      })
    ).rejects.toBe(abortSentinel);
    // 段 1 首次抛哨兵即中止：未重试
    expect(decoder.calls.get(1)).toBe(1);
  });
});

// ===== onChunk 拒绝（工单 04：待处理分片超限时停止新增工作）=====
// onChunk 返回 false = 下游拒绝（转写引擎活队列达 maxPendingChunks 上限）：
// 立即停止消费后续段并抛可读错误，不静默丢片。
describe("onChunk 拒绝（下游待处理分片超限）", () => {
  it("首个 onChunk 返回 false：抛 ASR_PENDING_CHUNKS_LIMIT_MESSAGE，后续段不再消费", async () => {
    const segments = tagSegments(makeSegments(600, 200)); // 3 段
    const decoder = makeFailingDecoder({ failAt: [] });
    const seen: number[] = [];

    await expect(
      streamWavChunks(segments, {
        chunkSeconds: 300, // 每段 200s，两段拼满 300s 即产出第一片
        decodeSegment: decoder.decodeSegment,
        onChunk: async (chunk) => {
          seen.push(chunk.index);
          return false;
        },
        decodeRetries: 1,
        skipFailedSegments: true
      })
    ).rejects.toThrow(ASR_PENDING_CHUNKS_LIMIT_MESSAGE);

    // 只有第一片交出过，段 2 不再解码
    expect(seen).toEqual([0]);
    expect(decoder.calls.has(2)).toBe(false);
  });

  it("残余不足一片的最后一整片被拒绝时同样停止并抛错", async () => {
    const segments = tagSegments(makeSegments(200, 200)); // 单段 200s
    await expect(
      streamWavChunks(segments, {
        chunkSeconds: 300, // 永远拼不满：唯一一片走残余分支
        decodeSegment: (seg) => Promise.resolve(seg as Float32Array),
        onChunk: async () => false
      })
    ).rejects.toThrow(ASR_PENDING_CHUNKS_LIMIT_MESSAGE);
  });

  it("onChunk 返回 true / undefined（既有消费方语义）不受影响：正常产出", async () => {
    const segments = makeSegments(300, 100);
    const out: WavChunk[] = [];
    const meta = await streamWavChunks(segments, {
      chunkSeconds: 300,
      decodeSegment: (seg) => Promise.resolve(seg as Float32Array),
      onChunk: async (chunk) => {
        out.push(chunk);
        return true;
      }
    });
    expect(meta.totalChunks).toBe(1);
    expect(out).toHaveLength(1);
  });
});
