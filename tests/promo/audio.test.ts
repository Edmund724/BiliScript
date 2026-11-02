import {describe, expect, it} from "vitest";
import {AUDIO, PROVIDER_BUBBLE_GAINS, cueMixStartFrame, musicVolumeAtFrame} from "../../scripts/promo/audio.mjs";
import {OUTRO_TIMELINE} from "../../scripts/promo/outro-timeline.mjs";
import {PROVIDER_LOGOS} from "../../scripts/promo/provider-logos.mjs";
import {SUBTITLE_MATCH_FRAME} from "../../scripts/promo/subtitle-timeline.mjs";
import {
  CHAT_PLAYER_VERIFY_FROM,
  CHAT_TIMESTAMP_CLICK_FRAME,
  OVERVIEW_TIMELINE,
  PROMO_DURATION,
  PROMO_FPS,
  PROVIDER_TIMELINE,
  SCENES,
  SUBTOOLS_TIMELINE,
  WEBSEARCH_TIMELINE,
  beatF
} from "../../scripts/promo/timeline.mjs";

const SUBTOOLS_FROM = SCENES.find((scene) => scene.id === "subtools")!.from;
const WEBSEARCH_FROM = SCENES.find((scene) => scene.id === "websearch")!.from;
const SUBTITLE_FROM = SCENES.find((scene) => scene.id === "subtitle")!.from;
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
    expect(PROMO_DURATION).toBe(33.5 * PROMO_FPS);
    expect(AUDIO.music.durationInFrames).toBe(PROMO_DURATION);
    for (const scene of SCENES.slice(1)) {
      expect(((scene.from * AUDIO.music.bpm) / 60) % PROMO_FPS, scene.id).toBe(0);
    }
  });

  it("把定制拟音与三段原片老师回应放在真实交互帧上，02:32 原声延后至金句卡弹出时印证", () => {
    expect(OVERVIEW_TIMELINE.triggerClickAt).toBe(36);
    expect(OVERVIEW_TIMELINE.spatialEnterAt).toBe(64);
    expect(OVERVIEW_TIMELINE.chapterClickAt).toBe(beatF(10));
    expect(OVERVIEW_TIMELINE.quoteClickAt).toBe(beatF(15));
    expect(AUDIO.cues.map((cue) => [cue.id, cue.frame, cue.src])).toEqual([
      ["overview-trigger-click", OVERVIEW_TIMELINE.triggerClickAt, "media/sfx/click.wav"],
      ["overview-chapter-seek", OVERVIEW_TIMELINE.chapterClickAt, "media/sfx/snap.wav"],
      ["overview-quote-click", OVERVIEW_TIMELINE.quoteClickAt, "media/sfx/click.wav"],
      ["overview-quote-cut", OVERVIEW_TIMELINE.quoteStartAt, "media/sfx/whoosh.wav"],
      ["quote-save", OVERVIEW_TIMELINE.quoteStartAt + OVERVIEW_TIMELINE.quoteLiftFrames - 4, "media/sfx/polaroid-shutter.wav"],
      ["voice-0232-fade", OVERVIEW_TIMELINE.quoteStartAt + 42, "media/sfx/voice-fade.wav"],
      ["subtools-cut", SUBTOOLS_FROM, "media/sfx/whoosh.wav"],
      ["subtools-settled", SUBTOOLS_FROM + SUBTOOLS_TIMELINE.settledAt, "media/sfx/pop.wav"],
      ["subtools-export", SUBTOOLS_FROM + SUBTOOLS_TIMELINE.exportClickAt, "media/sfx/snap.wav"],
      ["subtools-defocus", WEBSEARCH_FROM - 6, "media/sfx/click.wav"],
      ["websearch-focus", WEBSEARCH_FROM + 7, "media/sfx/whoosh.wav"],
      ["websearch-verify", WEBSEARCH_FROM + WEBSEARCH_TIMELINE.verifyCardAt, "media/sfx/pop.wav"],
      ["subtitle-cut", SUBTITLE_FROM, "media/sfx/whoosh.wav"],
      ["subtitle-keyword-resolve", SUBTITLE_FROM + 8, "media/sfx/click.wav"],
      ["type-huan", SUBTITLE_FROM + 12, "media/sfx/mech-key-1.wav"],
      ["type-jue", SUBTITLE_FROM + 16, "media/sfx/mech-key-2.wav"],
      ["type-enter", SUBTITLE_FROM + 20, "media/sfx/mech-enter.wav"],
      ["subtitle-seek-snap", SUBTITLE_FROM + SUBTITLE_MATCH_FRAME, "media/sfx/snap.wav"],
      ["chat-cut", CHAT_FROM, "media/sfx/whoosh.wav"],
      ["chat-timestamp-click", CHAT_FROM + CHAT_TIMESTAMP_CLICK_FRAME, "media/sfx/snap.wav"],
      ["provider-plate", PROVIDERS_FROM + PROVIDER_TIMELINE.plateAt, "media/sfx/pop.wav"],
      ["provider-orbit", PROVIDERS_FROM + PROVIDER_TIMELINE.orbitAt, "media/sfx/chord.wav"],
      ...PROVIDER_LOGOS.map((logo, index) => [
        `provider-bubble-${logo.id}`,
        Math.round(PROVIDERS_FROM + PROVIDER_TIMELINE.orbitAt + PROVIDER_TIMELINE.logoOffsets[index]),
        `media/sfx/bubble-${String(index + 1).padStart(2, "0")}.wav`
      ]),
      ["provider-exit", PROVIDERS_FROM + PROVIDER_TIMELINE.exitAt, "media/sfx/snap.wav"],
      ["outro-cut", OUTRO_TIMELINE.from, "media/sfx/whoosh.wav"],
      ["brand-resolve", OUTRO_TIMELINE.from + OUTRO_TIMELINE.brandResolveAt, "media/sfx/resolve.wav"],
      ["install-click", OUTRO_TIMELINE.from + OUTRO_TIMELINE.installClickAt, "media/sfx/snap.wav"]
    ]);
    expect(AUDIO.voices.map((voice) => [voice.id, voice.frame, voice.src])).toEqual([
      ["voice-0232", OVERVIEW_TIMELINE.quoteStartAt + 2, "media/sfx/voice-0232.wav"],
      ["voice-0407", SUBTITLE_FROM + SUBTITLE_MATCH_FRAME + 2, "media/sfx/voice-0407.wav"],
      ["voice-0444", CHAT_FROM + CHAT_PLAYER_VERIFY_FROM, "media/sfx/voice-0444.wav"]
    ]);
    expect(new Set(AUDIO.cues.map((cue) => cue.id)).size).toBe(AUDIO.cues.length);
    expect(AUDIO.cues.every((cue) => cue.frame >= 0 && cue.frame < PROMO_DURATION)).toBe(true);
    expect(AUDIO.cues.every((cue) => cue.gain > 0 && cue.gain <= 0.66)).toBe(true);
    expect(PROVIDER_BUBBLE_GAINS).toHaveLength(PROVIDER_LOGOS.length);
    // 14 个平台点亮采用先慢后快加速（3f -> 2f -> 1f），满版静止停留 >= 0.5s (15f)
    const lastLogoFinish = PROVIDER_TIMELINE.orbitAt + PROVIDER_TIMELINE.logoOffsets.at(-1)! + PROVIDER_TIMELINE.logoPopFrames;
    expect(PROVIDER_TIMELINE.exitAt - lastLogoFinish).toBeGreaterThanOrEqual(15);
    // 慢起音 whoosh 提前 3 帧混入以对齐能量峰值
    const subtitleCutCue = AUDIO.cues.find((cue) => cue.id === "subtitle-cut")!;
    expect(cueMixStartFrame(subtitleCutCue)).toBe(subtitleCutCue.frame - 3);
  });

  it("将语音转写与复制导出合并为一气呵成单幕（3.5s），并将联网检索延长至 3.5s", () => {
    const subtools = SCENES.find((item) => item.id === "subtools")!;
    const websearch = SCENES.find((item) => item.id === "websearch")!;
    expect(subtools.duration / PROMO_FPS).toBe(3.5);
    expect(websearch.duration / PROMO_FPS).toBe(3.5);
    expect(AUDIO.cues.map((cue) => [cue.id, cue.frame])).toContainEqual(["subtools-settled", subtools.from + SUBTOOLS_TIMELINE.settledAt]);
    expect(AUDIO.cues.map((cue) => [cue.id, cue.frame])).toContainEqual(["subtools-export", subtools.from + SUBTOOLS_TIMELINE.exportClickAt]);
    expect(SUBTOOLS_TIMELINE.exportAt).toBeGreaterThan(SUBTOOLS_TIMELINE.settledAt);
    expect(SUBTOOLS_TIMELINE.exportClickAt).toBeGreaterThan(SUBTOOLS_TIMELINE.exportAt);
    expect(SUBTOOLS_TIMELINE.exportClickAt).toBeLessThan(subtools.duration);
  });

  it("让配乐在音效前预先让位，章节阅读段不触发人声深压低，重叠时只取最深压低并自然淡入淡出", () => {
    const base = AUDIO.music.gain;
    const installClickFrame = OUTRO_TIMELINE.from + OUTRO_TIMELINE.installClickAt;
    expect(musicVolumeAtFrame(0)).toBe(0);
    expect(musicVolumeAtFrame(12)).toBeCloseTo(base * 0.5);
    expect(musicVolumeAtFrame(24)).toBe(base);
    // 章节跳播点击在新帧让位，其前保持基准音量
    expect(musicVolumeAtFrame(OVERVIEW_TIMELINE.chapterClickAt)).toBeCloseTo(base * 10 ** (-4.8 / 20));
    expect(musicVolumeAtFrame(OVERVIEW_TIMELINE.chapterClickAt - 12)).toBe(base);
    expect(musicVolumeAtFrame(SUBTITLE_FROM)).toBeCloseTo(base * 10 ** (-5 / 20));
    expect(musicVolumeAtFrame(SUBTITLE_FROM + 12)).toBeCloseTo(base * 10 ** (-3.8 / 20));
    expect(musicVolumeAtFrame(SUBTITLE_FROM + 14)).toBeCloseTo(base * 10 ** (-3.8 / 20));
    expect(musicVolumeAtFrame(SUBTITLE_FROM + 32)).toBeGreaterThan(musicVolumeAtFrame(SUBTITLE_FROM + 28));
    expect(musicVolumeAtFrame(SUBTITLE_FROM + SUBTITLE_MATCH_FRAME + 20)).toBeCloseTo(base * 10 ** (-11.5 / 20));
    // TL;DR 与章节阅读阶段不播原声，保持正常配乐音量
    expect(musicVolumeAtFrame(75)).toBe(base);
    // 金句分享卡弹出后播放 02:32 原声时执行 11.5 dB 闪避
    expect(musicVolumeAtFrame(OVERVIEW_TIMELINE.quoteStartAt + 20)).toBeCloseTo(base * 10 ** (-11.5 / 20));
    expect(musicVolumeAtFrame(CHAT_FROM + CHAT_PLAYER_VERIFY_FROM + 15)).toBeCloseTo(base * 10 ** (-11.5 / 20));
    // 片尾品牌落定音效收尾后、安装入口点击之前回到基准音量
    expect(musicVolumeAtFrame(OUTRO_TIMELINE.from + 30)).toBe(base);
    expect(musicVolumeAtFrame(installClickFrame)).toBeCloseTo(base * 10 ** (-4.2 / 20));
    expect(musicVolumeAtFrame(PROMO_DURATION - AUDIO.music.fadeOutFrames / 2)).toBeCloseTo(base / 2);
    expect(musicVolumeAtFrame(PROMO_DURATION - 1)).toBeCloseTo(base / AUDIO.music.fadeOutFrames);
    expect(musicVolumeAtFrame(PROMO_DURATION)).toBe(0);
  });
});
