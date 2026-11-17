// extension/live/moss-audio-player.ts
// Offscreen MOSS-LIVE 下行 48kHz 单声道 PCM S16LE 无缝队列播放器与回合进度追踪器。
// 封装 AudioContext 创建/恢复/销毁、共享输出增益、元数据与二进制音频帧配对排程、
// 局部打断停播，以及 playback.chunk.completed / playback.completed / playback.stopped 回执发射。

import {
  MOSS_DOWNSTREAM_SAMPLE_RATE,
  decodePcmS16LEToFloat32
} from "./moss-live-protocol.js";

export const DEFAULT_AUDIO_LEAD_TIME_SEC = 0.03;

export interface AudioBufferLike {
  readonly duration: number;
  readonly length: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null;
  readonly playbackRate?: { value: number };
  onended: (() => void) | null;
  connect(destination: unknown): void;
  disconnect(): void;
  start(when?: number): void;
  stop(): void;
}

export interface AudioGainNodeLike {
  readonly gain: { value: number };
  connect(destination: unknown): void;
  disconnect(): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly state?: string;
  readonly destination: unknown;
  resume?(): Promise<void>;
  close?(): Promise<void>;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  createGain(): AudioGainNodeLike;
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
  playbackRate: number;
}

interface PendingPlaybackChunk {
  context: PendingAudioContextItem;
  samples: Float32Array;
  isCurrent: () => boolean;
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
  sampleRate?: number;
  volume?: number;
  speed?: number;
  leadTimeSec?: number;
  enablePlaybackReceipts?: boolean;
  createAudioContext?: () => AudioContextLike | null;
  onSendJson?: (payload: unknown) => void;
  onTurnFinished: (runId: string, turnId: string) => void;
  onStateChange: () => void;
}

