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
  duration: 165,
  chapterRatio: 84 / 165,
  quoteClickFrame: 75,
  quoteLiftFrames: 18
};

export const SUBTOOLS_TIMELINE = {
  duration: 105,
  bilingualAt: 10,
  exportAt: 48,
  exportClickAt: 66
};

export const WEBSEARCH_TIMELINE = {
  duration: 75,
  searchBadgeAt: 8,
  verifyCardAt: 22
};

export const APPEARANCE_TIMELINE = {
  flymeDarkFrom: 22,
  editorialLightFrom: 44,
  editorialDarkFrom: 67
};

export const PROVIDER_TIMELINE = {
  duration: 90,
  plateAt: 2,
  orbitAt: 6,
  logoStagger: 3.2,
  exitAt: 78,
  exitDuration: 10
};

export const SCENES = [
  { id: "hero", from: 0, duration: 105 },
  { id: "subtitle", from: 105, duration: 120 },
  { id: "overview", from: 225, duration: OVERVIEW_TIMELINE.duration },
  { id: "chat", from: 390, duration: 180 },
  { id: "subtools", from: 570, duration: SUBTOOLS_TIMELINE.duration },
  { id: "websearch", from: 675, duration: WEBSEARCH_TIMELINE.duration },
  { id: "appearance", from: 750, duration: 90 },
  { id: "providers", from: 840, duration: PROVIDER_TIMELINE.duration },
  { id: "outro", from: OUTRO_TIMELINE.from, duration: OUTRO_TIMELINE.duration }
];

export const PANEL_FOCUS_HANDOFFS = [
  {from: "overview", to: "chat", at: 390, exitFrames: 6, enterFrames: 7, maxBlur: 12},
  {from: "chat", to: "subtools", at: 570, exitFrames: 6, enterFrames: 7, maxBlur: 12},
  {from: "subtools", to: "websearch", at: 675, exitFrames: 6, enterFrames: 7, maxBlur: 12},
  {from: "websearch", to: "appearance", at: 750, exitFrames: 6, enterFrames: 7, maxBlur: 12}
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
  { id: "flyme-light", label: "蓝雾玻璃 · 日间", palette: "flyme", mode: "light", from: 0, duration: 22, fontScale: 1.0 },
  { id: "flyme-dark", label: "蓝雾玻璃 · 夜间", palette: "flyme", mode: "dark", from: 22, duration: 22, fontScale: 1.06 },
  { id: "editorial-light", label: "数字刊物 · 日间", palette: "editorial", mode: "light", from: 44, duration: 23, fontScale: 1.12 },
  { id: "editorial-dark", label: "数字刊物 · 夜间", palette: "editorial", mode: "dark", from: 67, duration: 23, fontScale: 1.18 }
];

export const EVIDENCE_TIMES = [
  0, 0.2, 0.6, 1.2, 1.6, 2.0, 2.5, 3.1,
  3.7, 5.0, 5.5, 5.9, 7.3,
  7.7, 8.7, 10.0, 10.3, 10.9, 12.0, 12.8,
  13.2, 14.0, 14.5, 15.8, 16.5, 17.3, 18.2, 18.8,
  19.2, 19.8, 20.6, 21.2, 22.1,
  22.7, 23.3, 24.0, 24.7,
  25.2, 25.9, 26.6, 27.4,
  28.2, 28.8, 29.6, 30.5,
  31.3, 31.8, 32.5, 33.1, 34.0,
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
  {id: "quote-lift", at: 10.3},
  {id: "quote-freeze", at: 10.77},
  {id: "overview-chat-defocus", at: 13.0},
  {id: "chat-timestamp-click", at: 15.8},
  {id: "chat-player-verify", at: 17.1},
  {id: "chat-subtools-defocus", at: 19.0},
  {id: "subtools-export-click", at: (570 + SUBTOOLS_TIMELINE.exportClickAt) / PROMO_FPS},
  {id: "subtools-websearch-defocus", at: 22.5},
  {id: "websearch-verify-card", at: (675 + WEBSEARCH_TIMELINE.verifyCardAt) / PROMO_FPS},
  {id: "websearch-appearance-defocus", at: 25.0},
  {id: "appearance-flyme-dark", at: (750 + APPEARANCE_TIMELINE.flymeDarkFrom) / PROMO_FPS},
  {id: "appearance-editorial-light", at: (750 + APPEARANCE_TIMELINE.editorialLightFrom) / PROMO_FPS},
  {id: "appearance-editorial-dark", at: (750 + APPEARANCE_TIMELINE.editorialDarkFrom) / PROMO_FPS},
  {id: "providers", at: providerSeconds(0)},
  {id: "provider-plate", at: providerSeconds(PROVIDER_TIMELINE.plateAt)},
  {id: "provider-orbit", at: providerSeconds(PROVIDER_TIMELINE.orbitAt)},
  {id: "provider-lights", at: providerSeconds(PROVIDER_TIMELINE.orbitAt + (PROVIDER_LOGOS.length - 1) * PROVIDER_TIMELINE.logoStagger)},
  {id: "provider-exit", at: providerSeconds(PROVIDER_TIMELINE.exitAt)},
  {id: "brand-resolve", at: outroSeconds(OUTRO_TIMELINE.brandResolveAt)},
  {id: "brand-tagline", at: outroSeconds(OUTRO_TIMELINE.taglineAt)},
  {id: "brand-cta", at: outroSeconds(OUTRO_TIMELINE.ctaAt + 12)},
  {id: "install-click", at: outroSeconds(OUTRO_TIMELINE.installClickAt)},
  {id: "final-hold", at: outroSeconds(OUTRO_TIMELINE.finalHoldAt), holdToEnd: true}
];
