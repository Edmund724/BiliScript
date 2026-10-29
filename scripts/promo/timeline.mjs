import {OUTRO_TIMELINE} from "./outro-timeline.mjs";
import {PROVIDER_LOGOS} from "./provider-logos.mjs";

export const PROMO_WIDTH = 1920;
export const PROMO_HEIGHT = 1080;
export const PROMO_FPS = OUTRO_TIMELINE.fps;
export const PROMO_DURATION = OUTRO_TIMELINE.from + OUTRO_TIMELINE.duration;

export const HERO_TIMELINE = {
  hookPopAt: 4,
  hookHoldUntil: 51,
  pullbackEnd: 57,
  clickAt: 56,
  headlineRevealAt: 57,
  snapEmphasisAt: 76
};

export const OVERVIEW_TIMELINE = {
  chapterRatio: 2.6 / 4,
  quoteLiftFrames: 18
};

export const APPEARANCE_TIMELINE = {
  darkFrom: 21,
  editorialFrom: 57
};

export const PROVIDER_TIMELINE = {
  duration: 150,
  dialogShot: {from: 0, duration: 48, source: 106, playbackRate: 1.4},
  shotsExitAt: 36,
  shotsExitDuration: 10,
  plateAt: 44,
  orbitAt: 52,
  logoStagger: 3.75,
  exitAt: 136,
  exitDuration: 12
};

export const SCENES = [
  { id: "hero", from: 0, duration: 105 },
  { id: "subtitle", from: 105, duration: 120 },
  { id: "overview", from: 225, duration: 120 },
  { id: "chat", from: 345, duration: 180 },
  { id: "appearance", from: 525, duration: 90 },
  { id: "providers", from: 615, duration: PROVIDER_TIMELINE.duration },
  { id: "outro", from: OUTRO_TIMELINE.from, duration: OUTRO_TIMELINE.duration }
];

export const PANEL_FOCUS_HANDOFFS = [
  {from: "overview", to: "chat", at: 345, exitFrames: 6, enterFrames: 7, maxBlur: 12},
  {from: "chat", to: "appearance", at: 525, exitFrames: 6, enterFrames: 7, maxBlur: 12}
];

export const CHAT_TIMESTAMP_CLICK_FRAME = 84;
export const CHAT_PLAYER_VERIFY_FROM = 114;
export const CHAT_PLAYER_VERIFY_TO = 154;

export const CHAT_SHOTS = [
  { startFrom: 0, duration: 54, playbackRate: 1.5 },
  { startFrom: 300, duration: 60, playbackRate: 1.5 },
  { startFrom: 390, duration: 66, playbackRate: 0.75 }
];

export const APPEARANCE_SHOTS = [
  { title: "深色模式，\n完整切换。", startFrom: 0, duration: 45, playbackRate: 1.35, width: 860, top: 172 },
  { title: "阅读色板，\n随你偏好。", startFrom: 101, duration: 45, playbackRate: 1.25, width: 788, top: 172 }
];

export const EVIDENCE_TIMES = [
  0, 0.2, 0.6, 1.2, 1.6, 2.0, 2.5, 3.1,
  3.7, 5.0, 5.5, 5.9, 7.3,
  7.7, 8.7, 10.1, 10.7, 11.3,
  11.7, 12.5, 13.0, 14.3, 15.0, 15.8, 16.7, 17.3,
  17.7, 18.3, 19.0, 19.6, 20.3,
  20.7, 21.3, 21.6, 21.9, 23.0, 24.0, 25.0,
  26.0, 27.2, 28.4, 29.6, 30.4, 30.8, 31.1, 31.4, 31.7, 32.3, 33.1,
  (PROMO_DURATION - 1) / PROMO_FPS
];

const PROVIDERS_FROM = SCENES.find((scene) => scene.id === "providers").from;
const providerSeconds = (frame) => (PROVIDERS_FROM + frame) / PROMO_FPS;
const outroSeconds = (frame) => (OUTRO_TIMELINE.from + frame) / PROMO_FPS;

export const EVIDENCE_TRANSITIONS = [
  {id: "pain-point-hook", at: 0.55},
  {id: "hero-pullback-open", at: 1.8},
  {id: "hero-slogan-zoom", at: 2.53},
  {id: "keyword-slice", at: 3.6},
  {id: "timestamp-match", at: 5.6},
  {id: "chapters", at: 7.5},
  {id: "quote-lift", at: 10.1},
  {id: "quote-freeze", at: 10.57},
  {id: "overview-chat-defocus", at: 11.5},
  {id: "chat-timestamp-click", at: 14.3},
  {id: "chat-player-verify", at: 15.6},
  {id: "chat-appearance-defocus", at: 17.5},
  {id: "appearance-dark-wipe", at: 18.2},
  {id: "appearance-palette-wipe", at: 19.4},
  {id: "providers", at: providerSeconds(0)},
  {id: "provider-plate", at: providerSeconds(PROVIDER_TIMELINE.plateAt)},
  {id: "provider-orbit", at: providerSeconds(PROVIDER_TIMELINE.orbitAt)},
  {id: "provider-lights", at: providerSeconds(PROVIDER_TIMELINE.orbitAt + (PROVIDER_LOGOS.length - 1) * PROVIDER_TIMELINE.logoStagger)},
  {id: "provider-exit", at: providerSeconds(PROVIDER_TIMELINE.exitAt)},
  ...OUTRO_TIMELINE.features.map((feature) => ({id: feature.id, at: outroSeconds(feature.at)})),
  {id: "feature-converge", at: outroSeconds(OUTRO_TIMELINE.convergeAt)},
  {id: "brand-resolve", at: outroSeconds(OUTRO_TIMELINE.brandResolveAt)},
  {id: "brand-tagline", at: outroSeconds(OUTRO_TIMELINE.taglineAt)},
  {id: "brand-cta", at: outroSeconds(OUTRO_TIMELINE.ctaAt + 12)},
  {id: "install-click", at: outroSeconds(OUTRO_TIMELINE.installClickAt)},
  {id: "final-hold", at: outroSeconds(OUTRO_TIMELINE.finalHoldAt), holdToEnd: true}
];
