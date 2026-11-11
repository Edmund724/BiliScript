import { extractBvid } from "../bilibili/video-id-shared.js";
import type { AgentBridgeSnapshotResponse } from "../shared/messaging-protocol.js";
import {
  AGENT_BRIDGE_ALARM,
  AGENT_BRIDGE_PROTOCOL,
  AGENT_BRIDGE_URL,
  type AgentBridgeTabSnapshot,
  type AgentBridgeTabsResult
} from "./protocol.js";

const RECONNECT_DELAY_MS = 1000;
const TAB_SNAPSHOT_TIMEOUT_MS = 2000;

interface AgentBridgeDeps {
  getEnabled: () => Promise<boolean>;
}

interface WireRequest {
  type?: unknown;
  id?: unknown;
  command?: unknown;
}

function fallbackTabSnapshot(tab: chrome.tabs.Tab): AgentBridgeTabSnapshot {
  return {
    tabId: tab.id || 0,
    bvid: extractBvid(tab.url || ""),
    cid: "",
    title: tab.title || "",
    currentTime: 0,
    duration: 0,
    subtitlesReady: false
  };
}

async function readTabSnapshot(tab: chrome.tabs.Tab): Promise<AgentBridgeTabSnapshot> {
  const fallback = fallbackTabSnapshot(tab);
  if (!tab.id) return fallback;
  const snapshot = await new Promise<Partial<AgentBridgeTabSnapshot> | null>((resolve) => {
    let settled = false;
    const finish = (value: Partial<AgentBridgeTabSnapshot> | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => finish(null), TAB_SNAPSHOT_TIMEOUT_MS);
    try {
      chrome.tabs.sendMessage(tab.id!, { type: "agent-bridge-snapshot" }, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          finish(null);
          return;
        }
        const result = response as AgentBridgeSnapshotResponse | undefined;
        finish(result?.ok && result.snapshot ? result.snapshot : null);
      });
    } catch {
      finish(null);
    }
  });
  if (!snapshot) return fallback;
  return {
    tabId: fallback.tabId,
    bvid: String(snapshot.bvid || fallback.bvid),
    cid: String(snapshot.cid || ""),
    title: String(snapshot.title || fallback.title),
    currentTime: Number.isFinite(snapshot.currentTime) ? Number(snapshot.currentTime) : 0,
    duration: Number.isFinite(snapshot.duration) ? Number(snapshot.duration) : 0,
    subtitlesReady: snapshot.subtitlesReady === true
  };
}

export async function listAgentBridgeTabs(): Promise<AgentBridgeTabsResult> {
  const tabs = await chrome.tabs.query({
    url: [
      "https://www.bilibili.com/video/*",
      "https://www.bilibili.com/list/watchlater",
      "https://www.bilibili.com/list/watchlater/*"
    ]
  });
  return { tabs: await Promise.all(tabs.filter((tab) => tab.id).map(readTabSnapshot)) };
}

export function createAgentBridge({ getEnabled }: AgentBridgeDeps) {
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let syncTask: Promise<void> | null = null;
  let syncRequested = false;

  const send = (message: unknown): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const stop = (): void => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const active = socket;
    socket = null;
    if (active) {
      active.onclose = null;
      active.onerror = null;
      active.onmessage = null;
      active.onopen = null;
      try {
        active.close();
      } catch {}
    }
    void Promise.resolve(chrome.alarms?.clear(AGENT_BRIDGE_ALARM)).catch(() => {});
  };

  const scheduleReconnect = (): void => {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void sync();
    }, RECONNECT_DELAY_MS);
  };

  const connect = (): void => {
    const active = new WebSocket(AGENT_BRIDGE_URL, AGENT_BRIDGE_PROTOCOL);
    socket = active;
    active.onopen = () => {
      if (socket !== active) return;
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
        if (message.command === "tabs") {
          try {
            const result = await listAgentBridgeTabs();
            if (socket === active) send({ type: "response", id: message.id, ok: true, result });
          } catch (error) {
            if (socket === active) {
              send({ type: "response", id: message.id, ok: false, error: (error as Error).message });
            }
          }
          return;
        }
        send({ type: "response", id: message.id, ok: false, error: "不支持的桥接命令" });
      })();
    };
    active.onclose = () => {
      if (socket !== active) return;
      socket = null;
      scheduleReconnect();
    };
    active.onerror = () => {
      if (socket === active) active.close();
    };
  };

  const sync = (): Promise<void> => {
    if (syncTask) {
      syncRequested = true;
      return syncTask;
    }
    syncTask = (async () => {
      do {
        syncRequested = false;
        const enabled = await getEnabled();
        if (!enabled) {
          stop();
          continue;
        }
        void Promise.resolve(chrome.alarms?.create(AGENT_BRIDGE_ALARM, { periodInMinutes: 0.5 })).catch(() => {});
        if (!socket || socket.readyState === WebSocket.CLOSED) connect();
      } while (syncRequested);
    })().finally(() => {
      syncTask = null;
    });
    return syncTask;
  };

  return { sync };
}
