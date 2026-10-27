import {describe, expect, it} from "vitest";
import {
  SUBTITLE_ANCHORS,
  SUBTITLE_DURATION,
  SUBTITLE_MATCH_FRAME,
  SUBTITLE_PLAYBACK_RATE,
  SUBTITLE_SECOND_SHOT_SOURCE_FRAME,
  subtitleCameraAtFrame
} from "../../scripts/promo/subtitle-timeline.mjs";
import {PROMO_FPS, SCENES} from "../../scripts/promo/timeline.mjs";

const project = (point: {x: number; y: number}, camera: ReturnType<typeof subtitleCameraAtFrame>) => ({
  x: point.x * camera.scale + camera.x,
  y: point.y * camera.scale + camera.y
});

describe("字幕时间戳匹配剪辑", () => {
  it("在真实点击切点保持选中时刻的位置和尺寸，再连续拉回播放器", () => {
    const scene = SCENES.find((candidate) => candidate.id === "subtitle");
    expect(SUBTITLE_DURATION).toBe(scene?.duration);
    expect(SUBTITLE_PLAYBACK_RATE).toBe(1.25);
    expect(SUBTITLE_MATCH_FRAME).toBe(61);
    expect(SUBTITLE_SECOND_SHOT_SOURCE_FRAME).toBe(76);
    expect(SUBTITLE_ANCHORS.before.timestamp).toBe("0:01");
    expect(SUBTITLE_ANCHORS.before.seconds).toBe(1.62);

    const beforeCamera = subtitleCameraAtFrame(SUBTITLE_MATCH_FRAME - 1);
    const afterCamera = subtitleCameraAtFrame(SUBTITLE_MATCH_FRAME);
    const beforeCenter = project(SUBTITLE_ANCHORS.before.center, beforeCamera);
    const afterCenter = project(SUBTITLE_ANCHORS.after.center, afterCamera);
    expect(afterCenter.x).toBeCloseTo(beforeCenter.x, 6);
    expect(afterCenter.y).toBeCloseTo(beforeCenter.y, 6);
    expect(beforeCamera.tilt).toBe(0);
    expect(afterCamera.tilt).toBe(0);
    expect(SUBTITLE_ANCHORS.after.height * afterCamera.scale).toBeCloseTo(SUBTITLE_ANCHORS.before.height * beforeCamera.scale, 6);
    expect(SUBTITLE_ANCHORS.after.height * afterCamera.scale).toBeGreaterThanOrEqual(22);

    const playerCamera = subtitleCameraAtFrame(75);
    const settledCamera = subtitleCameraAtFrame(96);
    expect(afterCamera.scale).toBeLessThan(beforeCamera.scale);
    expect(playerCamera.scale).toBeLessThan(afterCamera.scale);
    expect(settledCamera.scale).toBe(1.35);
    expect(settledCamera.x).toBeCloseTo(101.4, 6);
    expect(settledCamera.y).toBeCloseTo(-206.85, 6);
    expect(settledCamera.tilt).toBe(0);
    expect(playerCamera.x).toBeGreaterThan(afterCamera.x);
    const matchSeconds = ((scene?.from ?? 0) + SUBTITLE_MATCH_FRAME) / PROMO_FPS;
    expect(matchSeconds).toBeGreaterThanOrEqual(5);
    expect(matchSeconds).toBeLessThan(6);
  });

  it("只在字幕正文和关键控件达到 22px 后展示字幕面板", () => {
    for (let frame = 0; frame < SUBTITLE_DURATION; frame += 1) {
      const camera = subtitleCameraAtFrame(frame);
      const panelLeft = 1365 * camera.scale + camera.x;
      const panelRight = 1920 * camera.scale + camera.x;
      const panelVisible = panelLeft < 1920 && panelRight > 0;
      if (panelVisible) {
        expect(camera.scale * 14, `frame ${frame}`).toBeGreaterThanOrEqual(22);
      }
    }
    const settledCamera = subtitleCameraAtFrame(96);
    expect(1365 * settledCamera.scale + settledCamera.x).toBeGreaterThan(1920);
  });
});
