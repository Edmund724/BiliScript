// extension/live/moss-audio-player.ts
// Offscreen MOSS-LIVE 下行 48kHz 单声道 PCM S16LE 无缝队列播放器与回合进度追踪器。
// 封装 AudioContext 创建/恢复/销毁、元数据与二进制音频帧配对排程、局部打断停播，
// 以及 playback.chunk.completed / playback.completed / playback.stopped 回执发射。

import {
  MOSS_DOWNSTREAM_SAMPLE_RATE,
  decodePcmS16LEToFloat32
} from "./moss-live-protocol.js";

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
  responseEnded: boolean;
  completedSent: boolean;
  stopped: boolean;
  stoppedSent: boolean;
  playedSamples: number;
  claimedChunkIds: Set<string>;
  activeSources: Set<ActiveSourceEntry>;
}

export interface MossAudioPlayerOptions {
  createAudioContext?: () => AudioContextLike | null;
  onSendJson: (payload: unknown) => void;
  onTurnFinished: (runId: string, turnId: string) => void;
  onStateChange: () => void;
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

export class MossAudioPlayer {
  private audioCtx: AudioContextLike | null = null;
  private nextPlayTime = 0;
  private readonly pendingAudioContexts: PendingAudioContextItem[] = [];
  private readonly pendingAudioFrames: ArrayBufferLike[] = [];
  private readonly turnPlaybacks = new Map<string, TurnPlaybackTracker>();
  private readonly options: MossAudioPlayerOptions;

