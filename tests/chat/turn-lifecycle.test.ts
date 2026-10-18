// tests/chat/turn-lifecycle.test.ts — 回合生命周期深 module（chat/turn-lifecycle.ts，
// GLOSSARY.md 词条「发送闸」「历史回放」的时序面）的聚焦单测：受理入口的双发闸、
// 唯一的在途判据、终态订阅（settle）的兑现协议与三条兜底。
//
// 先列的失败方式清单（每条对应下方一个或多个用例，先写测试再实现）：
//   1. 受理窗口漏判：判据只拼 activePort / activeUserPrompt，看不到「发送流程已在途、
//      端口未建」这段窗口 → 在途期间被当成空闲（→ 用例「受理窗口算在途」）。
//   2. ignored 被折算成受理：在途/空文本时仍进入受理体（消费附件、上屏半条消息）
//      → 必须直接 ignored 且受理体一次都不跑（→ 用例「在途/空文本 → ignored」）。
//   3. settle 永不结算（悬挂）：settle 是历史项点击的前置 await，悬挂即死锁
//      → 端口未建时登记补发、blocked 未起流、看门狗兜底三条出口各自兑现。
//   4. settle 双结算：同一回合多个落定出口（终态 + 断连 + 看门狗）重复兑现
//      → resolve 幂等（二次调用不重复回调）。
//   5. 断流先于落盘被破坏：settle 链上插入 await 会把「断流通知先于落盘」的时序
//      拉长 → discard 同步复位窗口并同步兑现（无定时器、无 await 缝隙）。
//   6. 停流顺序被破坏：端口未建时的停流请求若被提前补发（早于 chat 消息），
//      offscreen 当无活动请求空转、终态永不回来 → 登记期不发、补发点才发。
//   7. 图片被闸拦下却清场：受理体在闸放行前跑（takeInputImages 被消费）
//      → 只有 turn 放行才进入受理体（用例 2 的同一断言面）。
//   8. 受理窗口未复位：发送出结果后窗口仍开 → 此后每次发送都被判 ignored
//      （静默发不出去）→ accepted / blocked 两条出口都必须关窗。
import { describe, expect, it, vi } from "vitest";
import {
  createTurnLifecycle,
  TURN_SETTLE_FALLBACK_MS,
  type CreateTurnLifecycleDeps,
  type SendVerdict
} from "../../extension/chat/turn-lifecycle.js";

interface Harness {
  deps: CreateTurnLifecycleDeps;
  turn: ReturnType<typeof createTurnLifecycle>;
  /** 记录调用次序（断言时序类不变式，如「补发必须晚于受理体」）。 */
  calls: string[];
  /** 受理窗口槽位（= chat-runtime 的 sendInFlight 字段本体，此处以局部变量扮演）。 */
  window: { accepting: boolean };
  /** 流段存在性（= chat-runtime 的 activePort !== null）。 */
  stream: { active: boolean };
  /** 手动驱动的看门狗定时器（避免真实 4 秒等待；clearTimer 真正撤销挂起项）。 */
  timers: { pending: number; fire: () => void };
  settle: (promise: Promise<void>) => { readonly settled: boolean };
  flushMicrotasks: () => Promise<void>;
}

