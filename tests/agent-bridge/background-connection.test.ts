import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createAgentBridge, listAgentBridgeTabs, testAgentBridgeConnection } from "../../extension/agent-bridge/background.js";
import { AGENT_BRIDGE_ALARM } from "../../extension/agent-bridge/protocol.js";
import { normalizeAgentBridgeUrl, parseAgentBridgeUrl } from "../../extension/core/validators.js";

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

  it("地址变化后关闭旧连接并使用归一后的 127.0.0.1 地址", async () => {
    const config = { enabled: true, url: "ws://127.0.0.1:18492" };
    const bridge = createAgentBridge({ getConfig: async () => config });
    await bridge.sync();
    const first = FakeWebSocket.instances[0];
    first.open();

    config.url = "ws://localhost:19001";
    await bridge.sync();

    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toBe("ws://127.0.0.1:19001");

    FakeWebSocket.instances[1].open();
    config.url = "ws://[::1]:19001";
    await bridge.sync();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].readyState).toBe(FakeWebSocket.OPEN);
  });

  it("地址测试独立探测并在结束后关闭临时连接", async () => {
    const probing = testAgentBridgeConnection("ws://127.0.0.1:19002");
    const socket = FakeWebSocket.instances[0];
    socket.open();

    expect(await probing).toBe(true);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);

    const probingLocalhost = testAgentBridgeConnection("ws://localhost:19003");
    FakeWebSocket.instances[1].open();
    expect(await probingLocalhost).toBe(true);
    expect(FakeWebSocket.instances[1].url).toBe("ws://127.0.0.1:19003");

    const probingIpv6 = testAgentBridgeConnection("ws://[::1]:19004");
    FakeWebSocket.instances[2].open();
    expect(await probingIpv6).toBe(true);
    expect(FakeWebSocket.instances[2].url).toBe("ws://127.0.0.1:19004");

    expect(await testAgentBridgeConnection("https://example.com")).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("回环地址解析与校验统一归一 localhost 和 [::1] 并拒绝非法地址", () => {
    expect(parseAgentBridgeUrl("ws://localhost:19000")).toBe("ws://127.0.0.1:19000");
    expect(parseAgentBridgeUrl("ws://localhost:19000/")).toBe("ws://127.0.0.1:19000");
    expect(parseAgentBridgeUrl("WS://LOCALHOST:19000")).toBe("ws://127.0.0.1:19000");
    expect(parseAgentBridgeUrl("ws://[::1]:19000")).toBe("ws://127.0.0.1:19000");
    expect(parseAgentBridgeUrl("ws://[0:0:0:0:0:0:0:1]:19000/")).toBe("ws://127.0.0.1:19000");
    expect(normalizeAgentBridgeUrl("ws://[::1]:19500")).toBe("ws://127.0.0.1:19500");

    expect(parseAgentBridgeUrl("ws://example.com:19000")).toBeNull();
    expect(parseAgentBridgeUrl("ws://192.168.1.10:19000")).toBeNull();
    expect(parseAgentBridgeUrl("wss://localhost:19000")).toBeNull();
    expect(parseAgentBridgeUrl("http://127.0.0.1:19000")).toBeNull();
    expect(parseAgentBridgeUrl("ws://localhost")).toBeNull();
    expect(parseAgentBridgeUrl("ws://[::1]")).toBeNull();
    expect(parseAgentBridgeUrl("ws://127.0.0.1")).toBeNull();
    expect(parseAgentBridgeUrl("ws://127.0.0.1:0")).toBeNull();
    expect(parseAgentBridgeUrl("ws://127.0.0.1:19000/ws")).toBeNull();
    expect(normalizeAgentBridgeUrl("ws://example.com:19000")).toBe("ws://127.0.0.1:18492");
  });

  it("开关关闭时默认不建立连接也不轮询；单次连接失败后不安排后台重连", async () => {
    vi.useFakeTimers();
    try {
      const bridge = createAgentBridge({
        getConfig: async () => ({ enabled: false, url: "ws://127.0.0.1:18492" })
      });
      await bridge.sync();
      expect(FakeWebSocket.instances).toHaveLength(0);

      const connecting = bridge.connect();
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      FakeWebSocket.instances[0].close();

      expect(await connecting).toBe(false);
      await vi.advanceTimersByTimeAsync(5000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("开启连接但 Daemon 未运行时，单次唤醒按退避重试并在达上限后静默交由定时唤醒", async () => {
    vi.useFakeTimers();
    const alarms = {
      create: vi.fn(),
      clear: vi.fn()
    };
    vi.stubGlobal("chrome", { ...globalThis.chrome, alarms });
    try {
      const bridge = createAgentBridge({
        getConfig: async () => ({ enabled: true, url: "ws://127.0.0.1:18492" })
      });
      await bridge.sync();
      expect(alarms.create).toHaveBeenCalledTimes(1);
      expect(alarms.create).toHaveBeenCalledWith(AGENT_BRIDGE_ALARM, { periodInMinutes: 0.5 });
      expect(FakeWebSocket.instances).toHaveLength(1);

      FakeWebSocket.instances[0].close();
      await vi.advanceTimersByTimeAsync(999);
      expect(FakeWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(2);

      FakeWebSocket.instances[1].close();
      await vi.advanceTimersByTimeAsync(1999);
      expect(FakeWebSocket.instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(3);

      FakeWebSocket.instances[2].close();
      await vi.advanceTimersByTimeAsync(3999);
      expect(FakeWebSocket.instances).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(4);

      FakeWebSocket.instances[3].close();
      await vi.advanceTimersByTimeAsync(7999);
      expect(FakeWebSocket.instances).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(5);

      FakeWebSocket.instances[4].close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeWebSocket.instances).toHaveLength(5);
      expect(alarms.create).toHaveBeenCalledTimes(1);

      await bridge.sync();
      expect(FakeWebSocket.instances).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("重连成功后重置退避计数；关闭开关时立即停止连接并清除定时唤醒", async () => {
    vi.useFakeTimers();
    const alarms = {
      create: vi.fn(),
      clear: vi.fn()
    };
    vi.stubGlobal("chrome", { ...globalThis.chrome, alarms });
    try {
      const config = { enabled: true, url: "ws://127.0.0.1:18492" };
      const bridge = createAgentBridge({ getConfig: async () => config });
      await bridge.sync();

      FakeWebSocket.instances[0].close();
      await vi.advanceTimersByTimeAsync(1000);
      FakeWebSocket.instances[1].close();
      await vi.advanceTimersByTimeAsync(2000);
      expect(FakeWebSocket.instances).toHaveLength(3);
      FakeWebSocket.instances[2].open();
      expect(bridge.getStatus().connected).toBe(true);

      FakeWebSocket.instances[2].close();
      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeWebSocket.instances).toHaveLength(4);
      FakeWebSocket.instances[3].open();

      config.enabled = false;
      await bridge.sync();
      expect(FakeWebSocket.instances[3].readyState).toBe(FakeWebSocket.CLOSED);
      expect(bridge.getStatus().connected).toBe(false);
      expect(alarms.clear).toHaveBeenCalledWith(AGENT_BRIDGE_ALARM);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeWebSocket.instances).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("listAgentBridgeTabs 标记当前窗口活动视频标签页为 active", async () => {
    const prevChrome = globalThis.chrome;
    const allTabs = [
      { id: 10, url: "https://www.bilibili.com/video/BV1one000001/", title: "后台", active: false },
      { id: 20, url: "https://www.bilibili.com/video/BV1two000002/", title: "活动", active: true }
    ];
    vi.stubGlobal("chrome", {
      ...prevChrome,
      tabs: {
        query: vi.fn(async (queryInfo: { active?: boolean }) =>
          queryInfo.active ? [allTabs[1]] : allTabs
        ),
        sendMessage: vi.fn((_tabId: number, _msg: unknown, callback: (res: unknown) => void) => {
          callback({ ok: false });
        })
      }
    });
    try {
      const result = await listAgentBridgeTabs();
      expect(result.tabs).toHaveLength(2);
      expect(result.tabs[0]).toMatchObject({ tabId: 10, bvid: "BV1one000001" });
      expect(result.tabs[0].active).toBeUndefined();
      expect(result.tabs[1]).toMatchObject({ tabId: 20, bvid: "BV1two000002", active: true });
    } finally {
      vi.stubGlobal("chrome", prevChrome);
    }
  });
});
