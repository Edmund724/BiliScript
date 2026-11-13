import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createAgentBridge, testAgentBridgeConnection } from "../../extension/agent-bridge/background.js";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly protocol: string;
  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(url: string, protocol: string) {
    super();
    this.url = url;
    this.protocol = protocol;
    FakeWebSocket.instances.push(this);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    const event = new Event("open");
    this.dispatchEvent(event);
    this.onopen?.(event);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    const event = new Event("close");
    this.dispatchEvent(event);
    this.onclose?.(event);
  }
}

beforeEach(() => {
  resetModuleState();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

describe("Agent Bridge 连接", () => {
  it("使用保存的地址连接，并在打开后报告已连接", async () => {
    const bridge = createAgentBridge({
      getConfig: async () => ({ enabled: true, url: "ws://127.0.0.1:19000" })
    });
    await bridge.sync();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe("ws://127.0.0.1:19000");
    expect(bridge.getStatus().connected).toBe(false);

    const connecting = bridge.connect();
    FakeWebSocket.instances[0].open();
    expect(await connecting).toBe(true);
    expect(bridge.getStatus().connected).toBe(true);
    expect(JSON.parse(FakeWebSocket.instances[0].sent[0])).toMatchObject({ type: "hello", role: "extension" });
  });

  it("地址变化后关闭旧连接并使用新地址", async () => {
    const config = { enabled: true, url: "ws://127.0.0.1:18492" };
    const bridge = createAgentBridge({ getConfig: async () => config });
    await bridge.sync();
    const first = FakeWebSocket.instances[0];
    first.open();

    config.url = "ws://localhost:19001";
    await bridge.sync();

    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toBe("ws://localhost:19001");
  });

  it("地址测试独立探测并在结束后关闭临时连接", async () => {
    const probing = testAgentBridgeConnection("ws://127.0.0.1:19002");
    const socket = FakeWebSocket.instances[0];
    socket.open();

    expect(await probing).toBe(true);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(await testAgentBridgeConnection("https://example.com")).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
