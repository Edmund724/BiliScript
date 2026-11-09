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
  duration: beatF(22),
  triggerClickAt: 36,
  tldrAt: 42,
  spatialEnterAt: 64,
  chaptersAt: beatF(6),
  quoteCardAt: beatF(8),
  chapterClickAt: beatF(10),
  chapterSeekFrames: 10,
  quoteClickAt: beatF(15),
  quoteStartAt: beatF(15) + 9,
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

export const LIVE_TIMELINE = {
  duration: beatF(11),
  toggleClickAt: 10,
  overlayOpenAt: 14,
  userPromptAt: 22,
  duckActiveAt: 30,
  aiReplyAt: 45,
  aiReplyDoneAt: 142
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
  { id: "subtools", from: 330, duration: SUBTOOLS_TIMELINE.duration },
  { id: "websearch", from: 435, duration: WEBSEARCH_TIMELINE.duration },
  { id: "subtitle", from: 540, duration: 120 },
  { id: "chat", from: 660, duration: 165 },
  { id: "live", from: 825, duration: LIVE_TIMELINE.duration },
  { id: "providers", from: 990, duration: PROVIDER_TIMELINE.duration },
  { id: "outro", from: OUTRO_TIMELINE.from, duration: OUTRO_TIMELINE.duration }
];

export const PANEL_FOCUS_HANDOFFS = [
  {from: "subtools", to: "websearch", at: 435, exitFrames: 6, enterFrames: 7, maxBlur: 12}
];

export const CHAT_TIMESTAMP_CLICK_FRAME = beatF(5);
export const CHAT_PLAYER_VERIFY_FROM = 106;
export const CHAT_PLAYER_VERIFY_TO = 144;

export const CHAT_SHOTS = [
  { startFrom: 0, duration: 50, playbackRate: 1.5 },
  { startFrom: 300, duration: 55, playbackRate: 1.5 },
  { startFrom: 390, duration: 60, playbackRate: 0.75 }
];

export const EVIDENCE_TIMES = [
  0, 0.6, 1.2, 1.8, 2.2, 2.8, 3.6, 4.4, 5.2, 6.2, 7.5, 7.9, 9.0, 10.8,
  11.3, 12.0, 12.8, 13.8,
  14.8, 15.5, 16.5, 17.5,
  18.0, 18.4, 18.9, 20.1, 21.0,
  22.1, 22.9, 24.6, 25.3, 25.6, 26.5,
  27.8, 28.4, 29.1, 30.4, 31.8, 32.5,
  33.2, 33.6, 33.9, 34.4, 34.9, 35.3,
  35.8, 36.3, 36.9, 37.5, 38.2,
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
  {id: "subtools-export-click", at: sceneSeconds("subtools", SUBTOOLS_TIMELINE.exportClickAt)},
  {id: "subtools-websearch-defocus", at: sceneSeconds("websearch")},
  {id: "websearch-verify-card", at: sceneSeconds("websearch", WEBSEARCH_TIMELINE.verifyCardAt)},
  {id: "keyword-slice", at: sceneSeconds("subtitle", 12)},
  {id: "timestamp-match", at: sceneSeconds("subtitle", SUBTITLE_MATCH_FRAME)},
  {id: "chat-timestamp-click", at: sceneSeconds("chat", CHAT_TIMESTAMP_CLICK_FRAME)},
  {id: "chat-player-verify", at: sceneSeconds("chat", CHAT_PLAYER_VERIFY_FROM - 6)},
  {id: "live-overlay-open", at: sceneSeconds("live", LIVE_TIMELINE.overlayOpenAt)},
  {id: "live-voice-priority", at: sceneSeconds("live", LIVE_TIMELINE.duckActiveAt)},
  {id: "live-ai-reply", at: sceneSeconds("live", LIVE_TIMELINE.aiReplyAt + 12)},
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
