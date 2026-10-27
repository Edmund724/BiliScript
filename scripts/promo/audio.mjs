import {OUTRO_TIMELINE} from "./outro-timeline.mjs";
import {SUBTITLE_MATCH_FRAME} from "./subtitle-timeline.mjs";
import {PANEL_FOCUS_HANDOFFS, PROMO_DURATION, SCENES} from "./timeline.mjs";

const SUBTITLE_FROM = SCENES.find((scene) => scene.id === "subtitle").from;

export const AUDIO = {
  music: {
    src: "media/promo-score.wav",
    style: "Tech Pop",
    bpm: 120,
    license: "Original work; MIT License",
    durationInFrames: PROMO_DURATION,
    gain: 0.8,
    fadeInFrames: 24,
    fadeOutFrames: 60
  },
  cues: [
    {id: "subtitle-cut", frame: 90, src: "media/sfx/whoosh.wav", gain: 0.35, duckDb: 4},
    {id: "subtitle-keyword-resolve", frame: 100, src: "media/sfx/click.wav", gain: 0.35, duckDb: 2.5},
    {id: "type-huan", frame: 102, src: "media/sfx/key.wav", gain: 0.5, duckDb: 2.5},
    {id: "type-jue", frame: 106, src: "media/sfx/key.wav", gain: 0.5, duckDb: 2.5},
    {id: "subtitle-seek", frame: SUBTITLE_FROM + SUBTITLE_MATCH_FRAME, src: "media/sfx/click.wav", gain: 0.45, duckDb: 3},
    {id: "overview-cut", frame: 210, src: "media/sfx/whoosh.wav", gain: 0.35, duckDb: 4},
    {id: "chapters-quote-cut", frame: 262, src: "media/sfx/whoosh.wav", gain: 0.35, duckDb: 4},
    {id: "quote-card", frame: 278, src: "media/sfx/pop.wav", gain: 0.45, duckDb: 3},
    {id: "quote-slate", frame: 283, src: "media/sfx/pop.wav", gain: 0.4, duckDb: 3},
    {id: "quote-mist", frame: 295, src: "media/sfx/pop.wav", gain: 0.4, duckDb: 3},
    ...PANEL_FOCUS_HANDOFFS.flatMap((handoff) => [
      {id: `${handoff.from}-defocus`, frame: handoff.at - handoff.exitFrames, src: "media/sfx/click.wav", gain: 0.18, duckDb: 2},
      {id: `${handoff.to}-focus`, frame: handoff.at + handoff.enterFrames, src: "media/sfx/whoosh.wav", gain: 0.28, duckDb: 3}
    ]),
    {id: "dark-mode", frame: 531, src: "media/sfx/toggle.wav", gain: 0.5, duckDb: 3},
    {id: "editorial-palette", frame: 567, src: "media/sfx/pop.wav", gain: 0.45, duckDb: 3},
    {id: "provider-expand", frame: 618, src: "media/sfx/click.wav", gain: 0.42, duckDb: 3},
    {id: "provider-count", frame: 627, src: "media/sfx/pop.wav", gain: 0.38, duckDb: 3},
    {id: "provider-wall", frame: 634, src: "media/sfx/chord.wav", gain: 0.4, duckDb: 4},
    {id: "provider-collapse", frame: 654, src: "media/sfx/click.wav", gain: 0.36, duckDb: 3},
    {id: "outro-cut", frame: 660, src: "media/sfx/whoosh.wav", gain: 0.22, duckDb: 3},
    ...OUTRO_TIMELINE.features.map((feature) => ({
      id: feature.id,
      frame: OUTRO_TIMELINE.from + feature.at,
      src: "media/sfx/pop.wav",
      gain: 0.4,
      duckDb: 3
    })),
    {id: "brand-resolve", frame: OUTRO_TIMELINE.from + OUTRO_TIMELINE.convergeAt, src: "media/sfx/resolve.wav", gain: 0.45, duckDb: 5},
    {id: "install-click", frame: OUTRO_TIMELINE.from + OUTRO_TIMELINE.installClickAt, src: "media/sfx/click.wav", gain: 0.45, duckDb: 3}
  ]
};

export function musicVolumeAtFrame(frame) {
  const {durationInFrames, fadeInFrames, fadeOutFrames, gain} = AUDIO.music;
  const fadeIn = Math.min(1, Math.max(0, frame / fadeInFrames));
  const fadeOut = Math.min(1, Math.max(0, (durationInFrames - frame) / fadeOutFrames));
  let duck = 1;
  for (const cue of AUDIO.cues) {
    const local = frame - cue.frame;
    if (local < -2 || local > 16) continue;
    const envelope = local < 0 ? (local + 2) / 2 : local <= 8 ? 1 : (16 - local) / 8;
    duck = Math.min(duck, 1 - envelope * (1 - 10 ** (-cue.duckDb / 20)));
  }
  return gain * fadeIn * fadeOut * duck;
}
