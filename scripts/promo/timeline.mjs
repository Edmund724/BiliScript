import {OUTRO_TIMELINE} from "./outro-timeline.mjs";

export {CAPTIONS} from "./captions.mjs";

export const PROMO_WIDTH = 1920;
export const PROMO_HEIGHT = 1080;
export const PROMO_FPS = OUTRO_TIMELINE.fps;
export const PROMO_DURATION = OUTRO_TIMELINE.from + OUTRO_TIMELINE.duration;

export const PROVIDER_TIMELINE = {
  duration: 150,
  dialogShot: {from: 0, duration: 30, source: 60, playbackRate: 2.5},
  expandAt: 19,
  countAt: 26,
  countDuration: 10,
  shotsExitAt: 30,
  shotsExitDuration: 6,
  wallAt: 36,
  cardStagger: 0.45,
  collapseAt: 134,
  wallExitAt: 138,
  wallExitDuration: 10,
  collapseDuration: 12
};

export const SCENES = [
  { id: "hero", from: 0, duration: 90 },
  { id: "subtitle", from: 90, duration: 120 },
  { id: "overview", from: 210, duration: 120 },
  { id: "chat", from: 330, duration: 180 },
  { id: "appearance", from: 510, duration: 90 },
  { id: "providers", from: 600, duration: PROVIDER_TIMELINE.duration },
  { id: "outro", from: OUTRO_TIMELINE.from, duration: OUTRO_TIMELINE.duration }
];

export const PANEL_FOCUS_HANDOFFS = [
  {from: "overview", to: "chat", at: 330, exitFrames: 6, enterFrames: 7, maxBlur: 12},
  {from: "chat", to: "appearance", at: 510, exitFrames: 6, enterFrames: 7, maxBlur: 12}
];

export const CHAT_SHOTS = [
  { startFrom: 0, duration: 45, playbackRate: 1 },
  { startFrom: 150, duration: 15, playbackRate: 1 },
  { startFrom: 405, duration: 120, playbackRate: 0.375 }
];

export const APPEARANCE_SHOTS = [
  { title: "深色模式，\n完整切换。", startFrom: 0, duration: 42, playbackRate: 1.35, width: 560, top: 28 },
  { title: "阅读色板，\n随你偏好。", startFrom: 80, duration: 48, playbackRate: 1.25, width: 780, top: 295 }
];

export const EVIDENCE_TIMES = [0, 0.5, 1, 1.5, 2.5, 3.2, 4.5, 5, 5.4, 6.8, 7.2, 8.2, 9.5, 10.2, 10.8, 11.2, 12, 12.5, 13, 14.5, 16.8, 17.2, 18.5, 19.8, 20.2, 20.8, 21.4, 22.5, 23.5, 24.5, 25.2, 25.8, 26.6, 27.6, 28.7, 29.2, 30, 30.7, 31.5, (PROMO_DURATION - 1) / PROMO_FPS];
