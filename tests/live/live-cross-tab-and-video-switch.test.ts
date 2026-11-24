// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { LiveSessionTracker } from "../../extension/live/live-session-tracker.js";
import { createLiveChatController } from "../../extension/live/live-chat-controller.js";
import { attachMossLivePort, resetActiveLiveSessionForTests } from "../../extension/live/offscreen-moss-port.js";
import { OffscreenMossLiveClient } from "../../extension/live/offscreen-moss-client.js";
import { createContextLoad } from "../../extension/chat/context-load.js";
import { chatSessionState, resetChatSessionStateForTests } from "../../extension/chat/chat-state.js";
import { createConversationStore } from "../../extension/chat/conversation-store.js";
import type { ContextFetchOutcome } from "../../extension/core/context-assembly.js";

class FakePort {
  messageListeners: ((msg: any) => void)[] = [];
  disconnectListeners: (() => void)[] = [];
  postedMessages: any[] = [];

  get onMessage() {
    return {
      addListener: (fn: (msg: any) => void) => {
        this.messageListeners.push(fn);
      }
    };
  }

  get onDisconnect() {
    return {
      addListener: (fn: () => void) => {
        this.disconnectListeners.push(fn);
      }
    };
  }

  postMessage(msg: any) {
    this.postedMessages.push(msg);
  }

  simulateMessage(msg: any) {
    for (const fn of this.messageListeners) {
      fn(msg);
    }
  }

  disconnect() {
    for (const fn of this.disconnectListeners) {
      fn();
    }
  }
}

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = 0;
  sentData: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: any }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: any) {
    this.sentData.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: any) {
    this.onmessage?.({ data });
  }
}

