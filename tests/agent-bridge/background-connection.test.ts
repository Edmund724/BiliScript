import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createAgentBridge, testAgentBridgeConnection } from "../../extension/agent-bridge/background.js";
import { AGENT_BRIDGE_ALARM } from "../../extension/agent-bridge/protocol.js";

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

      // 第 1 次失败 -> 退避 1000ms
      FakeWebSocket.instances[0].close();
      await vi.advanceTimersByTimeAsync(999);
      expect(FakeWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(2);

      // 第 2 次失败 -> 退避 2000ms（不再每秒重试）
      FakeWebSocket.instances[1].close();
      await vi.advanceTimersByTimeAsync(1999);
      expect(FakeWebSocket.instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(3);

      // 第 3 次失败 -> 退避 4000ms
      FakeWebSocket.instances[2].close();
      await vi.advanceTimersByTimeAsync(3999);
      expect(FakeWebSocket.instances).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(4);

      // 第 4 次失败 -> 退避 8000ms
      FakeWebSocket.instances[3].close();
      await vi.advanceTimersByTimeAsync(7999);
      expect(FakeWebSocket.instances).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(5);

      // 达到单次唤醒重试上限后静默等待定时唤醒，不再继续发包
      FakeWebSocket.instances[4].close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeWebSocket.instances).toHaveLength(5);
      expect(alarms.create).toHaveBeenCalledTimes(1);

      // 模拟定时唤醒触发 sync，重新开启新一轮重连窗口
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

      // 经历两次失败后再成功连接，退避计数应归零
      FakeWebSocket.instances[0].close();
      await vi.advanceTimersByTimeAsync(1000);
      FakeWebSocket.instances[1].close();
      await vi.advanceTimersByTimeAsync(2000);
      expect(FakeWebSocket.instances).toHaveLength(3);
      FakeWebSocket.instances[2].open();
      expect(bridge.getStatus().connected).toBe(true);

      // 后续断线（如 Daemon 空闲退出）应从初始 1000ms 重新开始退避
      FakeWebSocket.instances[2].close();
      await vi.advanceTimersByTimeAsync(1000);
      expect(FakeWebSocket.instances).toHaveLength(4);
      FakeWebSocket.instances[3].open();

      // 关闭开关立即断开连接、取消待执行退避并清除定时唤醒
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
});
