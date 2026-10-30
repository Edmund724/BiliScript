import {OUTRO_TIMELINE} from "./outro-timeline.mjs";
import {PROVIDER_LOGOS} from "./provider-logos.mjs";
import {SUBTITLE_MATCH_FRAME} from "./subtitle-timeline.mjs";
import {
  APPEARANCE_TIMELINE,
  CHAT_PLAYER_VERIFY_FROM,
  CHAT_TIMESTAMP_CLICK_FRAME,
  HERO_TIMELINE,
  OVERVIEW_TIMELINE,
  PANEL_FOCUS_HANDOFFS,
  PROMO_DURATION,
  PROVIDER_TIMELINE,
  SCENES,
  SUBTOOLS_TIMELINE,
  WEBSEARCH_TIMELINE
} from "./timeline.mjs";

const SUBTITLE_FROM = SCENES.find((scene) => scene.id === "subtitle").from;
const OVERVIEW_FROM = SCENES.find((scene) => scene.id === "overview").from;
const CHAT_FROM = SCENES.find((scene) => scene.id === "chat").from;
const SUBTOOLS_FROM = SCENES.find((scene) => scene.id === "subtools").from;
const WEBSEARCH_FROM = SCENES.find((scene) => scene.id === "websearch").from;
const APPEARANCE_FROM = SCENES.find((scene) => scene.id === "appearance").from;
const PROVIDERS_FROM = SCENES.find((scene) => scene.id === "providers").from;
const OVERVIEW_DURATION = SCENES.find((scene) => scene.id === "overview").duration;
const OVERVIEW_CHAPTER_FRAMES = Math.round(OVERVIEW_DURATION * OVERVIEW_TIMELINE.chapterRatio);
const CHAT_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "chat");
const SUBTOOLS_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "subtools");
const WEBSEARCH_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "websearch");
const APPEARANCE_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "appearance");

const PROVIDER_BUBBLE_CUES = PROVIDER_LOGOS.map((logo, index) => ({
  id: `provider-bubble-${logo.id}`,
  frame: Math.round(PROVIDERS_FROM + PROVIDER_TIMELINE.orbitAt + index * PROVIDER_TIMELINE.logoStagger),
  src: `media/sfx/bubble-${String(index + 1).padStart(2, "0")}.wav`,
  gain: Number((0.44 + (index / 13) * 0.1).toFixed(2)),
  duckDb: 2.2
}));

