// 历史回放事务（GLOSSARY.md 词条「历史回放」）：整段重建消息区的分片渲染。
// 覆盖四件契约：空历史清场、user/assistant 顺序与 userPrompt、搜索回合对位、
// 世代作废丢过期分片 + inFlight 生命周期。预算让出的续跑正确性由分片用例
// 与 tests/reader/chat-tab.test.ts 的整页夹具共同背书。
//
// 句柄化（replace 不 layer）：回放不再自拼 `.chat-msg-assistant` 节点，也不再
// 直读消息容器——「助手消息节点长什么样」由渲染片的两个句柄唯一决定，本事务
// 只表达顺序（消息区句柄 append / 清场 + 回合句柄 finish / 挂时间线卡）。因此
// 假 renderer 也不再复现 DOM 形状（旧断言 firstNode.className 随假 DOM 一起退役），
// 改为断言经句柄表达的顺序与载荷；DOM 形状契约由
// tests/chat/chat-message-area.test.ts（同形）与 tests/reader/chat-tab.test.ts
// （真实渲染片整页回放）背书。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { appendChatHistory, resetChatSessionStateForTests } from "../../extension/chat/chat-state.js";
import type { ChatSessionMessage } from "../../extension/chat/chat-state.js";
import { createConversationReplay } from "../../extension/chat/replay.js";
import type { CreateConversationReplayDeps } from "../../extension/chat/replay.js";
import type { ChatAssistantTurn } from "../../extension/chat/chat-stream-render.js";

type MockFn = Mock<(...args: any[]) => any>;

function seedHistory(...messages: ChatSessionMessage[]): void {
  appendChatHistory(...messages);
}

// 假回合句柄：记录本回合的操作次序（finish 收尾 → 挂卡），不产生任何 DOM。
function makeFakeTurn(log: string[], slug: string) {
  const ops: string[] = [];
  const record = (op: string) => {
    ops.push(op);
    log.push(`${slug}:${op}`);
  };
  const turn: ChatAssistantTurn = {
    appendToken: vi.fn(),
    appendThinking: vi.fn(),
    reset: vi.fn(),
    discard: vi.fn(),
    finish: vi.fn(() => {
      record("finish");
      return "";
    }),
    fail: vi.fn(),
    stop: vi.fn(() => ({ raw: "", body: false })),
    markTruncated: vi.fn(),
    applySearchStatus: vi.fn(),
    attachSearchTimelineCard: vi.fn(() => {
      record("card");
    })
  };
  return {
    turn,
    ops,
    finish: turn.finish as unknown as MockFn,
    attachSearchTimelineCard: turn.attachSearchTimelineCard as unknown as MockFn
  };
}

function makeDeps(): {
  deps: CreateConversationReplayDeps;
  messages: HTMLElement;
  messageArea: { clear: MockFn; appendUserMessage: MockFn; appendAssistantMessage: MockFn };
  turns: ReturnType<typeof makeFakeTurn>[];
  log: string[];
  setAutoScroll: MockFn;
  scrollToBottom: MockFn;
} {
  const messages = document.createElement("div");
  const log: string[] = [];
  const turns: ReturnType<typeof makeFakeTurn>[] = [];
  const messageArea = {
    clear: vi.fn(() => {
      log.push("clear");
      messages.innerHTML = "";
    }),
    appendUserMessage: vi.fn((text: string, opts?: { source?: string }) => {
      log.push(`user:${opts?.source}:${text}`);
    }),
    appendAssistantMessage: vi.fn((opts?: { source?: string }) => {
      const fake = makeFakeTurn(log, `assistant${turns.length}`);
      turns.push(fake);
      log.push(`assistant:${opts?.source}`);
      return fake.turn;
    })
  };
  const setAutoScroll = vi.fn();
  const scrollToBottom = vi.fn();
  const deps: CreateConversationReplayDeps = {
    renderer: {
      messageArea,
      setAutoScroll,
      scrollToBottom
    },
    updateLayout: vi.fn(),
    clearSuggestions: vi.fn()
  };
  return { deps, messages, messageArea, turns, log, setAutoScroll, scrollToBottom };
}

