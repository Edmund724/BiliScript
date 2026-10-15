// tests/reader/serial-queue.test.ts
// reader 通用串行队列（createSerialQueue）语义真值表测试。
//
// 验证契约：
//   1. 后到等先到：并发 enqueue 按 FIFO 严格串行，后序必须等待前序完全落定再执行；
//   2. 失败不阻断后续：前序任务 reject/抛错不影响后序任务执行，队列链尾不被污染；
//   3. 自 promise 落定：每个 enqueue 调用返回的 promise 在自身任务落定后 resolve/reject；
//   4. 链头同步捕获：同步连续 enqueue 时链头即时锁定，同步抛错与异步 reject 均安全隔离；
//   5. 实例独立隔离：不同 createSerialQueue() 实例拥有独立时序，互不阻塞（ADR-0008 纪律）。

import { describe, expect, it } from "vitest";
import { createSerialQueue } from "../../extension/reader/serial-queue.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createSerialQueue 通用串行队列", () => {
  it("后到等先到：任务严格按 FIFO 顺序排队执行，后序等待前序完全落定", async () => {
    const queue = createSerialQueue();
    const events: string[] = [];

    const p1 = queue.enqueue(async () => {
      events.push("task1:start");
      await delay(25);
      events.push("task1:end");
      return "result1";
    });

    const p2 = queue.enqueue(async () => {
      events.push("task2:start");
      await delay(5);
      events.push("task2:end");
      return "result2";
    });

    const p3 = queue.enqueue(async () => {
      events.push("task3:start");
      events.push("task3:end");
      return "result3";
    });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1).toBe("result1");
    expect(r2).toBe("result2");
    expect(r3).toBe("result3");
    expect(events).toEqual([
      "task1:start",
      "task1:end",
      "task2:start",
      "task2:end",
      "task3:start",
      "task3:end"
    ]);
  });

  it("失败不阻断后续：前序任务抛错/reject，后序任务照常执行且队列链不中断", async () => {
    const queue = createSerialQueue();
    const executed: string[] = [];
    const boomError = new Error("task1 exploded");

    const p1 = queue.enqueue(async () => {
      executed.push("task1");
      await delay(10);
      throw boomError;
    });

    const p2 = queue.enqueue(async () => {
      executed.push("task2");
      return "task2-ok";
    });

    await expect(p1).rejects.toThrow("task1 exploded");
    const r2 = await p2;

    expect(r2).toBe("task2-ok");
    expect(executed).toEqual(["task1", "task2"]);
  });

  it("自 promise 落定：各自返回的 promise 只反映自身结果，互不污染", async () => {
    const queue = createSerialQueue();
    const err = new Error("fail");

    const p1 = queue.enqueue(async () => 123);
    const p2 = queue.enqueue(async () => {
      throw err;
    });
    const p3 = queue.enqueue(async () => "done");

    expect(await p1).toBe(123);
    await expect(p2).rejects.toBe(err);
    expect(await p3).toBe("done");
  });

  it("链头同步捕获：同步连续入队，同步抛错与同步返回值均被安全隔离", async () => {
    const queue = createSerialQueue();
    const order: number[] = [];

    // task1 同步抛出异常而非返回 rejected promise
    const p1 = queue.enqueue(() => {
      order.push(1);
      throw new Error("sync throw in task1");
    });

    // task2 返回普通同步值
    const p2 = queue.enqueue(() => {
      order.push(2);
      return 200;
    });

    // task3 异步任务
    const p3 = queue.enqueue(async () => {
      order.push(3);
      return 300;
    });

    await expect(p1).rejects.toThrow("sync throw in task1");
    expect(await p2).toBe(200);
    expect(await p3).toBe(300);
    expect(order).toEqual([1, 2, 3]);
  });

  it("多实例独立隔离：各队列实例互不阻塞，彼此并行执行", async () => {
    const queueA = createSerialQueue();
    const queueB = createSerialQueue();
    const events: string[] = [];

    const pa = queueA.enqueue(async () => {
      events.push("a:start");
      await delay(30);
      events.push("a:end");
    });

    const pb = queueB.enqueue(async () => {
      events.push("b:start");
      await delay(5);
      events.push("b:end");
    });

    await Promise.all([pa, pb]);

    // queueB 的短任务应在 queueA 的长任务还在睡眠时就已经完成
    expect(events[0]).toBe("a:start");
    expect(events[1]).toBe("b:start");
    expect(events[2]).toBe("b:end");
    expect(events[3]).toBe("a:end");
  });
});