function makeHarness(overrides: Partial<CreateTurnLifecycleDeps> = {}): Harness {
  const calls: string[] = [];
  const window = { accepting: false };
  const stream = { active: false };
  const handlers = new Map<number, () => void>();
  let nextTimerId = 1;
  const timers = {
    get pending(): number {
      return handlers.size;
    },
    fire: () => {
      const all = [...handlers.values()];
      handlers.clear();
      all.forEach((fn) => fn());
    }
  };
  const deps: CreateTurnLifecycleDeps = {
    accepting: {
      get: () => window.accepting,
      set: (value: boolean) => {
        window.accepting = value;
        calls.push(`window:${value}`);
      }
    },
    isStreaming: () => stream.active,
    stopStream: () => {
      calls.push("stopStream");
    },
    forceReset: () => {
      calls.push("forceReset");
      stream.active = false;
      window.accepting = false;
    },
    runAcceptance: async (text: string): Promise<SendVerdict> => {
      calls.push(`accept:${text}`);
      return "accepted";
    },
    setTimer: (fn: () => void) => {
      const id = nextTimerId++;
      handlers.set(id, fn);
      return id;
    },
    clearTimer: (handle: number) => {
      handlers.delete(handle);
    },
    ...overrides
  };
  const state = { settled: false };
  return {
    deps,
    turn: createTurnLifecycle(deps),
    calls,
    window,
    stream,
    timers,
    settle: (promise: Promise<void>) => {
      state.settled = false;
      void promise.then(() => {
        state.settled = true;
      });
      return state;
    },
    flushMicrotasks: async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
}

describe("回合生命周期 createTurnLifecycle", () => {
  describe("在途判据（受理窗口 ∪ 流段）", () => {
    it("空闲 false；受理窗口（端口未建）true；流段 true；两者都假才回到 false", () => {
      const h = makeHarness();
      expect(h.turn.isActive()).toBe(false);

      h.window.accepting = true;
      expect(h.turn.isActive()).toBe(true);
      h.window.accepting = false;

      h.stream.active = true;
      expect(h.turn.isActive()).toBe(true);
      h.stream.active = false;
      expect(h.turn.isActive()).toBe(false);
    });

    it("发送受理期间（受理体挂起）isActive 恒为 true——弱判据漏掉的正是这段窗口", async () => {
      const h = makeHarness();
      let releaseAcceptance!: (verdict: SendVerdict) => void;
      h.deps.runAcceptance = () =>
        new Promise<SendVerdict>((resolve) => {
          releaseAcceptance = resolve;
        });
      const turn = createTurnLifecycle(h.deps);

      const sending = turn.send("问题");
      // 窗口内：端口未建（isStreaming 假）、没有 activeUserPrompt，但在途
      expect(turn.isActive()).toBe(true);

      releaseAcceptance("accepted");
      await sending;
      expect(turn.isActive()).toBe(false);
    });
  });

  describe("受理入口 send（双发闸 + 窗口复位）", () => {
    it("空文本 / 全空白：ignored，不进入受理体、窗口不开", async () => {
      const h = makeHarness();
      await expect(h.turn.send("")).resolves.toBe("ignored");
      await expect(h.turn.send("   \n")).resolves.toBe("ignored");
      expect(h.calls).not.toContain("accept:");
      expect(h.turn.isActive()).toBe(false);
    });

    it("在途（受理窗口 / 流段）时 ignored：受理体一次都不跑（附件不被消费、不上屏半条）", async () => {
      const h = makeHarness();
      h.window.accepting = true;
      await expect(h.turn.send("第二条")).resolves.toBe("ignored");
      expect(h.calls.filter((c) => c.startsWith("accept:"))).toHaveLength(0);

      h.window.accepting = false;
      h.stream.active = true;
      await expect(h.turn.send("第三条")).resolves.toBe("ignored");
      expect(h.calls.filter((c) => c.startsWith("accept:"))).toHaveLength(0);
    });

    it("文本 trim 后交给受理体；accepted / blocked 两条出口都关闭窗口", async () => {
      const h = makeHarness();
      await expect(h.turn.send("  总结一下  ")).resolves.toBe("accepted");
      expect(h.calls).toContain("accept:总结一下");
      expect(h.window.accepting).toBe(false);
      expect(h.turn.isActive()).toBe(false);

      const blocked = makeHarness({ runAcceptance: async () => "blocked" as SendVerdict });
      await expect(blocked.turn.send("被拦下的")).resolves.toBe("blocked");
      expect(blocked.window.accepting).toBe(false);
      expect(blocked.turn.isActive()).toBe(false);
    });

    it("受理体抛错也要关闭窗口（异常路径不复位 = 此后静默发不出去）", async () => {
      const h = makeHarness({
        runAcceptance: async () => {
          throw new Error("connectPort 失败");
        }
      });
      await expect(h.turn.send("问题")).rejects.toThrow("connectPort 失败");
      expect(h.window.accepting).toBe(false);
      expect(h.turn.isActive()).toBe(false);
    });
  });

  describe("终态订阅 settled", () => {
    it("不在途：立即兑现，不发停流、不武装看门狗", async () => {
      const h = makeHarness();
      const settled = h.settle(h.turn.settled());
      await h.flushMicrotasks();
      expect(settled.settled).toBe(true);
      expect(h.calls).toEqual([]);
      expect(h.timers.pending).toBe(0);
    });

    it("流段在途：发停流；终态（resolve）后才兑现", async () => {
      const h = makeHarness();
      h.stream.active = true;
      const settled = h.settle(h.turn.settled());
      await h.flushMicrotasks();

      expect(h.calls).toContain("stopStream");
      expect(settled.settled).toBe(false);

      h.turn.resolve();
      await h.flushMicrotasks();
      expect(settled.settled).toBe(true);
    });

    it("受理窗口（端口未建）：停流只登记不发出；受理体补发点（flushDeferredStop）才发——必须晚于受理体", async () => {
      const h = makeHarness();
      let releaseAcceptance!: (verdict: SendVerdict) => void;
      h.deps.runAcceptance = async (text: string) => {
        h.calls.push(`accept:${text}`);
        return new Promise<SendVerdict>((resolve) => {
          releaseAcceptance = resolve;
        });
      };
      const turn = createTurnLifecycle(h.deps);

      const sending = turn.send("闸中问题");
      const settled = h.settle(turn.settled());
      await h.flushMicrotasks();

      // 端口未建：无从发 stop，只登记（若此刻发了，offscreen 当无活动请求空转）
      expect(h.calls).not.toContain("stopStream");
      expect(settled.settled).toBe(false);

      // 受理体结束（postMessage 之后）才补发
      h.stream.active = true;
      releaseAcceptance("accepted");
      await sending;
      expect(turn.flushDeferredStop()).toBe(true);
      expect(h.calls.indexOf("stopStream")).toBeGreaterThan(h.calls.findIndex((c) => c.startsWith("accept:")));

      // 补发是一次性的：再调不重复发
      expect(turn.flushDeferredStop()).toBe(false);
      expect(h.calls.filter((c) => c === "stopStream")).toHaveLength(1);

      turn.resolve();
      await h.flushMicrotasks();
      expect(settled.settled).toBe(true);
    });

    it("闸未放行（blocked，未起流）：受理结束即兑现待决 settle，不悬挂", async () => {
      const h = makeHarness();
      let releaseAcceptance!: (verdict: SendVerdict) => void;
      h.deps.runAcceptance = (text: string) => {
        h.calls.push(`accept:${text}`);
        return new Promise<SendVerdict>((resolve) => {
          releaseAcceptance = resolve;
        });
      };
      const turn = createTurnLifecycle(h.deps);

      const sending = turn.send("被拦下的问题");
      const settled = h.settle(turn.settled());
      await h.flushMicrotasks();
      expect(settled.settled).toBe(false);

      releaseAcceptance("blocked");
      await expect(sending).resolves.toBe("blocked");
      await h.flushMicrotasks();
      expect(settled.settled).toBe(true);
      expect(h.timers.pending).toBe(0);
    });

    it("重入：同一回合两次 settled 一起兑现", async () => {
      const h = makeHarness();
      h.stream.active = true;
      const first = h.settle(h.turn.settled());
      const secondState = { settled: false };
      const second = h.turn.settled();
      void second.then(() => {
        secondState.settled = true;
      });
      await h.flushMicrotasks();
      expect(first.settled).toBe(false);
      expect(secondState.settled).toBe(false);

      h.turn.resolve();
      await h.flushMicrotasks();
      expect(first.settled).toBe(true);
      expect(secondState.settled).toBe(true);
    });

    it("resolve 幂等：同一回合的多个落定出口重复兑现不重复回调（双结算防空转）", async () => {
      const h = makeHarness();
      h.stream.active = true;
      let calls = 0;
      const settled = h.turn.settled().then(() => {
        calls += 1;
      });
      await h.flushMicrotasks();

      h.turn.resolve();
      h.turn.resolve();
      h.turn.resolve();
      await settled;
      await h.flushMicrotasks();
      expect(calls).toBe(1);
    });

    it("看门狗：既不回终态也不断连时，兜底窗口后 forceReset + 兑现（settle 绝不悬挂）", async () => {
      const h = makeHarness();
      h.stream.active = true;
      const settled = h.settle(h.turn.settled());
      await h.flushMicrotasks();
      expect(h.timers.pending).toBe(1);
      expect(settled.settled).toBe(false);

      h.timers.fire();
      await h.flushMicrotasks();
      expect(h.calls).toContain("forceReset");
      expect(settled.settled).toBe(true);
    });

    it("看门狗窗口可注入（缺省 = TURN_SETTLE_FALLBACK_MS，4 秒）", async () => {
      const delays: number[] = [];
      const h = makeHarness({
        setTimer: (_fn: () => void, ms: number) => {
          delays.push(ms);
          return delays.length;
        }
      });
      h.stream.active = true;
      void h.turn.settled();
      await h.flushMicrotasks();
      expect(delays).toEqual([TURN_SETTLE_FALLBACK_MS]);
      expect(TURN_SETTLE_FALLBACK_MS).toBe(4000);
    });

    it("落定后撤下看门狗：终态先到时兜底不再触发（不误拆下一回合）", async () => {
      const h = makeHarness();
      h.stream.active = true;
      const settled = h.settle(h.turn.settled());
      await h.flushMicrotasks();
      h.turn.resolve();
      await h.flushMicrotasks();
      expect(settled.settled).toBe(true);

      h.timers.fire();
      await h.flushMicrotasks();
      expect(h.calls).not.toContain("forceReset");
    });
  });

  describe("拆除级清场 discard", () => {
    it("同步复位受理窗口并兑现已武装的 settle（断流先于落盘的时序不被拉长）", async () => {
      const h = makeHarness();
      h.window.accepting = true;
      const settled = h.settle(h.turn.settled());
      await h.flushMicrotasks();
      expect(settled.settled).toBe(false);

      h.turn.discard();
      // 同步复位：调用返回时窗口已关（无 await 缝隙）
      expect(h.window.accepting).toBe(false);
      expect(h.turn.isActive()).toBe(false);
      await h.flushMicrotasks();
      expect(settled.settled).toBe(true);
      // 拆除后新回合可再次受理
      await expect(h.turn.send("清场后的新问题")).resolves.toBe("accepted");
    });

    it("discard 撤下停流登记与看门狗：拆除后不再补发 stop、兜底不再触发", async () => {
      const h = makeHarness();
      let releaseAcceptance!: (verdict: SendVerdict) => void;
      h.deps.runAcceptance = () =>
        new Promise<SendVerdict>((resolve) => {
          releaseAcceptance = resolve;
        });
      const turn = createTurnLifecycle(h.deps);

      const sending = turn.send("闸中问题");
      void turn.settled();
      await h.flushMicrotasks();

      turn.discard();
      h.stream.active = true;
      releaseAcceptance("accepted");
      await sending;

      expect(turn.flushDeferredStop()).toBe(false);
      expect(h.calls).not.toContain("stopStream");
      h.timers.fire();
      expect(h.calls).not.toContain("forceReset");
    });
  });
});
