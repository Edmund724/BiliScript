import {describe, expect, it} from "vitest";
import {AUDIO, musicVolumeAtFrame} from "../../scripts/promo/audio.mjs";
import {OUTRO_TIMELINE} from "../../scripts/promo/outro-timeline.mjs";
import {PROVIDER_LOGOS} from "../../scripts/promo/provider-logos.mjs";
import {SUBTITLE_MATCH_FRAME} from "../../scripts/promo/subtitle-timeline.mjs";
import {
  CHAT_PLAYER_VERIFY_FROM,
  CHAT_TIMESTAMP_CLICK_FRAME,
  PROMO_DURATION,
  PROMO_FPS,
  PROVIDER_TIMELINE,
  SCENES
} from "../../scripts/promo/timeline.mjs";

const SUBTITLE_FROM = SCENES.find((scene) => scene.id === "subtitle")!.from;
const OVERVIEW_FROM = SCENES.find((scene) => scene.id === "overview")!.from;
const CHAT_FROM = SCENES.find((scene) => scene.id === "chat")!.from;
const PROVIDERS_FROM = SCENES.find((scene) => scene.id === "providers")!.from;

describe("宣传片配乐与三幕原声问答", () => {
  it("用原创 Tech Pop 配乐把全部主要切点落在 120 BPM 节拍上", () => {
    expect(AUDIO.music).toMatchObject({
      src: "media/promo-score.wav",
      style: "Tech Pop · Sound Design",
      bpm: 120,
      license: "Original work; MIT License",
      gain: 0.8,
      fadeInFrames: 24,
      fadeOutFrames: 60,
      fadeOutEndFrame: PROMO_DURATION
    });
    expect(PROMO_DURATION).toBe(35 * PROMO_FPS);
    expect(AUDIO.music.durationInFrames).toBe(PROMO_DURATION);
    for (const scene of SCENES.slice(1)) {
      expect((scene.from * AUDIO.music.bpm) / 60 % PROMO_FPS, scene.id).toBe(0);
    }
  });

  it("把定制拟音与三段原片老师回应放在真实交互帧上", () => {
    expect(AUDIO.cues.map((cue) => [cue.id, cue.frame, cue.src])).toEqual([
      ["hook-pain", 4, "media/sfx/pop.wav"],
      ["hero-pullback", 51, "media/sfx/whoosh.wav"],
      ["hero-open", 56, "media/sfx/click.wav"],
      ["hero-snap", 76, "media/sfx/finger-snap.wav"],
      ["subtitle-cut", 105, "media/sfx/whoosh.wav"],
      ["subtitle-keyword-resolve", 113, "media/sfx/click.wav"],
      ["type-huan", 117, "media/sfx/mech-key-1.wav"],
      ["type-jue", 121, "media/sfx/mech-key-2.wav"],
      ["type-enter", 125, "media/sfx/mech-enter.wav"],
      ["subtitle-seek-snap", SUBTITLE_FROM + SUBTITLE_MATCH_FRAME, "media/sfx/snap.wav"],
      ["overview-cut", 225, "media/sfx/whoosh.wav"],
      ["voice-0232-fade", 270, "media/sfx/voice-fade.wav"],
      ["chapters-quote-cut", 303, "media/sfx/whoosh.wav"],
      ["quote-save", 317, "media/sfx/polaroid-shutter.wav"],
      ["overview-defocus", 339, "media/sfx/click.wav"],
      ["chat-focus", 352, "media/sfx/whoosh.wav"],
      ["chat-timestamp-click", CHAT_FROM + CHAT_TIMESTAMP_CLICK_FRAME, "media/sfx/snap.wav"],
      ["chat-defocus", 519, "media/sfx/click.wav"],
      ["appearance-focus", 532, "media/sfx/whoosh.wav"],
      ["dark-mode", 546, "media/sfx/toggle.wav"],
      ["editorial-palette", 582, "media/sfx/shutter-2.wav"],
      ["provider-plate", PROVIDERS_FROM + PROVIDER_TIMELINE.plateAt, "media/sfx/pop.wav"],
      ["provider-orbit", PROVIDERS_FROM + PROVIDER_TIMELINE.orbitAt, "media/sfx/chord.wav"],
      ...PROVIDER_LOGOS.map((logo, index) => [
        `provider-bubble-${logo.id}`,
        Math.round(PROVIDERS_FROM + PROVIDER_TIMELINE.orbitAt + index * PROVIDER_TIMELINE.logoStagger),
        `media/sfx/bubble-${String(index + 1).padStart(2, "0")}.wav`
      ]),
      ["provider-exit", PROVIDERS_FROM + PROVIDER_TIMELINE.exitAt, "media/sfx/snap.wav"],
      ["outro-cut", OUTRO_TIMELINE.from, "media/sfx/whoosh.wav"],
      ...OUTRO_TIMELINE.features.map((feature) => [feature.id, OUTRO_TIMELINE.from + feature.at, "media/sfx/pop.wav"]),
      ["brand-resolve", OUTRO_TIMELINE.from + OUTRO_TIMELINE.brandResolveAt, "media/sfx/resolve.wav"],
      ["install-click", OUTRO_TIMELINE.from + OUTRO_TIMELINE.installClickAt, "media/sfx/snap.wav"]
    ]);
    expect(AUDIO.voices.map((voice) => [voice.id, voice.frame, voice.src])).toEqual([
      ["voice-0407", SUBTITLE_FROM + SUBTITLE_MATCH_FRAME + 2, "media/sfx/voice-0407.wav"],
      ["voice-0232", OVERVIEW_FROM + 5, "media/sfx/voice-0232.wav"],
      ["voice-0444", CHAT_FROM + CHAT_PLAYER_VERIFY_FROM, "media/sfx/voice-0444.wav"]
    ]);
    expect(new Set(AUDIO.cues.map((cue) => cue.id)).size).toBe(AUDIO.cues.length);
    expect(AUDIO.cues.every((cue) => cue.frame >= 0 && cue.frame < PROMO_DURATION)).toBe(true);
    expect(AUDIO.cues.every((cue) => cue.gain > 0 && cue.gain <= 0.66)).toBe(true);
  });

  it("让配乐在音效前预先让位，重叠时只取最深压低并自然淡入淡出", () => {
    const base = AUDIO.music.gain;
    const installClickFrame = OUTRO_TIMELINE.from + OUTRO_TIMELINE.installClickAt;
    expect(musicVolumeAtFrame(0)).toBe(0);
    expect(musicVolumeAtFrame(12)).toBeCloseTo(base * 0.5 * 10 ** (-4 / 20));
    expect(musicVolumeAtFrame(24)).toBe(base);
    expect(musicVolumeAtFrame(94)).toBe(base);
    expect(musicVolumeAtFrame(105)).toBeCloseTo(base * 10 ** (-5 / 20));
    expect(musicVolumeAtFrame(117)).toBeCloseTo(base * 10 ** (-3.8 / 20));
    expect(musicVolumeAtFrame(119)).toBeCloseTo(base * 10 ** (-3.8 / 20));
    expect(musicVolumeAtFrame(137)).toBeGreaterThan(musicVolumeAtFrame(133));
    expect(musicVolumeAtFrame(SUBTITLE_FROM + SUBTITLE_MATCH_FRAME + 20)).toBeCloseTo(base * 10 ** (-11.5 / 20));
    expect(musicVolumeAtFrame(OVERVIEW_FROM + 20)).toBeCloseTo(base * 10 ** (-11.5 / 20));
    expect(musicVolumeAtFrame(CHAT_FROM + CHAT_PLAYER_VERIFY_FROM + 15)).toBeCloseTo(base * 10 ** (-11.5 / 20));
    expect(musicVolumeAtFrame(850)).toBe(base);
    expect(musicVolumeAtFrame(installClickFrame)).toBeCloseTo(base * 10 ** (-4.2 / 20));
    expect(musicVolumeAtFrame(PROMO_DURATION - AUDIO.music.fadeOutFrames / 2)).toBeCloseTo(base / 2);
    expect(musicVolumeAtFrame(PROMO_DURATION - 1)).toBeCloseTo(base / AUDIO.music.fadeOutFrames);
    expect(musicVolumeAtFrame(PROMO_DURATION)).toBe(0);
  });
});
