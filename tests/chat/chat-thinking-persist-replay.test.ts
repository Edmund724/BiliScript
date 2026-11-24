// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeConversations } from "../../extension/ai/conversation.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import { renderMarkdown } from "../../extension/ui/markdown.js";
import type { CreateChatRuntimeDeps } from "../../extension/chat/chat-runtime.js";

let createChatRuntime: typeof import("../../extension/chat/chat-runtime.js").createChatRuntime;
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
let resetChatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").resetChatSessionStateForTests;
let applyContextToMain: typeof import("../../extension/chat/chat-state.js").applyContextToMain;
let applyConversationIdentity: typeof import("../../extension/chat/chat-state.js").applyConversationIdentity;
let appendChatHistory: typeof import("../../extension/chat/chat-state.js").appendChatHistory;
let createConversationReplay: typeof import("../../extension/chat/replay.js").createConversationReplay;
let createChatStreamRenderer: typeof import("../../extension/chat/chat-stream-render.js").createChatStreamRenderer;

function makeRuntimeDeps(): CreateChatRuntimeDeps & {
  messages: HTMLElement;
  input: HTMLTextAreaElement;
  onContinue: ReturnType<typeof vi.fn>;
  onRegenerate: ReturnType<typeof vi.fn>;
  emitMessage: (msg: unknown) => void;
} {
  const messages = document.createElement("div");
  const input = document.createElement("textarea");
  const onContinue = vi.fn();
  const onRegenerate = vi.fn();
  let messageListeners: Array<(msg: unknown) => void> = [];
  return {
    messages,
    input,
    onContinue,
    onRegenerate,
    emitMessage: (msg: unknown) => {
      for (const fn of [...messageListeners]) {
        fn(msg);
      }
    },
    store: {
      persistCurrent: vi.fn(async () => {}),
      isCurrent: () => true
    },
    ui: {
      setStreamingUiState: vi.fn(),
      showConversationContextNotice: vi.fn(),
      removeConversationContextNotice: vi.fn(),
      hideHistoryPopover: vi.fn(),
      removeCenteredState: vi.fn(),
      removeSuggestions: vi.fn(),
      requestViewReset: vi.fn(),
      autosizeInput: vi.fn()
    },
    ensureCurrentContextForSend: vi.fn(async () => ({ pass: true }) as const),
    getProviderId: () => "test-provider",
    getSelectedModel: () => "test-model",
    getTimestampNavDeps: () => ({}),
    normalizeMarkdownForSectionPaste,
    connectPort: vi.fn(async () => {
      messageListeners = [];
      return {
        name: "offscreen-chat",
        onMessage: { addListener: (fn: (msg: unknown) => void) => { messageListeners.push(fn); } },
        onDisconnect: { addListener: () => {} },
        postMessage: vi.fn(),
        disconnect: vi.fn()
      };
    })
  };
}

