import {describe, expect, it} from "vitest";
import {AUDIO, musicVolumeAtFrame} from "../../scripts/promo/audio.mjs";
import {OUTRO_TIMELINE} from "../../scripts/promo/outro-timeline.mjs";
import {CHAT_TIMESTAMP_CLICK_FRAME, PROMO_DURATION, PROMO_FPS, PROVIDER_TIMELINE, SCENES} from "../../scripts/promo/timeline.mjs";

const CHAT_FROM = SCENES.find((scene) => scene.id === "chat")!.from;
const PROVIDERS_FROM = SCENES.find((scene) => scene.id === "providers")!.from;

describe("宣传片配乐", () => {
  it("用原创 Tech Pop 配乐把全部主要切点落在 120 BPM 节拍上", () => {
    expect(AUDIO.music).toMatchObject({
      src: "media/promo-score.wav",
      style: "Tech Pop",
      bpm: 120,
      license: "Original work; MIT License",
      gain: 0.8,
      fadeInFrames: 24,
      fadeOutFrames: 60,
      fadeOutEndFrame: PROMO_DURATION
    });
    expect(PROMO_DURATION).toBe(33 * PROMO_FPS);
    expect(AUDIO.music.durationInFrames).toBe(PROMO_DURATION);
    for (const scene of SCENES.slice(1)) {
      expect(scene.from * AUDIO.music.bpm / 60 % PROMO_FPS, scene.id).toBe(0);
    }
  });

  it("把克制的 UI 音效放在真实操作的同一帧", () => {
    expect(AUDIO.cues.map((cue) => [cue.id, cue.frame, cue.src])).toEqual([
      ["hook-q1", 4, "media/sfx/pop.wav"],
      ["hook-q2", 16, "media/sfx/pop.wav"],
      ["hook-q3", 32, "media/sfx/pop.wav"],
      ["hero-pullback", 54, "media/sfx/whoosh.wav"],
      ["hero-open", 56, "media/sfx/click.wav"],
      ["subtitle-cut", 90, "media/sfx/whoosh.wav"],
      ["subtitle-keyword-resolve", 100, "media/sfx/click.wav"],
      ["type-huan", 102, "media/sfx/key.wav"],
      ["type-jue", 106, "media/sfx/key.wav"],
      ["subtitle-seek", 151, "media/sfx/click.wav"],
      ["overview-cut", 210, "media/sfx/whoosh.wav"],
      ["chapters-quote-cut", 262, "media/sfx/whoosh.wav"],
      ["quote-card", 278, "media/sfx/pop.wav"],
      ["quote-slate", 283, "media/sfx/pop.wav"],
      ["quote-mist", 295, "media/sfx/pop.wav"],
      ["overview-defocus", 324, "media/sfx/click.wav"],
      ["chat-focus", 337, "media/sfx/whoosh.wav"],
      ["chat-timestamp-click", CHAT_FROM + CHAT_TIMESTAMP_CLICK_FRAME, "media/sfx/click.wav"],
      ["chat-defocus", 504, "media/sfx/click.wav"],
      ["appearance-focus", 517, "media/sfx/whoosh.wav"],
      ["dark-mode", 531, "media/sfx/toggle.wav"],
      ["editorial-palette", 567, "media/sfx/pop.wav"],
      ["provider-expand", PROVIDERS_FROM + PROVIDER_TIMELINE.expandAt, "media/sfx/click.wav"],
      ["provider-count", PROVIDERS_FROM + PROVIDER_TIMELINE.countAt, "media/sfx/pop.wav"],
      ["provider-wall", PROVIDERS_FROM + PROVIDER_TIMELINE.wallAt, "media/sfx/chord.wav"],
      ["provider-collapse", PROVIDERS_FROM + PROVIDER_TIMELINE.collapseAt, "media/sfx/click.wav"],
      ["outro-cut", OUTRO_TIMELINE.from, "media/sfx/whoosh.wav"],
      ...OUTRO_TIMELINE.features.map((feature) => [feature.id, OUTRO_TIMELINE.from + feature.at, "media/sfx/pop.wav"]),
      ["brand-resolve", OUTRO_TIMELINE.from + OUTRO_TIMELINE.brandResolveAt, "media/sfx/resolve.wav"],
      ["install-click", OUTRO_TIMELINE.from + OUTRO_TIMELINE.installClickAt, "media/sfx/click.wav"]
    ]);
    expect(new Set(AUDIO.cues.map((cue) => cue.id)).size).toBe(AUDIO.cues.length);
    expect(AUDIO.cues.every((cue) => cue.frame >= 0 && cue.frame < PROMO_DURATION)).toBe(true);
    expect(AUDIO.cues.every((cue) => cue.gain > 0 && cue.gain <= 0.55)).toBe(true);
  });

  it("让配乐在音效前预先让位，重叠时只取最深压低并自然淡入淡出", () => {
    const base = AUDIO.music.gain;
    const installClickFrame = OUTRO_TIMELINE.from + OUTRO_TIMELINE.installClickAt;
    expect(musicVolumeAtFrame(0)).toBe(0);
    expect(musicVolumeAtFrame(24)).toBeCloseTo(base * 10 ** (-3.5 / 20));
    expect(musicVolumeAtFrame(76)).toBe(base);
    expect(musicVolumeAtFrame(90)).toBeCloseTo(base * 10 ** (-5 / 20));
    expect(musicVolumeAtFrame(102)).toBeCloseTo(base * 10 ** (-3.5 / 20));
    expect(musicVolumeAtFrame(104)).toBeCloseTo(base * 10 ** (-3.5 / 20));
    expect(musicVolumeAtFrame(116)).toBeGreaterThan(musicVolumeAtFrame(114));
    expect(musicVolumeAtFrame(860)).toBe(base);
    expect(musicVolumeAtFrame(installClickFrame)).toBeCloseTo(base * 10 ** (-4 / 20));
    expect(musicVolumeAtFrame(PROMO_DURATION - AUDIO.music.fadeOutFrames / 2)).toBeCloseTo(base / 2);
    expect(musicVolumeAtFrame(PROMO_DURATION - 1)).toBeCloseTo(base / AUDIO.music.fadeOutFrames);
    expect(musicVolumeAtFrame(PROMO_DURATION)).toBe(0);
  });
});
