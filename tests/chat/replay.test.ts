// 历史回放事务（CONTEXT.md 词条「历史回放」）：整段重建消息区的分片渲染。
// 覆盖四件契约：空历史清场、user/assistant 顺序与 userPrompt、搜索回合对位、
// 世代作废丢过期分片 + inFlight 生命周期。预算让出的续跑正确性由分片用例
// 与 tests/reader/chat-tab.test.ts 的整页夹具共同背书。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendChatHistory, resetChatSessionStateForTests } from "../../extension/chat/chat-state.js";
import type { ChatSessionMessage } from "../../extension/chat/chat-state.js";
import { createConversationReplay } from "../../extension/chat/replay.js";
import type { CreateConversationReplayDeps } from "../../extension/chat/replay.js";

function seedHistory(...messages: ChatSessionMessage[]): void {
  appendChatHistory(...messages);
}

function makeDeps(): { deps: CreateConversationReplayDeps; messages: HTMLElement; renderer: CreateConversationReplayDeps["renderer"] } {
  const messages = document.createElement("div");
  const renderer = {
    appendUserMessage: vi.fn((_text: string, _shouldScroll: boolean) => {
      const node = document.createElement("div");
      node.className = "chat-msg chat-msg-user";
      messages.appendChild(node);
    }),
    renderAssistantMessage: vi.fn((node: HTMLElement) => {
      messages.appendChild(node);
    }),
    buildSearchTimelineCard: vi.fn(() => {
      const card = document.createElement("div");
      card.className = "chat-search-card";
      return card;
    }),
    setAutoScroll: vi.fn(),
    scrollToBottom: vi.fn()
  };
  const deps: CreateConversationReplayDeps = {
    messages,
    renderer,
    updateLayout: vi.fn(),
    resetView: vi.fn(),
    clearSuggestions: vi.fn()
  };
  return { deps, messages, renderer };
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

  it("空历史：清消息区 + 建议区置空，整页走 resetView(\"\")，不渲染任何消息", async () => {
    const { deps, messages, renderer } = makeDeps();
    messages.innerHTML = "<div>旧内容</div>";
    const replay = createConversationReplay(deps);

    replay.render();

    expect(deps.updateLayout).toHaveBeenCalledTimes(1);
    expect(messages.innerHTML).toBe("");
    expect(deps.clearSuggestions).toHaveBeenCalledTimes(1);
    expect(deps.resetView).toHaveBeenCalledWith("");
    expect(renderer.appendUserMessage).not.toHaveBeenCalled();
    expect(renderer.renderAssistantMessage).not.toHaveBeenCalled();
    expect(renderer.setAutoScroll).not.toHaveBeenCalled();
    await flushTurn();
    expect(replay.inFlight).toBeNull();
  });

  it("user/assistant 顺序回放：userPrompt 取前一条用户消息，收尾滚底恰一次", async () => {
    const { deps, renderer } = makeDeps();
    seedHistory(
      { role: "user", content: "问一" },
      { role: "assistant", content: "答一" },
      { role: "user", content: "问二" },
      { role: "assistant", content: "答二" }
    );
    const replay = createConversationReplay(deps);

    replay.render();
    await flushTurn();

    expect(renderer.appendUserMessage).toHaveBeenNthCalledWith(1, "问一", false);
    expect(renderer.appendUserMessage).toHaveBeenNthCalledWith(2, "问二", false);
    expect(renderer.renderAssistantMessage).toHaveBeenCalledTimes(2);
    const firstNode = (renderer.renderAssistantMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as HTMLElement;
    expect(firstNode.className).toBe("chat-msg chat-msg-assistant");
    const firstOpts = (renderer.renderAssistantMessage as ReturnType<typeof vi.fn>).mock.calls[0][2] as { userPrompt: string; sources?: unknown };
    expect(firstOpts.userPrompt).toBe("问一");
    const secondOpts = (renderer.renderAssistantMessage as ReturnType<typeof vi.fn>).mock.calls[1][2] as { userPrompt: string; sources?: unknown };
    expect(secondOpts.userPrompt).toBe("问二");
    expect(secondOpts.sources).toBeUndefined();
    expect(renderer.buildSearchTimelineCard).not.toHaveBeenCalled();
    expect(renderer.setAutoScroll).toHaveBeenCalledTimes(1);
    expect(renderer.setAutoScroll).toHaveBeenCalledWith(true);
    expect(renderer.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(renderer.scrollToBottom).toHaveBeenCalledWith(true, { instant: true });
    expect(deps.resetView).not.toHaveBeenCalled();
  });

  it("搜索回合对位：tool 消息本体不渲染，时间线卡插在回答节点之前", async () => {
    const { deps, messages, renderer } = makeDeps();
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
        content: JSON.stringify([{ title: "A", url: "https://a.com", snippet: "sa" }])
      },
      { role: "assistant", content: "答 [1]。" }
    );
    const replay = createConversationReplay(deps);

    replay.render();
    await flushTurn();

    // 仅回答消息走 assistant 渲染，且带来源（tool 轮 assistant 无正文被跳过）。
    expect(renderer.renderAssistantMessage).toHaveBeenCalledTimes(1);
    const answerOpts = (renderer.renderAssistantMessage as ReturnType<typeof vi.fn>).mock.calls[0][2] as { userPrompt: string; sources?: unknown[] };
    expect(answerOpts.userPrompt).toBe("搜一下");
    expect(answerOpts.sources).toEqual([{ title: "A", url: "https://a.com", snippet: "sa" }]);
    expect(renderer.buildSearchTimelineCard).toHaveBeenCalledTimes(1);
    const card = messages.querySelector(".chat-search-card");
    expect(card).not.toBeNull();
    expect(card!.nextElementSibling?.classList.contains("chat-msg-assistant")).toBe(true);
  });

  it("世代作废丢分片：让出期间清场（invalidate）后，过期分片不写回消息区", async () => {
    const { deps, messages, renderer } = makeDeps();
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
    expect(renderer.appendUserMessage).toHaveBeenCalledTimes(1);
    expect(replay.inFlight).not.toBeNull();

    replay.invalidate();
    await flushTurn();

    // 过期分片全部丢弃：没有第二条用户消息、没有收尾滚底。
    expect(renderer.appendUserMessage).toHaveBeenCalledTimes(1);
    expect(renderer.renderAssistantMessage).not.toHaveBeenCalled();
    expect(renderer.setAutoScroll).not.toHaveBeenCalled();
    expect(messages.querySelectorAll(".chat-msg")).toHaveLength(1);
  });

  it("预算让出后续跑完整：不丢尾、顺序不变、滚底一次", async () => {
    const { deps, renderer } = makeDeps();
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
    expect(renderer.appendUserMessage).toHaveBeenCalledTimes(1);

    await flushTurn();

    expect(renderer.appendUserMessage).toHaveBeenCalledTimes(2);
    expect(renderer.renderAssistantMessage).toHaveBeenCalledTimes(2);
    expect(renderer.setAutoScroll).toHaveBeenCalledTimes(1);
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
