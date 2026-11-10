// extension/live/offscreen-interpret-client.ts
// 运行在 Offscreen Document 中的同声传译会话独立 runtime（ADR-0023：WebSocket 仍在
// offscreen）。与伴看 OffscreenLiveSessionRuntime 并列但不复用：不持有
// MossAudioPlayer、不执行页面工具与委派；下行二进制译文语音一律丢弃，
// 只把文本事件（input/output transcript、response.ended、session.closing、error）
// 经端口转发给页面侧字幕归并器。
// 握手：attach_session → media.mode(tagged-v1) → media.configure(playback=server,
// 上行 PCM16 16kHz)。关闭码 1013（并发满 / 服务端排空）如实上报为可识别错误，
// 不自动重试；其余断线沿用伴看的重连上限。服务端 error 事件与伴看的
// failOrReconnectOnServerError 有意不同：同传是手动开启的辅助会话，错误如实
// 上报并判失败，不做静默重连。

import {
  DEFAULT_LIVE_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_MOSS_RECONNECT_DELAY_MS,
  MAX_MOSS_RECONNECT_ATTEMPTS,
  MossBinaryTag,
  decodeBase64Bytes,
  packTaggedBinary
} from "./moss-live-protocol.js";
import {
  MOSS_INTERPRET_CLOSE_CODE_SESSION_LIMIT,
  buildMossInterpretMediaConfigurePayload,
  parseMossInterpretServerJsonEvent,
  resolveMossInterpretWsUrl,
  type MossInterpretClientAction,
  type MossInterpretServerEvent
} from "./moss-interpret-protocol.js";

export type InterpretClientState = "idle" | "connecting" | "connected" | "closed" | "failed";

export interface OffscreenInterpretClientOptions {
  wsUrl?: string;
  sessionId?: string | null;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  handshakeTimeoutMs?: number;
  onEvent?: (event: MossInterpretServerEvent) => void;
}

export class OffscreenInterpretClient {
  private ws: WebSocket | null = null;
  private state: InterpretClientState = "idle";
  private disposed = false;
  private socketGeneration = 0;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private wsUrl: string;
  private sessionId: string | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelayMs: number;
  private readonly handshakeTimeoutMs: number;
  private lastSocketError = "";
  private readonly options: OffscreenInterpretClientOptions;

  constructor(options: OffscreenInterpretClientOptions = {}) {
    this.options = options;
    this.wsUrl = options.wsUrl || resolveMossInterpretWsUrl();
    this.sessionId = options.sessionId || null;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? MAX_MOSS_RECONNECT_ATTEMPTS;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_MOSS_RECONNECT_DELAY_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_LIVE_HANDSHAKE_TIMEOUT_MS;
  }

