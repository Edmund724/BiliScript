// tests/live/live-transcript-merger.test.ts
// 双端增量/终态字幕归并器单元测试：覆盖正常问答、全量替换修正、乱序到达、重复完成去重与挂断后迟到事件拦截

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  chatSessionState,
  resetChatSessionStateForTests
} from "../../extension/chat/chat-state.js";
import type { ChatAssistantTurn, ChatMessageArea } from "../../extension/chat/chat-stream-render.js";
import { createLiveTranscriptMerger } from "../../extension/live/live-transcript-merger.js";

function createFakeMessageArea(messagesContainer: HTMLElement): {
  messageArea: Pick<ChatMessageArea, "appendAssistantMessage">;
  turns: Array<{
    node: HTMLDivElement;
    tokens: string[];
    resets: number;
    finishedRaw: string | null;
    discarded: boolean;
  }>;
} {
  const turns: Array<{
    node: HTMLDivElement;
    tokens: string[];
    resets: number;
    finishedRaw: string | null;
    discarded: boolean;
  }> = [];

  const messageArea: Pick<ChatMessageArea, "appendAssistantMessage"> = {
    appendAssistantMessage: () => {
      const node = document.createElement("div");
      node.className = "chat-msg chat-msg-assistant chat-msg-streaming";
      messagesContainer.appendChild(node);

      const record = {
        node,
        tokens: [] as string[],
        resets: 0,
        finishedRaw: null as string | null,
        discarded: false
      };
      turns.push(record);

      const turn: ChatAssistantTurn = {
        appendToken: (token) => {
          const str = String(token || "");
          record.tokens.push(str);
          node.textContent = record.tokens.join("");
        },
        appendThinking: () => {},
        reset: () => {
          record.resets += 1;
          record.tokens = [];
          node.textContent = "";
        },
        discard: () => {
          record.discarded = true;
          node.classList.remove("chat-msg-streaming");
        },
        finish: (opts) => {
          const raw = typeof opts?.raw === "string" ? opts.raw : record.tokens.join("");
          record.finishedRaw = raw;
          node.classList.remove("chat-msg-streaming");
          node.textContent = raw;
          return raw;
        },
        fail: () => {},
        stop: () => ({ raw: record.tokens.join(""), body: true }),
        markTruncated: () => {},
        applySearchStatus: () => {},
        attachSearchTimelineCard: () => {}
      };
      return turn;
    }
  };

  return { messageArea, turns };
}

beforeEach(() => {
  resetModuleState();
  resetChatSessionStateForTests();
  document.body.innerHTML = `<div id="messages"></div>`;
});

