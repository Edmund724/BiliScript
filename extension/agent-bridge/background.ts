import { extractBvid, extractPageIndex } from "../bilibili/video-id-shared.js";
import type { ContentScriptMessage, ResponseOf } from "../shared/messaging-protocol.js";
import { withBiliMediaSessionRule } from "../core/offscreen-host.js";
import { getErrorMessage, withTimeout } from "../shared/error-helpers.js";
import { sendMessageToTab } from "../shared/tab-utils.js";
import { createAgentBridgeVideoService } from "./video-service.js";
import { normalizeAgentBridgeUrl, parseAgentBridgeUrl } from "../core/validators.js";
import {
  AGENT_BRIDGE_ALARM,
  AGENT_BRIDGE_PROTOCOL,
  type AgentBridgeFramesResult,
  type AgentBridgeOffscreenFrameResponse,
  type AgentBridgeRequestOptions,
  type AgentBridgeTabSnapshot,
  type AgentBridgeTabsResult
} from "./protocol.js";

const RECONNECT_BACKOFF_DELAYS_MS = [1000, 2000, 4000, 8000] as const;
const TAB_SNAPSHOT_TIMEOUT_MS = 2000;
const VIDEO_URL_PATTERNS = [
  "https://www.bilibili.com/video/*",
  "https://www.bilibili.com/list/*",
  "https://www.bilibili.com/festival/*"
];

interface AgentBridgeDeps {
  getConfig: () => Promise<{ enabled: boolean; url: string }>;
  videoService?: ReturnType<typeof createAgentBridgeVideoService>;
}

interface WireRequest {
  type?: unknown;
  id?: unknown;
  command?: unknown;
  options?: unknown;
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
  const response = await withTimeout(
    sendMessageToTab(tab.id, { type: "agent-bridge-snapshot" }).catch(() => undefined),
    TAB_SNAPSHOT_TIMEOUT_MS
  );
  const snapshot = response?.ok && response.snapshot ? response.snapshot : null;
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
  const [tabs, activeTabs] = await Promise.all([
    chrome.tabs.query({ url: VIDEO_URL_PATTERNS }),
    chrome.tabs.query({ active: true, currentWindow: true, url: VIDEO_URL_PATTERNS }).catch(() => [] as chrome.tabs.Tab[])
  ]);
  const activeTabId = activeTabs.find((tab) => tab.id && tab.active === true)?.id;
  return {
    tabs: await Promise.all(
      tabs.filter((tab) => tab.id).map(async (tab) => {
        const snapshot = await readTabSnapshot(tab);
        return tab.id === activeTabId ? { ...snapshot, active: true } : snapshot;
      })
    )
  };
}

interface ResolvedTarget extends AgentBridgeRequestOptions {
  bvid: string;
  pageIndex: number;
  cid?: string;
  tabId?: number;
}

function parseBvidInput(value: unknown): { bvid: string; pageIndex: number } {
  const input = String(value || "").trim();
  const bvid = /^BV[0-9A-Za-z]+$/.test(input) ? input : extractBvid(input);
  if (!bvid) throw new Error("请传入有效的 BV 号或 B 站视频链接");
  return { bvid, pageIndex: extractPageIndex(input) };
}

async function snapshotTarget(tab: chrome.tabs.Tab): Promise<ResolvedTarget> {
  const snapshot = await readTabSnapshot(tab);
  if (!snapshot.bvid) throw new Error("目标标签页不是 B 站视频页");
  return {
    bvid: snapshot.bvid,
    pageIndex: extractPageIndex(tab.url || ""),
    cid: snapshot.cid || undefined,
    tabId: snapshot.tabId
  };
}

async function resolveTarget(rawOptions: unknown): Promise<ResolvedTarget> {
  const options = (rawOptions && typeof rawOptions === "object" ? rawOptions : {}) as AgentBridgeRequestOptions;
  let target: ResolvedTarget;
  if (options.tabId !== undefined) {
    const tabId = Number(options.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) throw new Error("--tab 必须是正整数标签页 ID");
    target = await snapshotTarget(await chrome.tabs.get(tabId));
  } else if (String(options.bvid || "").trim()) {
    const parsed = parseBvidInput(options.bvid);
    const tabs = await chrome.tabs.query({ url: VIDEO_URL_PATTERNS });
    const match = tabs.find((tab) => extractBvid(tab.url || "") === parsed.bvid
      && extractPageIndex(tab.url || "") === parsed.pageIndex);
    target = match?.id ? { ...parsed, ...(await snapshotTarget(match)) } : parsed;
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true, url: VIDEO_URL_PATTERNS });
    if (!tab) throw new Error("当前活动标签页不是 B 站视频页，请使用 --tab 或 --bvid 指定目标");
    target = await snapshotTarget(tab);
  }
  return { ...target, from: options.from, to: options.to, targetTime: options.targetTime };
}

