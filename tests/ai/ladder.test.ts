// ai/ladder.js 阶梯分派策略测试：
// 用 fake deps + 收集 postMessage 的 fake port 覆盖五个分支——
// ① 预算内单次流式；② map-reduce 下追问压缩命中；③ 未命中 + 成本护栏
// （确认走 Map-Reduce / 取消回 stopped）；④ 单次溢出转 Map-Reduce 重试一次；
// ⑤ 追问压缩后仍溢出 → 追问溢出错误。
// 溢出语义（候选 03 起）：fake streamChat 抛带 .overflow 标记的错误（旧返回哨兵已废）。

import { describe, expect, it, vi } from "vitest";
import { runLadderChat, type ChatMessage, type ChatMsg, type RunLadderChatDeps } from "../../extension/ai/ladder.js";
import { makeOverflowError } from "../../extension/ai/completion.js";

// 假 port 收发的消息形状（用例只断言 notice / stopped / error 三类的字段）
interface PortMessage {
  type?: string;
  data?: unknown;
  reason?: string;
  error?: string;
}

// 收集 postMessage 消息的 fake port
function makePort() {
  const messages: PortMessage[] = [];
  return {
    messages,
    postMessage(m: PortMessage) {
      messages.push(m);
    }
  };
}

// 依测试需要覆盖的 fake deps 工厂：默认全部可观察的最小实现
function makeDeps(overrides: Partial<RunLadderChatDeps> = {}) {
  const calls = { streamChat: [] as any[], mapReduce: [] as any[], followup: [] as any[], guard: [] as any[] };
  const deps = {
    streamChat: vi.fn(async (args) => {
      calls.streamChat.push(args);
      return "ok";
    }),
    orchestrateMapReduce: vi.fn(async (args) => {
      calls.mapReduce.push(args);
      return "ok";
    }),
    resolveFollowupContext: vi.fn(async (args) => {
      calls.followup.push(args);
      return null;
    }),
    buildBudgetPlan: vi.fn((): { mode: "single" | "map-reduce" } => ({ mode: "single" })),
    buildCostGuardNotice: vi.fn(() => ({ shouldPrompt: false, message: "" })),
    trimRecentTurns: vi.fn((history) => (history || []).slice(-2)),
    askCostGuard: vi.fn(async () => true),
    onActivity: vi.fn(),
    pauseIdleTimeout: vi.fn(),
    acquireSwKeepalive: undefined as RunLadderChatDeps["acquireSwKeepalive"],
    ...overrides
  };
  return { deps, calls };
}

function makeMsg(): ChatMsg {
  return {
    context: { subtitleBody: ["a", "b"], chapters: [] },
    history: [{ role: "user", content: "h1" }, { role: "assistant", content: "h2" }],
    prompt: "总结一下",
    thinkingLevel: "off"
  };
}

