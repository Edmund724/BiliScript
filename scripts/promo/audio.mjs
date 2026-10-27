import {PROMO_DURATION} from "./timeline.mjs";

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
    {id: "type-huan", frame: 102, src: "media/sfx/key.wav", gain: 0.5, duckDb: 2.5},
    {id: "type-jue", frame: 106, src: "media/sfx/key.wav", gain: 0.5, duckDb: 2.5},
    {id: "overview-cut", frame: 210, src: "media/sfx/whoosh.wav", gain: 0.35, duckDb: 4},
    {id: "chapters-quote-cut", frame: 262, src: "media/sfx/whoosh.wav", gain: 0.35, duckDb: 4},
    {id: "quote-card", frame: 278, src: "media/sfx/pop.wav", gain: 0.45, duckDb: 3},
    {id: "quote-slate", frame: 283, src: "media/sfx/pop.wav", gain: 0.4, duckDb: 3},
    {id: "quote-mist", frame: 295, src: "media/sfx/pop.wav", gain: 0.4, duckDb: 3},
    {id: "chat-cut", frame: 330, src: "media/sfx/whoosh.wav", gain: 0.35, duckDb: 4},
    {id: "appearance-cut", frame: 510, src: "media/sfx/whoosh.wav", gain: 0.35, duckDb: 4},
    {id: "dark-mode", frame: 531, src: "media/sfx/toggle.wav", gain: 0.5, duckDb: 3},
    {id: "editorial-palette", frame: 567, src: "media/sfx/pop.wav", gain: 0.45, duckDb: 3},
    {id: "outro-cut", frame: 600, src: "media/sfx/whoosh.wav", gain: 0.35, duckDb: 4},
    {id: "feature-reveal", frame: 608, src: "media/sfx/pop.wav", gain: 0.45, duckDb: 3},
    {id: "brand-resolve", frame: 650, src: "media/sfx/resolve.wav", gain: 0.45, duckDb: 5},
    {id: "install-click", frame: 708, src: "media/sfx/click.wav", gain: 0.45, duckDb: 3}
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
