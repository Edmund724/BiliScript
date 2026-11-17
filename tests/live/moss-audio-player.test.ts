import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AUDIO_LEAD_TIME_SEC,
  MossAudioPlayer,
  type AudioContextLike
} from "../../extension/live/moss-audio-player.js";
import { encodeFloat32ToPcmS16LE } from "../../extension/live/moss-live-protocol.js";

function createControllableAudioContext(initialState: "running" | "suspended" = "running") {
  const gain = { value: 1 };
  const outputGain = {
    gain,
    connect: (_destination: unknown) => {},
    disconnect: () => {}
  };
  let connectedDestination: unknown = null;
  let resolveResume: (() => void) | null = null;
  let rejectResume: ((err?: unknown) => void) | null = null;
  const resumeCalls: number[] = [];

  const sources: Array<{
    buffer: ReturnType<AudioContextLike["createBuffer"]> | null;
    playbackRate: { value: number };
    onended: (() => void) | null;
    startedAt: number | null;
    stopped: boolean;
    connect: (dest: unknown) => void;
    disconnect: () => void;
    start: (when?: number) => void;
    stop: () => void;
  }> = [];

  const audioContext: AudioContextLike & {
    currentTime: number;
    state: string;
    resumeCalls: number[];
    finishResume: () => Promise<void>;
    failResume: (err?: Error) => Promise<void>;
  } = {
    currentTime: 0,
    state: initialState,
    destination: {},
    resumeCalls,
    resume: () => {
      resumeCalls.push(1);
      return new Promise<void>((resolve, reject) => {
        resolveResume = resolve;
        rejectResume = reject;
      });
    },
    async finishResume() {
      this.state = "running";
      const r = resolveResume;
      resolveResume = null;
      rejectResume = null;
      r?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    async failResume(err = new Error("resume failed")) {
      const r = rejectResume;
      resolveResume = null;
      rejectResume = null;
      r?.(err);
      await Promise.resolve();
      await Promise.resolve();
    },
    createBuffer: (_channels: number, length: number, sampleRate: number) => ({
      duration: length / sampleRate,
      length,
      sampleRate,
      getChannelData: () => new Float32Array(length)
    }),
    createBufferSource: () => {
      const source = {
        buffer: null as ReturnType<AudioContextLike["createBuffer"]> | null,
        playbackRate: { value: 1 },
        onended: null as (() => void) | null,
        startedAt: null as number | null,
        stopped: false,
        connect: (destination: unknown) => {
          connectedDestination = destination;
        },
        disconnect: () => {},
        start: (when = 0) => {
          source.startedAt = when;
        },
        stop: () => {
          source.stopped = true;
        }
      };
      sources.push(source);
      return source;
    },
    createGain: () => outputGain
  };

  return {
    audioContext,
    gain,
    outputGain,
    sources,
    getConnectedDestination: () => connectedDestination
  };
}

describe("MossAudioPlayer volume, cold-start pendingChunks & scheduling cursor", () => {
  it("routes audio through one gain and updates it without restarting playback", () => {
    const { audioContext, gain, outputGain, getConnectedDestination } = createControllableAudioContext();
    const player = new MossAudioPlayer({
      volume: 0.8,
      createAudioContext: () => audioContext,
      onTurnFinished: () => {},
      onStateChange: () => {}
    });
    const isCurrent = () => true;
    player.enqueueAudioContext("chunk-1", "run-1", "turn-1", isCurrent);
    player.enqueueAudioFrame(
      encodeFloat32ToPcmS16LE(new Float32Array(4800).fill(0.2)).buffer,
      isCurrent
    );

    expect(getConnectedDestination()).toBe(outputGain);
    expect(gain.value).toBe(0.8);

    player.setVolume(0.25);
    expect(gain.value).toBe(0.25);
    player.setVolume(-1);
    expect(gain.value).toBe(0);
    player.setVolume(2);
    expect(gain.value).toBe(1);
  });

  it("applies playbackRate to created source nodes and adds leadTimeSec on cold start", () => {
    const { audioContext, sources } = createControllableAudioContext();
    audioContext.currentTime = 10;
    const player = new MossAudioPlayer({
      speed: 1.5,
      sampleRate: 48000,
      createAudioContext: () => audioContext,
      onTurnFinished: () => {},
      onStateChange: () => {}
    });

    expect(player.getPlaybackRate()).toBe(1.5);
    const isCurrent = () => true;
    player.enqueueAudioContext("chunk-1", "run-1", "turn-1", isCurrent);
    player.enqueueAudioFrame(
      encodeFloat32ToPcmS16LE(new Float32Array(48000).fill(0.1)).buffer,
      isCurrent
    );

    expect(sources[0].playbackRate.value).toBe(1.5);
    expect(sources[0].startedAt).toBeCloseTo(10 + DEFAULT_AUDIO_LEAD_TIME_SEC, 5);

    player.setPlaybackRate(2.0);
    expect(player.getPlaybackRate()).toBe(2.0);
  });

  it("queues cold-start chunks in pendingChunks while suspended and flushes FIFO once resume() settles", async () => {
    const { audioContext, sources } = createControllableAudioContext("suspended");
    const player = new MossAudioPlayer({
      sampleRate: 48000,
      createAudioContext: () => audioContext,
      onTurnFinished: () => {},
      onStateChange: () => {}
    });
    const isCurrent = () => true;

    const c1 = encodeFloat32ToPcmS16LE(new Float32Array(4800).fill(0.2)); // 0.1s
    const c2 = encodeFloat32ToPcmS16LE(new Float32Array(9600).fill(-0.2)); // 0.2s

    player.enqueueAudioContext("c1", "r1", "t1", isCurrent);
    player.enqueueAudioFrame(c1.buffer, isCurrent);
    player.enqueueAudioContext("c2", "r1", "t1", isCurrent);
    player.enqueueAudioFrame(c2.buffer, isCurrent);

    // Suspended: neither source has been scheduled at t=0; single-flight resume triggered once
    expect(sources).toHaveLength(0);
    expect(audioContext.resumeCalls).toHaveLength(1);
    expect(player.isPlaying()).toBe(true);

    audioContext.currentTime = 0.05;
    await audioContext.finishResume();

    expect(sources).toHaveLength(2);
    expect(sources[0].buffer?.length).toBe(4800);
    expect(sources[0].startedAt).toBeCloseTo(0.05 + DEFAULT_AUDIO_LEAD_TIME_SEC, 5);
    expect(sources[1].buffer?.length).toBe(9600);
    expect(sources[1].startedAt).toBeCloseTo(0.15 + DEFAULT_AUDIO_LEAD_TIME_SEC, 5);
  });

  it("discards pendingChunks on stopTurn / stopAll / reset while resume() is in flight", async () => {
    const { audioContext, sources } = createControllableAudioContext("suspended");
    const player = new MossAudioPlayer({
      sampleRate: 48000,
      createAudioContext: () => audioContext,
      onTurnFinished: () => {},
      onStateChange: () => {}
    });
    const isCurrent = () => true;

    player.enqueueAudioContext("c1", "r1", "t1", isCurrent);
    player.enqueueAudioFrame(encodeFloat32ToPcmS16LE(new Float32Array(4800)).buffer, isCurrent);
    expect(player.isPlaying()).toBe(true);

    player.stopTurn("r1", "t1");
    expect(player.isPlaying()).toBe(false);

    await audioContext.finishResume();
    expect(sources).toHaveLength(0);

    // Also test stopAll & reset during suspended state
    audioContext.state = "suspended";
    player.enqueueAudioContext("c2", "r2", "t2", isCurrent);
    player.enqueueAudioFrame(encodeFloat32ToPcmS16LE(new Float32Array(4800)).buffer, isCurrent);
    player.reset();
    expect(player.isPlaying()).toBe(false);
    await audioContext.finishResume();
    expect(sources).toHaveLength(0);
  });

  it("clears pendingChunks and resolves turn completion cleanly if resume() rejects", async () => {
    const { audioContext, sources } = createControllableAudioContext("suspended");
    const onSendJson = vi.fn();
    const onStateChange = vi.fn();
    const player = new MossAudioPlayer({
      sampleRate: 48000,
      createAudioContext: () => audioContext,
      onSendJson,
      onTurnFinished: () => {},
      onStateChange
    });
    const isCurrent = () => true;

    player.enqueueAudioContext("c1", "r1", "t1", isCurrent);
    player.enqueueAudioFrame(encodeFloat32ToPcmS16LE(new Float32Array(4800)).buffer, isCurrent);
    player.handleAudioDone("r1", "t1");
    expect(player.isPlaying()).toBe(true);

    await audioContext.failResume();

    expect(sources).toHaveLength(0);
    expect(player.isPlaying()).toBe(false);
    expect(onSendJson).toHaveBeenCalledWith({
      action: "playback.completed",
      run_id: "r1",
      turn_id: "t1"
    });
  });

  it("absorbs micro-jitter within leadTime without gaps, and re-injects leadTime only on true underrun", () => {
    const { audioContext, sources } = createControllableAudioContext("running");
    const player = new MossAudioPlayer({
      sampleRate: 48000,
      leadTimeSec: 0.04,
      createAudioContext: () => audioContext,
      onTurnFinished: () => {},
      onStateChange: () => {}
    });
    const isCurrent = () => true;
    const chunk100ms = encodeFloat32ToPcmS16LE(new Float32Array(4800).fill(0.2));

    // Chunk 1 at t=1.0 -> startAt = 1.04, nextPlayTime = 1.14
    audioContext.currentTime = 1.0;
    player.enqueueAudioContext("c1", "r1", "t1", isCurrent);
    player.enqueueAudioFrame(chunk100ms.buffer, isCurrent);
    expect(sources[0].startedAt).toBeCloseTo(1.04, 5);

    // Chunk 2 arrives after 20ms jitter (t=1.02 < 1.14) -> chained seamlessly at 1.14 (NO gap!)
    audioContext.currentTime = 1.02;
    player.enqueueAudioContext("c2", "r1", "t1", isCurrent);
    player.enqueueAudioFrame(chunk100ms.buffer, isCurrent);
    expect(sources[1].startedAt).toBeCloseTo(1.14, 5); // nextPlayTime = 1.24

    // True underrun: clock jumps to 1.50 > 1.24 -> fresh 40ms lead time -> 1.54
    audioContext.currentTime = 1.50;
    player.enqueueAudioContext("c3", "r1", "t1", isCurrent);
    player.enqueueAudioFrame(chunk100ms.buffer, isCurrent);
    expect(sources[2].startedAt).toBeCloseTo(1.54, 5);
  });
});