export const AUDIO = {
  music: {
    src: "media/promo-score.wav",
    style: "Tech Pop · Sound Design",
    bpm: 120,
    license: "Original work; MIT License",
    durationInFrames: PROMO_DURATION,
    gain: 0.8,
    fadeInFrames: 24,
    fadeOutFrames: 60,
    fadeOutEndFrame: PROMO_DURATION
  },
  cues: [
    {id: "hero-click", frame: HERO_TIMELINE.clickAt, src: "media/sfx/click.wav", gain: 0.50, duckDb: 4},
    {id: "hero-page", frame: HERO_TIMELINE.pageTurnAt, src: "media/sfx/shutter-1.wav", gain: 0.54, duckDb: 4.2},
    {id: "hero-answer", frame: HERO_TIMELINE.answerAt, src: "media/sfx/whoosh.wav", gain: 0.40, duckDb: 4.5},
    {id: "subtitle-cut", frame: SUBTITLE_FROM, src: "media/sfx/whoosh.wav", gain: 0.42, duckDb: 5},
    {id: "subtitle-keyword-resolve", frame: SUBTITLE_FROM + 8, src: "media/sfx/click.wav", gain: 0.44, duckDb: 3.2},
    {id: "type-huan", frame: SUBTITLE_FROM + 12, src: "media/sfx/mech-key-1.wav", gain: 0.58, duckDb: 3.8},
    {id: "type-jue", frame: SUBTITLE_FROM + 16, src: "media/sfx/mech-key-2.wav", gain: 0.60, duckDb: 3.8},
    {id: "type-enter", frame: SUBTITLE_FROM + 20, src: "media/sfx/mech-enter.wav", gain: 0.64, duckDb: 4.2},
    {id: "subtitle-seek-snap", frame: SUBTITLE_FROM + SUBTITLE_MATCH_FRAME, src: "media/sfx/snap.wav", gain: 0.66, duckDb: 5.2},
    {id: "overview-cut", frame: OVERVIEW_FROM, src: "media/sfx/whoosh.wav", gain: 0.42, duckDb: 5},
    {id: "chapters-quote-cut", frame: OVERVIEW_FROM + OVERVIEW_CHAPTER_FRAMES, src: "media/sfx/whoosh.wav", gain: 0.42, duckDb: 4.5},
    {
      id: "quote-save",
      frame: OVERVIEW_FROM + OVERVIEW_CHAPTER_FRAMES + OVERVIEW_TIMELINE.quoteLiftFrames - 4,
      src: "media/sfx/polaroid-shutter.wav",
      gain: 0.62,
      duckDb: 5.0
    },
    {id: "voice-0232-fade", frame: OVERVIEW_FROM + OVERVIEW_CHAPTER_FRAMES + 42, src: "media/sfx/voice-fade.wav", gain: 0.46, duckDb: 3.8},
    {id: `${CHAT_HANDOFF.from}-defocus`, frame: CHAT_HANDOFF.at - CHAT_HANDOFF.exitFrames, src: "media/sfx/click.wav", gain: 0.30, duckDb: 2.5},
    {id: `${CHAT_HANDOFF.to}-focus`, frame: CHAT_HANDOFF.at + CHAT_HANDOFF.enterFrames, src: "media/sfx/whoosh.wav", gain: 0.40, duckDb: 4},
    {id: "chat-timestamp-click", frame: CHAT_FROM + CHAT_TIMESTAMP_CLICK_FRAME, src: "media/sfx/snap.wav", gain: 0.58, duckDb: 4.8},
    {id: `${SUBTOOLS_HANDOFF.from}-defocus`, frame: SUBTOOLS_HANDOFF.at - SUBTOOLS_HANDOFF.exitFrames, src: "media/sfx/click.wav", gain: 0.30, duckDb: 2.5},
    {id: `${SUBTOOLS_HANDOFF.to}-focus`, frame: SUBTOOLS_HANDOFF.at + SUBTOOLS_HANDOFF.enterFrames, src: "media/sfx/whoosh.wav", gain: 0.40, duckDb: 4},
    {id: "subtools-bilingual", frame: SUBTOOLS_FROM + SUBTOOLS_TIMELINE.bilingualAt, src: "media/sfx/pop.wav", gain: 0.46, duckDb: 3.8},
    {id: "subtools-export", frame: SUBTOOLS_FROM + SUBTOOLS_TIMELINE.exportClickAt, src: "media/sfx/snap.wav", gain: 0.56, duckDb: 4.5},
    {id: `${WEBSEARCH_HANDOFF.from}-defocus`, frame: WEBSEARCH_HANDOFF.at - WEBSEARCH_HANDOFF.exitFrames, src: "media/sfx/click.wav", gain: 0.30, duckDb: 2.5},
    {id: `${WEBSEARCH_HANDOFF.to}-focus`, frame: WEBSEARCH_HANDOFF.at + WEBSEARCH_HANDOFF.enterFrames, src: "media/sfx/whoosh.wav", gain: 0.40, duckDb: 4},
    {id: "websearch-verify", frame: WEBSEARCH_FROM + WEBSEARCH_TIMELINE.verifyCardAt, src: "media/sfx/pop.wav", gain: 0.50, duckDb: 4.2},
    {id: `${APPEARANCE_HANDOFF.from}-defocus`, frame: APPEARANCE_HANDOFF.at - APPEARANCE_HANDOFF.exitFrames, src: "media/sfx/click.wav", gain: 0.30, duckDb: 2.5},
    {id: `${APPEARANCE_HANDOFF.to}-focus`, frame: APPEARANCE_HANDOFF.at + APPEARANCE_HANDOFF.enterFrames, src: "media/sfx/whoosh.wav", gain: 0.40, duckDb: 4},
    {id: "flyme-dark", frame: APPEARANCE_FROM + APPEARANCE_TIMELINE.flymeDarkFrom, src: "media/sfx/toggle.wav", gain: 0.54, duckDb: 4.2},
    {id: "editorial-light", frame: APPEARANCE_FROM + APPEARANCE_TIMELINE.editorialLightFrom, src: "media/sfx/shutter-2.wav", gain: 0.54, duckDb: 4.2},
    {id: "editorial-dark", frame: APPEARANCE_FROM + APPEARANCE_TIMELINE.editorialDarkFrom, src: "media/sfx/shutter-3.wav", gain: 0.54, duckDb: 4.2},
    {id: "provider-plate", frame: PROVIDERS_FROM + PROVIDER_TIMELINE.plateAt, src: "media/sfx/pop.wav", gain: 0.48, duckDb: 4},
    {id: "provider-orbit", frame: PROVIDERS_FROM + PROVIDER_TIMELINE.orbitAt, src: "media/sfx/chord.wav", gain: 0.42, duckDb: 4.2},
    ...PROVIDER_BUBBLE_CUES,
    {id: "provider-exit", frame: PROVIDERS_FROM + PROVIDER_TIMELINE.exitAt, src: "media/sfx/snap.wav", gain: 0.52, duckDb: 4},
    {id: "outro-cut", frame: OUTRO_TIMELINE.from, src: "media/sfx/whoosh.wav", gain: 0.38, duckDb: 4},
    {id: "brand-resolve", frame: OUTRO_TIMELINE.from + OUTRO_TIMELINE.brandResolveAt, src: "media/sfx/resolve.wav", gain: 0.56, duckDb: 6},
    {id: "install-click", frame: OUTRO_TIMELINE.from + OUTRO_TIMELINE.installClickAt, src: "media/sfx/snap.wav", gain: 0.54, duckDb: 4.2}
  ],
  voices: [
    {id: "voice-0407", frame: SUBTITLE_FROM + SUBTITLE_MATCH_FRAME + 2, src: "media/sfx/voice-0407.wav", gain: 0.86, duckDb: 11.5, durationFrames: 48},
    {id: "voice-0232", frame: OVERVIEW_FROM + OVERVIEW_CHAPTER_FRAMES + 2, src: "media/sfx/voice-0232.wav", gain: 0.86, duckDb: 11.5, durationFrames: 45},
    {id: "voice-0444", frame: CHAT_FROM + CHAT_PLAYER_VERIFY_FROM, src: "media/sfx/voice-0444.wav", gain: 0.86, duckDb: 11.5, durationFrames: 40}
  ]
};

