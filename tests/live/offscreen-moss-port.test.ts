// tests/live/offscreen-moss-port.test.ts
// Offscreen MOSS-LIVE 端口管理行为与异步加载竞态回归测试

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  attachMossLivePort,
  type MossLiveClientFactory,
  type MossLiveClientInstance
} from "../../extension/live/offscreen-moss-port.js";

class FakePort {
  disconnected = false;
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
    this.disconnected = true;
    for (const fn of this.disconnectListeners) {
      fn();
    }
  }
}

class FakeMossClient implements MossLiveClientInstance {
  connected = false;
  closed = false;
  options: any;

  constructor(options: any) {
    this.options = options;
  }

  connect() {
    this.connected = true;
  }

  close() {
    this.closed = true;
    this.connected = false;
  }
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
});

describe("attachMossLivePort", () => {
  it("normal lifecycle: start creates client, calls connect, and relays client events to port", async () => {
    const port = new FakePort();
    let createdClient: FakeMossClient | null = null;
    const clientFactory: MossLiveClientFactory = vi.fn((opts) => {
      createdClient = new FakeMossClient(opts);
      return createdClient;
    });

    attachMossLivePort(port as any, {
      loadClient: async () => clientFactory
    });

    port.simulateMessage({ action: "start", wsUrl: "wss://api.mosi.cn/v1/realtime" });

    // Allow promise microtasks to run
    await Promise.resolve();
    await Promise.resolve();

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(createdClient).not.toBeNull();
    expect(createdClient!.connected).toBe(true);

    // Relays client events to port
    createdClient!.options.onConnected();
    expect(port.postedMessages).toContainEqual({ type: "connected" });

    // Stop cleans up client and notifies port
    port.simulateMessage({ action: "stop" });
    expect(createdClient!.closed).toBe(true);
    expect(port.postedMessages).toContainEqual({ type: "closed" });
  });

  it("regression: when stop() occurs while loadClient() is pending, continuation creates no socket", async () => {
    const port = new FakePort();
    let resolveLoader!: (factory: MossLiveClientFactory) => void;
    const loadPromise = new Promise<MossLiveClientFactory>((resolve) => {
      resolveLoader = resolve;
    });

    let clientCreated = false;
    const clientFactory: MossLiveClientFactory = vi.fn((opts) => {
      clientCreated = true;
      return new FakeMossClient(opts);
    });

    attachMossLivePort(port as any, {
      loadClient: () => loadPromise
    });

    // 1. Port receives start, but loader is pending
    port.simulateMessage({ action: "start", wsUrl: "wss://api.mosi.cn/v1/realtime" });

    // 2. Before loader finishes, user triggers stop
    port.simulateMessage({ action: "stop" });
    expect(port.postedMessages).toContainEqual({ type: "closed" });

    // 3. Now loader completes
    resolveLoader(clientFactory);
    await Promise.resolve();
    await Promise.resolve();

    // 关键断言：因为代际已失效且已处于 stop 态，绝不得创建客户端或调用 connect
    expect(clientFactory).not.toHaveBeenCalled();
    expect(clientCreated).toBe(false);
  });

  it("regression: when port disconnects while loadClient() is pending, continuation creates no socket", async () => {
    const port = new FakePort();
    let resolveLoader!: (factory: MossLiveClientFactory) => void;
    const loadPromise = new Promise<MossLiveClientFactory>((resolve) => {
      resolveLoader = resolve;
    });

    let clientCreated = false;
    const clientFactory: MossLiveClientFactory = vi.fn((opts) => {
      clientCreated = true;
      return new FakeMossClient(opts);
    });

    attachMossLivePort(port as any, {
      loadClient: () => loadPromise
    });

    // 1. Port receives start, but loader is pending
    port.simulateMessage({ action: "start", wsUrl: "wss://api.mosi.cn/v1/realtime" });

    // 2. Before loader finishes, port disconnects
    port.disconnect();

    // 3. Now loader completes
    resolveLoader(clientFactory);
    await Promise.resolve();
    await Promise.resolve();

    // 关键断言：端口已断开，disposed 守卫必须拦截，不得连接任何 socket
    expect(clientFactory).not.toHaveBeenCalled();
    expect(clientCreated).toBe(false);
  });
});
