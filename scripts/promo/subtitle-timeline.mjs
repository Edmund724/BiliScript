import {Easing, interpolate} from "remotion";

export const SUBTITLE_DURATION = 120;
export const SUBTITLE_PLAYBACK_RATE = 1.25;
export const SUBTITLE_MATCH_FRAME = 61;
export const SUBTITLE_SECOND_SHOT_SOURCE_FRAME = 76;

export const SUBTITLE_ANCHORS = {
  before: {
    timestamp: "0:01",
    seconds: 1.62,
    center: {x: 1426.3984375, y: 315.5},
    height: 21
  },
  after: {
    timestamp: "0:01",
    seconds: 1.62,
    center: {x: 1433.3984375, y: 302.5},
    height: 23
  }
};

const BEFORE_MATCH = {scale: 2, x: -1410, y: -400, tilt: 0};
const MATCH_SCREEN = {
  x: SUBTITLE_ANCHORS.before.center.x * BEFORE_MATCH.scale + BEFORE_MATCH.x,
  y: SUBTITLE_ANCHORS.before.center.y * BEFORE_MATCH.scale + BEFORE_MATCH.y
};
const AFTER_SCALE = SUBTITLE_ANCHORS.before.height * BEFORE_MATCH.scale / SUBTITLE_ANCHORS.after.height;
const AFTER_MATCH = {
  scale: AFTER_SCALE,
  x: MATCH_SCREEN.x - SUBTITLE_ANCHORS.after.center.x * AFTER_SCALE,
  y: MATCH_SCREEN.y - SUBTITLE_ANCHORS.after.center.y * AFTER_SCALE,
  tilt: 0
};

const PLAYER_WIDE = {scale: 1.35, x: 101.4, y: -206.85, tilt: 0};
const FRAMES = [0, 9, 22, 45, 55, 60, 61, 75, 96];
const CAMERAS = [
  PLAYER_WIDE,
  PLAYER_WIDE,
  {scale: 2, x: -1540, y: -232, tilt: 0},
  {scale: 2, x: -1540, y: -232, tilt: 0},
  BEFORE_MATCH,
  BEFORE_MATCH,
  AFTER_MATCH,
  {scale: 1.6, x: -160, y: -270, tilt: 0},
  PLAYER_WIDE
];

const interpolateCamera = (frame, property) => interpolate(frame, FRAMES, CAMERAS.map((camera) => camera[property]), {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
  easing: Easing.bezier(0.16, 1, 0.3, 1)
});

export function subtitleCameraAtFrame(frame) {
  return {
    scale: interpolateCamera(frame, "scale"),
    x: interpolateCamera(frame, "x"),
    y: interpolateCamera(frame, "y"),
    tilt: interpolateCamera(frame, "tilt")
  };
}
