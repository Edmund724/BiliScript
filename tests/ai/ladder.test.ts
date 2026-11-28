import { describe, expect, it, vi } from "vitest";
import {
  runLadderChat,
  type BudgetPlan,
  type ChatMsg,
  type ChatPort,
  type OrchestrateMapReduceFn,
  type ResolveFollowupContextFn,
  type RunLadderChatDeps,
  type StreamChatArgs,
  type StreamChatFn,
  type WebSearchRuntime
} from "../../extension/ai/ladder.js";
import type { ChatPortMessage } from "../../extension/chat/protocol.js";
import { makeOverflowError } from "../../extension/ai/completion.js";
import type { ChatMessage } from "../../extension/ai/types.js";

type MapReduceResult = Awaited<ReturnType<OrchestrateMapReduceFn>>;

function makePort(): ChatPort & { messages: ChatPortMessage[] } {
  const messages: ChatPortMessage[] = [];
  return {
    messages,
    postMessage(m: ChatPortMessage) {
      messages.push(m);
    }
  };
}

function makeBudgetPlan(overrides: Partial<BudgetPlan> = {}): BudgetPlan {
  return {
    totalChars: 0,
    estimatedTokens: 0,
    mode: "single",
    segments: [],
    estimatedCalls: 1,
    needsReduce: false,
    reduceGroupInputChars: 100000,
    ...overrides
  };
}

function makeMapReduceResult(overrides: Partial<MapReduceResult> = {}): MapReduceResult {
  return {
    draft: "",
    segmentSummaries: [],
    aborted: false,
    ...overrides
  };
}

function makeWebSearchRuntime(): WebSearchRuntime {
  return {
    maxToolCalls: 5,
    executeSearch: async () => ({ results: [], platform: "Tavily" })
  };
}

function makeDeps(overrides: Partial<RunLadderChatDeps> = {}) {
  const calls = {
    streamChat: [] as StreamChatArgs[],
    mapReduce: [] as Parameters<OrchestrateMapReduceFn>[0][],
    followup: [] as Parameters<ResolveFollowupContextFn>[0][]
  };
  const deps: RunLadderChatDeps = {
    streamChat: vi.fn<StreamChatFn>(async (args) => {
      calls.streamChat.push(args);
      return { done: true };
    }),
    orchestrateMapReduce: vi.fn<OrchestrateMapReduceFn>(async (args) => {
      calls.mapReduce.push(args);
      return makeMapReduceResult();
    }),
    resolveFollowupContext: vi.fn<ResolveFollowupContextFn>(async (args) => {
      calls.followup.push(args);
      return null;
    }),
    buildBudgetPlan: vi.fn<NonNullable<RunLadderChatDeps["buildBudgetPlan"]>>(() => makeBudgetPlan()),
    askCostGuard: vi.fn<RunLadderChatDeps["askCostGuard"]>(async () => true),
    onActivity: vi.fn(),
    pauseIdleTimeout: vi.fn(),
    acquireSwKeepalive: undefined,
    ...overrides
  };
  return { deps, calls };
}

function makeMsg(): ChatMsg {
  return {
    context: { subtitleBody: [{ from: 0, to: 10, content: "字幕内容" }], chapters: [] },
    history: [{ role: "user", content: "h1" }, { role: "assistant", content: "h2" }],
    prompt: "总结一下",
    thinkingLevel: "off"
  };
}

