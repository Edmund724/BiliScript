// extension/live/offscreen-moss-port.ts
// Offscreen 文档专属 MOSS-LIVE 端口懒加载与代际隔离薄壳。
// 在 onConnect 同步挂载端口监听，保证首条 start 消息不丢失，并在异步加载客户端模块期间
// 拦截 stop / disconnect 竞态以防套接字泄漏；具体协议动作与会话状态机全由客户端处理。
//
// 伴看单通道模型：全文档独占一个活跃伴看槽位，跨端口 start 触发前序会话接管。

import type {
  LiveProviderType,
  MossLiveClientAction,
  MossLiveServerEvent,
  MossLiveSessionContext
} from "./moss-live-protocol.js";

export interface MossLiveClientInstance<TAction = MossLiveClientAction> {
  handleAction(action: TAction): void;
  close(): void;
}

export type MossLiveClientFactory<
  TAction = MossLiveClientAction,
  TEvent = MossLiveServerEvent
> = (options: {
  onEvent: (event: TEvent) => void;
}) => MossLiveClientInstance<TAction>;

export type LiveClientProviderType = LiveProviderType;

export interface AttachMossLivePortOptions<
  TAction = MossLiveClientAction,
  TEvent = MossLiveServerEvent
> {
  loadClient: (providerType?: LiveClientProviderType) => Promise<MossLiveClientFactory<TAction, TEvent>>;
  loadGeminiClient?: () => Promise<MossLiveClientFactory<TAction, TEvent>>;
  postMessage?: (port: chrome.runtime.Port, message: unknown) => void;
}

interface ActiveLivePortSession {
  port: chrome.runtime.Port;
  /** 活跃槽位只持有关闭能力：事件转发仍走各端口自己的 onEvent 闭包 */
  client: { close(): void };
  postMessage: (port: chrome.runtime.Port, message: unknown) => void;
}

let activeLiveSession: ActiveLivePortSession | null = null;

export function resetActiveLiveSessionForTests(): void {
  activeLiveSession = null;
}

export function attachMossLivePort<
  TAction = MossLiveClientAction,
  TEvent = MossLiveServerEvent
>(
  port: chrome.runtime.Port,
  options: AttachMossLivePortOptions<TAction, TEvent>
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
  let liveClient: MossLiveClientInstance<TAction> | null = null;
  let latestVideoContext: MossLiveSessionContext | null = null;

  function cleanup(): void {
    disposed = true;
    currentGeneration += 1;
    if (activeLiveSession?.port === port) {
      activeLiveSession = null;
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
      if (activeLiveSession && activeLiveSession.port !== port) {
        const prev = activeLiveSession;
        activeLiveSession = null;
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
        activeLiveSession = { port, client, postMessage };
        client.handleAction({
          action: "start",
          wsUrl: msg.wsUrl,
          ...(msg.providerType !== undefined ? { providerType: msg.providerType } : {}),
          ...(msg.model !== undefined ? { model: msg.model } : {}),
          ...(msg.liveGeminiNativeSearch !== undefined
            ? { liveGeminiNativeSearch: msg.liveGeminiNativeSearch }
            : {}),
          ...(msg.lowBandwidth !== undefined ? { lowBandwidth: msg.lowBandwidth } : {}),
          ...(msg.voiceId !== undefined ? { voiceId: msg.voiceId } : {}),
          ...(msg.volume !== undefined ? { volume: msg.volume } : {}),
          ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
          videoContext: latestVideoContext
        } as unknown as TAction);
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
      if (activeLiveSession?.port === port) {
        activeLiveSession = null;
      }
      if (liveClient) {
        const active = liveClient;
        liveClient = null;
        active.handleAction(msg as unknown as TAction);
        currentGeneration += 1;
      } else {
        currentGeneration += 1;
        postMessage(port, { type: "closed" });
      }
      return;
    }

    liveClient?.handleAction(msg as unknown as TAction);
  });

  port.onDisconnect.addListener(() => {
    cleanup();
  });

  return { dispose: cleanup };
}
