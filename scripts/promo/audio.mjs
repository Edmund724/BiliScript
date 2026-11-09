import {OUTRO_TIMELINE} from "./outro-timeline.mjs";
import {PROVIDER_LOGOS} from "./provider-logos.mjs";
import {SUBTITLE_MATCH_FRAME} from "./subtitle-timeline.mjs";
import {
  CHAT_PLAYER_VERIFY_FROM,
  CHAT_TIMESTAMP_CLICK_FRAME,
  LIVE_TIMELINE,
  OVERVIEW_TIMELINE,
  PANEL_FOCUS_HANDOFFS,
  PROMO_DURATION,
  PROVIDER_TIMELINE,
  SCENES,
  SUBTOOLS_TIMELINE,
  WEBSEARCH_TIMELINE
} from "./timeline.mjs";

const SUBTOOLS_FROM = SCENES.find((scene) => scene.id === "subtools").from;
const WEBSEARCH_FROM = SCENES.find((scene) => scene.id === "websearch").from;
const SUBTITLE_FROM = SCENES.find((scene) => scene.id === "subtitle").from;
const CHAT_FROM = SCENES.find((scene) => scene.id === "chat").from;
const LIVE_FROM = SCENES.find((scene) => scene.id === "live").from;
const PROVIDERS_FROM = SCENES.find((scene) => scene.id === "providers").from;
const WEBSEARCH_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "websearch");

export const PROVIDER_BUBBLE_GAINS = [
  0.50, 0.46, 0.43, 0.40, 0.39, 0.36, 0.35,
  0.33, 0.32, 0.30, 0.31, 0.29, 0.32, 0.52
];

export const SFX_PEAK_OFFSET_FRAMES = {
  "media/sfx/whoosh.wav": 3,
  "media/sfx/polaroid-shutter.wav": 1
};

export function cueMixStartFrame(cue) {
  return Math.max(0, cue.frame - (SFX_PEAK_OFFSET_FRAMES[cue.src] ?? 0));
}