describe("runLadderChat 分派", () => {
  it("① 预算内（非 map-reduce）→ 单次 streamChat，不触发追问与 Map-Reduce", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps, calls } = makeDeps();

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal }, deps);

    expect(calls.streamChat).toHaveLength(1);
    expect(calls.streamChat[0]).toMatchObject({
      provider: { id: "p" },
      context: { subtitleBody: [{ from: 0, to: 10, content: "字幕内容" }], chapters: [] },
      userPrompt: "总结一下",
      signal
    });
    expect(calls.mapReduce).toHaveLength(0);
    expect(calls.followup).toHaveLength(0);
    expect(port.messages).toHaveLength(0);
  });

  it("② map-reduce 模式下追问命中 → 统一透传完整历史与 summaryAnchor + 单次 streamChat", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const history: ChatMessage[] = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `h${i}`
    }));
    const summaryAnchor = { text: "归档摘要", coveredMessageCount: 2, updatedAt: 1000 };
    const followupFn = vi.fn(async () => ({ kind: "followup", compressedSummaryMarkdown: "压缩摘要内容" }));
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => makeBudgetPlan({ mode: "map-reduce", estimatedCalls: 8 }),
      resolveFollowupContext: followupFn
    });

    await runLadderChat(
      { msg: { ...makeMsg(), history, summaryAnchor }, provider: { id: "p" }, port, signal },
      deps
    );

    expect(followupFn).toHaveBeenCalledTimes(1);
    expect(calls.streamChat).toHaveLength(1);
    expect(calls.streamChat[0].history).toEqual(history);
    expect(calls.streamChat[0].summaryAnchor).toEqual(summaryAnchor);
    expect(calls.streamChat[0].context).toMatchObject({
      kind: "followup",
      subtitleBody: []
    });
    expect(calls.streamChat[0].context?.hybridRetrievalMarkdown).toContain("压缩摘要内容");
    expect(calls.mapReduce).toHaveLength(0);
    expect(port.messages).toHaveLength(0);
  });

  it("③a 未命中 + 达阈值 + 确认 → askCostGuard 后走 orchestrateMapReduce", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () =>
        makeBudgetPlan({ mode: "map-reduce", estimatedCalls: 12, totalChars: 150000, estimatedTokens: 150000 })
    });

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal }, deps);

    expect(deps.askCostGuard).toHaveBeenCalledWith(
      port,
      "当前视频较长，进行「AI 对话」全片分析预计约 12 次调用 / 约 150,000 token，可取消"
    );
    expect(deps.pauseIdleTimeout).toHaveBeenCalled();
    expect(calls.mapReduce).toHaveLength(1);
    expect(calls.mapReduce[0]).toMatchObject({ plan: { mode: "map-reduce" }, signal });
    expect(port.messages).toHaveLength(0);
  });

  it("③b 未命中 + 达阈值 + 取消 → postMessage stopped，不走 Map-Reduce", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => makeBudgetPlan({ mode: "map-reduce", estimatedCalls: 12, totalChars: 150000 }),
      askCostGuard: vi.fn(async () => false)
    });

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal }, deps);

    expect(deps.askCostGuard).toHaveBeenCalledWith(
      port,
      "当前视频较长，进行「AI 对话」全片分析预计约 12 次调用 / 约 150,000 token，可取消"
    );
    expect(calls.mapReduce).toHaveLength(0);
    expect(port.messages).toEqual([{ type: "stopped", reason: "已取消" }]);
  });

  it("④ 单次 streamChat 抛 overflow 标记错误 → orchestrateMapReduce 被调一次（仅一次）", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps, calls } = makeDeps({
      streamChat: vi.fn(async () => {
        throw makeOverflowError();
      })
    });

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal }, deps);

    expect(deps.streamChat).toHaveBeenCalledTimes(1);
    expect(calls.mapReduce).toHaveLength(1);
    expect(calls.mapReduce[0].plan).toBeNull();
  });

  it("⑤ 追问压缩后 streamChat 抛 overflow 标记错误 → postMessage 追问溢出错误，不转 Map-Reduce", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => makeBudgetPlan({ mode: "map-reduce", estimatedCalls: 8 }),
      resolveFollowupContext: vi.fn(async () => ({ kind: "followup" })),
      streamChat: vi.fn(async () => {
        throw makeOverflowError();
      })
    });

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal }, deps);

    expect(deps.streamChat).toHaveBeenCalledTimes(1);
    expect(calls.mapReduce).toHaveLength(0);
    expect(port.messages).toEqual([
      { type: "error", error: "追问内容仍超出上下文预算，请换个更具体的问题重试" }
    ]);
  });
});