describe("runLadderChat 分派", () => {
  it("① 预算内（非 map-reduce）→ 单次 streamChat，不触发追问与 Map-Reduce", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps();

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig" }, deps);

    expect(calls.streamChat).toHaveLength(1);
    expect(calls.streamChat[0]).toMatchObject({
      provider: { id: "p" },
      context: { subtitleBody: ["a", "b"], chapters: [] },
      userPrompt: "总结一下",
      signal: "sig"
    });
    expect(calls.mapReduce).toHaveLength(0);
    expect(calls.followup).toHaveLength(0);
    expect(port.messages).toHaveLength(0);
  });

  it("② map-reduce 模式下追问命中 → trimRecentTurns 截历史 + 单次 streamChat", async () => {
    const port = makePort();
    const history: ChatMessage[] = Array.from({ length: 6 }, (_, i) => ({ role: "user", content: `h${i}` }));
    const followupFn = vi.fn(async () => ({ kind: "followup" }));
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => ({ mode: "map-reduce", estimatedCalls: 8 }),
      resolveFollowupContext: followupFn
    });

    await runLadderChat({ msg: { ...makeMsg(), history }, provider: { id: "p" }, port, signal: "sig" }, deps);

    expect(followupFn).toHaveBeenCalledTimes(1);
    expect(deps.trimRecentTurns).toHaveBeenCalledWith(history);
    expect(calls.streamChat).toHaveLength(1);
    // 历史经 trimRecentTurns 封顶（fake: 保留最近 2 轮）
    expect(calls.streamChat[0].history).toEqual(history.slice(-2));
    expect(calls.streamChat[0].context).toEqual({ kind: "followup" });
    expect(calls.mapReduce).toHaveLength(0);
    expect(port.messages).toHaveLength(0);
  });

  it("③a 未命中 + shouldPrompt=true + 确认 → askCostGuard 后走 orchestrateMapReduce", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => ({ mode: "map-reduce", estimatedCalls: 8, estimatedTokens: 150000 }),
      buildCostGuardNotice: () => ({ shouldPrompt: true, message: "预计约 8 次调用" })
    });

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig" }, deps);

    expect(deps.askCostGuard).toHaveBeenCalledWith(port, "预计约 8 次调用");
    expect(deps.pauseIdleTimeout).toHaveBeenCalled();
    expect(calls.mapReduce).toHaveLength(1);
    expect(calls.mapReduce[0]).toMatchObject({ plan: { mode: "map-reduce" }, signal: "sig" });
    expect(port.messages).toHaveLength(0);
  });

  it("③b 未命中 + shouldPrompt=true + 取消 → postMessage stopped，不走 Map-Reduce", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => ({ mode: "map-reduce", estimatedCalls: 8 }),
      buildCostGuardNotice: () => ({ shouldPrompt: true, message: "预计约 8 次调用" }),
      askCostGuard: vi.fn(async () => false)
    });

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig" }, deps);

    expect(deps.askCostGuard).toHaveBeenCalledTimes(1);
    expect(calls.mapReduce).toHaveLength(0);
    expect(port.messages).toEqual([{ type: "stopped", reason: "已取消" }]);
  });

  it("④ 单次 streamChat 抛 overflow 标记错误 → orchestrateMapReduce 被调一次（仅一次）", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps({
      streamChat: vi.fn(async () => {
        throw makeOverflowError();
      })
    });

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig" }, deps);

    expect(deps.streamChat).toHaveBeenCalledTimes(1);
    expect(calls.mapReduce).toHaveLength(1);
    expect(calls.mapReduce[0].plan).toEqual({ mode: "single" });
  });

  it("⑤ 追问压缩后 streamChat 抛 overflow 标记错误 → postMessage 追问溢出错误，不转 Map-Reduce", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => ({ mode: "map-reduce", estimatedCalls: 8 }),
      resolveFollowupContext: vi.fn(async () => ({ kind: "followup" })),
      streamChat: vi.fn(async () => {
        throw makeOverflowError();
      })
    });

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig" }, deps);

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
    const port = makePort();
    const { deps } = makeDeps();
    const { acquireSwKeepalive, handle, events } = makeKeepaliveSpy();
    deps.acquireSwKeepalive = acquireSwKeepalive;

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig" }, deps);

    expect(acquireSwKeepalive).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["acquire", "release"]);
    expect(handle.release).toHaveBeenCalledTimes(1);
  });

  it("Map-Reduce 主路径（含成本护栏等待）全程持有，结束 release", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => ({ mode: "map-reduce", estimatedCalls: 8 }),
      resolveFollowupContext: vi.fn(async () => null),
      buildCostGuardNotice: () => ({ shouldPrompt: true, message: "确认？" }),
      askCostGuard: vi.fn(async () => true)
    });
    const { acquireSwKeepalive, events } = makeKeepaliveSpy();
    deps.acquireSwKeepalive = acquireSwKeepalive;

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig" }, deps);

    expect(calls.mapReduce).toHaveLength(1);
    expect(events).toEqual(["acquire", "release"]);
  });

  it("streamChat 抛非 overflow 错误（运行失败）→ 仍 release，异常继续上抛", async () => {
    const port = makePort();
    const { deps } = makeDeps({
      streamChat: vi.fn(async () => {
        throw new Error("boom");
      })
    });
    const { acquireSwKeepalive, handle } = makeKeepaliveSpy();
    deps.acquireSwKeepalive = acquireSwKeepalive;

    await expect(
      runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig" }, deps)
    ).rejects.toThrow("boom");
    expect(handle.release).toHaveBeenCalledTimes(1);
  });

  it("acquire 返回 null（无 chrome 环境）→ 运行不受影响", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps({
      acquireSwKeepalive: vi.fn(() => null)
    });

    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig" }, deps);

    expect(calls.streamChat).toHaveLength(1);
  });
});