  getState(): InterpretClientState {
    return this.state;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  private emit(event: MossInterpretServerEvent): void {
    this.options.onEvent?.(event);
  }

  handleAction(msg: MossInterpretClientAction): void {
    switch (msg.action) {
      case "start":
        if (msg.wsUrl !== undefined) {
          this.wsUrl = msg.wsUrl || resolveMossInterpretWsUrl();
        }
        if (msg.sessionId !== undefined) {
          this.sessionId = msg.sessionId || null;
        }
        this.connect();
        break;

      case "audio": {
        // 页面侧持续推送 20ms 帧（静音也推）；未连接时直接丢弃，不排队。
        if (!msg.pcmBase64 || this.state !== "connected") break;
        const bytes = decodeBase64Bytes(msg.pcmBase64);
        if (bytes.byteLength > 0) {
          this.sendBinary(packTaggedBinary(MossBinaryTag.AudioPcm, bytes.buffer));
        }
        break;
      }

      case "stop":
        this.sessionId = null;
        this.reconnectAttempts = 0;
        this.clearReconnectTimer();
        this.close();
        this.emit({ type: "closed" });
        break;
    }
  }

  connect(): void {
    this.clearReconnectTimer();
    if (this.state === "connecting" || this.state === "connected") {
      this.closeSocket();
    }
    this.disposed = false;
    this.state = "connecting";
    this.socketGeneration += 1;
    const generation = this.socketGeneration;
    this.clearHandshakeTimer();

    this.emit({ type: "connecting" });

    if (this.handshakeTimeoutMs > 0) {
      this.handshakeTimer = setTimeout(() => {
        if (this.disposed || this.socketGeneration !== generation) return;
        if (this.state === "connecting") {
          this.fail(new Error("同声传译会话附着握手超时：未在规定时间内收到 session_attached"));
        }
      }, this.handshakeTimeoutMs);
    }

    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => {
        if (this.disposed || this.socketGeneration !== generation) return;
        const payload: Record<string, unknown> = {
          type: "attach_session",
          memory_scope: "session",
          delegation: { type: "client" }
        };
        if (this.sessionId) {
          payload.session_id = this.sessionId;
        }
        this.sendJson(payload);
      };

      this.ws.onmessage = (event) => {
        if (this.disposed || this.socketGeneration !== generation) return;
        this.handleIncomingData(event.data);
      };

      this.ws.onerror = () => {
        if (this.disposed || this.socketGeneration !== generation) return;
        this.clearHandshakeTimer();
        this.lastSocketError = "WebSocket 连接失败或握手鉴权被拒绝";
        if (!this.sessionId) {
          this.fail(new Error("WebSocket 连接失败或握手鉴权被拒绝"));
        }
      };

      this.ws.onclose = (event) => {
        if (
          this.disposed ||
          this.socketGeneration !== generation ||
          this.state === "failed"
        ) {
          return;
        }
        this.handleConnectionDrop(event.code, event.reason, null, generation);
      };
    } catch (error) {
      this.clearHandshakeTimer();
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleIncomingData(data: unknown): void {
    if (typeof data === "string") {
      let message: unknown;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      this.handleServerJson(message);
      return;
    }
    // 下行二进制为译文语音：同传只用文本，丢弃，不排队不播放。
  }

  private handleServerJson(rawMessage: unknown): void {
    const parsed = parseMossInterpretServerJsonEvent(rawMessage);
    if (!parsed) return;

    switch (parsed.kind) {
      case "session_attached": {
        this.sendJson({ action: "media.mode", binary_protocol: "tagged-v1" });
        this.sendJson(buildMossInterpretMediaConfigurePayload());
        this.clearHandshakeTimer();
        if (parsed.sessionId) {
          this.sessionId = parsed.sessionId;
        }
        this.reconnectAttempts = 0;
        this.state = "connected";
        if (parsed.sessionId) {
          this.emit({ type: "session_attached", sessionId: parsed.sessionId });
        }
        this.emit({ type: "connected", sessionId: this.sessionId || undefined });
        break;
      }

      case "transcript":
        this.emit({ type: "transcript", event: parsed.event });
        break;

      case "session_closing":
        this.emit({ type: "session_closing", reason: parsed.reason || undefined });
        break;

      case "error": {
        this.fail(new Error(parsed.message), parsed.code || undefined);
        break;
      }
    }
  }

  private handleConnectionDrop(
    code: number,
    reason: string,
    error: Error | null,
    generation: number
  ): void {
    if (this.disposed || this.socketGeneration !== generation) return;
    this.clearHandshakeTimer();
    const wasConnected = this.state === "connected";
    const errorText = error?.message || this.lastSocketError || "";
    this.lastSocketError = "";

    if (code === 1000) {
      this.state = "closed";
      this.sessionId = null;
      this.reconnectAttempts = 0;
      this.closeSocket();
      this.emit({ type: "closed", code, reason });
      return;
    }

    // 并发满 / 服务端排空（1013）：如实上报为带原因的可识别错误，不自动重试。
    if (code === MOSS_INTERPRET_CLOSE_CODE_SESSION_LIMIT) {
      this.reconnectAttempts = 0;
      this.closeSocket();
      const detail = reason?.trim() ? `，原因: ${reason.trim()}` : "";
      this.fail(
        new Error(`同声传译连接被服务端关闭（关闭码: ${code}${detail}）`),
        code,
        reason
      );
      return;
    }

    if (this.sessionId && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts += 1;
      const attempt = this.reconnectAttempts;
      const maxAttempts = this.maxReconnectAttempts;
      this.closeSocket();
      this.state = "connecting";
      this.emit({
        type: "reconnecting",
        attempt,
        maxAttempts,
        code,
        reason,
        error: errorText || undefined
      });
      if (this.reconnectDelayMs > 0) {
        this.reconnectTimer = setTimeout(() => {
          if (this.disposed) return;
          this.connect();
        }, this.reconnectDelayMs);
      } else {
        this.connect();
      }
      return;
    }

    const exhausted = Boolean(
      this.sessionId && this.reconnectAttempts >= this.maxReconnectAttempts
    );
    this.reconnectAttempts = 0;
    this.closeSocket();

    const exhaustedMsg = `已达最大重连次数 (${this.maxReconnectAttempts} 次)`;
    const finalDetail = exhausted
      ? errorText
        ? `${errorText}，${exhaustedMsg}`
        : exhaustedMsg
      : errorText;

    if (wasConnected || exhausted) {
      this.state = "closed";
      this.emit({
        type: "closed",
        code,
        reason,
        error: finalDetail || undefined
      });
    } else {
      this.state = "failed";
      const failureMsg = errorText
        ? `WebSocket 连接失败：${errorText} (${code}: ${reason || "握手未完成"})`
        : `WebSocket 连接关闭 (${code}: ${reason || "握手未完成"})`;
      this.emit({
        type: "error",
        error: failureMsg,
        code,
        reason
      });
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocket(): void {
    this.clearHandshakeTimer();
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

  private fail(error: Error, code?: number | string, reason?: string): void {
    this.clearHandshakeTimer();
    this.clearReconnectTimer();
    this.state = "failed";
    this.socketGeneration += 1;
    this.closeSocket();
    this.emit({ type: "error", error: error.message, code, reason });
  }

  close(): void {
    this.disposed = true;
    this.sessionId = null;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.socketGeneration += 1;
    this.clearHandshakeTimer();
    this.state = "idle";
    this.closeSocket();
  }

  private sendJson(payload: unknown): boolean {
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

  private sendBinary(frame: Uint8Array<ArrayBuffer>): boolean {
    if (this.disposed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(frame as unknown as Parameters<WebSocket["send"]>[0]);
      return true;
    } catch {
      return false;
    }
  }
}