describe("08 票 SW 保活：运行期间持有，结束（含异常）释放", () => {
  function makeKeepaliveSpy() {
    const events: string[] = [];
    const handle = {
      release: vi.fn(() => {
        events.push("release");
      })
    };
    const acquireSwKeepalive = vi.fn(() => {
      events.push("acquire");
      return handle;
    });
    return { acquireSwKeepalive, handle, events };
  }

  it("单次流式路径：先 acquire（在任何分派之前），运行结束 release", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps } = makeDeps();
    const { acquireSwKeepalive, handle, events } = makeKeepaliveSpy();
    deps.acquireSwKeepalive = acquireSwKeepalive;

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal }, deps);

    expect(acquireSwKeepalive).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["acquire", "release"]);
    expect(handle.release).toHaveBeenCalledTimes(1);
  });

  it("Map-Reduce 主路径（含成本护栏等待）全程持有，结束 release", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => makeBudgetPlan({ mode: "map-reduce", estimatedCalls: 8, totalChars: 150000 }),
      resolveFollowupContext: vi.fn(async () => null),
      askCostGuard: vi.fn(async () => true)
    });
    const { acquireSwKeepalive, events } = makeKeepaliveSpy();
    deps.acquireSwKeepalive = acquireSwKeepalive;

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal }, deps);

    expect(calls.mapReduce).toHaveLength(1);
    expect(events).toEqual(["acquire", "release"]);
  });

  it("streamChat 抛非 overflow 错误（运行失败）→ 仍 release，异常继续上抛", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps } = makeDeps({
      streamChat: vi.fn(async () => {
        throw new Error("boom");
      })
    });
    const { acquireSwKeepalive, handle } = makeKeepaliveSpy();
    deps.acquireSwKeepalive = acquireSwKeepalive;

    await expect(
      runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal }, deps)
    ).rejects.toThrow("boom");
    expect(handle.release).toHaveBeenCalledTimes(1);
  });

  it("acquire 返回 null（无 chrome 环境）→ 运行不受影响", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps, calls } = makeDeps({
      acquireSwKeepalive: vi.fn(() => null)
    });

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal }, deps);

    expect(calls.streamChat).toHaveLength(1);
  });
});

describe("联网搜索透传与 Map-Reduce 剥离（spec Q12/Q13）", () => {
  it("单次路径：webSearch 透传 streamChat", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps, calls } = makeDeps();
    const webSearch = makeWebSearchRuntime();
    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal, webSearch }, deps);
    expect(calls.streamChat[0].webSearch).toBe(webSearch);
  });

  it("追问压缩路径：webSearch 透传（单次流式调用，非归约轮）", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => makeBudgetPlan({ mode: "map-reduce", estimatedCalls: 8 }),
      resolveFollowupContext: vi.fn(async () => ({ compressedSummaryMarkdown: "压缩摘要" }))
    });
    const webSearch = makeWebSearchRuntime();
    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal, webSearch }, deps);
    expect(calls.streamChat[0].webSearch).toBe(webSearch);
    expect(port.messages.some((m) => m.type === "notice" && m.data === "超长内容归约中，本轮不联网")).toBe(false);
  });

  it("Map-Reduce 归约轮：notice「本轮不联网」+ 不传 webSearch", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => makeBudgetPlan({ mode: "map-reduce", estimatedCalls: 8, estimatedTokens: 150000 })
    });
    const webSearch = makeWebSearchRuntime();
    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal, webSearch }, deps);
    expect(port.messages.some((m) => m.type === "notice" && m.data === "超长内容归约中，本轮不联网")).toBe(true);
    expect(calls.mapReduce.length).toBe(1);
  });

  it("单次溢出转 Map-Reduce：同样 notice + 不联网", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => makeBudgetPlan({ mode: "single" }),
      streamChat: vi.fn(async () => {
        throw Object.assign(new Error("overflow"), { overflow: true });
      })
    });
    const webSearch = makeWebSearchRuntime();
    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal, webSearch }, deps);
    expect(port.messages.some((m) => m.type === "notice" && m.data === "超长内容归约中，本轮不联网")).toBe(true);
    expect(calls.mapReduce.length).toBe(1);
    expect(calls.mapReduce[0].plan).toBeNull();
  });

  it("无 webSearch：归约轮不发 notice（行为回归）", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps } = makeDeps({
      buildBudgetPlan: () => makeBudgetPlan({ mode: "map-reduce", estimatedCalls: 8, estimatedTokens: 150000 })
    });
    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal }, deps);
    expect(port.messages.some((m) => m.type === "notice" && m.data === "超长内容归约中，本轮不联网")).toBe(false);
  });
});

