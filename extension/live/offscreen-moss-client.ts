import { logWarn } from "../shared/logging.js";
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
  MOSS_UPSTREAM_FRAME_BYTES,
  MossBinaryTag,
  buildClientContextUpdatePayload,
  buildChangeVoicePayload,
  buildMinimalSessionUpdatePayload,
  packTaggedBinary,
  parseMossServerJsonEvent,
  type MossLiveClientAction,
  type MossLiveSessionContext
} from "./moss-live-protocol.js";
import { buildMossMediaConfigureVideo, normalizeMossVideoConfig, resolveMossVideoConfig } from "./moss-video-config.js";

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
const DEFAULT_MOSS_VOICE_ACK_TIMEOUT_MS = 3000;

interface PendingAttach {
  callbacks: LiveWireRuntimeCallbacks;
  videoContext: MossLiveSessionContext | null;
  sessionId?: string;
  emitSessionAttached: boolean;
}

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
  private lowBandwidth = false;

  onStartAction(msg: Extract<MossLiveClientAction, { action: "start" }>): void {
    this.lowBandwidth = msg.lowBandwidth === true;
  }

  private currentVoiceId = "";
  private attached = false;
  private attachPending: PendingAttach | null = null;
  private awaitingVoice = "";
  private voiceAckTimer: ReturnType<typeof setTimeout> | null = null;

  onConnectReset(): void {
    this.mediaStreamsInitialized = false;
    this.latestVideoJpeg = null;
    this.activeDelegationIds.clear();
    this.attached = false;
    this.attachPending = null;
    this.currentVoiceId = "";
    this.clearVoiceWait();
  }

  onResetPlayback(): void {
    this.latestVideoJpeg = null;
    this.activeDelegationIds.clear();
    this.attached = false;
    this.attachPending = null;
    this.clearVoiceWait();
  }

  onSocketOpen(context: LiveWireSocketOpenContext): void {
    const videoContext = context.videoContext;
    this.currentVoiceId = String(context.voiceId || "").trim();
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
        callbacks.sendJson({
          action: "media.configure",
          playback: "server",
          video: buildMossMediaConfigureVideo(resolveMossVideoConfig(this.lowBandwidth))
        });
        callbacks.markContextSent(videoContext);
        const pending: PendingAttach = {
          callbacks,
          videoContext,
          sessionId: parsed.sessionId || undefined,
          emitSessionAttached: Boolean(parsed.sessionId)
        };
        this.attachPending = pending;
        if (!this.currentVoiceId) {
          this.completeAttach(pending);
          break;
        }
        this.awaitVoiceAck(this.currentVoiceId);
        callbacks.sendJson(buildChangeVoicePayload(this.currentVoiceId));
        break;
      }

      case "voice_changed":
        this.clearVoiceWait();
        if (this.attachPending) {
          this.completeAttach(this.attachPending);
        }
        break;

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

      case "client_context.updated":
        if (!parsed.accepted) {
          logWarn("[BILISCRIPT] 服务端未接受伴看客户端时区上下文，会话继续");
        }
        break;

      case "output.configured":
        callbacks.applyOutputConfiguration(parsed);
        break;

      case "media.configured":
        callbacks.applyMediaConfiguration({
          video: normalizeMossVideoConfig(parsed.video, resolveMossVideoConfig(this.lowBandwidth)),
          error: parsed.error
        });
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

      case "error": {
        const isVoiceError =
          /voice/i.test(parsed.code) || /voice|音色/i.test(parsed.message);
        if (this.awaitingVoice && isVoiceError) {
          const voiceId = this.awaitingVoice;
          const pending = this.attachPending;
          this.clearVoiceWait();
          this.currentVoiceId = "";
          callbacks.reportVoiceFallback(voiceId);
          if (pending) {
            this.completeAttach(pending);
          }
          return;
        }
        if (this.awaitingVoice) {
          this.clearVoiceWait();
        }
        if (parsed.code === "unsupported_control") {
          callbacks.useLocalPlaybackRate();
        } else {
          callbacks.failOrReconnectOnServerError(parsed.message, parsed.code);
        }
        break;
      }
    }
  }

  configureOutput(
    output: { volumeDb: number; speed?: number },
    transport: LiveWireTransport
  ): boolean {
    return transport.sendJson({
      action: "media.output.configure",
      volume_db: output.volumeDb,
      ...(output.speed !== undefined ? { speed: output.speed } : {})
    });
  }

  private clearVoiceWait(): void {
    if (this.voiceAckTimer !== null) {
      clearTimeout(this.voiceAckTimer);
      this.voiceAckTimer = null;
    }
    this.awaitingVoice = "";
  }

  private awaitVoiceAck(voiceId: string): void {
    this.clearVoiceWait();
    this.awaitingVoice = voiceId;
    this.voiceAckTimer = setTimeout(() => {
      this.voiceAckTimer = null;
      this.awaitingVoice = "";
      if (this.attachPending) {
        this.completeAttach(this.attachPending);
      }
    }, DEFAULT_MOSS_VOICE_ACK_TIMEOUT_MS);
  }

  private completeAttach(pending: PendingAttach): void {
    if (this.attachPending !== pending) return;
    this.clearVoiceWait();
    this.attachPending = null;
    this.attached = true;
    if (!pending.callbacks.isCurrent()) return;
    pending.callbacks.sendJson(buildMinimalSessionUpdatePayload(pending.videoContext));
    pending.callbacks.sendJson(buildClientContextUpdatePayload());
    pending.callbacks.completeHandshake({
      sessionId: pending.sessionId,
      emitSessionAttached: pending.emitSessionAttached
    });
  }

  changeVoice(voiceId: string, transport: LiveWireTransport): boolean {
    const next = String(voiceId || "").trim();
    this.currentVoiceId = next;
    if (!next || !this.attached || this.attachPending) return false;
    this.awaitVoiceAck(next);
    return transport.sendJson(buildChangeVoicePayload(next));
  }

  sendAudio(
    _pcmBase64: string,
    pcmBytes: Uint8Array<ArrayBuffer>,
    transport: LiveWireTransport
  ): boolean {
    if (pcmBytes.byteLength === 0) return false;
    if (pcmBytes.byteLength <= MOSS_UPSTREAM_FRAME_BYTES) {
      return this.sendTaggedBinary(MossBinaryTag.AudioPcm, pcmBytes, transport);
    }
    let allSent = true;
    for (let offset = 0; offset < pcmBytes.byteLength; offset += MOSS_UPSTREAM_FRAME_BYTES) {
      const end = Math.min(offset + MOSS_UPSTREAM_FRAME_BYTES, pcmBytes.byteLength);
      if (!this.sendTaggedBinary(MossBinaryTag.AudioPcm, pcmBytes.subarray(offset, end), transport)) {
        allSent = false;
      }
    }
    return allSent;
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
    payload: ArrayBufferLike | Uint8Array,
    transport: LiveWireTransport
  ): boolean {
    return transport.sendBinary(packTaggedBinary(tag, payload));
  }

  onMicStateChanged(
    enabled: boolean,
    previousEnabled: boolean,
    connected: boolean,
    transport: LiveWireTransport
  ): void {
    if (previousEnabled !== enabled && connected) {
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
    status: "in_progress" | "completed" | "failed",
    content: string,
    transport: LiveWireTransport
  ): boolean {
    if (!this.activeDelegationIds.has(delegationId)) return false;
    if (status !== "in_progress") this.activeDelegationIds.delete(delegationId);
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
  constructor(options: OffscreenMossClientOptions = {}) {
    super(new MossWireAdapter(), options);
  }
}