beforeEach(() => {
  resetModuleState();
  resetChatSessionStateForTests();
  resetActiveLiveSessionForTests();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

describe("04: 跨标签页伴看自动接管", () => {
  it("用户切换到另一个视频标签页并开启伴看时，自动通知旧标签页关闭伴看，新标签页直接接管", async () => {
    const tracker = new LiveSessionTracker();
    const setAuthRule = vi.fn(async () => {});
    const clearAuthRule = vi.fn(async () => {});
    const isTabAlive = vi.fn(async (_id: number) => true);
    const notifyTabTakeover = vi.fn(async () => {});

    const fakeDeps = {
      getSettings: async () => ({ activeLiveProviderId: "p1" }),
      loadProviders: async () => [{ id: "p1", name: "MOSS", type: "moss-live" as const, presetId: "moss-live", baseUrl: "https://api.mosi.cn", model: "moss-1", enabled: true, hasSavedKey: true }],
      loadKeys: async () => ({ p1: "key1" }),
      hasPermission: async () => true,
      setAuthRule,
      clearAuthRule,
      ensureOffscreen: async () => {},
      resolveActiveId: () => "p1",
      isTabAlive,
      notifyTabTakeover
    };

    const res1 = await tracker.prepare("session-tab-101", fakeDeps, 101);
    expect(res1.ok).toBe(true);
    expect(tracker.getOwnerTabId()).toBe(101);
    expect(tracker.getActiveRuleOwner()).toBe("session-tab-101");

    const res2 = await tracker.prepare("session-tab-202", fakeDeps, 202);
    expect(res2.ok).toBe(true);
    expect(notifyTabTakeover).toHaveBeenCalledWith(101, "companion");
    expect(tracker.getOwnerTabId()).toBe(202);
    expect(tracker.getActiveRuleOwner()).toBe("session-tab-202");
    expect(setAuthRule).toHaveBeenCalledTimes(2);
  });

  it("默认接管通知经 chrome.tabs 发送并携带被接管的会话通道", async () => {
    const tracker = new LiveSessionTracker();
    const sendMessage = vi.fn(async () => ({}));
    vi.stubGlobal("chrome", { tabs: { sendMessage } });

    const deps = {
      getSettings: async () => ({ activeLiveProviderId: "p1" }),
      loadProviders: async () => [
        { id: "p1", name: "MOSS", type: "moss-live" as const, presetId: "moss-live", baseUrl: "https://api.mosi.cn", model: "moss-1", enabled: true, hasSavedKey: true }
      ],
      loadKeys: async () => ({ p1: "key1" }),
      hasPermission: async () => true,
      setAuthRule: vi.fn(async () => {}),
      clearAuthRule: vi.fn(async () => {}),
      ensureOffscreen: async () => {},
      resolveActiveId: () => "p1",
      isTabAlive: async () => true
    };

    await tracker.prepare("companion-tab-101", deps, 101);
    await tracker.prepare("companion-tab-202", deps, 202);

    expect(sendMessage).toHaveBeenCalledWith(101, { type: "live-session-takeover" });
  });

  it("旧标签页收到接管通知时，停止音画采集并收起伴看状态条", async () => {
    let audioStopped = false;
    let videoStopped = false;
    let liveState = "idle";
    const fakePort = new FakePort();

    const controller = createLiveChatController({
      connectPort: () => fakePort as any,
      requestOrigins: async () => ({ ok: true }),
      sendRuntimeMessage: (async () => ({
        ok: true,
        provider: { baseUrl: "https://api.mosi.cn", model: "moss-1" }
      })) as any,
      startAudioCapture: async () => ({
        setMuted: () => {},
        isMuted: () => false,
        stop: () => { audioStopped = true; },
        setShareVideoAudio: () => {},
        isSharingVideoAudio: () => true,
        getVideoAudioStatus: () => "已获取音轨",
        isMicVadActive: () => false,
        isVoiceRecentlyActive: () => true
      }),
      startVideoCapture: () => ({
        stop: () => { videoStopped = true; },
        configure: () => {}
      }),
      onStateChange: (state) => {
        liveState = state;
      }
    });

    await controller.start();
    fakePort.simulateMessage({ type: "connected" });
    expect(controller.getState()).toBe("connected");
    expect(liveState).toBe("connected");

    await controller.stop();

    expect(controller.getState()).toBe("idle");
    expect(liveState).toBe("idle");
    expect(audioStopped).toBe(true);
    expect(videoStopped).toBe(true);
  });

  it("Offscreen 中跨端口接管：新端口发送 start 时，旧端口客户端收到 closed(takeover) 并被断开", async () => {
    const port1 = new FakePort();
    let client1: OffscreenMossLiveClient | null = null;
    attachMossLivePort(port1 as any, {
      loadClient: async () => (opts) => {
        client1 = new OffscreenMossLiveClient(opts);
        return client1;
      }
    });

    port1.simulateMessage({ action: "start", wsUrl: "wss://api.mosi.cn/v1/realtime", model: "moss-1" });
    await Promise.resolve();
    await Promise.resolve();
    const ws1 = FakeWebSocket.instances[0];
    ws1.simulateOpen();
    ws1.simulateMessage(JSON.stringify({ action: "session_attached", data: { session_id: "s1" } }));
    expect(client1!.getState()).toBe("connected");

    const port2 = new FakePort();
    let client2: OffscreenMossLiveClient | null = null;
    attachMossLivePort(port2 as any, {
      loadClient: async () => (opts) => {
        client2 = new OffscreenMossLiveClient(opts);
        return client2;
      }
    });

    port2.simulateMessage({ action: "start", wsUrl: "wss://api.mosi.cn/v1/realtime", model: "moss-1" });
    await Promise.resolve();
    await Promise.resolve();

    expect(port1.postedMessages).toContainEqual({ type: "closed", reason: "takeover" });
    expect(client1!.disposed || ws1.readyState === FakeWebSocket.CLOSED).toBe(true);

    const ws2 = FakeWebSocket.instances[1];
    ws2.simulateOpen();
    ws2.simulateMessage(JSON.stringify({ action: "session_attached", data: { session_id: "s2" } }));
    expect(client2!.getState()).toBe("connected");
  });
});

describe("04: 同一标签页内换片/分P会话隔离与底层连接保留", () => {
  it("换片/分P时保留 MOSS Live 连接并通过 context_update 刷新新视频上下文", async () => {
    const fakePort = new FakePort();
    let latestContext: any = { bvid: "BV1", cid: "101", title: "第一片" };

    const controller = createLiveChatController({
      connectPort: () => fakePort as any,
      requestOrigins: async () => ({ ok: true }),
      sendRuntimeMessage: (async () => ({
        ok: true,
        provider: { baseUrl: "https://api.mosi.cn", model: "moss-1" }
      })) as any,
      startAudioCapture: async () => ({
        setMuted: () => {},
        isMuted: () => false,
        stop: () => {},
        setShareVideoAudio: () => {},
        isSharingVideoAudio: () => true,
        getVideoAudioStatus: () => "已获取音轨",
        isMicVadActive: () => false,
        isVoiceRecentlyActive: () => true
      }),
      startVideoCapture: () => ({ stop: () => {}, configure: () => {} }),
      getVideoContext: () => latestContext,
      subscribeVideoContextChanges: (listener) => {
        (window as any).__notifyContextChange = listener;
        return () => {};
      }
    });

    await controller.start();
    fakePort.simulateMessage({ type: "connected" });
    expect(controller.getState()).toBe("connected");

    latestContext = { bvid: "BV2", cid: "202", title: "第二片" };
    (window as any).__notifyContextChange?.();

    expect(controller.getState()).toBe("connected");

    const lastMsg = fakePort.postedMessages.at(-1);
    expect(lastMsg).toEqual({
      action: "context_update",
      videoContext: latestContext
    });
  });

  it("换片时切换对话视图到新视频对应的本地对话历史，切换回原片时恢复原片历史", async () => {
    const storageData: Record<string, any> = {};
    const fakeStorage = {
      get: vi.fn(async (keys?: any) => {
        if (!keys) return { ...storageData };
        if (typeof keys === "string") return { [keys]: storageData[keys] };
        return { ...storageData };
      }),
      set: vi.fn(async (items: Record<string, any>) => {
        Object.assign(storageData, items);
      })
    };

    let fetchPayload: any = {
      signature: "sig-v1",
      bvid: "BV1",
      cid: "101",
      title: "视频一",
      url: "https://www.bilibili.com/video/BV1"
    };

    const requestViewReset = vi.fn();
    const renderInitialState = vi.fn();
    const renderHistoryList = vi.fn();
    const renderSuggestions = vi.fn();

    const store = createConversationStore({
      loadContextState: async () => true,
      resolveAiConversationRef: async () => ({}),
      onConversationChanged: () => {},
      onStreamInterrupted: () => {},
      onContextNotice: () => {},
      storage: fakeStorage as any
    });

    const contextLoad = createContextLoad({
      fetchContext: async (): Promise<ContextFetchOutcome> => ({
        kind: "payload",
        tabUrl: fetchPayload.url,
        payload: fetchPayload
      }),
      renderHistoryList,
      renderInitialState,
      renderSuggestions,
      requestViewReset,
      restoreLatest: () => store.restoreLatest(),
      isStreaming: () => false,
      hasPendingUserPrompt: () => false,
      isLiveActive: () => true
    });

    await contextLoad.loadContextState();
    expect(chatSessionState.currentContextKey).toBe("video:BV1|101");

    const conv1 = {
      id: "conv-video-1",
      title: "视频一的伴看对话",
      createdAt: 1000,
      updatedAt: 1000,
      contextKey: "video:BV1|101",
      messages: [
        { role: "user", content: "第一片讲了什么？" },
        { role: "assistant", content: "第一片讲了计算机基础。" }
      ]
    };
    storageData.biliscript_ai_conversations_v1 = [conv1];
    await store.loadAll();
    await store.restoreLatest();
    expect(chatSessionState.currentConversationId).toBe("conv-video-1");

    fetchPayload = {
      signature: "sig-v2",
      bvid: "BV2",
      cid: "202",
      title: "视频二",
      url: "https://www.bilibili.com/video/BV2"
    };
    await contextLoad.loadContextState();

    expect(chatSessionState.currentContextKey).toBe("video:BV2|202");
    expect(requestViewReset).toHaveBeenCalledWith({
      kind: "restart",
      keepContext: true,
      preserveInput: false
    });
    expect(renderInitialState).toHaveBeenCalled();
    expect(chatSessionState.currentConversationId).toBe("");

    const conv2 = {
      id: "conv-video-2",
      title: "视频二的对话",
      createdAt: 2000,
      updatedAt: 2000,
      contextKey: "video:BV2|202",
      messages: [
        { role: "user", content: "第二片讲了什么？" },
        { role: "assistant", content: "第二片讲了操作系统。" }
      ]
    };
    storageData.biliscript_ai_conversations_v1.unshift(conv2);
    await store.loadAll();

    fetchPayload = {
      signature: "sig-v1",
      bvid: "BV1",
      cid: "101",
      title: "视频一",
      url: "https://www.bilibili.com/video/BV1"
    };
    await contextLoad.loadContextState();

    expect(chatSessionState.currentContextKey).toBe("video:BV1|101");
    expect(chatSessionState.currentConversationId).toBe("conv-video-1");
    expect(chatSessionState.chatHistory).toEqual(conv1.messages);
  });
});
