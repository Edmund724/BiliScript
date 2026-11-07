// extension/live/offscreen-moss-port.ts
// Offscreen 文档专属 MOSS-LIVE 端口懒加载与代际隔离薄壳。
// 在 onConnect 同步挂载端口监听，保证首条 start 消息不丢失，并在异步加载客户端模块期间
// 拦截 stop / disconnect 竞态以防套接字泄漏；具体协议动作与会话状态机全由 OffscreenMossLiveClient 处理。

import type {
  LiveProviderType,
  MossLiveClientAction,
  MossLiveServerEvent,
  MossLiveVideoContext
} from "./moss-live-protocol.js";

export interface MossLiveClientInstance {
  handleAction(action: MossLiveClientAction): void;
  close(): void;
}

export type MossLiveClientFactory = (options: {
  onEvent: (event: MossLiveServerEvent) => void;
}) => MossLiveClientInstance;

export type LiveClientProviderType = LiveProviderType;

export interface AttachMossLivePortOptions {
  loadClient: (providerType?: LiveClientProviderType) => Promise<MossLiveClientFactory>;
  loadGeminiClient?: () => Promise<MossLiveClientFactory>;
  postMessage?: (port: chrome.runtime.Port, message: unknown) => void;
}

interface ActiveLivePortSession {
  port: chrome.runtime.Port;
  client: MossLiveClientInstance;
  postMessage: (port: chrome.runtime.Port, message: unknown) => void;
}

let activeGlobalLiveSession: ActiveLivePortSession | null = null;

export function resetActiveLiveSessionForTests(): void {
  activeGlobalLiveSession = null;
}

export function attachMossLivePort(
  port: chrome.runtime.Port,
  options: AttachMossLivePortOptions
): { dispose: () => void } {
  const {
    loadClient,
    postMessage = (p, m) => {
      try {
        p.postMessage(m);
      } catch {
        // 忽略端口断开时的发送失败
      }
    }
  } = options;

  let disposed = false;
  let currentGeneration = 0;
  let liveClient: MossLiveClientInstance | null = null;
  let latestVideoContext: MossLiveVideoContext | null = null;

  function cleanup(): void {
    disposed = true;
    currentGeneration += 1;
    if (activeGlobalLiveSession?.port === port) {
      activeGlobalLiveSession = null;
    }
    if (liveClient) {
      try {
        liveClient.close();
      } catch {
        // 忽略关闭异常
      }
      liveClient = null;
    }
  }

  port.onMessage.addListener(async (rawMsg: unknown) => {
    if (disposed) return;
    const msg = rawMsg as MossLiveClientAction;
    if (!msg) return;

    if (msg.action === "start") {
      if (activeGlobalLiveSession && activeGlobalLiveSession.port !== port) {
        const prev = activeGlobalLiveSession;
        activeGlobalLiveSession = null;
        try {
          prev.postMessage(prev.port, { type: "closed", reason: "takeover" });
        } catch {}
        try {
          prev.client.close();
        } catch {}
      }
      if (liveClient) {
        const previous = liveClient;
        liveClient = null;
        previous.close();
      }
      currentGeneration += 1;
      const generation = currentGeneration;
      latestVideoContext = msg.videoContext || null;
      const providerType: LiveClientProviderType =
        msg.providerType === "gemini-live" ? "gemini-live" : "moss-live";

      try {
        const createClient =
          providerType === "gemini-live" && options.loadGeminiClient
            ? await options.loadGeminiClient()
            : await loadClient(providerType);
        if (disposed || generation !== currentGeneration) {
          return;
        }

        const client = createClient({
          onEvent: (event) => {
            if (!disposed && generation === currentGeneration) {
              postMessage(port, event);
            }
          }
        });

        if (disposed || generation !== currentGeneration) {
          client.close();
          return;
        }

        liveClient = client;
        activeGlobalLiveSession = { port, client, postMessage };
        client.handleAction({
          action: "start",
          wsUrl: msg.wsUrl,
          ...(msg.providerType !== undefined ? { providerType: msg.providerType } : {}),
          ...(msg.model !== undefined ? { model: msg.model } : {}),
          ...(msg.liveGeminiNativeSearch !== undefined
            ? { liveGeminiNativeSearch: msg.liveGeminiNativeSearch }
            : {}),
          ...(msg.volume !== undefined ? { volume: msg.volume } : {}),
          ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
          videoContext: latestVideoContext
        });
      } catch (error) {
        if (!disposed && generation === currentGeneration) {
          postMessage(port, {
            type: "error",
            error: (error as Error)?.message || String(error)
          });
        }
      }
      return;
    }

    if (msg.action === "context_update") {
      latestVideoContext = msg.videoContext;
    }

    if (msg.action === "stop") {
      if (activeGlobalLiveSession?.port === port) {
        activeGlobalLiveSession = null;
      }
      if (liveClient) {
        const active = liveClient;
        liveClient = null;
        active.handleAction(msg);
        currentGeneration += 1;
      } else {
        currentGeneration += 1;
        postMessage(port, { type: "closed" });
      }
      return;
    }

    liveClient?.handleAction(msg);
  });

  port.onDisconnect.addListener(() => {
    cleanup();
  });

  return { dispose: cleanup };
}
