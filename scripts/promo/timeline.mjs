export {CAPTIONS} from "./captions.mjs";

export const PROMO_WIDTH = 1920;
export const PROMO_HEIGHT = 1080;
export const PROMO_FPS = 30;
export const PROMO_DURATION = 900;

export const SCENES = [
  { id: "hero", from: 0, duration: 90 },
  { id: "subtitle", from: 90, duration: 120 },
  { id: "overview", from: 210, duration: 120 },
  { id: "chat", from: 330, duration: 180 },
  { id: "appearance", from: 510, duration: 90 },
  { id: "providers", from: 600, duration: 60 },
  { id: "outro", from: 660, duration: 240 }
];

export const CHAT_SHOTS = [
  { startFrom: 0, duration: 45, playbackRate: 1 },
  { startFrom: 150, duration: 15, playbackRate: 1 },
  { startFrom: 405, duration: 120, playbackRate: 0.375 }
];

export const APPEARANCE_SHOTS = [
  { title: "深色模式，\n完整切换。", startFrom: 0, duration: 42, playbackRate: 1.35, crop: { x: 1366, y: 55, width: 540, height: 1025 }, width: 560, top: 28 },
  { title: "阅读色板，\n随你偏好。", startFrom: 80, duration: 48, playbackRate: 1.25, crop: { x: 1368, y: 500, width: 534, height: 320 }, width: 780, top: 295 }
];

export const EVIDENCE_TIMES = [0.5, 2.5, 3.2, 4.5, 5, 5.4, 6.8, 7.2, 8.2, 9.5, 10.2, 10.8, 11.2, 12, 12.5, 13, 14.5, 16.8, 17.2, 18.5, 19.8, 20.2, 20.7, 21, 21.4, 21.8, 22, 22.8, 23.8, 24.2, 26.3, 27.5, 29.5];
