// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatRuntime, type ChatPort } from "../../extension/chat/chat-runtime.js";
import {
  applyContextToMain,
  applyConversationIdentity,
  chatSessionState,
  resetChatSessionStateForTests
} from "../../extension/chat/chat-state.js";
import { createConversationStore, type StorageArea } from "../../extension/chat/conversation-store.js";
import { patchConversationSummaryAnchorEntry, readConversationById } from "../../extension/chat/conversation-storage.js";
import { normalizeConversations } from "../../extension/ai/conversation.js";
import { createSubtitleIdbStore } from "../../extension/subtitle/idb-store.js";
import {
  configureSubtitleCacheStoreForTests,
  resetSubtitleStoreClientForTests
} from "../../extension/subtitle/store-client.js";
import { createFakeIdbEnvironment } from "../helpers/fake-idb.js";
import { isLiveTextToolHistoryEntry } from "../../extension/live/live-text-tool-history.js";
import type { ConversationSummaryAnchor } from "../../extension/ai/types.js";

function makeMemoryStorage(): StorageArea {
  const map = new Map<string, unknown>();
  return {
    get: async (keys: string[]) => {
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (map.has(k)) out[k] = map.get(k);
      }
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
    }
  };
}

interface MockRuntimePort {
  port: ChatPort;
  sent: Array<Record<string, unknown>>;
  emit: (msg: unknown) => void;
  disconnected: () => boolean;
}

function createMockRuntimePort(): MockRuntimePort {
  const sent: Array<Record<string, unknown>> = [];
  const listeners: Array<(msg: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  let isDisconnected = false;
  const port: ChatPort = {
    name: "offscreen-chat",
    postMessage(message: unknown) {
      sent.push(message as Record<string, unknown>);
    },
    disconnect() {
      if (isDisconnected) return;
      isDisconnected = true;
      for (const fn of disconnectListeners) fn();
    },
    onMessage: {
      addListener(listener) {
        listeners.push(listener);
      }
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.push(listener);
      }
    }
  };
  return {
    port,
    sent,
    emit: (msg: unknown) => {
      for (const fn of listeners) fn(msg);
    },
    disconnected: () => isDisconnected
  };
}

function makeUiSpies() {
  return {
    setStreamingUiState: vi.fn(),
    messagesNotice: { show: vi.fn(), clear: vi.fn(), dispose: vi.fn() },
    inputNotice: { show: vi.fn(), clear: vi.fn(), dispose: vi.fn() },
    hideHistoryPopover: vi.fn(),
    removeCenteredState: vi.fn(),
    removeSuggestions: vi.fn(),
    showSetupBlockedState: vi.fn(),
    autosizeInput: vi.fn()
  };
}

