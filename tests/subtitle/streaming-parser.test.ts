// 增量流式 JSON 字幕解析器（subtitle/streaming-parser.ts）单测。
//
// 系统可能的失败方式：
//   1. 多字节 UTF-8 字符（中文/Emoji）被 5～12 字节随机分片截断时产生乱码或替换字符 \uFFFD；
//   2. 字符串字面量内包含转义引号 `\"`、双反斜杠 `\\` 或花括号 `{}`、`[]` 时误触发对象闭合或提前切片报错；
//   3. 对象尚未闭合前提前触发 `onCueReady`，或在尾部 `,` / `]}` 到达时重复触发；
//   4. 区间跳号、倒序或越界时未在断点熔断而继续发射脏后缀；
//   5. 流断线重置或降级重跑（`resetStreamAttempt`）后未按 `${startIndex}:${endIndex}` 去重导致重复上屏。

import { describe, expect, it, vi } from "vitest";
import {
  createStreamingSubtitleParser,
  type StreamingSubtitleCue
} from "../../extension/subtitle/streaming-parser.js";
import type { AtomicSubtitleEvent } from "../../extension/subtitle/segmentation.js";

function createDeterministicRng(initialSeed: number): () => number {
  let state = initialSeed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function sliceUtf8Randomly(bytes: Uint8Array, seed: number, minLen = 5, maxLen = 12): Uint8Array[] {
  const rng = createDeterministicRng(seed);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const span = minLen + Math.floor(rng() * (maxLen - minLen + 1));
    const end = Math.min(bytes.length, offset + span);
    chunks.push(bytes.subarray(offset, end));
    offset = end;
  }
  return chunks;
}

function findObjectCloseByteOffsets(json: string, objectLiterals: readonly string[]): number[] {
  const encoder = new TextEncoder();
  let searchFrom = 0;
  return objectLiterals.map((literal) => {
    const idx = json.indexOf(literal, searchFrom);
    if (idx < 0) {
      throw new Error(`Object literal not found in JSON: ${literal}`);
    }
    searchFrom = idx + literal.length;
    const prefix = json.slice(0, idx + literal.length);
    return encoder.encode(prefix).byteLength - 1;
  });
}

function findChunkIndexForByteOffset(chunks: readonly Uint8Array[], targetByteOffset: number): number {
  let cursor = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const nextCursor = cursor + chunks[i].byteLength;
    if (targetByteOffset >= cursor && targetByteOffset < nextCursor) {
      return i;
    }
    cursor = nextCursor;
  }
  return -1;
}

function feedChunksAndRecordCounts(
  parser: ReturnType<typeof createStreamingSubtitleParser>,
  chunks: readonly Uint8Array[],
  collected: readonly StreamingSubtitleCue[]
): Array<{ chunkIndex: number; emittedNow: number; totalAfter: number }> {
  return chunks.map((chunk, chunkIndex) => {
    const emitted = parser.feed(chunk);
    return {
      chunkIndex,
      emittedNow: emitted.length,
      totalAfter: collected.length
    };
  });
}

