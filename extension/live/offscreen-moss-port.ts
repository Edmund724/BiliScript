// extension/live/offscreen-moss-port.ts
// Offscreen 文档专属 MOSS-LIVE 端口管理状态机。
// 提供代际隔离与释放保护，防止在异步加载客户端模块期间发生 stop/disconnect 导致的套接字泄漏，
// 并负责跨 Port 转发上行 Base64 音频帧、麦克风静音状态、下行双端字幕与工具查询状态。

import {
  decodeBase64Bytes,
  type MossLiveClientAction,
  type MossLiveToolStatusEvent,
  type MossLiveTranscriptEvent
} from "./moss-live-protocol.js";

export interface MossLiveClientInstance {
  connect(): void;
  close(): void;
  sendAudioPcm?(pcmBuffer: ArrayBufferLike): boolean;
  setMicEnabled?(enabled: boolean): void;
}

export type MossLiveClientFactory = (options: {
  wsUrl?: string;
  onConnecting?: () => void;
  onConnected?: () => void;
  onTranscript?: (event: MossLiveTranscriptEvent) => void;
  onToolStatus?: (event: MossLiveToolStatusEvent) => void;
  onError?: (error: Error) => void;
  onClosed?: (event?: { code?: number; reason?: string }) => void;
}) => MossLiveClientInstance;

export interface AttachMossLivePortOptions {
  loadClient: () => Promise<MossLiveClientFactory>;
  postMessage?: (port: chrome.runtime.Port, message: unknown) => void;
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

  function cleanup(): void {
    disposed = true;
    currentGeneration += 1;
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
      currentGeneration += 1;
      const generation = currentGeneration;

      if (liveClient) {
        liveClient.close();
        liveClient = null;
      }

      try {
        const createClient = await loadClient();
        // 守卫 1：await 模块加载后校验代际与注销状态
        if (disposed || generation !== currentGeneration) {
          return;
        }

        const client = createClient({
          wsUrl: msg.wsUrl,
          onConnecting: () => {
            if (!disposed && generation === currentGeneration) {
              postMessage(port, { type: "connecting" });
            }
          },
          onConnected: () => {
            if (!disposed && generation === currentGeneration) {
              postMessage(port, { type: "connected" });
            }
          },
          onTranscript: (event) => {
            if (!disposed && generation === currentGeneration) {
              postMessage(port, { type: "transcript", event });
            }
          },
          onToolStatus: (event) => {
            if (!disposed && generation === currentGeneration) {
              postMessage(port, { type: "tool_status", event });
            }
          },
          onError: (err) => {
            if (!disposed && generation === currentGeneration) {
              postMessage(port, { type: "error", error: err.message });
            }
          },
          onClosed: (ev) => {
            if (!disposed && generation === currentGeneration) {
              postMessage(port, { type: "closed", reason: ev?.reason });
            }
          }
        });

        // 守卫 2：在正式发起 connect 前再次核验代际与注销状态
        if (disposed || generation !== currentGeneration) {
          client.close();
          return;
        }

        liveClient = client;
        client.connect();
      } catch (error) {
        if (!disposed && generation === currentGeneration) {
          postMessage(port, { type: "error", error: (error as Error)?.message || String(error) });
        }
      }
    } else if (msg.action === "audio") {
      if (!liveClient?.sendAudioPcm || !msg.pcmBase64) return;
      const bytes = decodeBase64Bytes(msg.pcmBase64);
      if (bytes.byteLength > 0) {
        liveClient.sendAudioPcm(bytes.buffer);
      }
    } else if (msg.action === "mic_state") {
      liveClient?.setMicEnabled?.(Boolean(msg.enabled));
    } else if (msg.action === "stop") {
      currentGeneration += 1;
      if (liveClient) {
        liveClient.close();
        liveClient = null;
      }
      postMessage(port, { type: "closed" });
    }
  });

  port.onDisconnect.addListener(() => {
    cleanup();
  });

  return { dispose: cleanup };
}