describe("联网搜索透传与 Map-Reduce 剥离（spec Q12/Q13）", () => {
  it("单次路径：webSearch 透传 streamChat", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps();
    const webSearch = { maxToolCalls: 5, executeSearch: async () => ({ results: [], platform: "Tavily" }) };
    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig", webSearch }, deps);
    expect(calls.streamChat[0].webSearch).toBe(webSearch);
  });

  it("追问压缩路径：webSearch 透传（单次流式调用，非归约轮）", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => ({ mode: "map-reduce", estimatedCalls: 8 }),
      resolveFollowupContext: vi.fn(async () => ({ compressedSummaryMarkdown: "压缩摘要" }))
    });
    const webSearch = { maxToolCalls: 5, executeSearch: async () => ({ results: [], platform: "Tavily" }) };
    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig", webSearch }, deps);
    expect(calls.streamChat[0].webSearch).toBe(webSearch);
    expect(port.messages.some((m) => m.data === "超长内容归约中，本轮不联网")).toBe(false);
  });

  it("Map-Reduce 归约轮：notice「本轮不联网」+ 不传 webSearch", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => ({ mode: "map-reduce", estimatedCalls: 8, estimatedTokens: 150000 })
    });
    const webSearch = { maxToolCalls: 5, executeSearch: async () => ({ results: [], platform: "Tavily" }) };
    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig", webSearch }, deps);
    expect(port.messages.some((m) => m.type === "notice" && m.data === "超长内容归约中，本轮不联网")).toBe(true);
    expect(calls.mapReduce.length).toBe(1);
  });

  it("单次溢出转 Map-Reduce：同样 notice + 不联网", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => ({ mode: "single" }),
      streamChat: vi.fn(async () => {
        throw Object.assign(new Error("overflow"), { overflow: true });
      })
    });
    const webSearch = { maxToolCalls: 5, executeSearch: async () => ({ results: [], platform: "Tavily" }) };
    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig", webSearch }, deps);
    expect(port.messages.some((m) => m.type === "notice" && m.data === "超长内容归约中，本轮不联网")).toBe(true);
    expect(calls.mapReduce.length).toBe(1);
  });

  it("无 webSearch：归约轮不发 notice（行为回归）", async () => {
    const port = makePort();
    const { deps } = makeDeps({
      buildBudgetPlan: () => ({ mode: "map-reduce", estimatedCalls: 8, estimatedTokens: 150000 })
    });
    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port, signal: "sig" }, deps);
    expect(port.messages.some((m) => m.data === "超长内容归约中，本轮不联网")).toBe(false);
  });
});

describe("图片输入透传（image-input 路线 B）", () => {
  const VALID = { mime: "image/webp", data: "QUJD" };

  it("单次路径：msg.images 经白名单归一后透传 streamChat", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps();

    await runLadderChat(
      { msg: { ...makeMsg(), images: [VALID] }, provider: { id: "p" }, port, signal: "sig" },
      deps
    );

    expect(calls.streamChat[0].userImages).toEqual([VALID]);
  });

  it("非法项被白名单丢弃；全非法/缺省时为 undefined（无图不带字段）", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps();

    await runLadderChat(
      {
        msg: { ...makeMsg(), images: [{ mime: "image/webp" }, VALID, { mime: "", data: "x" }] },
        provider: { id: "p" },
        port,
        signal: "sig"
      },
      deps
    );
    expect(calls.streamChat[0].userImages).toEqual([VALID]);

    const bare = makePort();
    const second = makeDeps();
    await runLadderChat({ msg: makeMsg(), provider: { id: "p" }, port: bare, signal: "sig" }, second.deps);
    expect(second.calls.streamChat[0].userImages).toBeUndefined();
  });

  it("追问压缩路径：同样透传；Map-Reduce 主路径不带图（各段现造 user 消息）", async () => {
    const port = makePort();
    const { deps, calls } = makeDeps({
      buildBudgetPlan: () => ({ mode: "map-reduce", estimatedCalls: 8 }),
      resolveFollowupContext: vi.fn(async () => ({ compressedSummaryMarkdown: "压缩摘要" }))
    });

    await runLadderChat(
      { msg: { ...makeMsg(), images: [VALID] }, provider: { id: "p" }, port, signal: "sig" },
      deps
    );
    expect(calls.streamChat[0].userImages).toEqual([VALID]);

    // 单次溢出转 Map-Reduce：归约/分段编排的 args 里没有图片字段（04 号票：
    // map-reduce 主路径不进 history，图片只在单次/追问两条路径生效）。
    const overflowPort = makePort();
    const overflowDeps = makeDeps({
      buildBudgetPlan: () => ({ mode: "single" }),
      streamChat: vi.fn(async () => {
        throw makeOverflowError("overflow");
      })
    });
    await runLadderChat(
      { msg: { ...makeMsg(), images: [VALID] }, provider: { id: "p" }, port: overflowPort, signal: "sig" },
      overflowDeps.deps
    );
    expect(overflowDeps.calls.mapReduce).toHaveLength(1);
    expect(overflowDeps.calls.mapReduce[0].userImages).toBeUndefined();
  });
});
