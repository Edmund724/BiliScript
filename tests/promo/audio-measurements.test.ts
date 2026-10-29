import {describe, expect, it} from "vitest";
import {FADE_OUT_TAIL_MAX_DB, measureFadeOutTail, windowRmsDb} from "../../scripts/promo/audio-measurements.mjs";

const SAMPLE_RATE = 1000;

function pcm({duration, tailFrame}: {duration: number; tailFrame: number}, {tail = 3, body = 16384} = {}) {
  const samples = new Int16Array(Math.round(duration * SAMPLE_RATE));
  for (let frame = 0; frame < samples.length; frame += 1) {
    samples[frame] = frame >= tailFrame ? tail : body;
  }
  return samples;
}

describe("成片淡出尾部测量", () => {
  it("用最后 100ms 与前 400ms 的真实 RMS 判断淡出，而不是空窗口", () => {
    const samples = pcm({duration: 1, tailFrame: 900});
    const measured = measureFadeOutTail({samples, channels: 1, sampleRate: SAMPLE_RATE, duration: 1});

    expect(measured.fromSeconds).toBe(0.9);
    expect(measured.toSeconds).toBe(1);
    expect(measured.tailRmsDb).toBeCloseTo(20 * Math.log10(3 / 32768), 5);
    expect(measured.previousRmsDb).toBeCloseTo(-6.0206, 3);
    expect(measured.tailRmsDb).toBeLessThanOrEqual(FADE_OUT_TAIL_MAX_DB);
  });

  it("尾部电平未降时测出高 RMS，阈值判断能够失败", () => {
    const samples = pcm({duration: 1, tailFrame: 1000});
    const measured = measureFadeOutTail({samples, channels: 1, sampleRate: SAMPLE_RATE, duration: 1});

    expect(measured.tailRmsDb).toBeCloseTo(-6.0206, 3);
    expect(measured.tailRmsDb).toBeGreaterThan(FADE_OUT_TAIL_MAX_DB);
  });

  it("窗口不足两个采样帧时直接报错，不返回可被阈值放过的空值", () => {
    const samples = pcm({duration: 0.001, tailFrame: 0});

    expect(() => measureFadeOutTail({samples, channels: 1, sampleRate: SAMPLE_RATE, duration: 0.001})).toThrow(/淡出尾部测量窗口为空/);
  });

  it("按声道交错读取立体声采样", () => {
    const samples = new Int16Array([16384, -16384, 16384, -16384]);

    expect(windowRmsDb(samples, {channels: 2, sampleRate: SAMPLE_RATE, fromSeconds: 0, toSeconds: 2})).toBeCloseTo(-6.0206, 3);
  });
});
