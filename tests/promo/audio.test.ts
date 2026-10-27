import {describe, expect, it} from "vitest";
import {AUDIO, musicVolumeAtFrame} from "../../scripts/promo/audio.mjs";
import {PROMO_DURATION, PROMO_FPS, SCENES} from "../../scripts/promo/timeline.mjs";

describe("宣传片配乐", () => {
  it("用原创 Tech Pop 配乐把全部主要切点落在 120 BPM 节拍上", () => {
    expect(AUDIO.music).toMatchObject({
      src: "media/promo-score.wav",
      style: "Tech Pop",
      bpm: 120,
      license: "Original work; MIT License",
      gain: 0.8,
      fadeInFrames: 24,
      fadeOutFrames: 60
    });
    expect(AUDIO.music.durationInFrames).toBe(PROMO_DURATION);
    for (const scene of SCENES.slice(1)) {
      expect(scene.from * AUDIO.music.bpm / 60 % PROMO_FPS, scene.id).toBe(0);
    }
  });

  it("把克制的 UI 音效放在真实操作的同一帧", () => {
    expect(AUDIO.cues.map((cue) => [cue.id, cue.frame, cue.src])).toEqual([
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
      ["chat-defocus", 504, "media/sfx/click.wav"],
      ["appearance-focus", 517, "media/sfx/whoosh.wav"],
      ["dark-mode", 531, "media/sfx/toggle.wav"],
      ["editorial-palette", 567, "media/sfx/pop.wav"],
      ["provider-expand", 618, "media/sfx/click.wav"],
      ["provider-count", 627, "media/sfx/pop.wav"],
      ["provider-wall", 634, "media/sfx/chord.wav"],
      ["provider-collapse", 654, "media/sfx/click.wav"],
      ["outro-cut", 660, "media/sfx/whoosh.wav"],
      ["feature-bilingual", 668, "media/sfx/pop.wav"],
      ["feature-export", 676, "media/sfx/pop.wav"],
      ["feature-asr", 683, "media/sfx/pop.wav"],
      ["feature-search", 691, "media/sfx/pop.wav"],
      ["brand-resolve", 710, "media/sfx/resolve.wav"],
      ["install-click", 768, "media/sfx/click.wav"]
    ]);
    expect(new Set(AUDIO.cues.map((cue) => cue.id)).size).toBe(AUDIO.cues.length);
    expect(AUDIO.cues.every((cue) => cue.frame >= 0 && cue.frame < PROMO_DURATION)).toBe(true);
    expect(AUDIO.cues.every((cue) => cue.gain > 0 && cue.gain <= 0.55)).toBe(true);
  });

  it("让配乐在音效前预先让位，重叠时只取最深压低并自然淡入淡出", () => {
    const base = AUDIO.music.gain;
    expect(musicVolumeAtFrame(0)).toBe(0);
    expect(musicVolumeAtFrame(24)).toBe(base);
    expect(musicVolumeAtFrame(90)).toBeCloseTo(base * 10 ** (-4 / 20));
    expect(musicVolumeAtFrame(102)).toBeCloseTo(base * 10 ** (-2.5 / 20));
    expect(musicVolumeAtFrame(104)).toBeCloseTo(base * 10 ** (-2.5 / 20));
    expect(musicVolumeAtFrame(116)).toBeGreaterThan(musicVolumeAtFrame(114));
    expect(musicVolumeAtFrame(800)).toBe(base);
    expect(musicVolumeAtFrame(PROMO_DURATION - 1)).toBeCloseTo(base / 60);
  });
});
