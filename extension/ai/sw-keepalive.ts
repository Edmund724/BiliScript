import { consumeRuntimeLastError } from "../shared/messaging.js";

export const SW_KEEPALIVE_PORT_NAME = "biliscript-sw-keepalive";

export interface SwKeepaliveHandle {
  release: () => void;
}

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
  port.onDisconnect?.addListener?.(() => {
    consumeRuntimeLastError();
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
      }
    }
  };
}

export function isSwKeepalivePort(port: { name?: string } | null | undefined): boolean {
  return Boolean(port && port.name === SW_KEEPALIVE_PORT_NAME);
}