  constructor(options: MossAudioPlayerOptions) {
    this.options = options;
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
        responseEnded: false,
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

  isPlaying(): boolean {
    if (this.pendingAudioContexts.length > 0 || this.pendingAudioFrames.length > 0) return true;
    for (const tracker of this.turnPlaybacks.values()) {
      if (tracker.stopped || tracker.completedSent) continue;
      if (tracker.activeSources.size > 0 || tracker.inFlightChunks > 0) {
        return true;
      }
    }
    return false;
  }

  canActivateTurn(runId: string, turnId: string): boolean {
    const tracker = this.getOrCreateTurnTracker(runId, turnId);
    return !tracker.stopped && !tracker.audioDoneReceived && !tracker.responseEnded;
  }

  markResponseEnded(runId: string, turnId: string): void {
    this.getOrCreateTurnTracker(runId, turnId).responseEnded = true;
  }

  enqueueAudioContext(
    chunkId: string,
    runId: string,
    turnId: string,
    isCurrent: () => boolean
  ): boolean {
    const tracker = this.getOrCreateTurnTracker(runId, turnId);
    const duplicate = Boolean(chunkId && tracker.claimedChunkIds.has(chunkId));
    const discard = tracker.stopped || tracker.audioDoneReceived || tracker.responseEnded || duplicate;
    if (chunkId && !duplicate) {
      tracker.claimedChunkIds.add(chunkId);
    }
    if (!discard) {
      tracker.inFlightChunks += 1;
    }
    this.pendingAudioContexts.push({
      chunkId,
      runId,
      turnId,
      discard
    });
    this.drainPendingAudio(isCurrent);
    return !discard;
  }

  enqueueAudioFrame(pcmBuffer: ArrayBufferLike, isCurrent: () => boolean): void {
    this.pendingAudioFrames.push(pcmBuffer);
    this.drainPendingAudio(isCurrent);
  }

  handleAudioDone(runId: string, turnId: string): boolean {
    const tracker = this.getOrCreateTurnTracker(runId, turnId);
    if (tracker.stopped) return false;
    tracker.audioDoneReceived = true;
    this.options.onTurnFinished(runId, turnId);
    this.sendTurnCompletedIfReady(tracker);
    return true;
  }

  handleAudioStop(runId: string, turnId: string): void {
    const tracker = this.getOrCreateTurnTracker(runId, turnId);
    if (tracker.stoppedSent) return;
    this.stopTurn(runId, turnId);
    tracker.stoppedSent = true;
    const playedAudioMs = Math.round((tracker.playedSamples / MOSS_DOWNSTREAM_SAMPLE_RATE) * 1000);
    this.options.onSendJson({
      action: "playback.stopped",
      run_id: runId,
      turn_id: turnId,
      played_audio_ms: playedAudioMs
    });
  }

  stopTurn(runId: string, turnId: string): void {
    const tracker = this.getOrCreateTurnTracker(runId, turnId);
    for (const context of this.pendingAudioContexts) {
      if (context.runId === runId && context.turnId === turnId) context.discard = true;
    }

    const now = this.audioCtx ? this.audioCtx.currentTime : 0;
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
    this.options.onStateChange();
    tracker.stopped = true;

    this.nextPlayTime = now;
    for (const other of this.turnPlaybacks.values()) {
      for (const entry of other.activeSources) {
        this.nextPlayTime = Math.max(
          this.nextPlayTime,
          entry.startAt + entry.sampleCount / MOSS_DOWNSTREAM_SAMPLE_RATE
        );
      }
    }
    this.options.onTurnFinished(runId, turnId);
  }

  interruptActiveTurns(): Array<{ runId: string; turnId: string }> {
    const interrupted: Array<{ runId: string; turnId: string }> = [];
    for (const tracker of [...this.turnPlaybacks.values()]) {
      if (!tracker.stopped && !tracker.completedSent) {
        this.stopTurn(tracker.runId, tracker.turnId);
        tracker.stoppedSent = true;
        const playedAudioMs = Math.round((tracker.playedSamples / MOSS_DOWNSTREAM_SAMPLE_RATE) * 1000);
        this.options.onSendJson({
          action: "playback.stopped",
          run_id: tracker.runId,
          turn_id: tracker.turnId,
          played_audio_ms: playedAudioMs
        });
        interrupted.push({ runId: tracker.runId, turnId: tracker.turnId });
      }
    }
    return interrupted;
  }

  stopAll(): void {
    this.pendingAudioContexts.length = 0;
    this.pendingAudioFrames.length = 0;
    for (const tracker of [...this.turnPlaybacks.values()]) {
      this.stopTurn(tracker.runId, tracker.turnId);
    }
    this.nextPlayTime = this.audioCtx ? this.audioCtx.currentTime : 0;
    this.options.onStateChange();
  }

  reset(): void {
    this.stopAll();
    this.turnPlaybacks.clear();
    this.nextPlayTime = 0;
    if (this.audioCtx) {
      const ctx = this.audioCtx;
      this.audioCtx = null;
      void ctx.close?.().catch(() => {});
    }
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
    this.options.onStateChange();
    this.options.onSendJson({
      action: "playback.completed",
      run_id: tracker.runId,
      turn_id: tracker.turnId
    });
  }

  private sendChunkCompleted(context: PendingAudioContextItem, tracker: TurnPlaybackTracker): void {
    if (context.chunkId) {
      this.options.onSendJson({
        action: "playback.chunk.completed",
        chunk_id: context.chunkId,
        run_id: context.runId,
        turn_id: context.turnId
      });
    }
    this.sendTurnCompletedIfReady(tracker);
  }

  private drainPendingAudio(isCurrent: () => boolean): void {
    while (this.pendingAudioContexts.length > 0 && this.pendingAudioFrames.length > 0) {
      const context = this.pendingAudioContexts.shift()!;
      const pcmBuffer = this.pendingAudioFrames.shift()!;
      this.playAudioChunk(context, pcmBuffer, isCurrent);
    }
  }

  private playAudioChunk(
    context: PendingAudioContextItem,
    pcmBuffer: ArrayBufferLike,
    isCurrent: () => boolean
  ): void {
    const tracker = this.getOrCreateTurnTracker(context.runId, context.turnId);
    if (context.discard || tracker.stopped) return;

    const samples = decodePcmS16LEToFloat32(pcmBuffer);
    const audioCtx = samples.length > 0 ? this.ensureAudioContext() : null;
    if (samples.length === 0 || !audioCtx) {
      tracker.inFlightChunks = Math.max(0, tracker.inFlightChunks - 1);
      this.sendChunkCompleted(context, tracker);
      this.options.onStateChange();
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
    this.options.onStateChange();

    source.onended = () => {
      if (!isCurrent()) return;
      if (!tracker.activeSources.has(entry)) return;
      tracker.activeSources.delete(entry);
      tracker.inFlightChunks = Math.max(0, tracker.inFlightChunks - 1);
      tracker.playedSamples += entry.sampleCount;
      try {
        source.disconnect();
      } catch {}
      this.sendChunkCompleted(context, tracker);
      this.options.onStateChange();
    };

    source.start(startAt);
  }
}
