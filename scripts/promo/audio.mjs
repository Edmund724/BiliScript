import {OUTRO_TIMELINE} from "./outro-timeline.mjs";
import {PROVIDER_LOGOS} from "./provider-logos.mjs";
import {SUBTITLE_MATCH_FRAME} from "./subtitle-timeline.mjs";
import {
  CHAT_PLAYER_VERIFY_FROM,
  CHAT_TIMESTAMP_CLICK_FRAME,
  PANEL_FOCUS_HANDOFFS,
  PROMO_DURATION,
  PROVIDER_TIMELINE,
  SCENES
} from "./timeline.mjs";

const SUBTITLE_FROM = SCENES.find((scene) => scene.id === "subtitle").from;
const OVERVIEW_FROM = SCENES.find((scene) => scene.id === "overview").from;
const CHAT_FROM = SCENES.find((scene) => scene.id === "chat").from;
const PROVIDERS_FROM = SCENES.find((scene) => scene.id === "providers").from;
const CHAT_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "chat");
const APPEARANCE_HANDOFF = PANEL_FOCUS_HANDOFFS.find((handoff) => handoff.to === "appearance");

const PROVIDER_BUBBLE_CUES = PROVIDER_LOGOS.map((logo, index) => ({
  id: `provider-bubble-${logo.id}`,
  frame: Math.round(PROVIDERS_FROM + PROVIDER_TIMELINE.wallAt + index * PROVIDER_TIMELINE.cardStagger),
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
    {id: "hook-q1", frame: 4, src: "media/sfx/pop.wav", gain: 0.46, duckDb: 3.5},
    {id: "hook-q2", frame: 16, src: "media/sfx/pop.wav", gain: 0.48, duckDb: 3.5},
    {id: "hook-q3", frame: 32, src: "media/sfx/pop.wav", gain: 0.50, duckDb: 4},
    {id: "hero-pullback", frame: 54, src: "media/sfx/whoosh.wav", gain: 0.44, duckDb: 4.5},
    {id: "hero-open", frame: 56, src: "media/sfx/click.wav", gain: 0.50, duckDb: 4},
    {id: "subtitle-cut", frame: 90, src: "media/sfx/whoosh.wav", gain: 0.42, duckDb: 5},
    {id: "subtitle-keyword-resolve", frame: 98, src: "media/sfx/click.wav", gain: 0.44, duckDb: 3.2},
    {id: "type-huan", frame: 102, src: "media/sfx/mech-key-1.wav", gain: 0.58, duckDb: 3.8},
    {id: "type-jue", frame: 106, src: "media/sfx/mech-key-2.wav", gain: 0.60, duckDb: 3.8},
    {id: "type-enter", frame: 110, src: "media/sfx/mech-enter.wav", gain: 0.64, duckDb: 4.2},
    {id: "subtitle-seek-snap", frame: SUBTITLE_FROM + SUBTITLE_MATCH_FRAME, src: "media/sfx/snap.wav", gain: 0.66, duckDb: 5.2},
    {id: "overview-cut", frame: 210, src: "media/sfx/whoosh.wav", gain: 0.42, duckDb: 5},
    {id: "chapters-quote-cut", frame: 262, src: "media/sfx/whoosh.wav", gain: 0.42, duckDb: 4.5},
    {id: "quote-card", frame: 276, src: "media/sfx/shutter-1.wav", gain: 0.58, duckDb: 4.5},
    {id: "quote-slate", frame: 283, src: "media/sfx/shutter-2.wav", gain: 0.60, duckDb: 4.5},
    {id: "quote-mist", frame: 295, src: "media/sfx/shutter-3.wav", gain: 0.64, duckDb: 4.8},
    {id: `${CHAT_HANDOFF.from}-defocus`, frame: CHAT_HANDOFF.at - CHAT_HANDOFF.exitFrames, src: "media/sfx/click.wav", gain: 0.30, duckDb: 2.5},
    {id: `${CHAT_HANDOFF.to}-focus`, frame: CHAT_HANDOFF.at + CHAT_HANDOFF.enterFrames, src: "media/sfx/whoosh.wav", gain: 0.40, duckDb: 4},
    {id: "chat-timestamp-click", frame: CHAT_FROM + CHAT_TIMESTAMP_CLICK_FRAME, src: "media/sfx/snap.wav", gain: 0.58, duckDb: 4.8},
    {id: `${APPEARANCE_HANDOFF.from}-defocus`, frame: APPEARANCE_HANDOFF.at - APPEARANCE_HANDOFF.exitFrames, src: "media/sfx/click.wav", gain: 0.30, duckDb: 2.5},
    {id: `${APPEARANCE_HANDOFF.to}-focus`, frame: APPEARANCE_HANDOFF.at + APPEARANCE_HANDOFF.enterFrames, src: "media/sfx/whoosh.wav", gain: 0.40, duckDb: 4},
    {id: "dark-mode", frame: 531, src: "media/sfx/toggle.wav", gain: 0.56, duckDb: 4.5},
    {id: "editorial-palette", frame: 567, src: "media/sfx/shutter-2.wav", gain: 0.54, duckDb: 4.2},
    {id: "provider-expand", frame: PROVIDERS_FROM + PROVIDER_TIMELINE.expandAt, src: "media/sfx/click.wav", gain: 0.48, duckDb: 4},
    {id: "provider-count", frame: PROVIDERS_FROM + PROVIDER_TIMELINE.countAt, src: "media/sfx/pop.wav", gain: 0.48, duckDb: 4},
    {id: "provider-wall", frame: PROVIDERS_FROM + PROVIDER_TIMELINE.wallAt, src: "media/sfx/chord.wav", gain: 0.42, duckDb: 4.2},
    ...PROVIDER_BUBBLE_CUES,
    {id: "provider-collapse", frame: PROVIDERS_FROM + PROVIDER_TIMELINE.collapseAt, src: "media/sfx/snap.wav", gain: 0.52, duckDb: 4},
    {id: "outro-cut", frame: OUTRO_TIMELINE.from, src: "media/sfx/whoosh.wav", gain: 0.38, duckDb: 4},
    ...OUTRO_TIMELINE.features.map((feature, index) => ({
      id: feature.id,
      frame: OUTRO_TIMELINE.from + feature.at,
      src: "media/sfx/pop.wav",
      gain: Number((0.40 + index * 0.04).toFixed(2)),
      duckDb: 3.5 + index * 0.4
    })),
    {id: "brand-resolve", frame: OUTRO_TIMELINE.from + OUTRO_TIMELINE.brandResolveAt, src: "media/sfx/resolve.wav", gain: 0.56, duckDb: 6},
    {id: "install-click", frame: OUTRO_TIMELINE.from + OUTRO_TIMELINE.installClickAt, src: "media/sfx/snap.wav", gain: 0.54, duckDb: 4.2}
  ],
  voices: [
    {id: "voice-0407", frame: SUBTITLE_FROM + SUBTITLE_MATCH_FRAME + 2, src: "media/sfx/voice-0407.wav", gain: 0.50, duckDb: 6.5, durationFrames: 48},
    {id: "voice-0232", frame: OVERVIEW_FROM + 5, src: "media/sfx/voice-0232.wav", gain: 0.50, duckDb: 6.5, durationFrames: 44},
    {id: "voice-0444", frame: CHAT_FROM + CHAT_PLAYER_VERIFY_FROM, src: "media/sfx/voice-0444.wav", gain: 0.50, duckDb: 6.5, durationFrames: 40}
  ]
};

export function musicVolumeAtFrame(frame) {
  const {fadeInFrames, fadeOutFrames, fadeOutEndFrame, gain} = AUDIO.music;
  const fadeIn = Math.min(1, Math.max(0, frame / fadeInFrames));
  const fadeOut = Math.min(1, Math.max(0, (fadeOutEndFrame - frame) / fadeOutFrames));
  let duck = 1;
  for (const cue of AUDIO.cues) {
    const local = frame - cue.frame;
    if (local < -2 || local > 16) continue;
    const envelope = local < 0 ? (local + 2) / 2 : local <= 8 ? 1 : (16 - local) / 8;
    duck = Math.min(duck, 1 - envelope * (1 - 10 ** (-cue.duckDb / 20)));
  }
  return gain * fadeIn * fadeOut * duck;
}