async function flushTurn(): Promise<void> {
  // 让出点走 window.setTimeout 0（jsdom 无 scheduler.yield）：冲一个宏任务。
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

describe("createConversationReplay（历史回放事务）", () => {
  beforeEach(() => {
    resetChatSessionStateForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("user/assistant 顺序回放：来源=replay、userPrompt 取前一条用户消息，收尾滚底恰一次", async () => {
    const { deps, messageArea, turns, log, setAutoScroll, scrollToBottom } = makeDeps();
    seedHistory(
      { role: "user", content: "问一" },
      { role: "assistant", content: "答一" },
      { role: "user", content: "问二" },
      { role: "assistant", content: "答二" }
    );
    const replay = createConversationReplay(deps);

    replay.render();
    await flushTurn();

    // 顺序（消息区句柄表达）：清场 → 用户 → 助手（收尾）→ 用户 → 助手（收尾）
    expect(log).toEqual([
      "clear",
      "user:replay:问一",
      "assistant:replay",
      "assistant0:finish",
      "user:replay:问二",
      "assistant:replay",
      "assistant1:finish"
    ]);
    expect(messageArea.appendUserMessage).toHaveBeenNthCalledWith(1, "问一", { source: "replay" });
    expect(messageArea.appendUserMessage).toHaveBeenNthCalledWith(2, "问二", { source: "replay" });
    expect(messageArea.appendAssistantMessage).toHaveBeenNthCalledWith(1, { source: "replay" });
    expect(turns[0].finish).toHaveBeenCalledWith({ raw: "答一", userPrompt: "问一", sources: [] });
    expect(turns[1].finish).toHaveBeenCalledWith({ raw: "答二", userPrompt: "问二", sources: [] });
    expect(turns[0].attachSearchTimelineCard).not.toHaveBeenCalled();
    expect(setAutoScroll).toHaveBeenCalledTimes(1);
    expect(setAutoScroll).toHaveBeenCalledWith(true);
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
    expect(scrollToBottom).toHaveBeenCalledWith(true, { instant: true });
  });

  it("搜索回合对位：tool 消息本体不渲染，时间线卡经回合句柄插在回答之前（finish 先于挂卡）", async () => {
    const { deps, turns } = makeDeps();
    const sources = [{ title: "A", url: "https://a.com", snippet: "sa" }];
    seedHistory(
      { role: "user", content: "搜一下" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", function: { name: "web_search", arguments: '{"query":"第一问"}' } }]
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: JSON.stringify(sources)
      },
      { role: "assistant", content: "答 [1]。" }
    );
    const replay = createConversationReplay(deps);

    replay.render();
    await flushTurn();

    // 仅回答消息走回合句柄，且带本回合来源（tool 轮 assistant 无正文被跳过）。
    expect(turns).toHaveLength(1);
    expect(turns[0].finish).toHaveBeenCalledWith({ raw: "答 [1]。", userPrompt: "搜一下", sources });
    expect(turns[0].attachSearchTimelineCard).toHaveBeenCalledTimes(1);
    expect(turns[0].attachSearchTimelineCard).toHaveBeenCalledWith({
      assistantIndex: 3,
      queries: ["第一问"],
      resultCounts: [1],
      sources
    });
    // 卡必须在正文收尾之后挂（顺序是回放唯一表达的东西）
    expect(turns[0].ops).toEqual(["finish", "card"]);
  });

  it("世代作废丢分片：让出期间清场（invalidate）后，过期分片不再经句柄表达", async () => {
    const { deps, messages, messageArea, setAutoScroll } = makeDeps();
    seedHistory(
      { role: "user", content: "问一" },
      { role: "assistant", content: "答一" },
      { role: "user", content: "问二" },
      { role: "assistant", content: "答二" }
    );
    const replay = createConversationReplay(deps);
    // 预算判定恒超时：首条消息后即让出，剩余分片留在宏任务侧。
    let nowCalls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls === 1 ? 1000 : 2000;
    });

    replay.render();
    // 首片已同步上屏（问一），在途分片（答一/问二/答二）等待让出。
    expect(messageArea.appendUserMessage).toHaveBeenCalledTimes(1);
    expect(replay.inFlight).not.toBeNull();

    replay.invalidate();
    await flushTurn();

    // 过期分片全部丢弃：没有第二条用户消息、没有助手回合、没有收尾滚底；
    // 回放不自拼节点 → 消息区只有清场后的空容器。
    expect(messageArea.appendUserMessage).toHaveBeenCalledTimes(1);
    expect(messageArea.appendAssistantMessage).not.toHaveBeenCalled();
    expect(setAutoScroll).not.toHaveBeenCalled();
    expect(messages.querySelectorAll(".chat-msg")).toHaveLength(0);
  });

  it("预算让出后续跑完整：不丢尾、顺序不变、滚底一次", async () => {
    const { deps, messageArea, setAutoScroll } = makeDeps();
    seedHistory(
      { role: "user", content: "问一" },
      { role: "assistant", content: "答一" },
      { role: "user", content: "问二" },
      { role: "assistant", content: "答二" }
    );
    const replay = createConversationReplay(deps);
    let nowCalls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls === 1 ? 1000 : 2000;
    });

    replay.render();
    expect(messageArea.appendUserMessage).toHaveBeenCalledTimes(1);

    await flushTurn();

    expect(messageArea.appendUserMessage).toHaveBeenCalledTimes(2);
    expect(messageArea.appendAssistantMessage).toHaveBeenCalledTimes(2);
    expect(setAutoScroll).toHaveBeenCalledTimes(1);
  });

  it("inFlight 生命周期：在途非 null，落定归 null", async () => {
    const { deps } = makeDeps();
    seedHistory({ role: "user", content: "问" }, { role: "assistant", content: "答" });
    const replay = createConversationReplay(deps);
    let nowCalls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls === 1 ? 1000 : 2000;
    });

    replay.render();
    expect(replay.inFlight).not.toBeNull();

    await flushTurn();
    await flushTurn();

    expect(replay.inFlight).toBeNull();
  });
});
