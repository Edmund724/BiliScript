// 「SW 保活」模块（08 票）：Map-Reduce/流式运行期间，段缓存的每次读写都会经
// runtime 消息唤醒可能已被 30s 空闲回收冷启动的 SW。运行期间持一条
// offscreen → SW 的长连端口即可钉住 SW（MV3：SW 生命周期与活动端口绑定），
// 运行结束 release 断开。SW 异常断连（崩溃/重载）时端口随之失效——兜底为
// 不重连：后续段缓存消息自然走既有唤醒/错误路径，不影响运行本身的错误语义。

export const SW_KEEPALIVE_PORT_NAME = "biliscript-sw-keepalive";

export interface SwKeepaliveHandle {
  release: () => void;
}

/**
 * 获取保活句柄：connect 失败 / 无 chrome 环境（测试）→ null，调用方跳过保活。
 * release 幂等；SW 侧断连（onDisconnect 触发）后 release 不再调 disconnect。
 */
export function acquireSwKeepalive(): SwKeepaliveHandle | null {
  const connect = globalThis.chrome?.runtime?.connect;
  if (typeof connect !== "function") {
    return null;
  }
  let port;
  try {
    port = connect.call(globalThis.chrome.runtime, { name: SW_KEEPALIVE_PORT_NAME });
  } catch {
    return null;
  }
  if (!port || typeof port.disconnect !== "function") {
    return null;
  }
  let released = false;
  // SW 异常断连兜底：端口作废（release 不再 disconnect，也不重连）。
  port.onDisconnect?.addListener?.(() => {
    released = true;
  });
  return {
    release() {
      if (released) {
        return;
      }
      released = true;
      try {
        port.disconnect();
      } catch {
        // 已断连：忽略。
      }
    }
  };
}

// SW 端 onConnect 分派：保活端口只需被接受持有即生效，无消息往来。
export function isSwKeepalivePort(port: { name?: string } | null | undefined): boolean {
  return Boolean(port && port.name === SW_KEEPALIVE_PORT_NAME);
}