describe("createLiveTranscriptMerger", () => {
  it("replaces user incremental transcript on input.updated and commits to chatHistory on input.done", () => {
    const messagesContainer = document.getElementById("messages")!;
    const { messageArea } = createFakeMessageArea(messagesContainer);
    const persistCurrent = vi.fn().mockResolvedValue(undefined);
    const onActivity = vi.fn();

    const merger = createLiveTranscriptMerger({
      messagesContainer,
      messageArea,
      store: { persistCurrent },
      onActivity
    });

    merger.handleEvent({ kind: "input.updated", text: "这个视频" });
    expect(onActivity).toHaveBeenCalledTimes(1);

    const userNodes = messagesContainer.querySelectorAll(".chat-msg-user");
    expect(userNodes).toHaveLength(1);
    expect(userNodes[0].textContent).toBe("这个视频");
    expect(userNodes[0].classList.contains("chat-msg-live-pending")).toBe(true);
    expect(chatSessionState.chatHistory).toHaveLength(0);

    // MOSS-LIVE input.transcript.updated sends full text (replace, not append)
    merger.handleEvent({ kind: "input.updated", text: "这个视频主要讲了什么" });
    expect(messagesContainer.querySelectorAll(".chat-msg-user")).toHaveLength(1);
    expect(userNodes[0].textContent).toBe("这个视频主要讲了什么");

    // input.done finalizes user bubble and persists to chatHistory
    merger.handleEvent({ kind: "input.done", text: "这个视频主要讲了什么？" });
    expect(userNodes[0].textContent).toBe("这个视频主要讲了什么？");
    expect(userNodes[0].classList.contains("chat-msg-live-pending")).toBe(false);
    expect(chatSessionState.currentConversationId).toBeTruthy();
    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "这个视频主要讲了什么？" }
    ]);
    expect(persistCurrent).toHaveBeenCalledTimes(1);
  });

  it("streams assistant output.updated (both suffix delta and full-text revision) and commits on output.done", () => {
    const messagesContainer = document.getElementById("messages")!;
    const { messageArea, turns } = createFakeMessageArea(messagesContainer);
    const persistCurrent = vi.fn().mockResolvedValue(undefined);

    const merger = createLiveTranscriptMerger({
      messagesContainer,
      messageArea,
      store: { persistCurrent }
    });

    merger.handleEvent({ kind: "input.done", text: "总结一下核心观点" });

    // Suffix growth -> appendToken receives only delta
    merger.handleEvent({
      kind: "output.updated",
      text: "核心观点是",
      runId: "r1",
      turnId: "t1"
    });
    merger.handleEvent({
      kind: "output.updated",
      text: "核心观点是实时全双工交互",
      runId: "r1",
      turnId: "t1"
    });

    expect(turns).toHaveLength(1);
    expect(turns[0].tokens).toEqual(["核心观点是", "实时全双工交互"]);
    expect(turns[0].resets).toBe(0);

    // Non-prefix revision -> resets turn and feeds full revised text
    merger.handleEvent({
      kind: "output.updated",
      text: "本视频的核心观点是实时全双工语音交互",
      runId: "r1",
      turnId: "t1"
    });
    expect(turns[0].resets).toBe(1);
    expect(turns[0].node.textContent).toBe("本视频的核心观点是实时全双工语音交互");

    // output.done finalizes and persists assistant turn
    merger.handleEvent({
      kind: "output.done",
      text: "本视频的核心观点是实时全双工语音交互。",
      runId: "r1",
      turnId: "t1"
    });

    expect(turns[0].finishedRaw).toBe("本视频的核心观点是实时全双工语音交互。");
    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "总结一下核心观点" },
      { role: "assistant", content: "本视频的核心观点是实时全双工语音交互。" }
    ]);
    expect(persistCurrent).toHaveBeenCalledTimes(2);
  });

  it("preserves user -> assistant order when output.updated arrives before input.done (out-of-order guard)", () => {
    const messagesContainer = document.getElementById("messages")!;
    const { messageArea } = createFakeMessageArea(messagesContainer);
    const persistCurrent = vi.fn().mockResolvedValue(undefined);

    const merger = createLiveTranscriptMerger({
      messagesContainer,
      messageArea,
      store: { persistCurrent }
    });

    // User is speaking
    merger.handleEvent({ kind: "input.updated", text: "中间那层是什么" });

    // Server starts streaming output BEFORE input.done arrives
    merger.handleEvent({
      kind: "output.updated",
      text: "中间那层是消息队列",
      runId: "r1",
      turnId: "t1"
    });

    // Pending user text was auto-committed first so user precedes assistant
    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "中间那层是什么" }
    ]);

    // Now input.done arrives with punctuated text -> updates user entry in-place without duplicating
    merger.handleEvent({ kind: "input.done", text: "中间那层是什么？" });
    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "中间那层是什么？" }
    ]);

    // Finally output.done arrives -> assistant entry is second
    merger.handleEvent({
      kind: "output.done",
      text: "中间那层是消息队列。",
      runId: "r1",
      turnId: "t1"
    });

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "中间那层是什么？" },
      { role: "assistant", content: "中间那层是消息队列。" }
    ]);

    const allNodes = Array.from(messagesContainer.children);
    expect(allNodes).toHaveLength(2);
    expect(allNodes[0].classList.contains("chat-msg-user")).toBe(true);
    expect(allNodes[0].textContent).toBe("中间那层是什么？");
    expect(allNodes[1].classList.contains("chat-msg-assistant")).toBe(true);
    expect(allNodes[1].textContent).toBe("中间那层是消息队列。");
  });

  it("deduplicates repeated output.done and response.ended for the same turn", () => {
    const messagesContainer = document.getElementById("messages")!;
    const { messageArea } = createFakeMessageArea(messagesContainer);
    const persistCurrent = vi.fn().mockResolvedValue(undefined);

    const merger = createLiveTranscriptMerger({
      messagesContainer,
      messageArea,
      store: { persistCurrent }
    });

    merger.handleEvent({ kind: "input.done", text: "你好" });
    merger.handleEvent({
      kind: "output.done",
      text: "你好！有什么可以帮你的？",
      runId: "r1",
      turnId: "t1"
    });
    merger.handleEvent({
      kind: "output.done",
      text: "你好！有什么可以帮你的？",
      runId: "r1",
      turnId: "t1"
    });
    merger.handleEvent({
      kind: "response.ended",
      status: "completed",
      runId: "r1",
      turnId: "t1"
    });

    expect(chatSessionState.chatHistory).toHaveLength(2);
    expect(persistCurrent).toHaveBeenCalledTimes(2);
  });

  it("finalizes in-flight assistant turn on response.ended if output.done was omitted", () => {
    const messagesContainer = document.getElementById("messages")!;
    const { messageArea } = createFakeMessageArea(messagesContainer);
    const persistCurrent = vi.fn().mockResolvedValue(undefined);

    const merger = createLiveTranscriptMerger({
      messagesContainer,
      messageArea,
      store: { persistCurrent }
    });

    merger.handleEvent({ kind: "input.done", text: "测试" });
    merger.handleEvent({
      kind: "output.updated",
      text: "正在回答中",
      runId: "r2",
      turnId: "t2"
    });
    merger.handleEvent({
      kind: "response.ended",
      status: "completed",
      runId: "r2",
      turnId: "t2"
    });

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "测试" },
      { role: "assistant", content: "正在回答中" }
    ]);
  });

  it("dispose() cleans up uncommitted nodes and rejects any late events after hangup", () => {
    const messagesContainer = document.getElementById("messages")!;
    const { messageArea } = createFakeMessageArea(messagesContainer);
    const persistCurrent = vi.fn().mockResolvedValue(undefined);

    const merger = createLiveTranscriptMerger({
      messagesContainer,
      messageArea,
      store: { persistCurrent }
    });

    // Complete Turn 1
    merger.handleEvent({ kind: "input.done", text: "第一轮提问" });
    merger.handleEvent({
      kind: "output.done",
      text: "第一轮回答",
      runId: "r1",
      turnId: "t1"
    });
    expect(chatSessionState.chatHistory).toHaveLength(2);

    // Start Turn 2 (in-flight when user clicks hangup)
    merger.handleEvent({ kind: "input.updated", text: "半截提问" });
    expect(messagesContainer.querySelectorAll(".chat-msg-user")).toHaveLength(2);

    // Hangup!
    merger.dispose();

    // Uncommitted pending user bubble is removed; Turn 1 remains intact
    expect(messagesContainer.querySelectorAll(".chat-msg-user")).toHaveLength(1);
    expect(chatSessionState.chatHistory).toHaveLength(2);

    // Late events arrive after hangup -> strictly ignored
    const persistCallsBefore = persistCurrent.mock.calls.length;
    merger.handleEvent({ kind: "input.done", text: "迟到的用户字幕" });
    merger.handleEvent({
      kind: "output.updated",
      text: "迟到的AI流式字幕",
      runId: "r2",
      turnId: "t2"
    });
    merger.handleEvent({
      kind: "output.done",
      text: "迟到的AI完成字幕",
      runId: "r2",
      turnId: "t2"
    });

    expect(chatSessionState.chatHistory).toHaveLength(2);
    expect(persistCurrent).toHaveBeenCalledTimes(persistCallsBefore);
    expect(messagesContainer.children).toHaveLength(2);
  });
});
