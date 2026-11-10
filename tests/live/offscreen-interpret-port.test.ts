// tests/live/offscreen-interpret-port.test.ts
// Offscreen 端口层双通道隔离：伴看与同传并行会话互不影响，接管只在同通道内发生

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  attachMossLivePort,
  resetActiveLiveSessionForTests,
  type MossLiveClientInstance
} from "../../extension/live/offscreen-moss-port.js";
import { OffscreenInterpretClient } from "../../extension/live/offscreen-interpret-client.js";
import { OffscreenMossLiveClient } from "../../extension/live/offscreen-moss-client.js";
import type { MossLiveClientAction } from "../../extension/live/moss-live-protocol.js";
import type { MossInterpretServerEvent } from "../../extension/live/moss-interpret-protocol.js";

class FakePort {
  disconnected = false;
  messageListeners: ((msg: unknown) => void)[] = [];
  disconnectListeners: (() => void)[] = [];
  postedMessages: unknown[] = [];

  get onMessage() {
    return {
      addListener: (fn: (msg: unknown) => void) => {
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

  postMessage(msg: unknown) {
    this.postedMessages.push(msg);
  }

  simulateMessage(msg: unknown) {
    for (const fn of this.messageListeners) {
      fn(msg);
    }
  }

  disconnect() {
    this.disconnected = true;
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
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sentData: unknown[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown) {
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

  simulateMessage(data: unknown) {
    this.onmessage?.({ data });
  }
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  resetModuleState();
  resetActiveLiveSessionForTests();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

describe("attachMossLivePort dual-channel sessions", () => {
  function attachCompanion(port: FakePort) {
    let client: OffscreenMossLiveClient | null = null;
    attachMossLivePort(port as any, {
      loadClient: async () => (options) => {
        client = new OffscreenMossLiveClient(options);
        return client;
      }
    });
    return () => client;
  }

  function attachInterpret(port: FakePort) {
    let client: OffscreenInterpretClient | null = null;
    attachMossLivePort(port as any, {
      channel: "interpret",
      loadClient: async () => (options: { onEvent: (event: MossInterpretServerEvent) => void }) => {
        client = new OffscreenInterpretClient(options);
        return client;
      }
    });
    return () => client;
  }

  it("keeps companion and interpret sessions connected in parallel without takeover", async () => {
    const companionPort = new FakePort();
    const interpretPort = new FakePort();
    const getCompanion = attachCompanion(companionPort);
    const getInterpret = attachInterpret(interpretPort);

    companionPort.simulateMessage({ action: "start", wsUrl: "wss://api.mosi.cn/v1/realtime" });
    await flushAsync();
    interpretPort.simulateMessage({
      action: "start",
      wsUrl: "wss://api.mosi.cn/v1/realtime/interpret?model=moss-live-1.0&target=zh"
    });
    await flushAsync();

    expect(FakeWebSocket.instances).toHaveLength(2);
    const [companionWs, interpretWs] = FakeWebSocket.instances;

    companionWs.simulateOpen();
    companionWs.simulateMessage(JSON.stringify({ type: "session_attached", data: { session_id: "c-1" } }));
    companionWs.simulateMessage(JSON.stringify({ type: "session.updated", data: { error: "" } }));
    interpretWs.simulateOpen();
    interpretWs.simulateMessage(JSON.stringify({ type: "session_attached", data: { session_id: "i-1" } }));

    expect(getCompanion()!.getState()).toBe("connected");
    expect(getInterpret()!.getState()).toBe("connected");
    expect(companionPort.postedMessages).not.toContainEqual({ type: "closed", reason: "takeover" });
    expect(interpretPort.postedMessages).not.toContainEqual({ type: "closed", reason: "takeover" });

    // 同传下行文本只进同传端口；伴看端口收不到
    interpretWs.simulateMessage(
      JSON.stringify({ type: "output.transcript.updated", data: { text: "你好", run_id: "r-1", source_turn: "t-1" } })
    );
    expect(interpretPort.postedMessages).toContainEqual({
      type: "transcript",
      event: { kind: "output.updated", text: "你好", runId: "r-1", sourceTurn: "t-1" }
    });
    expect(companionPort.postedMessages).not.toContainEqual(
      expect.objectContaining({ type: "transcript" })
    );
  });

  it("starting a second interpret session takes over only the interpret channel", async () => {
    const companionPort = new FakePort();
    const interpretPort1 = new FakePort();
    const interpretPort2 = new FakePort();
    attachCompanion(companionPort);
    attachInterpret(interpretPort1);
    attachInterpret(interpretPort2);

    companionPort.simulateMessage({ action: "start", wsUrl: "wss://api.mosi.cn/v1/realtime" });
    await flushAsync();
    interpretPort1.simulateMessage({
      action: "start",
      wsUrl: "wss://api.mosi.cn/v1/realtime/interpret?model=moss-live-1.0&target=zh"
    });
    await flushAsync();
    const companionWs = FakeWebSocket.instances[0];
    companionWs.simulateOpen();
    companionWs.simulateMessage(JSON.stringify({ type: "session_attached", data: { session_id: "c-1" } }));
    companionWs.simulateMessage(JSON.stringify({ type: "session.updated", data: { error: "" } }));
    const interpretWs1 = FakeWebSocket.instances[1];
    interpretWs1.simulateOpen();
    interpretWs1.simulateMessage(JSON.stringify({ type: "session_attached", data: { session_id: "i-1" } }));

    interpretPort2.simulateMessage({
      action: "start",
      wsUrl: "wss://api.mosi.cn/v1/realtime/interpret?model=moss-live-1.0&target=en"
    });
    await flushAsync();

    expect(interpretPort1.postedMessages).toContainEqual({ type: "closed", reason: "takeover" });
    expect(interpretWs1.readyState).toBe(FakeWebSocket.CLOSED);
    expect(companionPort.postedMessages).not.toContainEqual({ type: "closed", reason: "takeover" });
    expect(companionWs.readyState).toBe(FakeWebSocket.OPEN);

    const interpretWs2 = FakeWebSocket.instances[2];
    interpretWs2.simulateOpen();
    interpretWs2.simulateMessage(JSON.stringify({ type: "session_attached", data: { session_id: "i-2" } }));
    expect(companionWs.readyState).toBe(FakeWebSocket.OPEN);
  });

  it("stopping the interpret session leaves the companion session untouched", async () => {
    const companionPort = new FakePort();
    const interpretPort = new FakePort();
    const getCompanion = attachCompanion(companionPort);
    attachInterpret(interpretPort);

    companionPort.simulateMessage({ action: "start", wsUrl: "wss://api.mosi.cn/v1/realtime" });
    await flushAsync();
    interpretPort.simulateMessage({
      action: "start",
      wsUrl: "wss://api.mosi.cn/v1/realtime/interpret?model=moss-live-1.0&target=zh"
    });
    await flushAsync();
    const companionWs = FakeWebSocket.instances[0];
    companionWs.simulateOpen();
    companionWs.simulateMessage(JSON.stringify({ type: "session_attached", data: { session_id: "c-1" } }));
    companionWs.simulateMessage(JSON.stringify({ type: "session.updated", data: { error: "" } }));

    interpretPort.simulateMessage({ action: "stop" });
    await flushAsync();

    expect(interpretPort.postedMessages).toContainEqual({ type: "closed" });
    expect(getCompanion()!.getState()).toBe("connected");
    expect(companionWs.readyState).toBe(FakeWebSocket.OPEN);

    // 伴看会话继续收发：start 新伴看不被同传 stop 影响
    companionWs.simulateMessage(
      JSON.stringify({ type: "input.transcript.updated", data: { text: "伴看正常" } })
    );
    expect(companionPort.postedMessages).toContainEqual({
      type: "transcript",
      event: { kind: "input.updated", text: "伴看正常" }
    });
  });

  it("interpret start forwards wsUrl and sessionId to the client", async () => {
    const port = new FakePort();
    let receivedStart: unknown = null;
    const fakeClient: MossLiveClientInstance = {
      handleAction: (action: MossLiveClientAction) => {
        if (action.action === "start") receivedStart = action;
      },
      close: () => {}
    };
    attachMossLivePort(port as any, {
      channel: "interpret",
      loadClient: async () => () => fakeClient
    });

    port.simulateMessage({
      action: "start",
      wsUrl: "wss://api.mosi.cn/v1/realtime/interpret?model=moss-live-1.0&target=ja",
      sessionId: "i-resume"
    });
    await flushAsync();

    expect(receivedStart).toEqual({
      action: "start",
      wsUrl: "wss://api.mosi.cn/v1/realtime/interpret?model=moss-live-1.0&target=ja",
      sessionId: "i-resume"
    });
  });
});