const PROVIDER_BUBBLE_CUES = PROVIDER_LOGOS.map((logo, index) => ({
  id: `provider-bubble-${logo.id}`,
  frame: Math.round(PROVIDERS_FROM + PROVIDER_TIMELINE.orbitAt + PROVIDER_TIMELINE.logoOffsets[index]),
  src: `media/sfx/bubble-${String(index + 1).padStart(2, "0")}.wav`,
  gain: PROVIDER_BUBBLE_GAINS[index],
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
    {id: "overview-trigger-click", frame: OVERVIEW_TIMELINE.triggerClickAt, src: "media/sfx/click.wav", gain: 0.46, duckDb: 3.2},
    {id: "overview-chapter-seek", frame: OVERVIEW_TIMELINE.chapterClickAt, src: "media/sfx/snap.wav", gain: 0.58, duckDb: 4.8},
    {id: "overview-quote-click", frame: OVERVIEW_TIMELINE.quoteClickAt, src: "media/sfx/click.wav", gain: 0.46, duckDb: 3.2},
    {id: "overview-quote-cut", frame: OVERVIEW_TIMELINE.quoteStartAt, src: "media/sfx/whoosh.wav", gain: 0.42, duckDb: 4.5},
    {
      id: "quote-save",
      frame: OVERVIEW_TIMELINE.quoteStartAt + OVERVIEW_TIMELINE.quoteLiftFrames - 4,
      src: "media/sfx/polaroid-shutter.wav",
      gain: 0.62,
      duckDb: 5.0
    },
    {id: "voice-0232-fade", frame: OVERVIEW_TIMELINE.quoteStartAt + 42, src: "media/sfx/voice-fade.wav", gain: 0.46, duckDb: 3.8},
    {id: "subtools-cut", frame: SUBTOOLS_FROM, src: "media/sfx/whoosh.wav", gain: 0.40, duckDb: 4},
    {id: "subtools-settled", frame: SUBTOOLS_FROM + SUBTOOLS_TIMELINE.settledAt, src: "media/sfx/pop.wav", gain: 0.44, duckDb: 3.6},
    {id: "subtools-export", frame: SUBTOOLS_FROM + SUBTOOLS_TIMELINE.exportClickAt, src: "media/sfx/snap.wav", gain: 0.56, duckDb: 4.5},
    {id: `${WEBSEARCH_HANDOFF.from}-defocus`, frame: WEBSEARCH_HANDOFF.at - WEBSEARCH_HANDOFF.exitFrames, src: "media/sfx/click.wav", gain: 0.30, duckDb: 2.5},
    {id: `${WEBSEARCH_HANDOFF.to}-focus`, frame: WEBSEARCH_HANDOFF.at + WEBSEARCH_HANDOFF.enterFrames, src: "media/sfx/whoosh.wav", gain: 0.40, duckDb: 4},
    {id: "websearch-verify", frame: WEBSEARCH_FROM + WEBSEARCH_TIMELINE.verifyCardAt, src: "media/sfx/pop.wav", gain: 0.50, duckDb: 4.2},
    {id: "subtitle-cut", frame: SUBTITLE_FROM, src: "media/sfx/whoosh.wav", gain: 0.42, duckDb: 5},
    {id: "subtitle-keyword-resolve", frame: SUBTITLE_FROM + 8, src: "media/sfx/click.wav", gain: 0.44, duckDb: 3.2},
    {id: "type-huan", frame: SUBTITLE_FROM + 12, src: "media/sfx/mech-key-1.wav", gain: 0.58, duckDb: 3.8},
    {id: "type-jue", frame: SUBTITLE_FROM + 16, src: "media/sfx/mech-key-2.wav", gain: 0.60, duckDb: 3.8},
    {id: "type-enter", frame: SUBTITLE_FROM + 20, src: "media/sfx/mech-enter.wav", gain: 0.64, duckDb: 4.2},
    {id: "subtitle-seek-snap", frame: SUBTITLE_FROM + SUBTITLE_MATCH_FRAME, src: "media/sfx/snap.wav", gain: 0.66, duckDb: 5.2},
    {id: "chat-cut", frame: CHAT_FROM, src: "media/sfx/whoosh.wav", gain: 0.40, duckDb: 4},
    {id: "chat-timestamp-click", frame: CHAT_FROM + CHAT_TIMESTAMP_CLICK_FRAME, src: "media/sfx/snap.wav", gain: 0.58, duckDb: 4.8},
    {id: "live-cut", frame: LIVE_FROM, src: "media/sfx/whoosh.wav", gain: 0.40, duckDb: 4},
    {id: "live-toggle-click", frame: LIVE_FROM + LIVE_TIMELINE.toggleClickAt, src: "media/sfx/click.wav", gain: 0.48, duckDb: 3.4},
    {id: "live-overlay-open", frame: LIVE_FROM + LIVE_TIMELINE.overlayOpenAt, src: "media/sfx/pop.wav", gain: 0.48, duckDb: 3.8},
    {id: "live-voice-priority", frame: LIVE_FROM + LIVE_TIMELINE.duckActiveAt, src: "media/sfx/snap.wav", gain: 0.54, duckDb: 4.2},
    {id: "provider-plate", frame: PROVIDERS_FROM + PROVIDER_TIMELINE.plateAt, src: "media/sfx/pop.wav", gain: 0.48, duckDb: 4},
    {id: "provider-orbit", frame: PROVIDERS_FROM + PROVIDER_TIMELINE.orbitAt, src: "media/sfx/chord.wav", gain: 0.42, duckDb: 4.2},
    ...PROVIDER_BUBBLE_CUES,
    {id: "provider-exit", frame: PROVIDERS_FROM + PROVIDER_TIMELINE.exitAt, src: "media/sfx/snap.wav", gain: 0.52, duckDb: 4},
    {id: "outro-cut", frame: OUTRO_TIMELINE.from, src: "media/sfx/whoosh.wav", gain: 0.38, duckDb: 4},
    {id: "brand-resolve", frame: OUTRO_TIMELINE.from + OUTRO_TIMELINE.brandResolveAt, src: "media/sfx/resolve.wav", gain: 0.56, duckDb: 6},
    {id: "install-click", frame: OUTRO_TIMELINE.from + OUTRO_TIMELINE.installClickAt, src: "media/sfx/snap.wav", gain: 0.54, duckDb: 4.2}
  ],
  voices: [
    {id: "voice-0232", frame: OVERVIEW_TIMELINE.quoteStartAt + 2, src: "media/sfx/voice-0232.wav", gain: 0.86, duckDb: 11.5, durationFrames: 45},
    {id: "voice-0407", frame: SUBTITLE_FROM + SUBTITLE_MATCH_FRAME + 2, src: "media/sfx/voice-0407.wav", gain: 0.86, duckDb: 11.5, durationFrames: 48},
    {id: "voice-0444", frame: CHAT_FROM + CHAT_PLAYER_VERIFY_FROM, src: "media/sfx/voice-0444.wav", gain: 0.86, duckDb: 11.5, durationFrames: 40},
    {id: "voice-live-ai", frame: LIVE_FROM + LIVE_TIMELINE.aiReplyAt, src: "media/sfx/voice-live-ai.wav", gain: 0.86, duckDb: 11.5, durationFrames: 97}
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

export function voiceDuckEmphasisAtFrame(frame) {
  const deepestDuck = Math.min(...AUDIO.voices.map((voice) => 10 ** (-voice.duckDb / 20)));
  return Math.min(1, Math.max(0, (1 - voiceDuckAtFrame(frame)) / (1 - deepestDuck)));
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
