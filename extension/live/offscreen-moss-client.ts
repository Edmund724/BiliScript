// extension/live/offscreen-moss-client.ts
// 运行在 Offscreen Document 中的 MOSS-LIVE 协议适配器与客户端预设壳。
// 会话状态机、重连、工具超时与音频播放协调由 OffscreenLiveSessionRuntime 统一承载；
// 本文件仅负责 MOSS-LIVE (wss://api.mosi.cn/v1/realtime) 的 tagged-v1 二进制帧与 JSON 握手协议映射。

import {
  DEFAULT_LIVE_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_LIVE_OVERVIEW_TOOL_TIMEOUT_MS,
  DEFAULT_LIVE_PAGE_TOOL_TIMEOUT_MS,
  OffscreenLiveSessionRuntime,
  executeLiveWebSearch,
  type AudioBufferLike,
  type AudioBufferSourceNodeLike,
  type AudioContextLike,
  type LiveSessionClientState,
  type LiveWebSearchExecutor,
  type LiveWebSearchOutcome,
  type LiveWireProtocolAdapter,
  type LiveWireRuntimeCallbacks,
  type LiveWireSocketOpenContext,
  type LiveWireTransport,
  type OffscreenLiveSessionRuntimeOptions
} from "./offscreen-live-session-runtime.js";
import {
  DEFAULT_MOSS_LIVE_WS_URL,
  MossBinaryTag,
  buildMinimalSessionUpdatePayload,
  packTaggedBinary,
  parseMossServerJsonEvent,
  type MossLiveClientAction,
  type MossLiveSessionContext
} from "./moss-live-protocol.js";

export type {
  AudioBufferLike,
  AudioBufferSourceNodeLike,
  AudioContextLike,
  LiveWebSearchExecutor,
  LiveWebSearchOutcome
};
export { executeLiveWebSearch };

export type MossLiveClientState = LiveSessionClientState;

export const DEFAULT_MOSS_HANDSHAKE_TIMEOUT_MS = DEFAULT_LIVE_HANDSHAKE_TIMEOUT_MS;
export const DEFAULT_MOSS_PAGE_TOOL_TIMEOUT_MS = DEFAULT_LIVE_PAGE_TOOL_TIMEOUT_MS;
export const DEFAULT_MOSS_OVERVIEW_TOOL_TIMEOUT_MS = DEFAULT_LIVE_OVERVIEW_TOOL_TIMEOUT_MS;

export type OffscreenMossClientOptions = OffscreenLiveSessionRuntimeOptions;

function extractMossSearchQuery(argumentsText: string): string {
  try {
    const args = JSON.parse(argumentsText) as { query?: unknown };
    return typeof args?.query === "string" ? args.query.trim() : "";
  } catch {
    return "";
  }
}

export class MossWireAdapter implements LiveWireProtocolAdapter {
  readonly defaultWsUrl = DEFAULT_MOSS_LIVE_WS_URL;
  readonly handshakeTimeoutMessage =
    "MOSS-LIVE 会话附着握手超时：未在规定时间内收到 session_attached";
  readonly enablePlaybackReceipts = true;

  private mediaStreamsInitialized = false;
  private latestVideoJpeg: ArrayBufferLike | null = null;
  private readonly activeDelegationIds = new Set<string>();
  private delegationVideoKey = "";

  onConnectReset(): void {
    this.mediaStreamsInitialized = false;
    this.latestVideoJpeg = null;
    this.activeDelegationIds.clear();
  }

  onResetPlayback(): void {
    this.latestVideoJpeg = null;
    this.activeDelegationIds.clear();
  }

  onSocketOpen(context: LiveWireSocketOpenContext): void {
    const videoContext = context.videoContext;
    this.delegationVideoKey = videoContext && !("kind" in videoContext)
      ? `${videoContext.bvid}:${videoContext.cid}:${videoContext.pageIndex}`
      : "";
    const payload: Record<string, unknown> = {
      type: "attach_session",
      memory_scope: "session",
      delegation: { type: "client" }
    };
    if (context.sessionId) {
      payload.session_id = context.sessionId;
    }
    context.sendJson(payload);
  }

