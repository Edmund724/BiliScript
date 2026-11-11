import { extractBvid, extractPageIndex } from "../bilibili/video-id-shared.js";
import type { AgentBridgeFrameResponse, AgentBridgeSnapshotResponse, AgentBridgeSubtitlesResponse } from "../shared/messaging-protocol.js";
import { handleAsrDecodeCleanup, handleVideoFramePrepare } from "../asr/offscreen-bridge.bg.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { createAgentBridgeVideoService } from "./video-service.js";
import {
  AGENT_BRIDGE_ALARM,
  AGENT_BRIDGE_FRAME_TASK_PREPARE,
  AGENT_BRIDGE_PROTOCOL,
  AGENT_BRIDGE_URL,
  type AgentBridgeContentSubtitlesResult,
  type AgentBridgeFramesResult,
  type AgentBridgeOffscreenFrameResponse,
  type AgentBridgeRequestOptions,
  type AgentBridgeTabSnapshot,
  type AgentBridgeTabsResult
} from "./protocol.js";

const RECONNECT_DELAY_MS = 1000;
const TAB_SNAPSHOT_TIMEOUT_MS = 2000;
const VIDEO_URL_PATTERNS = [
  "https://www.bilibili.com/video/*",
  "https://www.bilibili.com/list/watchlater",
  "https://www.bilibili.com/list/watchlater/*"
];

interface AgentBridgeDeps {
  getEnabled: () => Promise<boolean>;
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
  const tabs = await chrome.tabs.query({ url: VIDEO_URL_PATTERNS });
  return { tabs: await Promise.all(tabs.filter((tab) => tab.id).map(readTabSnapshot)) };
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

function requestContentSubtitles(tabId: number): Promise<AgentBridgeContentSubtitlesResult | null> {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "agent-bridge-subtitles" }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        const result = response as AgentBridgeSubtitlesResponse | undefined;
        if (!result) {
          resolve(null);
          return;
        }
        if (!result.ok || !result.result) {
          reject(new Error(result?.error || "页内字幕抓取失败"));
          return;
        }
        resolve(result.result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function requestContentFrames(
  tabId: number,
  input: { bvid: string; cid: string; targetTime?: number }
): Promise<AgentBridgeFramesResult | null> {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "agent-bridge-frame", ...input }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        const result = response as AgentBridgeFrameResponse | undefined;
        if (!result) {
          resolve(null);
          return;
        }
        if (!result.ok || !result.result) {
          reject(new Error(result?.error || "页内视频截帧失败"));
          return;
        }
        resolve(result.result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function prepareVideoFrameTask(): Promise<number> {
  return new Promise((resolve, reject) => {
    void handleVideoFramePrepare({ taskType: AGENT_BRIDGE_FRAME_TASK_PREPARE }, {}, (result) => {
      if (!result.ok || !result.ruleId) {
        reject(new Error(result.error || "后台截帧准备失败"));
        return;
      }
      resolve(result.ruleId);
    });
  });
}

function cleanupVideoFrameTask(ruleId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    void handleAsrDecodeCleanup({ ruleId }, {}, (result) => {
      if (!result.ok) {
        reject(new Error(result.error || "后台截帧规则清理失败"));
        return;
      }
      resolve();
    });
  });
}

async function captureOffscreenFrames(input: { bvid: string; cid: string; targetTime: number }): Promise<AgentBridgeFramesResult> {
  const ruleId = await prepareVideoFrameTask();
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
  } finally {
    await cleanupVideoFrameTask(ruleId);
  }
}

export function createAgentBridge({ getEnabled, videoService = createAgentBridgeVideoService() }: AgentBridgeDeps) {
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let syncTask: Promise<void> | null = null;
  let syncRequested = false;

  const send = (message: unknown): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const captureFrames = async (options: unknown): Promise<AgentBridgeFramesResult> => {
    const target = await resolveTarget(options);
    if (target.targetTime === undefined) {
      if (!target.tabId) {
        throw new Error("目标视频未在标签页中打开；未打开视频请使用 --time <sec> 截取历史帧");
      }
      const result = await requestContentFrames(target.tabId, {
        bvid: target.bvid,
        cid: target.cid || ""
      });
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
      const result = await requestContentFrames(contextTabId, input);
      if (result) return result;
    }
    return captureOffscreenFrames(input);
  };

  const execute = async (command: unknown, options: unknown): Promise<unknown> => {
    if (command === "tabs") return listAgentBridgeTabs();
    if (command === "frame") return captureFrames(options);
    if (command !== "subtitles" && command !== "comments") throw new Error("不支持的桥接命令");
    const target = await resolveTarget(options);
    if (command === "comments") return videoService.getComments(target);
    if (target.tabId) {
      const content = await requestContentSubtitles(target.tabId);
      if (content) return videoService.completeContentSubtitles(target, content);
    }
    return videoService.getSubtitles(target);
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
        try {
          const result = await execute(message.command, message.options);
          if (socket === active) send({ type: "response", id: message.id, ok: true, result });
        } catch (error) {
          if (socket === active) {
            send({ type: "response", id: message.id, ok: false, error: (error as Error).message });
          }
        }
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
