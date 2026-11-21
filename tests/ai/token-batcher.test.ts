import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenBatcher } from "../../extension/ai/token-batcher.js";

describe("TokenBatcher 合帧窗口", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("窗口内多个 token 合并成一批；窗口到期才吐", () => {
    const batches: string[][] = [];
    const batcher = new TokenBatcher({ onFlush: (tokens) => batches.push(tokens) });

    for (const t of ["a", "b", "c"]) {
      batcher.push(t);
    }
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(40);
    expect(batches).toEqual([["a", "b", "c"]]);
  });

  it("窗口从首 token 起算；flush 后静默期重新起窗", () => {
    const batches: string[][] = [];
    const batcher = new TokenBatcher({ onFlush: (tokens) => batches.push(tokens), windowMs: 30 });

    batcher.push("t1");
    vi.advanceTimersByTime(25);
    batcher.push("t2");
    vi.advanceTimersByTime(10);
    expect(batches).toEqual([["t1", "t2"]]);

    batcher.push("t3");
    vi.advanceTimersByTime(30);
    expect(batches).toEqual([["t1", "t2"], ["t3"]]);
  });

  it("maxPending 积压上限提前 flush，且不留残余计时器", () => {
    const batches: string[][] = [];
    const batcher = new TokenBatcher({ onFlush: (tokens) => batches.push(tokens), maxPending: 4 });

    for (let i = 0; i < 4; i += 1) {
      batcher.push(`t${i}`);
    }
    expect(batches).toEqual([["t0", "t1", "t2", "t3"]]);
    vi.advanceTimersByTime(10000);
    expect(batches).toHaveLength(1);
  });

  it("flush() 同步收尾剩余积压并清计时器；空 flush 不吐", () => {
    const batches: string[][] = [];
    const batcher = new TokenBatcher({ onFlush: (tokens) => batches.push(tokens) });

    batcher.flush();
    expect(batches).toEqual([]);

    batcher.push("x");
    batcher.push("y");
    batcher.flush();
    expect(batches).toEqual([["x", "y"]]);

    vi.advanceTimersByTime(10000);
    expect(batches).toHaveLength(1);
    batcher.flush();
    expect(batches).toHaveLength(1);
  });

  it("不丢不重：交错窗口到期与积压上限，全批次拼接 === 原序列", () => {
    const batches: string[][] = [];
    const batcher = new TokenBatcher({ onFlush: (tokens) => batches.push(tokens), windowMs: 40, maxPending: 7 });

    const source = Array.from({ length: 1000 }, (_, i) => `tok-${i}-xyz`);
    for (let i = 0; i < source.length; i += 1) {
      batcher.push(source[i]);
      if (i % 3 === 0) {
        vi.advanceTimersByTime(15);
      }
      if (i % 11 === 0) {
        vi.advanceTimersByTime(50);
      }
    }
    batcher.flush();

    expect(batches.length).toBeLessThan(source.length / 4);
    expect(batches.flat()).toEqual(source);
  });
});