  handleIncomingData(data: unknown, callbacks: LiveWireRuntimeCallbacks): void {
    if (!callbacks.isCurrent()) return;
    if (typeof data === "string") {
      let message: unknown;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      this.handleServerJson(message, callbacks);
      return;
    }
    if (data instanceof ArrayBuffer) {
      callbacks.enqueueAudioFrame(data);
      return;
    }
    if (ArrayBuffer.isView(data)) {
      const view = data;
      const slice = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
      callbacks.enqueueAudioFrame(slice);
    }
  }

  private handleServerJson(rawMessage: unknown, callbacks: LiveWireRuntimeCallbacks): void {
    if (!callbacks.isCurrent()) return;
    const parsed = parseMossServerJsonEvent(rawMessage);
    if (!parsed) return;

    switch (parsed.kind) {
      case "session_attached": {
        const videoContext = callbacks.getVideoContext();
        callbacks.sendJson({ action: "media.mode", binary_protocol: "tagged-v1" });
        callbacks.sendJson({ action: "media.configure", playback: "server" });
        callbacks.markContextSent(videoContext);
        callbacks.sendJson(buildMinimalSessionUpdatePayload(videoContext));
        callbacks.completeHandshake({
          sessionId: parsed.sessionId || undefined,
          emitSessionAttached: Boolean(parsed.sessionId)
        });
        break;
      }

      case "session.updated":
        if (parsed.error) {
          callbacks.fail(new Error(`MOSS-LIVE 会话配置失败：${parsed.error}`));
          return;
        }
        if (!this.mediaStreamsInitialized) {
          this.mediaStreamsInitialized = true;
          callbacks.sendJson({ action: "video.state", source: "screen", enabled: true });
          callbacks.sendJson({ action: "video.stream_focus", source: "screen" });
          callbacks.sendJson({ action: "mic_state", enabled: callbacks.getMicEnabled() });
          if (this.latestVideoJpeg) {
            callbacks.sendBinary(
              packTaggedBinary(MossBinaryTag.ScreenJpeg, this.latestVideoJpeg)
            );
          }
        }
        break;

      case "transcript":
        callbacks.emitTranscript(parsed.event);
        break;

      case "audio.context":
        callbacks.enqueueAudioContext(parsed.chunkId, parsed.runId, parsed.turnId);
        break;

      case "audio.done":
        callbacks.handleAudioDone(parsed.runId, parsed.turnId);
        break;

      case "audio.stop":
        callbacks.handleAudioStop(parsed.runId, parsed.turnId);
        break;

      case "delegation.created":
        if (parsed.delegation.delegationId && parsed.delegation.objective) {
          this.activeDelegationIds.add(parsed.delegation.delegationId);
          callbacks.startDelegation(parsed.delegation);
        }
        break;

      case "delegation.cancelled":
        this.activeDelegationIds.delete(parsed.delegationId);
        callbacks.cancelDelegation(parsed.delegationId);
        break;

      case "tool.call":
        callbacks.startPageToolCall(parsed.call, "", "");
        break;

      case "function_call.done":
        callbacks.startFunctionCall({
          callId: parsed.callId,
          name: parsed.name,
          arguments: parsed.argumentsText,
          query: parsed.name === "web_search" ? extractMossSearchQuery(parsed.argumentsText) : "",
          runId: parsed.runId,
          turnId: parsed.turnId
        });
        break;

      case "error":
        callbacks.failOrReconnectOnServerError(parsed.message, parsed.code);
        break;
    }
  }

  sendAudio(
    _pcmBase64: string,
    pcmBytes: Uint8Array<ArrayBuffer>,
    transport: LiveWireTransport
  ): boolean {
    return this.sendTaggedBinary(MossBinaryTag.AudioPcm, pcmBytes.buffer, transport);
  }