function clampVolume(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

function clampPlaybackRate(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(0.25, Math.min(4, value)) : 1;
}

function createBrowserAudioContext(sampleRate: number = MOSS_DOWNSTREAM_SAMPLE_RATE): AudioContextLike | null {
  const Ctor =
    (globalThis as unknown as { AudioContext?: new (opts?: AudioContextOptions) => AudioContextLike })
      .AudioContext ||
    (globalThis as unknown as { webkitAudioContext?: new (opts?: AudioContextOptions) => AudioContextLike })
      .webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor({ sampleRate });
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
  private outputGain: AudioGainNodeLike | null = null;
  private volume: number;
  private nextPlayTime = 0;
  private resumeInFlight: Promise<void> | null = null;
  private readonly pendingAudioContexts: PendingAudioContextItem[] = [];
  private readonly pendingAudioFrames: ArrayBufferLike[] = [];
  private readonly pendingChunks: PendingPlaybackChunk[] = [];
  private readonly turnPlaybacks = new Map<string, TurnPlaybackTracker>();
  private readonly options: MossAudioPlayerOptions;
  private readonly sampleRate: number;
  private readonly leadTimeSec: number;
  private readonly enablePlaybackReceipts: boolean;
  private playbackRate: number = 1;

  constructor(options: MossAudioPlayerOptions) {
    this.options = options;
    const rawRate = options.sampleRate;
    this.sampleRate =
      typeof rawRate === "number" && Number.isFinite(rawRate) && rawRate > 0
        ? rawRate
        : MOSS_DOWNSTREAM_SAMPLE_RATE;
    const rawLeadTime = options.leadTimeSec;
    this.leadTimeSec =
      typeof rawLeadTime === "number" && Number.isFinite(rawLeadTime) && rawLeadTime >= 0
        ? rawLeadTime
        : DEFAULT_AUDIO_LEAD_TIME_SEC;
    this.volume = clampVolume(options.volume ?? 1);
    this.playbackRate = clampPlaybackRate(options.speed ?? 1);
    this.enablePlaybackReceipts = options.enablePlaybackReceipts !== false;
  }

  setVolume(volume: number): void {
    this.volume = clampVolume(volume);
    if (this.outputGain) this.outputGain.gain.value = this.volume;
  }

  setPlaybackRate(speed: number): void {
    this.playbackRate = clampPlaybackRate(speed);
  }

  getPlaybackRate(): number {
    return this.playbackRate;
  }

  private ensureAudioContext(): AudioContextLike | null {
    if (!this.audioCtx) {
      this.audioCtx = this.options.createAudioContext
        ? this.options.createAudioContext()
        : createBrowserAudioContext(this.sampleRate);
      if (this.audioCtx) {
        this.outputGain = this.audioCtx.createGain();
        this.outputGain.gain.value = this.volume;
        this.outputGain.connect(this.audioCtx.destination);
      }
    }
    if (this.audioCtx && typeof this.audioCtx.state === "string" && this.audioCtx.state !== "running") {
      this.ensureAudioContextResumed(this.audioCtx);
    }
    return this.audioCtx;
  }

  private ensureAudioContextResumed(audioCtx: AudioContextLike): void {
    if (this.resumeInFlight || audioCtx.state === "closed" || typeof audioCtx.resume !== "function") {
      return;
    }
    let resumePromise: Promise<void>;
    try {
      resumePromise = Promise.resolve(audioCtx.resume());
    } catch {
      this.discardPendingChunksOnResumeFailure();
      return;
    }
    const trackedPromise = resumePromise.then(
      () => {
        if (this.resumeInFlight === trackedPromise) {
          this.resumeInFlight = null;
        }
        if (this.audioCtx !== audioCtx) {
          return;
        }
        if (typeof audioCtx.state === "string" && audioCtx.state !== "running") {
          this.discardPendingChunksOnResumeFailure();
          return;
        }
        this.flushPendingChunks();
      },
      () => {
        if (this.resumeInFlight === trackedPromise) {
          this.resumeInFlight = null;
        }
        if (this.audioCtx !== audioCtx) {
          return;
        }
        this.discardPendingChunksOnResumeFailure();
      }
    );
    this.resumeInFlight = trackedPromise;
  }

  private discardPendingChunksOnResumeFailure(): void {
    if (this.pendingChunks.length === 0) return;
    while (this.pendingChunks.length > 0) {
      const item = this.pendingChunks.shift()!;
      const tracker = this.turnPlaybacks.get(this.getTurnKey(item.context.runId, item.context.turnId));
      if (!tracker || tracker.stopped || item.context.discard) continue;
      tracker.inFlightChunks = Math.max(0, tracker.inFlightChunks - 1);
      this.sendTurnCompletedIfReady(tracker);
    }
    this.options.onStateChange();
  }

  private flushPendingChunks(): void {
    const audioCtx = this.audioCtx;
    if (!audioCtx || (typeof audioCtx.state === "string" && audioCtx.state !== "running")) {
      return;
    }
    while (this.pendingChunks.length > 0) {
      if (this.audioCtx !== audioCtx) return;
      if (typeof audioCtx.state === "string" && audioCtx.state !== "running") {
        this.ensureAudioContextResumed(audioCtx);
        return;
      }
      const item = this.pendingChunks.shift()!;
      const tracker = this.getOrCreateTurnTracker(item.context.runId, item.context.turnId);
      if (item.context.discard || tracker.stopped) {
        continue;
      }
      if (!item.isCurrent()) {
        tracker.inFlightChunks = Math.max(0, tracker.inFlightChunks - 1);
        this.sendTurnCompletedIfReady(tracker);
        this.options.onStateChange();
        continue;
      }
      this.scheduleDecodedChunk(item.context, item.samples, audioCtx, item.isCurrent);
    }
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
    if (
      this.pendingAudioContexts.some((item) => !item.discard) ||
      this.pendingAudioFrames.length > 0 ||
      this.pendingChunks.length > 0
    ) {
      return true;
    }
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

  enqueueAudioChunk(
    chunkId: string,
    runId: string,
    turnId: string,
    pcmBuffer: ArrayBufferLike,
    isCurrent: () => boolean
  ): boolean {
    const tracker = this.getOrCreateTurnTracker(runId, turnId);
    const duplicate = Boolean(chunkId && tracker.claimedChunkIds.has(chunkId));
    const discard = tracker.stopped || tracker.audioDoneReceived || tracker.responseEnded || duplicate;
    if (chunkId && !duplicate) {
      tracker.claimedChunkIds.add(chunkId);
    }
    if (discard) {
      return false;
    }
    tracker.inFlightChunks += 1;
    this.playAudioChunk(
      {
        chunkId,
        runId,
        turnId,
        discard: false
      },
      pcmBuffer,
      isCurrent
    );
    return true;
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
    const playedAudioMs = Math.round((tracker.playedSamples / this.sampleRate) * 1000);
    if (this.enablePlaybackReceipts) {
      this.options.onSendJson?.({
        action: "playback.stopped",
        run_id: runId,
        turn_id: turnId,
        played_audio_ms: playedAudioMs
      });
    }
  }

  stopTurn(runId: string, turnId: string): void {
    const tracker = this.getOrCreateTurnTracker(runId, turnId);
    for (const context of this.pendingAudioContexts) {
      if (context.runId === runId && context.turnId === turnId) context.discard = true;
    }
    for (let i = this.pendingChunks.length - 1; i >= 0; i--) {
      const pending = this.pendingChunks[i];
      if (pending.context.runId === runId && pending.context.turnId === turnId) {
        pending.context.discard = true;
        this.pendingChunks.splice(i, 1);
      }
    }

    const now = this.audioCtx ? this.audioCtx.currentTime : 0;
    for (const entry of tracker.activeSources) {
      entry.source.onended = null;
      if (now > entry.startAt) {
        const elapsedSec = Math.max(0, now - entry.startAt);
        tracker.playedSamples += Math.min(
          entry.sampleCount,
          Math.round(elapsedSec * this.sampleRate * entry.playbackRate)
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

    let maxRemainingEnd = 0;
    let hasOtherActiveSources = false;
    for (const other of this.turnPlaybacks.values()) {
      for (const entry of other.activeSources) {
        hasOtherActiveSources = true;
        maxRemainingEnd = Math.max(
          maxRemainingEnd,
          entry.startAt + entry.sampleCount / (this.sampleRate * entry.playbackRate)
        );
      }
    }
    this.nextPlayTime = hasOtherActiveSources ? Math.max(now, maxRemainingEnd) : 0;
    this.options.onTurnFinished(runId, turnId);
  }

  interruptActiveTurns(): Array<{ runId: string; turnId: string }> {
    // 保留 pendingAudioContexts 槽位并标 discard，以 1:1 吸收并丢弃跨打断边界晚到的分离二进制帧。
    for (const context of this.pendingAudioContexts) {
      context.discard = true;
    }
    this.pendingChunks.length = 0;

    const interrupted: Array<{ runId: string; turnId: string }> = [];
    for (const tracker of [...this.turnPlaybacks.values()]) {
      if (!tracker.stopped && !tracker.completedSent) {
        this.stopTurn(tracker.runId, tracker.turnId);
        tracker.stoppedSent = true;
        const playedAudioMs = Math.round((tracker.playedSamples / this.sampleRate) * 1000);
        if (this.enablePlaybackReceipts) {
          this.options.onSendJson?.({
            action: "playback.stopped",
            run_id: tracker.runId,
            turn_id: tracker.turnId,
            played_audio_ms: playedAudioMs
          });
        }
        interrupted.push({ runId: tracker.runId, turnId: tracker.turnId });
      }
    }
    this.nextPlayTime = 0;
    this.options.onStateChange();
    return interrupted;
  }

  stopAll(): void {
    this.pendingAudioContexts.length = 0;
    this.pendingAudioFrames.length = 0;
    this.pendingChunks.length = 0;
    for (const tracker of [...this.turnPlaybacks.values()]) {
      this.stopTurn(tracker.runId, tracker.turnId);
    }
    this.nextPlayTime = 0;
    this.options.onStateChange();
  }

  reset(): void {
    this.stopAll();
    this.turnPlaybacks.clear();
    this.nextPlayTime = 0;
    this.resumeInFlight = null;
    if (this.audioCtx) {
      const ctx = this.audioCtx;
      this.audioCtx = null;
      this.outputGain?.disconnect();
      this.outputGain = null;
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
    if (this.enablePlaybackReceipts) {
      this.options.onSendJson?.({
        action: "playback.completed",
        run_id: tracker.runId,
        turn_id: tracker.turnId
      });
    }
  }

  private sendChunkCompleted(context: PendingAudioContextItem, tracker: TurnPlaybackTracker): void {
    if (this.enablePlaybackReceipts && context.chunkId) {
      this.options.onSendJson?.({
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

    if (typeof audioCtx.state === "string" && audioCtx.state !== "running") {
      if (audioCtx.state === "closed" || typeof audioCtx.resume !== "function") {
        tracker.inFlightChunks = Math.max(0, tracker.inFlightChunks - 1);
        this.sendTurnCompletedIfReady(tracker);
        this.options.onStateChange();
        return;
      }
      this.pendingChunks.push({ context, samples, isCurrent });
      this.options.onStateChange();
      this.ensureAudioContextResumed(audioCtx);
      return;
    }

    if (this.pendingChunks.length > 0) {
      this.flushPendingChunks();
    }

    this.scheduleDecodedChunk(context, samples, audioCtx, isCurrent);
  }

  private scheduleDecodedChunk(
    context: PendingAudioContextItem,
    samples: Float32Array,
    audioCtx: AudioContextLike,
    isCurrent: () => boolean
  ): void {
    const tracker = this.getOrCreateTurnTracker(context.runId, context.turnId);
    if (context.discard || tracker.stopped) return;

    const audioBuffer = audioCtx.createBuffer(1, samples.length, this.sampleRate);
    audioBuffer.getChannelData(0).set(samples);

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    const rate = this.playbackRate;
    if (source.playbackRate) {
      source.playbackRate.value = rate;
    }
    source.connect(this.outputGain!);

    const startAt =
      this.nextPlayTime <= audioCtx.currentTime
        ? audioCtx.currentTime + this.leadTimeSec
        : this.nextPlayTime;
    const durationSec = samples.length / (this.sampleRate * rate);
    this.nextPlayTime = startAt + durationSec;

    const entry: ActiveSourceEntry = {
      source,
      startAt,
      sampleCount: samples.length,
      playbackRate: rate
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
