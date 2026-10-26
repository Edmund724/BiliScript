export {CAPTIONS} from "./captions.mjs";

export const PROMO_WIDTH = 1920;
export const PROMO_HEIGHT = 1080;
export const PROMO_FPS = 30;
export const PROMO_DURATION = 840;

export const SCENES = [
  { id: "hero", from: 0, duration: 90 },
  { id: "subtitle", from: 90, duration: 120 },
  { id: "overview", from: 210, duration: 120 },
  { id: "chat", from: 330, duration: 180 },
  { id: "appearance", from: 510, duration: 90 },
  { id: "outro", from: 600, duration: 240 }
];

export const CHAT_SHOTS = [
  { startFrom: 0, duration: 45, playbackRate: 1 },
  { startFrom: 150, duration: 15, playbackRate: 1 },
  { startFrom: 405, duration: 120, playbackRate: 0.375 }
];

export const EVIDENCE_TIMES = [0.5, 2.5, 3.2, 4.5, 5, 5.4, 6.8, 7.2, 8.2, 9.5, 10.2, 10.8, 11.2, 12, 12.5, 13, 14.5, 16.8, 17.2, 18.5, 19.8, 20.2, 21, 22, 22.8, 23.8, 24.2, 27.5];