export function voiceDuckAtFrame(frame) {
  let duck = 1;
  for (const voice of AUDIO.voices) {
    const local = frame - voice.frame;
    const holdEnd = (voice.durationFrames ?? 40) - 4;
    const releaseFrames = 10;
    const preFrames = 3;
    if (local < -preFrames || local > holdEnd + releaseFrames) continue;
    const envelope =
      local < 0
        ? (local + preFrames) / preFrames
        : local <= holdEnd
          ? 1
          : (holdEnd + releaseFrames - local) / releaseFrames;
    duck = Math.min(duck, 1 - envelope * (1 - 10 ** (-voice.duckDb / 20)));
  }
  return duck;
}

export function musicVolumeAtFrame(frame) {
  const {fadeInFrames, fadeOutFrames, fadeOutEndFrame, gain} = AUDIO.music;
  const fadeIn = Math.min(1, Math.max(0, frame / fadeInFrames));
  const fadeOut = Math.min(1, Math.max(0, (fadeOutEndFrame - frame) / fadeOutFrames));
  let duck = voiceDuckAtFrame(frame);
  for (const cue of AUDIO.cues) {
    const local = frame - cue.frame;
    if (local < -2 || local > 16) continue;
    const envelope = local < 0 ? (local + 2) / 2 : local <= 8 ? 1 : (16 - local) / 8;
    duck = Math.min(duck, 1 - envelope * (1 - 10 ** (-cue.duckDb / 20)));
  }
  return gain * fadeIn * fadeOut * duck;
}