  sendVideo(
    _jpegBase64: string,
    jpegBytes: Uint8Array<ArrayBuffer>,
    transport: LiveWireTransport
  ): boolean {
    return this.sendVideoBuffer(jpegBytes.buffer, transport);
  }

  sendVideoBuffer(jpegBuffer: ArrayBufferLike, transport: LiveWireTransport): boolean {
    this.latestVideoJpeg = jpegBuffer;
    return this.sendTaggedBinary(MossBinaryTag.ScreenJpeg, jpegBuffer, transport);
  }

  sendTaggedBinary(
    tag: MossBinaryTag,
    payload: ArrayBufferLike,
    transport: LiveWireTransport
  ): boolean {
    return transport.sendBinary(packTaggedBinary(tag, payload));
  }

  onMicStateChanged(
    enabled: boolean,
    _previousEnabled: boolean,
    connected: boolean,
    transport: LiveWireTransport
  ): void {
    if (connected) {
      transport.sendJson({ action: "mic_state", enabled });
    }
  }

  onVideoContextUpdated(context: MossLiveSessionContext | null): void {
    const nextVideoKey = context && !("kind" in context)
      ? `${context.bvid}:${context.cid}:${context.pageIndex}`
      : "";
    if (nextVideoKey !== this.delegationVideoKey) {
      this.activeDelegationIds.clear();
      this.delegationVideoKey = nextVideoKey;
    }
    if (!context) {
      this.latestVideoJpeg = null;
    }
  }

  sendContextUpdate(context: MossLiveSessionContext | null, transport: LiveWireTransport): void {
    transport.sendJson(buildMinimalSessionUpdatePayload(context));
  }

  sendDelegationSilent(
    delegationId: string,
    content: string,
    transport: LiveWireTransport
  ): boolean {
    if (!this.activeDelegationIds.has(delegationId)) return false;
    return transport.sendJson({
      action: "session.thinking.append",
      event_id: crypto.randomUUID(),
      delegation_id: delegationId,
      content,
      status: "in_progress"
    });
  }

  sendDelegationResult(
    delegationId: string,
    status: "completed" | "failed",
    content: string,
    transport: LiveWireTransport
  ): boolean {
    if (!this.activeDelegationIds.has(delegationId)) return false;
    this.activeDelegationIds.delete(delegationId);
    return transport.sendJson({
      action: "session.commentary.append",
      event_id: crypto.randomUUID(),
      delegation_id: delegationId,
      status,
      content
    });
  }

  sendToolResponse(): boolean {
    return true;
  }
}

export class OffscreenMossLiveClient extends OffscreenLiveSessionRuntime {
  private readonly mossAdapter: MossWireAdapter;

  constructor(options: OffscreenMossClientOptions = {}) {
    const adapter = new MossWireAdapter();
    super(adapter, options);
    this.mossAdapter = adapter;
  }

  handleAction(msg: MossLiveClientAction): void {
    if (msg.action === "delegation_silent") {
      this.mossAdapter.sendDelegationSilent(msg.delegationId, msg.content, this.transport);
      return;
    }
    if (msg.action === "delegation_result") {
      this.mossAdapter.sendDelegationResult(msg.delegationId, msg.status, msg.content, this.transport);
      return;
    }
    super.handleAction(msg);
  }

  sendAudioPcm(pcmBuffer: ArrayBufferLike): boolean {
    if (!this.micEnabled || this.state !== "connected") {
      return false;
    }
    return this.sendBinary(MossBinaryTag.AudioPcm, pcmBuffer);
  }

  sendVideoJpeg(jpegBuffer: ArrayBufferLike): boolean {
    if (this.state !== "connected") {
      return false;
    }
    return this.mossAdapter.sendVideoBuffer(jpegBuffer, this.transport);
  }

  sendBinary(tag: MossBinaryTag, payload: ArrayBufferLike): boolean {
    return this.mossAdapter.sendTaggedBinary(tag, payload, this.transport);
  }
}