async function flushTurn(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

beforeEach(async () => {
  resetModuleState();
  ({ createChatRuntime } = await import("../../extension/chat/chat-runtime.js"));
  ({ chatSessionState, resetChatSessionStateForTests, appendChatHistory, applyContextToMain, applyConversationIdentity } = await import("../../extension/chat/chat-state.js"));
  ({ createConversationReplay } = await import("../../extension/chat/replay.js"));
  ({ createChatStreamRenderer } = await import("../../extension/chat/chat-stream-render.js"));
  resetChatSessionStateForTests();
});

describe("Ticket 03: 思考过程会话持久化与历史回放", () => {
  describe("存储结构规范化（normalizeConversations / normalizeHistoryMessage）", () => {
    it("normalizeConversations：保留有效 thinking 与 stopped: true，丢弃空白与非法类型", () => {
      const raw = [
        {
          id: "conv-1",
          title: "测试会话",
          messages: [
            { role: "user", content: "请思考并回答" },
            {
              role: "assistant",
              content: "回答内容",
              thinking: "这是深度思考步骤：1. 分析 2. 推导",
              stopped: false
            },
            {
              role: "assistant",
              content: "",
              thinking: "中断时的思考过程",
              stopped: true
            },
            {
              role: "assistant",
              content: "另一条回答",
              thinking: "   ",
              stopped: "invalid"
            }
          ]
        }
      ];

      const normalized = normalizeConversations(raw);
      expect(normalized).toHaveLength(1);
      const msgs = normalized[0].messages;
      expect(msgs).toHaveLength(4);

      expect(msgs[1]).toEqual({
        role: "assistant",
        content: "回答内容",
        thinking: "这是深度思考步骤：1. 分析 2. 推导"
      });

      expect(msgs[2]).toEqual({
        role: "assistant",
        content: "",
        thinking: "中断时的思考过程",
        stopped: true
      });

      expect(msgs[3]).toEqual({
        role: "assistant",
        content: "另一条回答"
      });
      expect(msgs[3].thinking).toBeUndefined();
      expect(msgs[3].stopped).toBeUndefined();
    });

    it("conversation-store 持久化：保存与加载均保留 thinking 与 stopped", async () => {
      const { createConversationStore, CONVERSATIONS_STORAGE_KEY } = await import("../../extension/chat/conversation-store.js");
      let savedData: unknown = null;
      const fakeStorage = {
        get: vi.fn(async () => ({ [CONVERSATIONS_STORAGE_KEY]: savedData })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          savedData = items[CONVERSATIONS_STORAGE_KEY];
        })
      };

      const store = createConversationStore({
        storage: fakeStorage,
        onConversationChanged: vi.fn(),
        onStreamInterrupted: vi.fn(),
        onContextNotice: vi.fn(),
        loadContextState: vi.fn(async () => true),
        resolveAiConversationRef: vi.fn(async () => ({ isVideoContext: false })),
      });

      applyContextToMain({ title: "测试视频", url: "https://www.bilibili.com/video/BV1test", isVideoContext: true });
      appendChatHistory(
        { role: "user", content: "问" },
        { role: "assistant", content: "", thinking: "深度思考", stopped: true }
      );
      applyConversationIdentity({ id: "conv-test", meta: { id: "conv-test", title: "测试" } });

      await store.persistCurrent();

      expect(fakeStorage.set).toHaveBeenCalled();
      const savedList = (fakeStorage.set.mock.calls[0][0] as Record<string, any>)[CONVERSATIONS_STORAGE_KEY];
      expect(savedList[0].messages[1]).toMatchObject({
        role: "assistant",
        content: "",
        thinking: "深度思考",
        stopped: true
      });

      resetChatSessionStateForTests();
      await store.loadAll();
      const loaded = chatSessionState.savedConversations.find((item) => item.id === "conv-test") as any;
      expect(loaded?.messages[1]).toMatchObject({
        role: "assistant",
        content: "",
        thinking: "深度思考",
        stopped: true
      });
    });
  });

  describe("历史回放渲染（replay.ts + chat-stream-render.ts）", () => {
    function setupReplayHarness() {
      const messages = document.createElement("div");
      const onContinue = vi.fn();
      const onRegenerate = vi.fn();
      const renderer = createChatStreamRenderer({
        messages,
        getTimestampNavDeps: () => ({}),
        onContinue,
        onRegenerate
      });
      const replay = createConversationReplay({
        renderer: {
          messageArea: renderer.messageArea,
          setAutoScroll: renderer.setAutoScroll,
          scrollToBottom: renderer.scrollToBottom
        },
        updateLayout: vi.fn(),
        clearSuggestions: vi.fn()
      });
      return { messages, replay, onContinue, onRegenerate };
    }

    it("正常完成且带 thinking 的消息：回放呈现折叠态思考框（文案“思考过程”）、markdown 正文、4 个标准操作按钮", async () => {
      const { messages, replay } = setupReplayHarness();
      appendChatHistory(
        { role: "user", content: "请问抗日战争爆发于哪一年？" },
        {
          role: "assistant",
          content: "卢沟桥事变标志着全面抗战的爆发，时间是1937年7月7日。",
          thinking: "1. 识别问题关键词：抗日战争、爆发年份\n2. 确定时间节点：1937年7月7日卢沟桥事变"
        }
      );

      replay.render();
      await flushTurn();

      const assistantEl = messages.querySelector(".chat-msg-assistant") as HTMLDivElement;
      expect(assistantEl).toBeTruthy();

      const thinkingEl = assistantEl.querySelector(".chat-thinking") as HTMLDivElement;
      expect(thinkingEl).toBeTruthy();
      expect(thinkingEl.classList.contains("chat-thinking-collapsible")).toBe(true);
      expect(thinkingEl.classList.contains("chat-thinking-collapsed")).toBe(true);
      expect(thinkingEl.querySelector(".chat-thinking-label-text")?.textContent).toBe("思考过程");
      expect(thinkingEl.querySelector(".chat-thinking-text")?.textContent).toContain("1. 识别问题关键词");

      const thinkingBtn = thinkingEl.querySelector<HTMLButtonElement>(".chat-thinking-label")!;
      expect(thinkingBtn.getAttribute("aria-expanded")).toBe("false");
      thinkingBtn.click();
      expect(thinkingEl.classList.contains("chat-thinking-collapsed")).toBe(false);
      expect(thinkingBtn.getAttribute("aria-expanded")).toBe("true");

      const bodyEl = assistantEl.querySelector(".chat-msg-assistant-body");
      expect(bodyEl?.innerHTML).toBe(renderMarkdown("卢沟桥事变标志着全面抗战的爆发，时间是1937年7月7日。"));

      const actionBtns = assistantEl.querySelectorAll<HTMLButtonElement>(".chat-msg-action-btn");
      expect(actionBtns).toHaveLength(4);
      expect([...actionBtns].map((b) => b.getAttribute("aria-label"))).toEqual([
        "复制回复",
        "朗读回答",
        "重新生成",
        "导出 Markdown"
      ]);

      expect(assistantEl.querySelector(".chat-msg-stopped")).toBeNull();
      expect(assistantEl.querySelector(".chat-msg-continue-btn")).toBeNull();
    });

    it("中断且无正文（stopped=true, content=''）的消息：回放呈现展开态思考框（文案“已停止”）、停止徽标、仅有重试与继续按钮", async () => {
      const { messages, replay, onContinue, onRegenerate } = setupReplayHarness();
      appendChatHistory(
        { role: "user", content: "请写一篇长文" },
        {
          role: "assistant",
          content: "",
          thinking: "正在构思大纲：第一部分、第二部分...",
          stopped: true
        }
      );

      replay.render();
      await flushTurn();

      const assistantEl = messages.querySelector(".chat-msg-assistant") as HTMLDivElement;
      expect(assistantEl).toBeTruthy();

      const thinkingEl = assistantEl.querySelector(".chat-thinking") as HTMLDivElement;
      expect(thinkingEl).toBeTruthy();
      expect(thinkingEl.classList.contains("chat-thinking-collapsible")).toBe(true);
      expect(thinkingEl.classList.contains("chat-thinking-collapsed")).toBe(false);
      expect(thinkingEl.querySelector(".chat-thinking-label-text")?.textContent).toBe("已停止");
      expect(thinkingEl.querySelector(".chat-thinking-text")?.textContent).toBe("正在构思大纲：第一部分、第二部分...");

      const thinkingBtn = thinkingEl.querySelector<HTMLButtonElement>(".chat-thinking-label")!;
      expect(thinkingBtn.getAttribute("aria-expanded")).toBe("true");
      thinkingBtn.click();
      expect(thinkingEl.classList.contains("chat-thinking-collapsed")).toBe(true);
      expect(thinkingBtn.getAttribute("aria-expanded")).toBe("false");

      expect(assistantEl.querySelector(".chat-msg-assistant-body")).toBeNull();

      const stoppedBadge = assistantEl.querySelector(".chat-msg-stopped");
      expect(stoppedBadge?.textContent).toBe("已停止生成");

      const actionBtns = assistantEl.querySelectorAll<HTMLButtonElement>(".chat-msg-action-btn");
      expect(actionBtns).toHaveLength(2);
      expect(actionBtns[0].getAttribute("aria-label")).toBe("重新生成");
      expect(actionBtns[1].getAttribute("aria-label")).toBe("继续生成");

      expect(assistantEl.querySelector(".chat-msg-copy-btn")).toBeNull();
      expect(assistantEl.querySelector(".chat-msg-speak-btn")).toBeNull();
      expect(assistantEl.querySelector(".chat-msg-export-btn")).toBeNull();

      actionBtns[0].click();
      expect(onRegenerate).toHaveBeenCalledWith(1, assistantEl);
      actionBtns[1].click();
      expect(onContinue).toHaveBeenCalledWith(1, assistantEl);
    });

    it("中断且有部分正文：回放呈现折叠思考框、停止徽标与完整消息操作", async () => {
      const { messages, replay } = setupReplayHarness();
      appendChatHistory(
        { role: "user", content: "请写一段话" },
        {
          role: "assistant",
          content: "这是写了一半的话",
          thinking: "前置构思思考",
          stopped: true
        }
      );

      replay.render();
      await flushTurn();

      const assistantEl = messages.querySelector(".chat-msg-assistant") as HTMLDivElement;
      expect(assistantEl).toBeTruthy();

      const thinkingEl = assistantEl.querySelector(".chat-thinking") as HTMLDivElement;
      expect(thinkingEl).toBeTruthy();
      expect(thinkingEl.classList.contains("chat-thinking-collapsed")).toBe(true);

      const bodyEl = assistantEl.querySelector(".chat-msg-assistant-body");
      expect(bodyEl?.innerHTML).toBe(renderMarkdown("这是写了一半的话"));

      expect(assistantEl.querySelector(".chat-msg-stopped")?.textContent).toBe("已停止生成");
      const actionBtns = assistantEl.querySelectorAll<HTMLButtonElement>(".chat-msg-action-btn");
      expect([...actionBtns].map((button) => button.getAttribute("aria-label"))).toEqual([
        "复制回复", "朗读回答", "重新生成", "继续生成", "导出 Markdown"
      ]);
    });
  });

  describe("运行时记录与持久化（chat-runtime）", () => {
    it("中断时无正文但有思考内容：commit 助手消息到 chatHistory（含 thinking 与 stopped: true），并调 persistCurrent", async () => {
      const deps = makeRuntimeDeps();
      const runtime = createChatRuntime(deps);

      await runtime.sendTurn("帮我算一道微积分");
      deps.emitMessage({ type: "reasoning", data: "首先求导数步骤..." });
      deps.emitMessage({ type: "stopped", reason: "用户停止" });

      expect(chatSessionState.chatHistory).toHaveLength(2);
      expect(chatSessionState.chatHistory[0]).toEqual({
        role: "user",
        content: "帮我算一道微积分"
      });
      expect(chatSessionState.chatHistory[1]).toEqual({
        role: "assistant",
        content: "",
        thinking: "首先求导数步骤...",
        stopped: true
      });
      expect(deps.store.persistCurrent).toHaveBeenCalledTimes(1);
    });

    it("正常生成完成且有思考过程：commit 助手消息到 chatHistory（含 thinking，无 stopped），并调 persistCurrent", async () => {
      const deps = makeRuntimeDeps();
      const runtime = createChatRuntime(deps);

      await runtime.sendTurn("1+1等于几？");
      deps.emitMessage({ type: "reasoning", data: "思考皮亚诺公理..." });
      deps.emitMessage({ type: "token", data: "等于2。" });
      deps.emitMessage({ type: "done" });

      expect(chatSessionState.chatHistory).toHaveLength(2);
      expect(chatSessionState.chatHistory[1]).toEqual({
        role: "assistant",
        content: "等于2。",
        thinking: "思考皮亚诺公理..."
      });
      expect(chatSessionState.chatHistory[1].stopped).toBeUndefined();
      expect(deps.store.persistCurrent).toHaveBeenCalledTimes(1);
    });
  });
});