describe("图片输入透传（image-input 路线 B）", () => {
  const VALID = { mime: "image/webp", data: "QUJD" };

  it("单次路径：msg.images 经白名单归一后透传 streamChat", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps, calls } = makeDeps();

    await runLadderChat(
      { msg: { ...makeMsg(), images: [VALID] }, provider: { id: "p" }, port, signal },
      deps
    );

    expect(calls.streamChat[0].userImages).toEqual([VALID]);
  });

  it("非法项被白名单丢弃；全非法/缺省时为 undefined（无图不带字段）", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps, calls } = makeDeps();

    await runLadderChat(
      {
        msg: { ...makeMsg(), images: [{ mime: "image/webp" }, VALID, { mime: "", data: "x" }] },
        provider: { id: "p" },
        port,
        signal
      },
      deps
    );
    expect(calls.streamChat[0].userImages).toEqual([VALID]);

    const bare = makePort();
    const second = makeDeps();
    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port: bare, signal }, second.deps);
    expect(second.calls.streamChat[0].userImages).toBeUndefined();
  });

  it("追问压缩路径：同样透传；Map-Reduce 主路径不带图（各段现造 user 消息）", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => makeBudgetPlan({ mode: "map-reduce", estimatedCalls: 8 }),
      resolveFollowupContext: vi.fn(async () => ({ compressedSummaryMarkdown: "压缩摘要" }))
    });

    await runLadderChat(
      { msg: { ...makeMsg(), images: [VALID] }, provider: { id: "p" }, port, signal },
      deps
    );
    expect(calls.streamChat[0].userImages).toEqual([VALID]);

    const overflowPort = makePort();
    const overflowDeps = makeDeps({
      buildBudgetPlan: () => makeBudgetPlan({ mode: "single" }),
      streamChat: vi.fn(async () => {
        throw makeOverflowError("overflow");
      })
    });
    await runLadderChat(
      { msg: { ...makeMsg(), images: [VALID] }, provider: { id: "p" }, port: overflowPort, signal },
      overflowDeps.deps
    );
    expect(overflowDeps.calls.mapReduce).toHaveLength(1);
    expect(overflowDeps.calls.mapReduce[0]).not.toHaveProperty("userImages");
    expect(overflowDeps.calls.mapReduce[0].plan).toBeNull();
  });
});

