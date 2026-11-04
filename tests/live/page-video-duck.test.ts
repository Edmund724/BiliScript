import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  MOSS_VIDEO_DUCK_MIN_VOLUME,
  MOSS_VIDEO_DUCK_RATIO,
  createPageVideoDuck,
  getDuckedVolume
} from "../../extension/live/page-video-duck.js";

class FakeVideo extends EventTarget {
  private currentVolume: number;
  readonly writes: number[] = [];

  constructor(volume: number) {
    super();
    this.currentVolume = volume;
  }

  get volume(): number {
    return this.currentVolume;
  }

  set volume(value: number) {
    this.currentVolume = value;
    this.writes.push(value);
  }
}

class FrameDriver {
  time = 0;
  private nextHandle = 1;
  private readonly callbacks = new Map<number, (time: number) => void>();

  request = (callback: (time: number) => void): number => {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  };

  cancel = (handle: number): void => {
    this.callbacks.delete(handle);
  };

  step(ms: number): void {
    this.time += ms;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(this.time);
  }

  settle(): void {
    this.step(0);
    this.step(100);
  }
}

beforeEach(() => {
  resetModuleState();
});

describe("createPageVideoDuck", () => {
  function setup(initialVolume = 0.8) {
    const video = new FakeVideo(initialVolume);
    const frames = new FrameDriver();
    let currentVideo = video as FakeVideo | null;
    const duck = createPageVideoDuck({
      getVideo: () => currentVideo as unknown as HTMLVideoElement | null,
      transitionMs: 100,
      now: () => frames.time,
      requestFrame: frames.request,
      cancelFrame: frames.cancel
    });
    return {
      video,
      frames,
      duck,
      setVideo: (next: FakeVideo | null) => {
        currentVideo = next;
      }
    };
  }

  it("smoothly ducks by 0.18 with a 0.05 floor and restores without compounding", () => {
    expect(getDuckedVolume(0.8)).toBeCloseTo(0.8 * MOSS_VIDEO_DUCK_RATIO, 5);
    expect(getDuckedVolume(0.1)).toBe(MOSS_VIDEO_DUCK_MIN_VOLUME);

    const { video, frames, duck } = setup();
    duck.setDucked(true);
    frames.step(50);
    expect(video.volume).toBeGreaterThan(0.144);
    expect(video.volume).toBeLessThan(0.8);
    frames.step(50);
    expect(video.volume).toBeCloseTo(0.144, 5);

    duck.setDucked(true);
    frames.settle();
    expect(video.volume).toBeCloseTo(0.144, 5);
    duck.setDucked(false);
    frames.settle();
    expect(video.volume).toBeCloseTo(0.8, 5);

    const writeCount = video.writes.length;
    duck.setDucked(false);
    frames.settle();
    expect(video.writes).toHaveLength(writeCount);
    duck.stop();
  });

  it("uses a manual volume change as the new restore target", () => {
    const { video, frames, duck } = setup();
    duck.setDucked(true);
    frames.settle();

    video.volume = 0.6;
    video.dispatchEvent(new Event("volumechange"));
    frames.settle();
    expect(video.volume).toBeCloseTo(0.108, 5);

    duck.setDucked(false);
    frames.settle();
    expect(video.volume).toBeCloseTo(0.6, 5);
    duck.stop();
  });

  it("restores on SPA navigation and never carries ducking to a replacement node", () => {
    const { video, frames, duck, setVideo } = setup(0.7);
    duck.setDucked(true);
    frames.settle();
    expect(video.volume).toBeCloseTo(0.126, 5);

    window.dispatchEvent(new Event("biliscript:urlchange"));
    frames.settle();
    expect(video.volume).toBeCloseTo(0.7, 5);

    duck.setDucked(true);
    frames.settle();
    const replacement = new FakeVideo(0.9);
    const oldWriteCount = video.writes.length;
    setVideo(replacement);
    frames.settle();
    expect(video.writes).toHaveLength(oldWriteCount);
    expect(replacement.volume).toBe(0.9);
    expect(replacement.writes).toHaveLength(0);
    duck.stop();
  });

  it("handles quick repeated turns and hangup without stacked ducking or repeated restore", () => {
    const { video, frames, duck } = setup();
    duck.setDucked(true);
    frames.settle();
    duck.setDucked(false);
    frames.step(30);
    duck.setDucked(true);
    frames.settle();
    expect(video.volume).toBeCloseTo(0.144, 5);

    duck.stop();
    expect(video.volume).toBeCloseTo(0.8, 5);
    const writeCount = video.writes.length;
    duck.stop();
    duck.setDucked(true);
    frames.settle();
    expect(video.writes).toHaveLength(writeCount);
  });
});
