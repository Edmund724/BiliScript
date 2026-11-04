// extension/live/offscreen-moss-client.ts
// 运行在 Offscreen Document 中的 MOSS-LIVE WebSocket 客户端。
// 持有与 wss://api.mosi.cn/v1/realtime 的真实 WebSocket 连接，负责：
// 1. 会话握手（attach_session -> session_attached -> media.mode + session.update -> session.updated -> mic_state）
// 2. 上行 16kHz 单声道 PCM S16LE 音频（tagged-v1 0x00）与视频 JPEG（0x02）、静音控制
// 3. 下行 48kHz 单声道 PCM S16LE 无缝队列播放与 playback.chunk.completed / playback.completed / playback.stopped 回执
// 4. 双端增量/终态字幕事件转发

import {
  DEFAULT_MOSS_LIVE_WS_URL,
  MOSS_DOWNSTREAM_SAMPLE_RATE,
  MossBinaryTag,
  buildMinimalSessionUpdatePayload,
  decodePcmS16LEToFloat32,
  packTaggedBinary,
  parseMossServerJsonEvent,
  type MossLiveToolCall,
  type MossLiveTranscriptEvent,
  type MossLiveVideoContext
} from "./moss-live-protocol.js";

export type MossLiveClientState = "idle" | "connecting" | "connected" | "closed" | "failed";

export const DEFAULT_MOSS_HANDSHAKE_TIMEOUT_MS = 10000;

export interface AudioBufferLike {
  readonly duration: number;
  readonly length: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null;
  onended: (() => void) | null;
  connect(destination: unknown): void;
  disconnect(): void;
  start(when?: number): void;
  stop(): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly state?: string;
  readonly destination: unknown;
  resume?(): Promise<void>;
  close?(): Promise<void>;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceNodeLike;
}

export interface OffscreenMossClientOptions {
  wsUrl?: string;
  videoContext?: MossLiveVideoContext | null;
  handshakeTimeoutMs?: number;
  createAudioContext?: () => AudioContextLike | null;
  onConnecting?: () => void;
  onConnected?: () => void;
  onTranscript?: (event: MossLiveTranscriptEvent) => void;
  onToolCall?: (call: MossLiveToolCall) => void;
  onError?: (error: Error) => void;
  onClosed?: (event?: { code?: number; reason?: string }) => void;
}

interface PendingAudioContextItem {
  chunkId: string;
  runId: string;
  turnId: string;
  discard: boolean;
}

interface ActiveSourceEntry {
  source: AudioBufferSourceNodeLike;
  startAt: number;
  sampleCount: number;
}

interface TurnPlaybackTracker {
  runId: string;
  turnId: string;
  inFlightChunks: number;
  audioDoneReceived: boolean;
  completedSent: boolean;
  stopped: boolean;
  stoppedSent: boolean;
  playedSamples: number;
  claimedChunkIds: Set<string>;
  activeSources: Set<ActiveSourceEntry>;
}

function createBrowserAudioContext(): AudioContextLike | null {
  const Ctor =
    (globalThis as unknown as { AudioContext?: new (opts?: AudioContextOptions) => AudioContextLike })
      .AudioContext ||
    (globalThis as unknown as { webkitAudioContext?: new (opts?: AudioContextOptions) => AudioContextLike })
      .webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor({ sampleRate: MOSS_DOWNSTREAM_SAMPLE_RATE });
  } catch {
    try {
      return new Ctor();
    } catch {
      return null;
    }
  }
}

export class OffscreenMossLiveClient {
  private ws: WebSocket | null = null;
  private state: MossLiveClientState = "idle";
  private disposed = false;
  private socketGeneration = 0;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private micEnabled = true;
  private audioCtx: AudioContextLike | null = null;
  private nextPlayTime = 0;
  private readonly pendingAudioContexts: PendingAudioContextItem[] = [];
  private readonly pendingAudioFrames: ArrayBufferLike[] = [];
  private readonly turnPlaybacks = new Map<string, TurnPlaybackTracker>();
  private readonly wsUrl: string;
  private readonly handshakeTimeoutMs: number;
  private readonly options: OffscreenMossClientOptions;
  private videoContext: MossLiveVideoContext | null;
  private lastSentContextKey = "";

