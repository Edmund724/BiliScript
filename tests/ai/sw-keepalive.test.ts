// 「SW 保活」单元测试（08 票）：Map-Reduce/流式运行期间持一条 offscreen → SW
// 长连端口钉住 SW（防 30s 空闲回收冷启动），运行结束 release。契约：
//   - acquire 以固定端口名 connect；release 断开端口，重复 release 幂等；
//   - SW 异常断连（onDisconnect 触发）后 release 不再调 disconnect（兜底不重连，
//     后续段缓存消息走既有错误路径）；
//   - 无 chrome 环境 / connect 抛错 / 端口畸形 → 返回 null（调用方跳过保活）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let mod: typeof import("../../extension/ai/sw-keepalive.js");

function makeFakePort() {
  const disconnectListeners: Array<() => void> = [];
  return {
    port: {
      name: "boc-sw-keepalive",
      onDisconnect: {
        addListener: vi.fn((fn) => disconnectListeners.push(fn))
      },
      disconnect: vi.fn()
    },
    disconnectListeners
  };
}

async function importFresh() {
  vi.resetModules();
  resetModuleState();
  mod = await import("../../extension/ai/sw-keepalive.js");
}

beforeEach(async () => {
  await importFresh();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("acquireSwKeepalive", () => {
  it("以固定端口名 connect；release 断开端口；重复 release 幂等", async () => {
    const { port } = makeFakePort();
    const connect = vi.fn(() => port);
    vi.stubGlobal("chrome", { runtime: { connect } });

    const handle = mod.acquireSwKeepalive()!;
    expect(handle).not.toBeNull();
    expect(connect).toHaveBeenCalledWith({ name: mod.SW_KEEPALIVE_PORT_NAME });

    handle.release();
    expect(port.disconnect).toHaveBeenCalledTimes(1);
    handle.release();
    expect(port.disconnect).toHaveBeenCalledTimes(1); // 幂等
  });

  it("SW 异常断连（onDisconnect 触发）→ release 不再调 disconnect", async () => {
    const { port, disconnectListeners } = makeFakePort();
    vi.stubGlobal("chrome", { runtime: { connect: vi.fn(() => port) } });

    const handle = mod.acquireSwKeepalive()!;
    expect(port.onDisconnect.addListener).toHaveBeenCalledTimes(1);
    // 模拟 SW 崩溃/重载导致的端口断连
    for (const fn of disconnectListeners) {
      fn();
    }
    handle.release();
    expect(port.disconnect).not.toHaveBeenCalled();
  });

  it("无 chrome 环境 / connect 抛错 / 端口无 disconnect → 返回 null", async () => {
    // 无 chrome
    vi.stubGlobal("chrome", undefined);
    expect(mod.acquireSwKeepalive()).toBeNull();

    // connect 抛错
    vi.stubGlobal("chrome", { runtime: { connect: vi.fn(() => { throw new Error("no SW"); }) } });
    expect(mod.acquireSwKeepalive()).toBeNull();

    // 端口畸形（无 disconnect）
    vi.stubGlobal("chrome", { runtime: { connect: vi.fn(() => ({ name: "x" })) } });
    expect(mod.acquireSwKeepalive()).toBeNull();
  });
});

describe("isSwKeepalivePort（SW 端 onConnect 分派）", () => {
  it("按端口名判定保活端口", () => {
    expect(mod.isSwKeepalivePort({ name: "boc-sw-keepalive" })).toBe(true);
    expect(mod.isSwKeepalivePort({ name: "offscreen-chat" })).toBe(false);
    expect(mod.isSwKeepalivePort(null)).toBe(false);
    expect(mod.isSwKeepalivePort(undefined)).toBe(false);
  });
});
