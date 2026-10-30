import {describe, expect, it} from "vitest";
import {AUDIO, musicVolumeAtFrame} from "../../scripts/promo/audio.mjs";
import {OUTRO_TIMELINE} from "../../scripts/promo/outro-timeline.mjs";
import {PROVIDER_LOGOS} from "../../scripts/promo/provider-logos.mjs";
import {SUBTITLE_MATCH_FRAME} from "../../scripts/promo/subtitle-timeline.mjs";
import {
  APPEARANCE_TIMELINE,
  CHAT_PLAYER_VERIFY_FROM,
  CHAT_TIMESTAMP_CLICK_FRAME,
  OVERVIEW_TIMELINE,
  PROMO_DURATION,
  PROMO_FPS,
  PROVIDER_TIMELINE,
  SCENES,
  SUBTOOLS_TIMELINE,
  WEBSEARCH_TIMELINE
} from "../../scripts/promo/timeline.mjs";

const SUBTITLE_FROM = SCENES.find((scene) => scene.id === "subtitle")!.from;
const OVERVIEW_SCENE = SCENES.find((scene) => scene.id === "overview")!;
const OVERVIEW_FROM = OVERVIEW_SCENE.from;
const OVERVIEW_CHAPTER_FRAMES = Math.round(OVERVIEW_SCENE.duration * OVERVIEW_TIMELINE.chapterRatio);
const CHAT_FROM = SCENES.find((scene) => scene.id === "chat")!.from;
const SUBTOOLS_FROM = SCENES.find((scene) => scene.id === "subtools")!.from;
const WEBSEARCH_FROM = SCENES.find((scene) => scene.id === "websearch")!.from;
const APPEARANCE_FROM = SCENES.find((scene) => scene.id === "appearance")!.from;
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

  it("把定制拟音与三段原片老师回应放在真实交互帧上，02:32 原声延后至金句卡弹出时印证", () => {
    expect(AUDIO.cues.map((cue) => [cue.id, cue.frame, cue.src])).toEqual([
      ["hook-pain", 4, "media/sfx/pop.wav"],
      ["hero-pullback", 51, "media/sfx/whoosh.wav"],
      ["hero-open", 56, "media/sfx/click.wav"],
      ["hero-snap", 76, "media/sfx/finger-snap.wav"],
      ["subtitle-cut", SUBTITLE_FROM, "media/sfx/whoosh.wav"],
      ["subtitle-keyword-resolve", SUBTITLE_FROM + 8, "media/sfx/click.wav"],
      ["type-huan", SUBTITLE_FROM + 12, "media/sfx/mech-key-1.wav"],
      ["type-jue", SUBTITLE_FROM + 16, "media/sfx/mech-key-2.wav"],
      ["type-enter", SUBTITLE_FROM + 20, "media/sfx/mech-enter.wav"],
      ["subtitle-seek-snap", SUBTITLE_FROM + SUBTITLE_MATCH_FRAME, "media/sfx/snap.wav"],
      ["overview-cut", OVERVIEW_FROM, "media/sfx/whoosh.wav"],
      ["chapters-quote-cut", OVERVIEW_FROM + OVERVIEW_CHAPTER_FRAMES, "media/sfx/whoosh.wav"],
      ["quote-save", OVERVIEW_FROM + OVERVIEW_CHAPTER_FRAMES + OVERVIEW_TIMELINE.quoteLiftFrames - 4, "media/sfx/polaroid-shutter.wav"],
      ["voice-0232-fade", OVERVIEW_FROM + OVERVIEW_CHAPTER_FRAMES + 42, "media/sfx/voice-fade.wav"],
      ["overview-defocus", CHAT_FROM - 6, "media/sfx/click.wav"],
      ["chat-focus", CHAT_FROM + 7, "media/sfx/whoosh.wav"],
      ["chat-timestamp-click", CHAT_FROM + CHAT_TIMESTAMP_CLICK_FRAME, "media/sfx/snap.wav"],
      ["chat-defocus", SUBTOOLS_FROM - 6, "media/sfx/click.wav"],
      ["subtools-focus", SUBTOOLS_FROM + 7, "media/sfx/whoosh.wav"],
      ["subtools-bilingual", SUBTOOLS_FROM + SUBTOOLS_TIMELINE.bilingualAt, "media/sfx/pop.wav"],
      ["subtools-export", SUBTOOLS_FROM + SUBTOOLS_TIMELINE.exportClickAt, "media/sfx/snap.wav"],
      ["subtools-defocus", WEBSEARCH_FROM - 6, "media/sfx/click.wav"],
      ["websearch-focus", WEBSEARCH_FROM + 7, "media/sfx/whoosh.wav"],
      ["websearch-verify", WEBSEARCH_FROM + WEBSEARCH_TIMELINE.verifyCardAt, "media/sfx/pop.wav"],
      ["websearch-defocus", APPEARANCE_FROM - 6, "media/sfx/click.wav"],
      ["appearance-focus", APPEARANCE_FROM + 7, "media/sfx/whoosh.wav"],
      ["flyme-dark", APPEARANCE_FROM + APPEARANCE_TIMELINE.flymeDarkFrom, "media/sfx/toggle.wav"],
      ["editorial-light", APPEARANCE_FROM + APPEARANCE_TIMELINE.editorialLightFrom, "media/sfx/shutter-2.wav"],
      ["editorial-dark", APPEARANCE_FROM + APPEARANCE_TIMELINE.editorialDarkFrom, "media/sfx/shutter-3.wav"],
      ["provider-plate", PROVIDERS_FROM + PROVIDER_TIMELINE.plateAt, "media/sfx/pop.wav"],
      ["provider-orbit", PROVIDERS_FROM + PROVIDER_TIMELINE.orbitAt, "media/sfx/chord.wav"],
      ...PROVIDER_LOGOS.map((logo, index) => [
        `provider-bubble-${logo.id}`,
        Math.round(PROVIDERS_FROM + PROVIDER_TIMELINE.orbitAt + index * PROVIDER_TIMELINE.logoStagger),
        `media/sfx/bubble-${String(index + 1).padStart(2, "0")}.wav`
      ]),
      ["provider-exit", PROVIDERS_FROM + PROVIDER_TIMELINE.exitAt, "media/sfx/snap.wav"],
      ["outro-cut", OUTRO_TIMELINE.from, "media/sfx/whoosh.wav"],
      ["brand-resolve", OUTRO_TIMELINE.from + OUTRO_TIMELINE.brandResolveAt, "media/sfx/resolve.wav"],
      ["install-click", OUTRO_TIMELINE.from + OUTRO_TIMELINE.installClickAt, "media/sfx/snap.wav"]
    ]);
    expect(AUDIO.voices.map((voice) => [voice.id, voice.frame, voice.src])).toEqual([
      ["voice-0407", SUBTITLE_FROM + SUBTITLE_MATCH_FRAME + 2, "media/sfx/voice-0407.wav"],
      ["voice-0232", OVERVIEW_FROM + OVERVIEW_CHAPTER_FRAMES + 2, "media/sfx/voice-0232.wav"],
      ["voice-0444", CHAT_FROM + CHAT_PLAYER_VERIFY_FROM, "media/sfx/voice-0444.wav"]
    ]);
    expect(new Set(AUDIO.cues.map((cue) => cue.id)).size).toBe(AUDIO.cues.length);
    expect(AUDIO.cues.every((cue) => cue.frame >= 0 && cue.frame < PROMO_DURATION)).toBe(true);
    expect(AUDIO.cues.every((cue) => cue.gain > 0 && cue.gain <= 0.66)).toBe(true);
  });

  it("让配乐在音效前预先让位，章节阅读段不触发人声深压低，重叠时只取最深压低并自然淡入淡出", () => {
    const base = AUDIO.music.gain;
    const installClickFrame = OUTRO_TIMELINE.from + OUTRO_TIMELINE.installClickAt;
    expect(musicVolumeAtFrame(0)).toBe(0);
    expect(musicVolumeAtFrame(12)).toBeCloseTo(base * 0.5 * 10 ** (-4 / 20));
    expect(musicVolumeAtFrame(24)).toBe(base);
    // 开场钩子音效收尾后、字幕镜头音效之前保持基准音量
    expect(musicVolumeAtFrame(94)).toBe(base);
    expect(musicVolumeAtFrame(SUBTITLE_FROM)).toBeCloseTo(base * 10 ** (-5 / 20));
    expect(musicVolumeAtFrame(SUBTITLE_FROM + 12)).toBeCloseTo(base * 10 ** (-3.8 / 20));
    expect(musicVolumeAtFrame(SUBTITLE_FROM + 14)).toBeCloseTo(base * 10 ** (-3.8 / 20));
    expect(musicVolumeAtFrame(SUBTITLE_FROM + 32)).toBeGreaterThan(musicVolumeAtFrame(SUBTITLE_FROM + 28));
    expect(musicVolumeAtFrame(SUBTITLE_FROM + SUBTITLE_MATCH_FRAME + 20)).toBeCloseTo(base * 10 ** (-11.5 / 20));
    // 章节阅读阶段（如 frame 305）不播原声，保持正常配乐音量
    expect(musicVolumeAtFrame(OVERVIEW_FROM + 35)).toBe(base);
    // 金句阶段播放 02:32 原声时执行 11.5 dB 闪避
    expect(musicVolumeAtFrame(OVERVIEW_FROM + OVERVIEW_CHAPTER_FRAMES + 20)).toBeCloseTo(base * 10 ** (-11.5 / 20));
    expect(musicVolumeAtFrame(CHAT_FROM + CHAT_PLAYER_VERIFY_FROM + 15)).toBeCloseTo(base * 10 ** (-11.5 / 20));
    // 片尾品牌落定音效收尾后、安装入口点击之前回到基准音量
    expect(musicVolumeAtFrame(960)).toBe(base);
    expect(musicVolumeAtFrame(installClickFrame)).toBeCloseTo(base * 10 ** (-4.2 / 20));
    expect(musicVolumeAtFrame(PROMO_DURATION - AUDIO.music.fadeOutFrames / 2)).toBeCloseTo(base / 2);
    expect(musicVolumeAtFrame(PROMO_DURATION - 1)).toBeCloseTo(base / AUDIO.music.fadeOutFrames);
    expect(musicVolumeAtFrame(PROMO_DURATION)).toBe(0);
  });
});
