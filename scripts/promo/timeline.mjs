import {OUTRO_TIMELINE} from "./outro-timeline.mjs";
import {PROVIDER_LOGOS} from "./provider-logos.mjs";
import {SUBTITLE_MATCH_FRAME} from "./subtitle-timeline.mjs";

export const PROMO_WIDTH = 1920;
export const PROMO_HEIGHT = 1080;
export const PROMO_FPS = OUTRO_TIMELINE.fps;
export const PROMO_DURATION = OUTRO_TIMELINE.from + OUTRO_TIMELINE.duration;

export const HERO_TIMELINE = {
  firstLineAt: 2,
  iconAt: 24,
  clickAt: 41,
  pageTurnAt: 48,
  answerAt: 66,
  pushInFrom: 78,
  pushInTo: 108,
  holdAt: 132
};

export const OVERVIEW_TIMELINE = {
  duration: 165,
  chapterRatio: 84 / 165,
  quoteClickFrame: 75,
  quoteLiftFrames: 18
};

export const SUBTOOLS_TIMELINE = {
  duration: 135,
  bilingualAt: 44,
  exportAt: 90,
  exportClickAt: 85
};

export const WEBSEARCH_TIMELINE = {
  duration: 75,
  searchBadgeAt: 8,
  verifyCardAt: 22
};

export const APPEARANCE_TIMELINE = {
  duration: 60,
  flymeDarkFrom: 15,
  editorialLightFrom: 30,
  editorialDarkFrom: 45
};

export const PROVIDER_TIMELINE = {
  duration: 60,
  plateAt: 2,
  orbitAt: 4,
  logoStagger: 2.5,
  exitAt: 46,
  exitDuration: 12
};

export const SCENES = [
  { id: "hero", from: 0, duration: 150 },
  { id: "subtitle", from: 150, duration: 120 },
  { id: "overview", from: 270, duration: OVERVIEW_TIMELINE.duration },
  { id: "chat", from: 435, duration: 165 },
  { id: "subtools", from: 600, duration: SUBTOOLS_TIMELINE.duration },
  { id: "websearch", from: 735, duration: WEBSEARCH_TIMELINE.duration },
  { id: "appearance", from: 810, duration: APPEARANCE_TIMELINE.duration },
  { id: "providers", from: 870, duration: PROVIDER_TIMELINE.duration },
  { id: "outro", from: OUTRO_TIMELINE.from, duration: OUTRO_TIMELINE.duration }
];

export const PANEL_FOCUS_HANDOFFS = [
  {from: "overview", to: "chat", at: 435, exitFrames: 6, enterFrames: 7, maxBlur: 12},
  {from: "chat", to: "subtools", at: 600, exitFrames: 6, enterFrames: 7, maxBlur: 12},
  {from: "subtools", to: "websearch", at: 735, exitFrames: 6, enterFrames: 7, maxBlur: 12},
  {from: "websearch", to: "appearance", at: 810, exitFrames: 6, enterFrames: 7, maxBlur: 12}
];

export const CHAT_TIMESTAMP_CLICK_FRAME = 78;
export const CHAT_PLAYER_VERIFY_FROM = 106;
export const CHAT_PLAYER_VERIFY_TO = 144;

export const CHAT_SHOTS = [
  { startFrom: 0, duration: 50, playbackRate: 1.5 },
  { startFrom: 300, duration: 55, playbackRate: 1.5 },
  { startFrom: 390, duration: 60, playbackRate: 0.75 }
];

export const APPEARANCE_SHOTS = [
  { id: "flyme-light", label: "蓝雾玻璃 · 日间", palette: "flyme", mode: "light", from: 0, duration: 15, fontScale: 1.0 },
  { id: "flyme-dark", label: "蓝雾玻璃 · 夜间", palette: "flyme", mode: "dark", from: 15, duration: 15, fontScale: 1.06 },
  { id: "editorial-light", label: "数字刊物 · 日间", palette: "editorial", mode: "light", from: 30, duration: 15, fontScale: 1.12 },
  { id: "editorial-dark", label: "数字刊物 · 夜间", palette: "editorial", mode: "dark", from: 45, duration: 15, fontScale: 1.18 }
];

