import { describe, expect, it } from "vitest";
import {
  MOSS_VIDEO_FRAME_MAX_EDGE,
  getVideoFrameSize
} from "../../extension/live/page-video-frame-capture.js";

describe("getVideoFrameSize", () => {
  it("scales landscape and portrait frames to the configured long edge", () => {
    expect(getVideoFrameSize(1920, 1080)).toEqual({ width: 960, height: 540 });
    expect(getVideoFrameSize(1080, 1920)).toEqual({ width: 540, height: 960 });
    expect(getVideoFrameSize(1920, 1080, 480)).toEqual({ width: 480, height: 270 });
  });

  it("does not upscale smaller frames and keeps at least one pixel per edge", () => {
    expect(getVideoFrameSize(640, 360)).toEqual({ width: 640, height: 360 });
    expect(getVideoFrameSize(1, 10000)).toEqual({ width: 1, height: MOSS_VIDEO_FRAME_MAX_EDGE });
  });
});
