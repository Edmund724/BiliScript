// extension/live/offscreen-moss-client.ts
// 运行在 Offscreen Document 中的 MOSS-LIVE WebSocket 客户端。
// 持有与 wss://api.mosi.cn/v1/realtime 的真实 WebSocket 连接。
// 严禁在 MV3 service worker 或 Bilibili content script 中实例化。

import {
  DEFAULT_MOSS_LIVE_WS_URL,
  MossBinaryTag,
  buildMinimalSessionUpdatePayload,
  packTaggedBinary
} from "./moss-live-protocol.js";

export type MossLiveClientState = "idle" | "connecting" | "connected" | "closed" | "failed";

export const DEFAULT_MOSS_HANDSHAKE_TIMEOUT_MS = 10000;

export interface OffscreenMossClientOptions {
  wsUrl?: string;
  handshakeTimeoutMs?: number;
  onConnecting?: () => void;
  onConnected?: () => void;
  onError?: (error: Error) => void;
  onClosed?: (event?: { code?: number; reason?: string }) => void;
}

export class OffscreenMossLiveClient {
  private ws: WebSocket | null = null;
  private state: MossLiveClientState = "idle";
  private disposed = false;
  private socketGeneration = 0;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly wsUrl: string;
  private readonly handshakeTimeoutMs: number;
  private readonly options: OffscreenMossClientOptions;

  constructor(options: OffscreenMossClientOptions = {}) {
    this.options = options;
    this.wsUrl = options.wsUrl || DEFAULT_MOSS_LIVE_WS_URL;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_MOSS_HANDSHAKE_TIMEOUT_MS;
  }

  getState(): MossLiveClientState {
    return this.state;
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  connect(): void {
    if (this.state === "connecting" || this.state === "connected") {
      this.close();
    }
    this.disposed = false;
    this.state = "connecting";
    this.socketGeneration += 1;
    const currentGeneration = this.socketGeneration;
    this.clearHandshakeTimer();

    this.options.onConnecting?.();

    if (this.handshakeTimeoutMs > 0) {
      this.handshakeTimer = setTimeout(() => {
        if (this.disposed || this.socketGeneration !== currentGeneration) {
          return;
        }
        if (this.state === "connecting") {
          this.fail(new Error("MOSS-LIVE 会话附着握手超时：未在规定时间内收到 session_attached"));
        }
      }, this.handshakeTimeoutMs);
    }

    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => {
        if (this.disposed || this.socketGeneration !== currentGeneration) return;
        // 握手连接打开后，上报附着会话请求；注意此时尚未收到 session_attached，仍处于 connecting 态
        this.sendJson({ action: "attach_session", memory_scope: "session" });
      };

      this.ws.onmessage = (event) => {
        if (this.disposed || this.socketGeneration !== currentGeneration) return;
        if (typeof event.data === "string") {
          let message: any;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          this.handleServerJson(message, currentGeneration);
        }
      };

      this.ws.onerror = () => {
        if (this.disposed || this.socketGeneration !== currentGeneration) return;
        this.clearHandshakeTimer();
        this.fail(new Error("WebSocket 连接失败或握手鉴权被拒绝"));
      };

      this.ws.onclose = (event) => {
        if (this.disposed || this.socketGeneration !== currentGeneration || this.state === "failed") return;
        this.clearHandshakeTimer();
        if (this.state === "connecting") {
          this.fail(new Error(`WebSocket 连接关闭 (${event.code}: ${event.reason || "握手未完成"})`));
        } else {
          this.state = "closed";
          this.options.onClosed?.({ code: event.code, reason: event.reason });
        }
      };
    } catch (error) {
      this.clearHandshakeTimer();
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleServerJson(message: any, generation: number): void {
    if (this.disposed || this.socketGeneration !== generation) return;
    const action = String(message?.action || "").trim();
    switch (action) {
      case "session_attached":
        // 收到会话附着成功事件后，才确认为 connected 状态并清除超时计时器
        this.clearHandshakeTimer();
        this.state = "connected";
        this.sendJson({ action: "media.mode", binary_protocol: "tagged-v1" });
        this.sendJson(buildMinimalSessionUpdatePayload());
        this.options.onConnected?.();
        break;

      case "session.updated":
        // 协议已核实约束：session.updated 的 data.error 非空表示配置失败
        if (message?.data?.error) {
          this.clearHandshakeTimer();
          this.fail(new Error(`MOSS-LIVE 会话配置失败：${message.data.error}`));
        }
        break;

      case "error":
        this.clearHandshakeTimer();
        this.fail(new Error(message?.message || message?.error || "MOSS-LIVE 服务端拒绝"));
        break;

      default:
        // 忽略其他后续工单消息
        break;
    }
  }

  private fail(error: Error): void {
    this.clearHandshakeTimer();
    this.state = "failed";
    this.socketGeneration += 1;
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {}
    }
    this.options.onError?.(error);
  }

  close(): void {
    // 设置已释放标志，立即清除超时计时器并忽略随后到来的网络晚到事件
    this.disposed = true;
    this.socketGeneration += 1;
    this.clearHandshakeTimer();
    this.state = "idle";
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {}
    }
  }

  sendJson(payload: unknown): boolean {
    if (this.disposed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  sendBinary(tag: MossBinaryTag, payload: ArrayBuffer): boolean {
    if (this.disposed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      const frame = packTaggedBinary(tag, payload);
      this.ws.send(frame as unknown as Parameters<WebSocket["send"]>[0]);
      return true;
    } catch {
      return false;
    }
  }
}
