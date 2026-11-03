// tests/live/offscreen-moss-client.test.ts
// Offscreen MOSS-LIVE 客户端生命周期、握手超时、代际隔离与断连处理测试

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  OffscreenMossLiveClient
} from "../../extension/live/offscreen-moss-client.js";
import {
  buildMinimalSessionUpdatePayload
} from "../../extension/live/moss-live-protocol.js";

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  readyState = 0;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: ((error: any) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sentData: any[] = [];

  constructor(url: string) {
    this.url = url;
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

  simulateError(err: any = new Error("Socket error")) {
    this.onerror?.(err);
  }
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("OffscreenMossLiveClient", () => {
  it("connects, sends attach_session upon open, and does not fire onConnected yet", () => {
    const onConnected = vi.fn();
    const onError = vi.fn();
    const client = new OffscreenMossLiveClient({
      wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
      onConnected,
      onError
    });

    client.connect();
    expect(client.getState()).toBe("connecting");

    const ws = (client as any).ws as FakeWebSocket;
    expect(ws).toBeDefined();
    expect(ws.binaryType).toBe("arraybuffer");

    ws.simulateOpen();

    // attach_session sent immediately on open
    expect(ws.sentData).toHaveLength(1);
    expect(JSON.parse(ws.sentData[0])).toEqual({
      action: "attach_session",
      memory_scope: "session"
    });

    // not connected yet (session_attached required)
    expect(client.getState()).toBe("connecting");
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("transitions to connected, sends tagged-v1 media.mode and session.update upon receiving session_attached", () => {
    const onConnected = vi.fn();
    const client = new OffscreenMossLiveClient({
      wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
      onConnected
    });

    client.connect();
    const ws = (client as any).ws as FakeWebSocket;
    ws.simulateOpen();

    ws.simulateMessage(JSON.stringify({ action: "session_attached" }));

    expect(client.getState()).toBe("connected");
    expect(onConnected).toHaveBeenCalledTimes(1);

    // Verify protocol handshake messages sent
    expect(ws.sentData).toHaveLength(3);
    expect(JSON.parse(ws.sentData[1])).toEqual({
      action: "media.mode",
      binary_protocol: "tagged-v1"
    });
    expect(JSON.parse(ws.sentData[2])).toEqual(buildMinimalSessionUpdatePayload());
  });

  it("fails when server sends error action", () => {
    const onError = vi.fn();
    const client = new OffscreenMossLiveClient({
      wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
      onError
    });

    client.connect();
    const ws = (client as any).ws as FakeWebSocket;
    ws.simulateOpen();

    ws.simulateMessage(JSON.stringify({ action: "error", message: "鉴权失败：密钥无效" }));

    expect(client.getState()).toBe("failed");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("鉴权失败：密钥无效")
    }));
  });

  it("fails when session.updated contains data.error", () => {
    const onError = vi.fn();
    const client = new OffscreenMossLiveClient({
      wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
      onError
    });

    client.connect();
    const ws = (client as any).ws as FakeWebSocket;
    ws.simulateOpen();

    ws.simulateMessage(JSON.stringify({
      action: "session.updated",
      data: { error: "unsupported sample rate" }
    }));

    expect(client.getState()).toBe("failed");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("unsupported sample rate")
    }));
  });

  it("fails when socket encounters error", () => {
    const onError = vi.fn();
    const client = new OffscreenMossLiveClient({
      wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
      onError
    });

    client.connect();
    const ws = (client as any).ws as FakeWebSocket;

    ws.simulateError();

    expect(client.getState()).toBe("failed");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("WebSocket 连接失败或握手鉴权被拒绝")
    }));
  });

  it("fails when socket closes during connecting state", () => {
    const onError = vi.fn();
    const client = new OffscreenMossLiveClient({
      wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
      onError
    });

    client.connect();
    const ws = (client as any).ws as FakeWebSocket;

    ws.close(1006, "Connection refused");

    expect(client.getState()).toBe("failed");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("1006")
    }));
  });

  it("notifies onClosed when socket closes cleanly after connected", () => {
    const onClosed = vi.fn();
    const client = new OffscreenMossLiveClient({
      wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
      onClosed
    });

    client.connect();
    const ws = (client as any).ws as FakeWebSocket;
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ action: "session_attached" }));
    expect(client.getState()).toBe("connected");

    ws.close(1000, "Normal closure");

    expect(client.getState()).toBe("closed");
    expect(onClosed).toHaveBeenCalledWith({ code: 1000, reason: "Normal closure" });
  });

  it("close() shuts down socket, transitions to idle, and ignores subsequent server messages", () => {
    const onConnected = vi.fn();
    const onError = vi.fn();
    const onClosed = vi.fn();
    const client = new OffscreenMossLiveClient({
      wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
      onConnected,
      onError,
      onClosed
    });

    client.connect();
    const ws = (client as any).ws as FakeWebSocket;
    ws.simulateOpen();

    client.close();
    expect(client.getState()).toBe("idle");

    // Late session_attached or error arrives from wire
    ws.simulateMessage(JSON.stringify({ action: "session_attached" }));
    ws.simulateError();
    ws.close(1006, "Abnormal closure");

    expect(onConnected).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onClosed).not.toHaveBeenCalled();
  });

  describe("handshake timeout and socket replacement", () => {
    it("times out if server remains silent and does not send session_attached within handshakeTimeoutMs", () => {
      vi.useFakeTimers();
      const onError = vi.fn();
      const client = new OffscreenMossLiveClient({
        wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
        handshakeTimeoutMs: 5000,
        onError
      });

      client.connect();
      const ws = (client as any).ws as FakeWebSocket;
      ws.simulateOpen();

      expect(client.getState()).toBe("connecting");

      // Advance clock past 5000ms
      vi.advanceTimersByTime(5001);

      expect(client.getState()).toBe("failed");
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining("MOSS-LIVE 会话附着握手超时")
      }));
    });

    it("clears handshake timeout once session_attached arrives", () => {
      vi.useFakeTimers();
      const onError = vi.fn();
      const onConnected = vi.fn();
      const client = new OffscreenMossLiveClient({
        wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
        handshakeTimeoutMs: 5000,
        onConnected,
        onError
      });

      client.connect();
      const ws = (client as any).ws as FakeWebSocket;
      ws.simulateOpen();

      // Handshake succeeds at 2000ms
      vi.advanceTimersByTime(2000);
      ws.simulateMessage(JSON.stringify({ action: "session_attached" }));

      expect(client.getState()).toBe("connected");
      expect(onConnected).toHaveBeenCalledTimes(1);

      // Advance clock well beyond original 5000ms timeout
      vi.advanceTimersByTime(10000);

      // Must remain connected and timeout must not fire
      expect(client.getState()).toBe("connected");
      expect(onError).not.toHaveBeenCalled();
    });

    it("regression: handshake timeout from an earlier replaced socket does not fail a newer attached socket", () => {
      vi.useFakeTimers();
      const onError = vi.fn();
      const onConnected = vi.fn();
      const client = new OffscreenMossLiveClient({
        wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
        handshakeTimeoutMs: 5000,
        onConnected,
        onError
      });

      // Socket 1 starts connecting at t=0
      client.connect();
      const ws1 = (client as any).ws as FakeWebSocket;
      ws1.simulateOpen();

      // At t=2000, reconnect is called (replacing socket 1 with socket 2)
      vi.advanceTimersByTime(2000);
      client.connect();
      const ws2 = (client as any).ws as FakeWebSocket;
      ws2.simulateOpen();

      // Socket 2 receives session_attached at t=3000
      vi.advanceTimersByTime(1000);
      ws2.simulateMessage(JSON.stringify({ action: "session_attached" }));

      expect(client.getState()).toBe("connected");
      expect(onConnected).toHaveBeenCalledTimes(1);

      // Advance clock past t=5000 (socket 1's original timeout would have fired here)
      vi.advanceTimersByTime(3000);

      // Client must remain connected, socket 1's stale timer was ignored
      expect(client.getState()).toBe("connected");
      expect(onError).not.toHaveBeenCalled();
    });

    it("regression: fail() invalidates socket generation, ignoring late session_attached/error/close after failure, while allowing later explicit connect()", () => {
      const onError = vi.fn();
      const onConnected = vi.fn();
      const onClosed = vi.fn();
      const client = new OffscreenMossLiveClient({
        wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
        onConnected,
        onError,
        onClosed
      });

      client.connect();
      const ws1 = (client as any).ws as FakeWebSocket;
      ws1.simulateOpen();

      // Simulate failure (e.g. server error or socket error)
      ws1.simulateError(new Error("Initial connection error"));

      expect(client.getState()).toBe("failed");
      expect(onError).toHaveBeenCalledTimes(1);

      // Now late events arrive from ws1
      ws1.simulateMessage(JSON.stringify({ action: "session_attached" }));
      ws1.simulateError(new Error("Late error"));
      ws1.close(1006, "Late close");

      // State MUST remain failed, onConnected MUST NOT be called, onError must not be called again
      expect(client.getState()).toBe("failed");
      expect(onConnected).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onClosed).not.toHaveBeenCalled();

      // Explicit later connect() must work normally
      client.connect();
      expect(client.getState()).toBe("connecting");

      const ws2 = (client as any).ws as FakeWebSocket;
      expect(ws2).not.toBe(ws1);
      ws2.simulateOpen();
      ws2.simulateMessage(JSON.stringify({ action: "session_attached" }));

      expect(client.getState()).toBe("connected");
      expect(onConnected).toHaveBeenCalledTimes(1);
    });
  });
});