describe("chat-runtime 滚动摘要触发、并发第 13 轮安全与回滚失效（#29）", () => {
  beforeEach(() => {
    resetChatSessionStateForTests();
    resetSubtitleStoreClientForTests();
    document.body.innerHTML = "";
    vi.stubGlobal("chrome", {
      runtime: { lastError: null },
      storage: { local: makeMemoryStorage(), sync: makeMemoryStorage() }
    });
  });

  afterEach(() => {
    configureSubtitleCacheStoreForTests(null);
    resetChatSessionStateForTests();
    vi.unstubAllGlobals();
  });

  it("第 12 轮结束后非阻塞触发 Offscreen 压缩（零页面侧 fetch），并发第 13 轮保留完好，且第 14 轮携带 summaryAnchor", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("content script must not call external fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { factory } = createFakeIdbEnvironment();
    const idbStore = createSubtitleIdbStore({ indexedDB: factory, dbName: "test-29-runtime-flow" });
    configureSubtitleCacheStoreForTests(idbStore);
    const storage = makeMemoryStorage();

    applyContextToMain(
      {
        site: "bilibili",
        bvid: "BV129runtime",
        cid: "100",
        title: "测试视频",
        url: "https://www.bilibili.com/video/BV129runtime",
        subtitleBody: [{ from: 0, to: 10, content: "测试字幕" }]
      },
      "video:BV129runtime|100"
    );

    const store = createConversationStore({
      loadContextState: async () => true,
      resolveAiConversationRef: async () => ({}),
      onConversationChanged: vi.fn(),
      onStreamInterrupted: vi.fn(),
      onContextNotice: vi.fn(),
      storage
    });

    const initial11 = Array.from({ length: 11 }, (_, idx) => [
      { id: `m${idx * 2 + 1}`, role: "user", content: `问题 ${idx + 1}` },
      { id: `m${idx * 2 + 2}`, role: "assistant", content: `回答 ${idx + 1}` }
    ]).flat();
    applyConversationIdentity({
      id: "conv-12",
      meta: {
        id: "conv-12",
        title: "测试视频",
        createdAt: 1000,
        updatedAt: 2000,
        contextKey: "video:BV129runtime|100",
        contextTitle: "测试视频",
        contextUrl: "https://www.bilibili.com/video/BV129runtime",
        isVideoContext: true,
        pinnedContext: true,
        contextRef: { site: "bilibili", bvid: "BV129runtime", cid: "100" }
      },
      history: initial11
    });
    await store.persistCurrent();

    const ports: MockRuntimePort[] = [];
    const ui = makeUiSpies();
    const messagesEl = document.createElement("div");
    const inputEl = document.createElement("textarea");
    document.body.append(messagesEl, inputEl);

    const runtime = createChatRuntime({
      messages: messagesEl,
      input: inputEl,
      store,
      ui,
      ensureCurrentContextForSend: async () => ({ pass: true }),
      getProviderId: () => "p1",
      getSelectedModel: () => "gemini-2.5-flash",
      getTimestampNavDeps: () => ({
        contextUrl: "https://www.bilibili.com/video/BV129runtime",
        isContextValid: () => true,
        notice: vi.fn(),
        seek: () => null,
        getSubtitlePreview: () => null,
        tooltipContainer: messagesEl
      }),
      connectPort: () => {
        const created = createMockRuntimePort();
        ports.push(created);
        return created.port;
      }
    });

    const v12 = await runtime.sendTurn("问题 12");
    expect(v12).toBe("accepted");
    const turn12Port = ports[0];
    expect(turn12Port.sent[0].action).toBe("chat");
    expect(turn12Port.sent[0].summaryAnchor).toBeUndefined();

    turn12Port.emit({ type: "token", data: "回答 12" });
    turn12Port.emit({ type: "done" });

    expect(runtime.isStreaming()).toBe(false);
    expect(runtime.isTurnActive()).toBe(false);

    await vi.waitFor(() => {
      expect(ports.length).toBe(2);
      expect(ports[1].sent[0]?.action).toBe("compact-history");
    });

    const compactPort = ports[1];
    expect(compactPort.sent[0]).toMatchObject({
      action: "compact-history",
      conversationId: "conv-12",
      providerId: "p1",
      model: "gemini-2.5-flash",
      coveredMessageCount: 16,
      expectedBoundaryContent: "回答 8"
    });

    const v13 = await runtime.sendTurn("问题 13");
    expect(v13).toBe("accepted");
    const turn13Port = ports[2];
    turn13Port.emit({ type: "token", data: "回答 13" });
    turn13Port.emit({ type: "done" });

    await vi.waitFor(async () => {
      const conv = await readConversationById("conv-12", storage);
      expect(conv && !isLiveTextToolHistoryEntry(conv) ? conv.messages.length : 0).toBe(26);
    });

    const nextAnchor: ConversationSummaryAnchor = {
      text: "前 8 轮归档摘要内容",
      coveredMessageCount: 16,
      updatedAt: 9_000
    };
    const patchRes = await patchConversationSummaryAnchorEntry({
      id: "conv-12",
      summaryAnchor: nextAnchor,
      expectedBoundaryContent: "回答 8"
    });
    expect(patchRes.updated).toBe(true);

    compactPort.emit({
      type: "compact-history-result",
      conversationId: "conv-12",
      ok: true,
      updated: true,
      summaryAnchor: nextAnchor
    });

    expect(compactPort.disconnected()).toBe(true);
    expect(chatSessionState.currentConversationMeta?.summaryAnchor).toEqual(nextAnchor);

    const persistedAfterConcurrent = await readConversationById("conv-12", storage);
    expect(persistedAfterConcurrent && !isLiveTextToolHistoryEntry(persistedAfterConcurrent)).toBe(true);
    if (persistedAfterConcurrent && !isLiveTextToolHistoryEntry(persistedAfterConcurrent)) {
      expect(persistedAfterConcurrent.messages).toHaveLength(26);
      expect(persistedAfterConcurrent.messages[24].content).toBe("问题 13");
      expect(persistedAfterConcurrent.messages[25].content).toBe("回答 13");
      expect(persistedAfterConcurrent.summaryAnchor).toEqual(nextAnchor);
    }

    const v14 = await runtime.sendTurn("问题 14");
    expect(v14).toBe("accepted");
    const turn14Port = ports[3];
    expect(turn14Port.sent[0].action).toBe("chat");
    expect(turn14Port.sent[0].summaryAnchor).toEqual(nextAnchor);
    turn14Port.emit({ type: "token", data: "回答 14" });
    turn14Port.emit({ type: "done" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ui.messagesNotice.show).not.toHaveBeenCalled();
  });

  it("重新生成早于 coveredMessageCount 的轮次时自动清空内存与 IDB 中的失效 summaryAnchor", async () => {
    const { factory } = createFakeIdbEnvironment();
    const idbStore = createSubtitleIdbStore({ indexedDB: factory, dbName: "test-29-rollback" });
    configureSubtitleCacheStoreForTests(idbStore);
    const storage = makeMemoryStorage();

    applyContextToMain(
      {
        site: "bilibili",
        bvid: "BV129roll",
        cid: "200",
        title: "回滚测试",
        url: "https://www.bilibili.com/video/BV129roll",
        subtitleBody: [{ from: 0, to: 10, content: "字幕" }]
      },
      "video:BV129roll|200"
    );

    const store = createConversationStore({
      loadContextState: async () => true,
      resolveAiConversationRef: async () => ({}),
      onConversationChanged: vi.fn(),
      onStreamInterrupted: vi.fn(),
      onContextNotice: vi.fn(),
      storage
    });

    const turns10 = Array.from({ length: 10 }, (_, idx) => [
      { role: "user", content: `Q${idx + 1}`, contextKey: "video:BV129roll|200" },
      { role: "assistant", content: `A${idx + 1}` }
    ]).flat();
    const anchor: ConversationSummaryAnchor = {
      text: "旧归档摘要（覆盖前 8 轮）",
      coveredMessageCount: 16,
      updatedAt: 5000
    };

    applyConversationIdentity({
      id: "conv-roll",
      meta: {
        id: "conv-roll",
        title: "回滚测试",
        createdAt: 1000,
        updatedAt: 2000,
        contextKey: "video:BV129roll|200",
        contextTitle: "回滚测试",
        contextUrl: "https://www.bilibili.com/video/BV129roll",
        isVideoContext: true,
        pinnedContext: true,
        contextRef: { site: "bilibili", bvid: "BV129roll", cid: "200" },
        resolvedContext: chatSessionState.contextData,
        summaryAnchor: anchor
      },
      history: turns10
    });
    await store.persistCurrent();

    const beforeRollback = await readConversationById("conv-roll", storage);
    expect(beforeRollback && !isLiveTextToolHistoryEntry(beforeRollback) ? beforeRollback.summaryAnchor : undefined).toEqual(anchor);

    const ports: MockRuntimePort[] = [];
    const ui = makeUiSpies();
    const messagesEl = document.createElement("div");
    const inputEl = document.createElement("textarea");
    document.body.append(messagesEl, inputEl);

    const runtime = createChatRuntime({
      messages: messagesEl,
      input: inputEl,
      store,
      ui,
      ensureCurrentContextForSend: async () => ({ pass: true }),
      getProviderId: () => "p1",
      getSelectedModel: () => "gpt-4o",
      getTimestampNavDeps: () => ({
        contextUrl: "https://www.bilibili.com/video/BV129roll",
        isContextValid: () => true,
        notice: vi.fn(),
        seek: () => null,
        getSubtitlePreview: () => null,
        tooltipContainer: messagesEl
      }),
      connectPort: () => {
        const created = createMockRuntimePort();
        ports.push(created);
        return created.port;
      }
    });

    for (let i = 0; i < turns10.length; i += 2) {
      runtime.messageArea.appendUserMessage(turns10[i].content, { source: "replay" });
      const turn = runtime.messageArea.appendAssistantMessage({ source: "replay" });
      turn.appendToken(turns10[i + 1].content);
      turn.finish({ userPrompt: turns10[i].content, historyIndex: i + 1 });
    }

    const regenButtons = Array.from(messagesEl.querySelectorAll<HTMLButtonElement>(".chat-msg-regenerate-btn"));
    expect(regenButtons.length).toBeGreaterThanOrEqual(3);
    regenButtons[2].click();

    await vi.waitFor(() => {
      expect(ports).toHaveLength(1);
      expect(ports[0].sent[0]?.action).toBe("chat");
    });

    expect(ports[0].sent[0].summaryAnchor).toBeUndefined();

    ports[0].emit({ type: "token", data: "重写后的 A3" });
    ports[0].emit({ type: "done" });

    expect(chatSessionState.currentConversationMeta?.summaryAnchor).toBeUndefined();
    await vi.waitFor(async () => {
      const reloaded = await readConversationById("conv-roll", storage);
      expect(reloaded && !isLiveTextToolHistoryEntry(reloaded)).toBe(true);
      if (reloaded && !isLiveTextToolHistoryEntry(reloaded)) {
        expect(reloaded.messages).toHaveLength(6);
        expect(reloaded.summaryAnchor).toBeUndefined();
      }
    });

    const invalidNormalized = normalizeConversations([
      {
        id: "conv-stale-norm",
        title: "t",
        messages: [
          { role: "user", content: "Q1" },
          { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "c1", content: "res" },
          { role: "assistant", content: "A1" }
        ],
        summaryAnchor: { text: "切在工具中间", coveredMessageCount: 2, updatedAt: 100 }
      }
    ]);
    expect(invalidNormalized).toHaveLength(1);
    const conv0 = invalidNormalized[0];
    expect(!isLiveTextToolHistoryEntry(conv0) && conv0.summaryAnchor).toBeUndefined();
  });

  it("后台压缩通道失败时不向用户弹任何错误提示", async () => {
    const { factory } = createFakeIdbEnvironment();
    const idbStore = createSubtitleIdbStore({ indexedDB: factory, dbName: "test-29-silent-fail" });
    configureSubtitleCacheStoreForTests(idbStore);
    const storage = makeMemoryStorage();

    applyContextToMain(
      {
        site: "bilibili",
        bvid: "BV129silent",
        cid: "300",
        title: "静默失败",
        url: "https://www.bilibili.com/video/BV129silent",
        subtitleBody: [{ from: 0, to: 10, content: "字幕" }]
      },
      "video:BV129silent|300"
    );

    const store = createConversationStore({
      loadContextState: async () => true,
      resolveAiConversationRef: async () => ({}),
      onConversationChanged: vi.fn(),
      onStreamInterrupted: vi.fn(),
      onContextNotice: vi.fn(),
      storage
    });

    const initial11 = Array.from({ length: 11 }, (_, idx) => [
      { role: "user", content: `Q${idx + 1}` },
      { role: "assistant", content: `A${idx + 1}` }
    ]).flat();
    applyConversationIdentity({
      id: "conv-silent",
      meta: {
        id: "conv-silent",
        title: "静默失败",
        createdAt: 1000,
        updatedAt: 2000,
        contextKey: "video:BV129silent|300",
        contextTitle: "静默失败",
        contextUrl: "https://www.bilibili.com/video/BV129silent",
        isVideoContext: true,
        pinnedContext: true,
        contextRef: { site: "bilibili", bvid: "BV129silent", cid: "300" }
      },
      history: initial11
    });
    await store.persistCurrent();

    let connectCount = 0;
    const chatPort = createMockRuntimePort();
    const ui = makeUiSpies();
    const messagesEl = document.createElement("div");
    const inputEl = document.createElement("textarea");
    document.body.append(messagesEl, inputEl);

    const runtime = createChatRuntime({
      messages: messagesEl,
      input: inputEl,
      store,
      ui,
      ensureCurrentContextForSend: async () => ({ pass: true }),
      getProviderId: () => "p1",
      getSelectedModel: () => "gpt-4o",
      getTimestampNavDeps: () => ({
        contextUrl: "https://www.bilibili.com/video/BV129silent",
        isContextValid: () => true,
        notice: vi.fn(),
        seek: () => null,
        getSubtitlePreview: () => null,
        tooltipContainer: messagesEl
      }),
      connectPort: async () => {
        connectCount += 1;
        if (connectCount === 1) return chatPort.port;
        throw new Error("offscreen unavailable");
      }
    });

    await runtime.sendTurn("Q12");
    chatPort.emit({ type: "token", data: "A12" });
    chatPort.emit({ type: "done" });

    await vi.waitFor(() => {
      expect(connectCount).toBe(2);
    });
    await Promise.resolve();
    expect(ui.messagesNotice.show).not.toHaveBeenCalled();
    expect(ui.inputNotice.show).not.toHaveBeenCalled();
  });
});