type AgentBridgeTabResultMessage = Extract<
  ContentScriptMessage,
  { type: "agent-bridge-subtitles" | "agent-bridge-frame" }
>;

async function requestTabResult<M extends AgentBridgeTabResultMessage>(
  tabId: number,
  message: M,
  fallbackError: string
): Promise<NonNullable<ResponseOf<M>["result"]> | null> {
  let response: ResponseOf<M> | undefined;
  try {
    response = await sendMessageToTab(tabId, message);
  } catch {
    return null;
  }
  if (!response) {
    return null;
  }
  if (!response.ok || !response.result) {
    throw new Error(response.error || fallbackError);
  }
  return response.result as NonNullable<ResponseOf<M>["result"]>;
}

async function captureOffscreenFrames(input: { bvid: string; cid: string; targetTime: number }): Promise<AgentBridgeFramesResult> {
  return withBiliMediaSessionRule("video-media", async () => {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "agent-bridge-offscreen-frame",
        ...input
      }) as AgentBridgeOffscreenFrameResponse | undefined;
      if (!response?.ok || !response.result) {
        throw new Error(response?.error || "Offscreen 文档未完成视频截帧");
      }
      return response.result;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  });
}

const CONNECTION_TIMEOUT_MS = 3000;

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
        try { active.close(); } catch {}
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

export function createAgentBridge({ getConfig, videoService = createAgentBridgeVideoService() }: AgentBridgeDeps) {
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

  const captureFrames = async (options: unknown): Promise<AgentBridgeFramesResult> => {
    const target = await resolveTarget(options);
    if (target.targetTime === undefined) {
      if (!target.tabId) {
        throw new Error("目标视频未在标签页中打开；未打开视频请使用 --time <sec> 截取历史帧");
      }
      const result = await requestTabResult(
        target.tabId,
        { type: "agent-bridge-frame", bvid: target.bvid, cid: target.cid || "" },
        "页内视频截帧失败"
      );
      if (!result) throw new Error("目标标签页尚未加载扩展，请刷新页面后重试当前帧截取");
      return result;
    }

    const targetTime = Number(target.targetTime);
    if (!Number.isFinite(targetTime) || targetTime < 0) {
      throw new Error("--time 必须是大于或等于 0 的有限秒数");
    }
    const cid = target.cid || (await videoService.resolveVideoInfo(target)).cid;
    const input = { bvid: target.bvid, cid, targetTime };
    let contextTabId = target.tabId;
    if (!contextTabId) {
      const tabs = await chrome.tabs.query({ url: VIDEO_URL_PATTERNS });
      contextTabId = tabs.find((tab) => tab.id)?.id;
    }
    if (contextTabId) {
      const result = await requestTabResult(
        contextTabId,
        { type: "agent-bridge-frame", ...input },
        "页内视频截帧失败"
      );
      if (result) return result;
    }
    return captureOffscreenFrames(input);
  };

  const execute = async (command: unknown, options: unknown): Promise<unknown> => {
    if (command === "tabs") return listAgentBridgeTabs();
    if (command === "frame") return captureFrames(options);
    if (command !== "fetch" && command !== "subtitles" && command !== "comments") {
      throw new Error("不支持的桥接命令");
    }
    const target = await resolveTarget(options);
    if (command === "comments") return videoService.getComments(target);
    if (command === "fetch") {
      return videoService.getVideoBundle(
        target,
        target.tabId
          ? () => requestTabResult(target.tabId!, { type: "agent-bridge-subtitles" }, "页内字幕抓取失败")
          : undefined
      );
    }
    if (target.tabId) {
      const content = await requestTabResult(target.tabId, { type: "agent-bridge-subtitles" }, "页内字幕抓取失败");
      if (content) return videoService.completeContentSubtitles(target, content);
    }
    return videoService.getSubtitles(target);
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
      try { active.close(); } catch {}
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
          const result = await execute(message.command, message.options);
          if (socket === active) send({ type: "response", id: message.id, ok: true, result });
        } catch (error) {
          if (socket === active) send({ type: "response", id: message.id, ok: false, error: (error as Error).message });
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
