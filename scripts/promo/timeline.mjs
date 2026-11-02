import {OUTRO_TIMELINE} from "./outro-timeline.mjs";
import {PROVIDER_LOGOS} from "./provider-logos.mjs";
import {SUBTITLE_MATCH_FRAME} from "./subtitle-timeline.mjs";

export const PROMO_WIDTH = 1920;
export const PROMO_HEIGHT = 1080;
export const PROMO_FPS = OUTRO_TIMELINE.fps;
export const PROMO_BPM = 120;
export const BEAT_FRAMES = (PROMO_FPS * 60) / PROMO_BPM;
export const beatF = (beats) => Math.round(beats * BEAT_FRAMES);
export const PROMO_DURATION = OUTRO_TIMELINE.from + OUTRO_TIMELINE.duration;

export const OVERVIEW_TIMELINE = {
  duration: beatF(18),
  triggerClickAt: 8,
  tldrAt: 10,
  spatialEnterAt: 20,
  chaptersAt: beatF(3),
  quoteCardAt: beatF(4.5),
  chapterClickAt: beatF(7),
  chapterSeekFrames: 10,
  quoteClickAt: beatF(11),
  quoteStartAt: beatF(11) + 9,
  quoteLiftFrames: 18
};

export const SUBTOOLS_TIMELINE = {
  duration: beatF(7),
  settledAt: 18,
  exportAt: beatF(3.5),
  exportClickAt: beatF(4.5)
};

export const WEBSEARCH_TIMELINE = {
  duration: beatF(7),
  searchBadgeAt: beatF(0.5),
  verifyCardAt: beatF(1.5)
};

export const APPEARANCE_TIMELINE = {
  duration: beatF(4),
  flymeDarkFrom: beatF(1),
  editorialLightFrom: beatF(2),
  editorialDarkFrom: beatF(3)
};

export const PROVIDER_TIMELINE = {
  duration: beatF(5),
  plateAt: 2,
  orbitAt: 4,
  logoStagger: 2.5,
  logoOffsets: [0, 3, 6, 8, 10, 12, 14, 16, 17, 18, 19, 20, 21, 22],
  logoPopFrames: 4,
  exitAt: 61,
  exitDuration: 12
};

export const SCENES = [
  { id: "overview", from: 0, duration: OVERVIEW_TIMELINE.duration },
  { id: "subtitle", from: 270, duration: 120 },
  { id: "chat", from: 390, duration: 165 },
  { id: "subtools", from: 555, duration: SUBTOOLS_TIMELINE.duration },
  { id: "websearch", from: 660, duration: WEBSEARCH_TIMELINE.duration },
  { id: "appearance", from: 765, duration: APPEARANCE_TIMELINE.duration },
  { id: "providers", from: 825, duration: PROVIDER_TIMELINE.duration },
  { id: "outro", from: OUTRO_TIMELINE.from, duration: OUTRO_TIMELINE.duration }
];

export const PANEL_FOCUS_HANDOFFS = [
  {from: "chat", to: "subtools", at: 555, exitFrames: 6, enterFrames: 7, maxBlur: 12},
  {from: "subtools", to: "websearch", at: 660, exitFrames: 6, enterFrames: 7, maxBlur: 12},
  {from: "websearch", to: "appearance", at: 765, exitFrames: 6, enterFrames: 7, maxBlur: 12}
];

export const CHAT_TIMESTAMP_CLICK_FRAME = beatF(5);
export const CHAT_PLAYER_VERIFY_FROM = 106;
export const CHAT_PLAYER_VERIFY_TO = 144;

export const CHAT_SHOTS = [
  { startFrom: 0, duration: 50, playbackRate: 1.5 },
  { startFrom: 300, duration: 55, playbackRate: 1.5 },
  { startFrom: 390, duration: 60, playbackRate: 0.75 }
];

export const APPEARANCE_SHOTS = [
  { id: "flyme-light", label: "蓝雾玻璃 · 日间", palette: "flyme", mode: "light", from: 0, duration: beatF(1), fontScale: 1.0 },
  { id: "flyme-dark", label: "蓝雾玻璃 · 夜间", palette: "flyme", mode: "dark", from: APPEARANCE_TIMELINE.flymeDarkFrom, duration: beatF(1), fontScale: 1.06 },
  { id: "editorial-light", label: "数字刊物 · 日间", palette: "editorial", mode: "light", from: APPEARANCE_TIMELINE.editorialLightFrom, duration: beatF(1), fontScale: 1.12 },
  { id: "editorial-dark", label: "数字刊物 · 夜间", palette: "editorial", mode: "dark", from: APPEARANCE_TIMELINE.editorialDarkFrom, duration: beatF(1), fontScale: 1.18 }
];

export const EVIDENCE_TIMES = [
  0, 0.4, 1.0, 1.6, 2.4, 3.2, 3.6, 4.4, 5.2, 5.6, 6.0, 6.5, 7.5, 8.9,
  9.0, 9.4, 9.9, 11.1, 12.0,
  13.1, 13.9, 15.6, 16.3, 16.6, 17.5,
  18.8, 19.5, 20.3, 21.2,
  22.3, 23.0, 24.0, 25.0,
  25.7, 26.0, 26.4, 26.8, 27.4,
  27.7, 28.1, 28.4, 28.9, 29.4, 29.8,
  30.3, 30.8, 31.4, 32.0, 32.7,
  (PROMO_DURATION - 1) / PROMO_FPS
];

const sceneFrom = (id) => SCENES.find((scene) => scene.id === id).from;
const sceneSeconds = (id, frame = 0) => (sceneFrom(id) + frame) / PROMO_FPS;
const providerSeconds = (frame) => sceneSeconds("providers", frame);
const outroSeconds = (frame) => (OUTRO_TIMELINE.from + frame) / PROMO_FPS;

export const EVIDENCE_TRANSITIONS = [
  {id: "overview-tldr", at: sceneSeconds("overview", OVERVIEW_TIMELINE.chaptersAt - 4)},
  {id: "overview-chapters", at: sceneSeconds("overview", OVERVIEW_TIMELINE.chaptersAt + 14)},
  {id: "chapter-seek", at: sceneSeconds("overview", OVERVIEW_TIMELINE.chapterClickAt + OVERVIEW_TIMELINE.chapterSeekFrames)},
  {id: "quote-lift", at: sceneSeconds("overview", OVERVIEW_TIMELINE.quoteStartAt)},
  {id: "quote-freeze", at: sceneSeconds("overview", OVERVIEW_TIMELINE.quoteStartAt + OVERVIEW_TIMELINE.quoteLiftFrames - 4)},
  {id: "keyword-slice", at: sceneSeconds("subtitle", 12)},
  {id: "timestamp-match", at: sceneSeconds("subtitle", SUBTITLE_MATCH_FRAME)},
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
  {id: "provider-lights", at: providerSeconds(PROVIDER_TIMELINE.orbitAt + PROVIDER_TIMELINE.logoOffsets[PROVIDER_LOGOS.length - 1])},
  {id: "provider-exit", at: providerSeconds(PROVIDER_TIMELINE.exitAt)},
  {id: "brand-resolve", at: outroSeconds(OUTRO_TIMELINE.brandResolveAt)},
  {id: "brand-tagline", at: outroSeconds(OUTRO_TIMELINE.taglineAt)},
  {id: "brand-cta", at: outroSeconds(OUTRO_TIMELINE.ctaAt + 12)},
  {id: "install-click", at: outroSeconds(OUTRO_TIMELINE.installClickAt)},
  {id: "final-hold", at: outroSeconds(OUTRO_TIMELINE.finalHoldAt), holdToEnd: true}
];