  constructor(options: OffscreenMossClientOptions = {}) {
    this.options = options;
    this.wsUrl = options.wsUrl || DEFAULT_MOSS_LIVE_WS_URL;
    this.videoContext = options.videoContext || null;
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

  private ensureAudioContext(): AudioContextLike | null {
    if (!this.audioCtx) {
      this.audioCtx = this.options.createAudioContext
        ? this.options.createAudioContext()
        : createBrowserAudioContext();
    }
    if (this.audioCtx && this.audioCtx.state === "suspended") {
      void this.audioCtx.resume?.().catch(() => {});
    }
    return this.audioCtx;
  }

  private getTurnKey(runId: string, turnId: string): string {
    return `${runId}:${turnId}`;
  }

  private getOrCreateTurnTracker(runId: string, turnId: string): TurnPlaybackTracker {
    const key = this.getTurnKey(runId, turnId);
    let tracker = this.turnPlaybacks.get(key);
    if (!tracker) {
      tracker = {
        runId,
        turnId,
        inFlightChunks: 0,
        audioDoneReceived: false,
        completedSent: false,
        stopped: false,
        stoppedSent: false,
        playedSamples: 0,
        claimedChunkIds: new Set(),
        activeSources: new Set()
      };
      this.turnPlaybacks.set(key, tracker);
    }
    return tracker;
  }

  private sendTurnCompletedIfReady(tracker: TurnPlaybackTracker): void {
    if (
      tracker.stopped ||
      !tracker.audioDoneReceived ||
      tracker.inFlightChunks !== 0 ||
      tracker.completedSent
    ) {
      return;
    }
    tracker.completedSent = true;
    this.sendJson({
      action: "playback.completed",
      run_id: tracker.runId,
      turn_id: tracker.turnId
    });
  }

  private sendChunkCompleted(context: PendingAudioContextItem, tracker: TurnPlaybackTracker): void {
    if (context.chunkId) {
      this.sendJson({
        action: "playback.chunk.completed",
        chunk_id: context.chunkId,
        run_id: context.runId,
        turn_id: context.turnId
      });
    }
    this.sendTurnCompletedIfReady(tracker);
  }

  private stopAllPlayback(): void {
    this.pendingAudioContexts.length = 0;
    this.pendingAudioFrames.length = 0;
    const now = this.audioCtx ? this.audioCtx.currentTime : 0;
    for (const tracker of this.turnPlaybacks.values()) {
      for (const entry of tracker.activeSources) {
        entry.source.onended = null;
        if (now > entry.startAt) {
          const elapsedSec = Math.max(0, now - entry.startAt);
          tracker.playedSamples += Math.min(
            entry.sampleCount,
            Math.round(elapsedSec * MOSS_DOWNSTREAM_SAMPLE_RATE)
          );
        }
        try {
          entry.source.stop();
        } catch {}
        try {
          entry.source.disconnect();
        } catch {}
      }
      tracker.activeSources.clear();
      tracker.inFlightChunks = 0;
      tracker.completedSent = true;
      tracker.stopped = true;
    }
    this.nextPlayTime = now;
  }

  private stopAndResetAllPlayback(): void {
    this.stopAllPlayback();
    this.turnPlaybacks.clear();
    this.nextPlayTime = 0;
    if (this.audioCtx) {
      const ctx = this.audioCtx;
      this.audioCtx = null;
      void ctx.close?.().catch(() => {});
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
        this.sendJson({ action: "attach_session", memory_scope: "session" });
      };

      this.ws.onmessage = (event) => {
        if (this.disposed || this.socketGeneration !== currentGeneration) return;
        if (typeof event.data === "string") {
          let message: unknown;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          this.handleServerJson(message, currentGeneration);
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          this.handleServerBinaryAudio(event.data, currentGeneration);
          return;
        }
        if (ArrayBuffer.isView(event.data)) {
          const view = event.data;
          const slice = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
          this.handleServerBinaryAudio(slice, currentGeneration);
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
          this.stopAndResetAllPlayback();
          this.options.onClosed?.({ code: event.code, reason: event.reason });
        }
      };
    } catch (error) {
      this.clearHandshakeTimer();
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleServerJson(rawMessage: unknown, generation: number): void {
    if (this.disposed || this.socketGeneration !== generation) return;
    const parsed = parseMossServerJsonEvent(rawMessage);
    if (!parsed) return;

    switch (parsed.kind) {
      case "session_attached":
        this.clearHandshakeTimer();
        this.state = "connected";
        this.sendJson({ action: "media.mode", binary_protocol: "tagged-v1" });
        this.lastSentContextKey = JSON.stringify(this.videoContext);
        this.sendJson(buildMinimalSessionUpdatePayload(this.videoContext));
        this.options.onConnected?.();
        break;

      case "session.updated":
        if (parsed.error) {
          this.clearHandshakeTimer();
          this.fail(new Error(`MOSS-LIVE 会话配置失败：${parsed.error}`));
          return;
        }
        this.sendJson({ action: "mic_state", enabled: this.micEnabled });
        break;

      case "transcript":
        if (parsed.event.kind === "response.interrupted") {
          this.stopAllPlayback();
        }
        this.options.onTranscript?.(parsed.event);
        break;

      case "audio.context": {
        const tracker = this.getOrCreateTurnTracker(parsed.runId, parsed.turnId);
        const duplicate = Boolean(parsed.chunkId && tracker.claimedChunkIds.has(parsed.chunkId));
        const discard = tracker.stopped || duplicate;
        if (parsed.chunkId && !duplicate) {
          tracker.claimedChunkIds.add(parsed.chunkId);
        }
        if (!discard) {
          tracker.inFlightChunks += 1;
        }
        this.pendingAudioContexts.push({
          chunkId: parsed.chunkId,
          runId: parsed.runId,
          turnId: parsed.turnId,
          discard
        });
        this.drainPendingAudio(generation);
        break;
      }

      case "audio.done": {
        const tracker = this.getOrCreateTurnTracker(parsed.runId, parsed.turnId);
        if (tracker.stopped) break;
        tracker.audioDoneReceived = true;
        this.sendTurnCompletedIfReady(tracker);
        break;
      }

      case "audio.stop": {
        const tracker = this.getOrCreateTurnTracker(parsed.runId, parsed.turnId);
        if (tracker.stoppedSent) break;
        this.stopAllPlayback();
        tracker.stoppedSent = true;
        const playedAudioMs = Math.round((tracker.playedSamples / MOSS_DOWNSTREAM_SAMPLE_RATE) * 1000);
        this.sendJson({
          action: "playback.stopped",
          run_id: parsed.runId,
          turn_id: parsed.turnId,
          played_audio_ms: playedAudioMs
        });
        break;
      }

      case "tool.call":
        this.options.onToolCall?.(parsed.call);
        if (!this.options.onToolCall) {
          this.sendToolResult(parsed.call.callId, { ok: false, error: "当前客户端未接入字幕工具执行器" });
        }
        break;

      case "error":
        this.clearHandshakeTimer();
        this.fail(new Error(parsed.message));
        break;
    }
  }

  private handleServerBinaryAudio(pcmBuffer: ArrayBufferLike, generation: number): void {
    if (this.disposed || this.socketGeneration !== generation) return;
    this.pendingAudioFrames.push(pcmBuffer);
    this.drainPendingAudio(generation);
  }

  private drainPendingAudio(generation: number): void {
    while (this.pendingAudioContexts.length > 0 && this.pendingAudioFrames.length > 0) {
      const context = this.pendingAudioContexts.shift()!;
      const pcmBuffer = this.pendingAudioFrames.shift()!;
      this.playAudioChunk(context, pcmBuffer, generation);
    }
  }

  private playAudioChunk(
    context: PendingAudioContextItem,
    pcmBuffer: ArrayBufferLike,
    generation: number
  ): void {
    const tracker = this.getOrCreateTurnTracker(context.runId, context.turnId);
    if (context.discard || tracker.stopped) return;

    const samples = decodePcmS16LEToFloat32(pcmBuffer);
    const audioCtx = samples.length > 0 ? this.ensureAudioContext() : null;
    if (samples.length === 0 || !audioCtx) {
      tracker.inFlightChunks = Math.max(0, tracker.inFlightChunks - 1);
      this.sendChunkCompleted(context, tracker);
      return;
    }

    const audioBuffer = audioCtx.createBuffer(1, samples.length, MOSS_DOWNSTREAM_SAMPLE_RATE);
    audioBuffer.getChannelData(0).set(samples);

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtx.destination);

    const startAt = Math.max(audioCtx.currentTime, this.nextPlayTime);
    const durationSec = samples.length / MOSS_DOWNSTREAM_SAMPLE_RATE;
    this.nextPlayTime = startAt + durationSec;

    const entry: ActiveSourceEntry = {
      source,
      startAt,
      sampleCount: samples.length
    };
    tracker.activeSources.add(entry);

    source.onended = () => {
      if (this.disposed || this.socketGeneration !== generation) return;
      if (!tracker.activeSources.has(entry)) return;
      tracker.activeSources.delete(entry);
      tracker.inFlightChunks = Math.max(0, tracker.inFlightChunks - 1);
      tracker.playedSamples += entry.sampleCount;
      try {
        source.disconnect();
      } catch {}
      this.sendChunkCompleted(context, tracker);
    };

    source.start(startAt);
  }

  private fail(error: Error): void {
    this.clearHandshakeTimer();
    this.state = "failed";
    this.socketGeneration += 1;
    this.stopAndResetAllPlayback();
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
    this.disposed = true;
    this.socketGeneration += 1;
    this.clearHandshakeTimer();
    this.state = "idle";
    this.stopAndResetAllPlayback();
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

  setMicEnabled(enabled: boolean): void {
    this.micEnabled = Boolean(enabled);
    if (this.state === "connected") {
      this.sendJson({ action: "mic_state", enabled: this.micEnabled });
    }
  }

  sendAudioPcm(pcmBuffer: ArrayBufferLike): boolean {
    if (!this.micEnabled || this.state !== "connected") {
      return false;
    }
    return this.sendBinary(MossBinaryTag.AudioPcm, pcmBuffer);
  }

  updateVideoContext(context: MossLiveVideoContext | null): void {
    this.videoContext = context;
    if (this.state !== "connected") return;
    const contextKey = JSON.stringify(context);
    if (contextKey === this.lastSentContextKey) return;
    this.lastSentContextKey = contextKey;
    this.sendJson(buildMinimalSessionUpdatePayload(context));
  }

  sendToolResult(callId: string, result: unknown): boolean {
    return this.sendJson({ action: "tool.result", call_id: callId, result });
  }

  sendVideoJpeg(jpegBuffer: ArrayBufferLike): boolean {
    if (this.state !== "connected") {
      return false;
    }
    return this.sendBinary(MossBinaryTag.ScreenJpeg, jpegBuffer);
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

  sendBinary(tag: MossBinaryTag, payload: ArrayBufferLike): boolean {
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
