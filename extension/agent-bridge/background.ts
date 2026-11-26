import { normalizeAgentBridgeUrl, parseAgentBridgeUrl } from "../core/validators.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { createAgentBridgeCommandRouter, type AgentBridgeCommandRouter } from "./command-router.js";
import { AGENT_BRIDGE_ALARM, AGENT_BRIDGE_PROTOCOL } from "./protocol.js";

const RECONNECT_BACKOFF_DELAYS_MS = [1000, 2000, 4000, 8000] as const;
const CONNECTION_TIMEOUT_MS = 3000;

export interface AgentBridgeDeps {
  getConfig: () => Promise<{ enabled: boolean; url: string }>;
  router?: Pick<AgentBridgeCommandRouter, "execute">;
}

interface WireRequest {
  type?: unknown;
  id?: unknown;
  command?: unknown;
  options?: unknown;
}

function waitForSocket(active: WebSocket, closeWhenDone = false): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (connected: boolean): void => {
      if (settled) return;
      settled = true;
      active.removeEventListener("open", onOpen);
      active.removeEventListener("close", onClose);
      active.removeEventListener("error", onError);
      clearTimeout(timeout);
      if (closeWhenDone) {
        try {
          active.close();
        } catch {}
      }
      resolve(connected);
    };
    const onOpen = (): void => finish(true);
    const onClose = (): void => finish(false);
    const onError = (): void => finish(false);
    const timeout = setTimeout(() => finish(false), CONNECTION_TIMEOUT_MS);
    active.addEventListener("open", onOpen);
    active.addEventListener("close", onClose);
    active.addEventListener("error", onError);
    if (active.readyState === WebSocket.OPEN) finish(true);
    if (active.readyState === WebSocket.CLOSED) finish(false);
  });
}

export async function testAgentBridgeConnection(rawUrl: unknown): Promise<boolean> {
  const url = parseAgentBridgeUrl(rawUrl);
  if (!url) return false;
  try {
    return await waitForSocket(new WebSocket(url, AGENT_BRIDGE_PROTOCOL), true);
  } catch {
    return false;
  }
}

export function createAgentBridge({ getConfig, router = createAgentBridgeCommandRouter() }: AgentBridgeDeps) {
  let socket: WebSocket | null = null;
  let socketUrl = "";
  let reconnectEnabled = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let alarmEnsured = false;
  let syncTask: Promise<void> | null = null;
  let syncRequested = false;
  let syncResetRequested = false;

  const send = (message: unknown): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const clearReconnectTimer = (): void => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const closeSocket = (): void => {
    const active = socket;
    socket = null;
    socketUrl = "";
    if (active) {
      active.onclose = null;
      active.onerror = null;
      active.onmessage = null;
      active.onopen = null;
      try {
        active.close();
      } catch {}
    }
  };

  const stop = (): void => {
    clearReconnectTimer();
    reconnectAttempt = 0;
    alarmEnsured = false;
    closeSocket();
    void Promise.resolve(chrome.alarms?.clear(AGENT_BRIDGE_ALARM)).catch(() => {});
  };

  const scheduleReconnect = (): void => {
    if (!reconnectEnabled || reconnectTimer) return;
    if (reconnectAttempt >= RECONNECT_BACKOFF_DELAYS_MS.length) return;
    const delay = RECONNECT_BACKOFF_DELAYS_MS[reconnectAttempt];
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void runSync(false);
    }, delay);
  };

  const openSocket = (url: string): void => {
    const active = new WebSocket(url, AGENT_BRIDGE_PROTOCOL);
    socket = active;
    socketUrl = url;
    active.onopen = () => {
      if (socket !== active) return;
      reconnectAttempt = 0;
      send({ type: "hello", role: "extension", version: 1 });
    };
    active.onmessage = (event) => {
      if (socket !== active) return;
      void (async () => {
        let message: WireRequest;
        try {
          message = JSON.parse(String(event.data)) as WireRequest;
        } catch {
          return;
        }
        if (message.type !== "request" || typeof message.id !== "string") return;
        try {
          const result = await router.execute(message.command, message.options);
          if (socket === active) send({ type: "response", id: message.id, ok: true, result });
        } catch (error) {
          if (socket === active) send({ type: "response", id: message.id, ok: false, error: getErrorMessage(error) });
        }
      })();
    };
    active.onclose = () => {
      if (socket !== active) return;
      socket = null;
      socketUrl = "";
      scheduleReconnect();
    };
    active.onerror = () => {
      if (socket === active) active.close();
    };
  };

  const runSync = (resetBackoff: boolean): Promise<void> => {
    if (syncTask) {
      syncRequested = true;
      if (resetBackoff) syncResetRequested = true;
      return syncTask;
    }
    let pendingReset = resetBackoff;
    syncTask = (async () => {
      do {
        const shouldReset = pendingReset || syncResetRequested;
        pendingReset = false;
        syncRequested = false;
        syncResetRequested = false;
        const config = await getConfig();
        const enabled = config.enabled;
        const url = normalizeAgentBridgeUrl(config.url);
        reconnectEnabled = enabled;
        if (!enabled) {
          stop();
          continue;
        }
        if (!alarmEnsured) {
          alarmEnsured = true;
          void Promise.resolve(chrome.alarms?.create(AGENT_BRIDGE_ALARM, { periodInMinutes: 0.5 })).catch(() => {});
        }
        if (shouldReset) {
          clearReconnectTimer();
          reconnectAttempt = 0;
        }
        if (socket && socketUrl !== url) {
          clearReconnectTimer();
          reconnectAttempt = 0;
          closeSocket();
        }
        if (socket?.readyState === WebSocket.CLOSED) {
          socket = null;
          socketUrl = "";
        }
        if (!socket) {
          try {
            openSocket(url);
          } catch {
            scheduleReconnect();
          }
        }
      } while (syncRequested);
    })().finally(() => {
      syncTask = null;
    });
    return syncTask;
  };

  const sync = (): Promise<void> => runSync(true);

  return {
    sync,
    getStatus: () => ({ connected: socket?.readyState === WebSocket.OPEN }),
    connect: async (): Promise<boolean> => {
      if (syncTask) await syncTask;
      clearReconnectTimer();
      reconnectAttempt = 0;
      const config = await getConfig();
      const enabled = config.enabled;
      const url = normalizeAgentBridgeUrl(config.url);
      reconnectEnabled = enabled;
      if (socket && socketUrl !== url) closeSocket();
      if (socket?.readyState === WebSocket.CLOSED) {
        socket = null;
        socketUrl = "";
      }
      if (!socket) {
        try {
          openSocket(url);
        } catch {
          return false;
        }
      }
      const connected = socket ? await waitForSocket(socket) : false;
      if (!connected && !(await getConfig()).enabled) {
        stop();
      }
      return connected;
    }
  };
}
