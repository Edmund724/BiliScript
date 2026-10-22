import { describe, expect, it } from "vitest";
import { isAutoOpenEligible } from "../../extension/bilibili/video-id-shared.js";

describe("isAutoOpenEligible (自动打开文摘面板判定)", () => {
  it("普通视频页面应判定为允许自动打开", () => {
    expect(isAutoOpenEligible("https://www.bilibili.com/video/BV1xx411c7mD/")).toBe(true);
    expect(isAutoOpenEligible("https://www.bilibili.com/video/BV1xx411c7mD/?p=2")).toBe(true);
    expect(isAutoOpenEligible("https://www.bilibili.com/video/av170001")).toBe(true);
  });

  it("稍后再看页面应排除", () => {
    expect(isAutoOpenEligible("https://www.bilibili.com/list/watchlater")).toBe(false);
    expect(isAutoOpenEligible("https://www.bilibili.com/list/watchlater/")).toBe(false);
    expect(isAutoOpenEligible("https://www.bilibili.com/list/watchlater?bvid=BV1xx411c7mD")).toBe(false);
    expect(isAutoOpenEligible("https://www.bilibili.com/video/BV1xx411c7mD/?from=watchlater")).toBe(false);
    expect(isAutoOpenEligible("https://www.bilibili.com/video/BV1xx411c7mD/?business=watchlater")).toBe(false);
  });

  it("收藏夹与媒体列表播放页面应排除", () => {
    expect(isAutoOpenEligible("https://www.bilibili.com/list/ml12345678?bvid=BV1xx411c7mD")).toBe(false);
    expect(isAutoOpenEligible("https://www.bilibili.com/medialist/play/ml12345678/BV1xx411c7mD")).toBe(false);
    expect(isAutoOpenEligible("https://www.bilibili.com/video/BV1xx411c7mD/?business=space_favlist")).toBe(false);
    expect(isAutoOpenEligible("https://www.bilibili.com/video/BV1xx411c7mD/?from=space_favlist")).toBe(false);
    expect(isAutoOpenEligible("https://www.bilibili.com/video/BV1xx411c7mD/?business=space_collection")).toBe(false);
    expect(isAutoOpenEligible("https://www.bilibili.com/video/BV1xx411c7mD/?from=space_collection")).toBe(false);
  });

  it("非视频页面与外部域名应排除", () => {
    expect(isAutoOpenEligible("https://www.bilibili.com/read/cv12345")).toBe(false);
    expect(isAutoOpenEligible("https://space.bilibili.com/12345")).toBe(false);
    expect(isAutoOpenEligible("https://example.com/video/BV1xx")).toBe(false);
    expect(isAutoOpenEligible("invalid-url")).toBe(false);
  });
});
