import { consumeRuntimeLastError } from "../shared/messaging.js";
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
  postMessage?: (port: chrome.runtime.Port, message: unknown) => void;
}

interface ActiveLivePortSession {
  port: chrome.runtime.Port;
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
        const createClient = await loadClient(providerType);
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
          ...msg,
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
    consumeRuntimeLastError();
    cleanup();
  });

  return { dispose: cleanup };
}