describe("createStreamingSubtitleParser：增量流式 JSON 字幕解析", () => {
  it("按随机 5～12 字节碎片喂入含 4 个 groups 的 JSON（含转义引号与花括号），在每个对象闭合瞬间立即触发且不重复", () => {
    const events: AtomicSubtitleEvent[] = [
      { text: 'He said "hi {user}"', startMs: 100, endMs: 1200 },
      { text: "in {dev} mode.", startMs: 1250, endMs: 2400 },
      { text: "Keep \\{escaped\\} braces", startMs: 2500, endMs: 3600 },
      { text: 'Check "nested {a: [1,2]}"', startMs: 3700, endMs: 4900 },
      { text: "and quote \\\"ok\\\"", startMs: 5000, endMs: 6100 },
      { text: "Final {done}.", startMs: 6200, endMs: 7500 }
    ];

    const groupObjects = [
      '{"ids":["0","1"],"text":"LLM ignored text","translation":"他说\\"你好 {user}\\"处于 {dev} 模式。"}',
      '{"ids":["2"],"text":"Keep {escaped}","translation":"保留 \\\\{转义\\\\} 花括号"}',
      '{"ids":["3","4"],"text":"Check nested","translation":"检查\\"嵌套 {a: [1,2]}\\"与引号 \\\\\\"ok\\\\\\""}',
      '{"ids":["5"],"text":"Final {done}.","translation":"最终 {完成}。"}'
    ];
    const fullJson = `\`\`\`json\n{"groups":[${groupObjects.join(",")}]}\n\`\`\``;
    const encoded = new TextEncoder().encode(fullJson);
    const chunks = sliceUtf8Randomly(encoded, 20261118, 5, 12);
    const closeChunkIndices = findObjectCloseByteOffsets(fullJson, groupObjects).map((byteOffset) =>
      findChunkIndexForByteOffset(chunks, byteOffset)
    );

    const emitted: StreamingSubtitleCue[] = [];
    const onCueReady = vi.fn((cue: StreamingSubtitleCue) => {
      emitted.push(cue);
    });

    const parser = createStreamingSubtitleParser({
      events,
      sourceLang: "en",
      onCueReady
    });

    const snapshots = feedChunksAndRecordCounts(parser, chunks, emitted);

    // 验证所有内部切片严格处于 5~12 字节区间
    expect(chunks.slice(0, -1).every((chunk) => chunk.byteLength >= 5 && chunk.byteLength <= 12)).toBe(true);
    expect(chunks[chunks.length - 1].byteLength).toBeGreaterThanOrEqual(1);
    expect(chunks[chunks.length - 1].byteLength).toBeLessThanOrEqual(12);

    // 第 1、2、3、4 个对象闭合前一碎片未提前触发，闭合碎片到达瞬间立即触发且计数精准递增
    expect(snapshots[closeChunkIndices[0] - 1].totalAfter).toBe(0);
    expect(snapshots[closeChunkIndices[0]].totalAfter).toBe(1);

    expect(snapshots[closeChunkIndices[1] - 1].totalAfter).toBe(1);
    expect(snapshots[closeChunkIndices[1]].totalAfter).toBe(2);

    expect(snapshots[closeChunkIndices[2] - 1].totalAfter).toBe(2);
    expect(snapshots[closeChunkIndices[2]].totalAfter).toBe(3);

    expect(snapshots[closeChunkIndices[3] - 1].totalAfter).toBe(3);
    expect(snapshots[closeChunkIndices[3]].totalAfter).toBe(4);

    // 仅在 4 个对象闭合瞬间触发，喂完尾部围栏不重复触发
    expect(snapshots.filter((s) => s.emittedNow > 0).map((s) => s.chunkIndex)).toEqual(closeChunkIndices);
    expect(onCueReady).toHaveBeenCalledTimes(4);

    expect(emitted).toEqual([
      {
        startIndex: 0,
        endIndex: 1,
        from: 0.1,
        to: 2.4,
        text: 'He said "hi {user}" in {dev} mode.',
        translation: '他说"你好 {user}"处于 {dev} 模式。'
      },
      {
        startIndex: 2,
        endIndex: 2,
        from: 2.5,
        to: 3.6,
        text: "Keep \\{escaped\\} braces",
        translation: "保留 \\{转义\\} 花括号"
      },
      {
        startIndex: 3,
        endIndex: 4,
        from: 3.7,
        to: 6.1,
        text: 'Check "nested {a: [1,2]}" and quote \\"ok\\"',
        translation: '检查"嵌套 {a: [1,2]}"与引号 \\"ok\\"'
      },
      {
        startIndex: 5,
        endIndex: 5,
        from: 6.2,
        to: 7.5,
        text: "Final {done}.",
        translation: "最终 {完成}。"
      }
    ]);
  });

  it("支持顶层 CC 数组逐条解析，并在 resetStreamAttempt 重放时按 startIndex:endIndex 去重", () => {
    const items = [
      { from: 0, to: 2, content: 'Line "one" {a}' },
      { from: 2, to: 5, content: "Line two" },
      { from: 5, to: 8, content: "Line three" }
    ];
    const emitted: StreamingSubtitleCue[] = [];
    const onCueReady = vi.fn((cue: StreamingSubtitleCue) => {
      emitted.push(cue);
    });

    const parser = createStreamingSubtitleParser({
      items,
      mode: "cc-json",
      onCueReady
    });

    const prefixChunks = sliceUtf8Randomly(
      new TextEncoder().encode('[Note]\n[{"id":"0","translation":"第一\\"句\\" {a}"},{"id":"1","translation":"第二句"}'),
      99,
      5,
      12
    );
    feedChunksAndRecordCounts(parser, prefixChunks, emitted);
    expect(onCueReady).toHaveBeenCalledTimes(2);

    // 模拟流断流重试或降级非流式：重置当前流扫描游标并重放全量响应
    parser.resetStreamAttempt();
    const replayChunks = sliceUtf8Randomly(
      new TextEncoder().encode(
        '[{"id":"0","translation":"第一\\"句\\" {a}"},{"id":"1","translation":"第二句"},{"id":"2","translation":"第三句"}]'
      ),
      101,
      5,
      12
    );
    feedChunksAndRecordCounts(parser, replayChunks, emitted);

    // 0:0 与 1:1 不重复触发，仅新增触发 2:2
    expect(onCueReady).toHaveBeenCalledTimes(3);
    expect(emitted.map((c) => `${c.startIndex}:${c.endIndex}:${c.translation}`)).toEqual([
      '0:0:第一"句" {a}',
      "1:1:第二句",
      "2:2:第三句"
    ]);
  });

  it("索引跳号或越界时立即熔断，不发射后续脏数据", () => {
    const events: AtomicSubtitleEvent[] = [
      { text: "a", startMs: 0, endMs: 1000 },
      { text: "b", startMs: 1000, endMs: 2000 },
      { text: "c", startMs: 2000, endMs: 3000 },
      { text: "d", startMs: 3000, endMs: 4000 }
    ];
    const onCueReady = vi.fn();
    const parser = createStreamingSubtitleParser({ events, onCueReady });

    parser.feed('{"groups":[{"ids":["0","1"],"text":"a b","translation":"甲乙"},');
    expect(onCueReady).toHaveBeenCalledTimes(1);

    // 跳过索引 "2"，直接跳到 "3"
    parser.feed('{"ids":["3"],"text":"d","translation":"丁"}]}');
    expect(onCueReady).toHaveBeenCalledTimes(1);
  });

  it("cc-json 缺少 translation 字段时回落读取 text，显式空 translation 不误回落", () => {
    const items = [
      { from: 0, to: 2, content: "Line one" },
      { from: 2, to: 4, content: "Line two" },
      { from: 4, to: 6, content: "Line three" }
    ];
    const emitted: StreamingSubtitleCue[] = [];
    const parser = createStreamingSubtitleParser({
      items,
      mode: "cc-json",
      onCueReady: (cue) => emitted.push(cue)
    });

    parser.feed('[{"id":"0","translation":"第一句"},{"id":"1","text":"第二句"},{"id":"2","translation":"","text":"Line three"}]');
    expect(emitted.map((c) => c.translation)).toEqual(["第一句", "第二句", ""]);
  });
});