export const EVIDENCE_TIMES = [
  0, 0.4, 0.8, 1.2, 1.4, 1.6, 2.0, 2.2, 3.2, 4.4,
  5.0, 5.4, 5.9, 7.1, 8.0,
  9.2, 10.0, 10.9, 11.8, 12.3, 13.2, 14.0,
  14.6, 15.4, 17.1, 17.8, 18.1, 19.0,
  20.3, 21.0, 21.5, 22.5, 22.9, 23.5,
  24.7, 25.2, 26.0, 26.6,
  27.2, 27.5, 28.0, 28.5, 28.9,
  29.2, 29.6, 30.0, 30.3, 30.8,
  31.3, 31.8, 32.5, 33.1, 34.0,
  (PROMO_DURATION - 1) / PROMO_FPS
];

const sceneFrom = (id) => SCENES.find((scene) => scene.id === id).from;
const sceneSeconds = (id, frame = 0) => (sceneFrom(id) + frame) / PROMO_FPS;
const providerSeconds = (frame) => sceneSeconds("providers", frame);
const outroSeconds = (frame) => (OUTRO_TIMELINE.from + frame) / PROMO_FPS;
const OVERVIEW_CHAPTER_FRAMES = Math.round(OVERVIEW_TIMELINE.duration * OVERVIEW_TIMELINE.chapterRatio);

export const EVIDENCE_TRANSITIONS = [
  {id: "hero-icon", at: sceneSeconds("hero", HERO_TIMELINE.iconAt)},
  {id: "hero-click", at: sceneSeconds("hero", HERO_TIMELINE.clickAt)},
  {id: "hero-panel-open", at: sceneSeconds("hero", HERO_TIMELINE.pageTurnAt)},
  {id: "hero-answer", at: sceneSeconds("hero", HERO_TIMELINE.answerAt)},
  {id: "hero-tldr-push", at: sceneSeconds("hero", HERO_TIMELINE.pushInFrom)},
  {id: "keyword-slice", at: sceneSeconds("subtitle", 12)},
  {id: "timestamp-match", at: sceneSeconds("subtitle", SUBTITLE_MATCH_FRAME)},
  {id: "chapters", at: sceneSeconds("overview")},
  {id: "quote-lift", at: sceneSeconds("overview", OVERVIEW_CHAPTER_FRAMES)},
  {id: "quote-freeze", at: sceneSeconds("overview", OVERVIEW_CHAPTER_FRAMES + OVERVIEW_TIMELINE.quoteLiftFrames - 4)},
  {id: "overview-chat-defocus", at: sceneSeconds("chat")},
  {id: "chat-timestamp-click", at: sceneSeconds("chat", CHAT_TIMESTAMP_CLICK_FRAME)},
  {id: "chat-player-verify", at: sceneSeconds("chat", CHAT_PLAYER_VERIFY_FROM - 6)},
  {id: "chat-subtools-defocus", at: sceneSeconds("subtools")},
  {id: "subtools-export-click", at: sceneSeconds("subtools", SUBTOOLS_TIMELINE.exportClickAt)},
  {id: "subtools-websearch-defocus", at: sceneSeconds("websearch")},
  {id: "websearch-verify-card", at: sceneSeconds("websearch", WEBSEARCH_TIMELINE.verifyCardAt)},
  {id: "websearch-appearance-defocus", at: sceneSeconds("appearance")},
  {id: "appearance-flyme-dark", at: sceneSeconds("appearance", APPEARANCE_TIMELINE.flymeDarkFrom)},
  {id: "appearance-editorial-light", at: sceneSeconds("appearance", APPEARANCE_TIMELINE.editorialLightFrom)},
  {id: "appearance-editorial-dark", at: sceneSeconds("appearance", APPEARANCE_TIMELINE.editorialDarkFrom)},
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
