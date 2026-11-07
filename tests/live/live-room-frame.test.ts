import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isLiveRoomPage, parseLiveRoomId } from "../../extension/bilibili/video-id-shared.js";

const PLAYER_FRAME_URL = "https://live.bilibili.com/blanc/23612045?liteVersion=true";

describe("直播间内嵌播放器", () => {
  it("blanc 框架保留房间号，只在嵌入时作为直播间启动", () => {
    expect(parseLiveRoomId(PLAYER_FRAME_URL)).toBe("23612045");
    expect(isLiveRoomPage(PLAYER_FRAME_URL, true)).toBe(true);
    expect(isLiveRoomPage(PLAYER_FRAME_URL, false)).toBe(false);
  });

  it("直播内容脚本进入同源框架，视频页仍只注入顶层", () => {
    const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8")) as {
      content_scripts: { matches: string[]; all_frames: boolean }[];
    };
    const live = manifest.content_scripts.find((entry) => entry.matches.includes("https://live.bilibili.com/*"));
    const video = manifest.content_scripts.find((entry) => entry.matches.includes("https://www.bilibili.com/video/*"));
    expect(live?.all_frames).toBe(true);
    expect(video?.all_frames).toBe(false);
  });
});