describe("档位透传（票 thinking-seam-tightening/02：链上只透传，归一施加点只在解析入口）", () => {
  const DIRTY: unknown[] = ["none", "", 7, null, { weird: true }];

  it("单次路径：端口脏值（含非字符串）逐字到达 streamChat，不判、不归、不拒", async () => {
    for (const dirty of DIRTY) {
      const { deps, calls } = makeDeps();

      await runLadderChat(
        { msg: { ...makeMsg(), thinkingLevel: dirty }, provider: { id: "p" }, port: makePort(), signal: new AbortController().signal },
        deps
      );

      expect(calls.streamChat[0].thinkingLevel, `thinkingLevel=${JSON.stringify(dirty)}`).toBe(dirty);
    }
  });

  it("合法档位同样逐字透传（透传不挑值）", async () => {
    const { deps, calls } = makeDeps();

    await runLadderChat(
      { msg: { ...makeMsg(), thinkingLevel: "high" }, provider: { id: "p" }, port: makePort(), signal: new AbortController().signal },
      deps
    );

    expect(calls.streamChat[0].thinkingLevel).toBe("high");
  });

  it("追问压缩 / Map-Reduce 主路径 / 单次溢出转 Map-Reduce：三条边同样逐字透传", async () => {
    const dirty = { weird: true };
    const msg = { ...makeMsg(), thinkingLevel: dirty };

    const followup = makeDeps({
      buildBudgetPlan: () => makeBudgetPlan({ mode: "map-reduce", estimatedCalls: 8 }),
      resolveFollowupContext: vi.fn(async () => ({ compressedSummaryMarkdown: "压缩摘要" }))
    });
    await runLadderChat(
      { msg, provider: { id: "p" }, port: makePort(), signal: new AbortController().signal },
      followup.deps
    );
    expect(followup.calls.streamChat[0].thinkingLevel).toBe(dirty);

    const main = makeDeps({
      buildBudgetPlan: () => makeBudgetPlan({ mode: "map-reduce", estimatedCalls: 8 }),
      resolveFollowupContext: vi.fn(async () => null)
    });
    await runLadderChat(
      { msg, provider: { id: "p" }, port: makePort(), signal: new AbortController().signal },
      main.deps
    );
    expect(main.calls.mapReduce[0].thinkingLevel).toBe(dirty);

    const overflow = makeDeps({
      buildBudgetPlan: () => makeBudgetPlan({ mode: "single" }),
      streamChat: vi.fn(async () => {
        throw makeOverflowError();
      })
    });
    await runLadderChat(
      { msg, provider: { id: "p" }, port: makePort(), signal: new AbortController().signal },
      overflow.deps
    );
    expect(overflow.calls.mapReduce[0].thinkingLevel).toBe(dirty);
  });
});

describe("L0+L1 混合路径与无 L0 行回退", () => {
  it("map-reduce 且存在有效 L0 字幕行时，调用 resolveFollowupContext 并将纯压缩摘要注入混合上下文", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const resolveFollowupContext = vi.fn(async () => ({
      bvid: "BV1l0",
      cid: "1",
      compressedSummaryMarkdown: "## 分段小结\n\n### 片段 1\n纯摘要\n\n## 成稿笔记\n\n笔记正文"
    }));
    const expectedPlan = makeBudgetPlan({ mode: "map-reduce", estimatedCalls: 8 });
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => expectedPlan,
      resolveFollowupContext
    });

    await runLadderChat(
      {
        msg: {
          ...makeMsg(),
          context: {
            bvid: "BV1l0",
            cid: "1",
            subtitleBody: [{ from: 0, to: 10, content: "第一句有效字幕" }],
            chapters: []
          }
        },
        provider: { id: "p", baseUrl: "https://api.example.com/v1", model: "m", apiKey: "k" },
        port,
        signal
      },
      deps
    );

    expect(resolveFollowupContext).toHaveBeenCalledWith({
      context: expect.objectContaining({ bvid: "BV1l0", cid: "1" }),
      plan: expectedPlan,
      history: makeMsg().history
    });
    expect(calls.streamChat).toHaveLength(1);
    expect(calls.streamChat[0].context?.hybridRetrievalMarkdown).toContain("纯摘要");
  });

  it("map-reduce 且无有效 L0 字幕行时，跳过追问回退并直接进入 Map-Reduce 编排", async () => {
    const signal = new AbortController().signal;
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => makeBudgetPlan({ mode: "map-reduce", estimatedCalls: 4 })
    });

    await runLadderChat(
      {
        msg: {
          ...makeMsg(),
          context: { bvid: "BV1empty", cid: "1", subtitleBody: [], chapters: [] }
        },
        provider: { id: "p" },
        port,
        signal
      },
      deps
    );

    expect(calls.followup).toHaveLength(0);
    expect(calls.streamChat).toHaveLength(0);
    expect(calls.mapReduce).toHaveLength(1);
  });
});
