// tests/live/live-room.test.ts
// 直播间实时伴看：房间号判定、会话上下文投影、工具拒绝与提示词/工具声明裁剪

import { describe, expect, it } from "vitest";
import { isLiveRoomPage, parseLiveRoomId } from "../../extension/bilibili/video-id-shared.js";
import { createLiveRoomBridge } from "../../extension/live/live-room-bridge.js";
import {
  buildMinimalSessionUpdatePayload,
  buildVideoInstructions,
  toolCallVideoIdentity,
  type MossLiveVideoContext
} from "../../extension/live/moss-live-protocol.js";
import { buildGeminiSetupTools } from "../../extension/live/offscreen-gemini-live-client.js";
import { buildPlayerLiveQuickActionIconSvg } from "../../extension/ui/icons.js";
import { startLiveRoomCompanion } from "../../extension/live/live-room-entry.js";

const ROOM_URL = "https://live.bilibili.com/21452505?broadcast_type=0";

describe("parseLiveRoomId / isLiveRoomPage", () => {
  it("只认 live.bilibili.com/<数字房间号>", () => {
    expect(parseLiveRoomId("https://live.bilibili.com/21452505")).toBe("21452505");
    expect(parseLiveRoomId("https://live.bilibili.com/21452505/")).toBe("21452505");
    expect(parseLiveRoomId(ROOM_URL)).toBe("21452505");
  });

  it("排除嵌入页、活动页、首页与其他域名", () => {
    expect(isLiveRoomPage("https://live.bilibili.com/blanc/21452505")).toBe(false);
    expect(isLiveRoomPage("https://live.bilibili.com/")).toBe(false);
    expect(isLiveRoomPage("https://live.bilibili.com/p/eden/area-tags")).toBe(false);
    expect(isLiveRoomPage("https://www.bilibili.com/21452505")).toBe(false);
    expect(isLiveRoomPage("not a url")).toBe(false);
  });
});

describe("createLiveRoomBridge", () => {
  it("以房间号为身份投影上下文，标题与主播名取注入值", () => {
    const bridge = createLiveRoomBridge({
      getUrl: () => ROOM_URL,
      getTitle: () => "深夜杂谈",
      getAnchorName: () => "某主播"
    });
    expect(bridge.getVideoContext()).toEqual({
      kind: "live-room",
      url: ROOM_URL,
      roomId: "21452505",
      title: "深夜杂谈",
      anchorName: "某主播"
    });
  });

  it("非直播间页面没有上下文", () => {
    const bridge = createLiveRoomBridge({ getUrl: () => "https://live.bilibili.com/" });
    expect(bridge.getVideoContext()).toBeNull();
  });

  it("页面工具一律拒绝执行", async () => {
    const bridge = createLiveRoomBridge({ getUrl: () => ROOM_URL });
    await expect(
      bridge.executeTool({ callId: "c1", name: "search_video_subtitles", arguments: "{}" })
    ).rejects.toThrow("直播间不支持页面工具：search_video_subtitles");
  });
});

describe("直播间提示词与工具声明", () => {
  const room = {
    kind: "live-room" as const,
    url: ROOM_URL,
    roomId: "21452505",
    title: "深夜杂谈",
    anchorName: "某主播"
  };

  it("提示词带房间标题与主播名，不含字幕/概览/跳转教学", () => {
    const text = buildVideoInstructions(room);
    expect(text).toContain("直播间");
    expect(text).toContain("突然被压低");
    expect(text).toContain("当前直播间：深夜杂谈");
    expect(text).toContain("主播：某主播");
    expect(text).not.toContain("search_video_subtitles");
    expect(text).not.toContain("BV：");
  });

  it("没有主播名时不写主播行", () => {
    expect(buildVideoInstructions({ ...room, anchorName: "" })).not.toContain("主播：");
  });

  it("session.update 载荷接受直播间上下文", () => {
    const payload = buildMinimalSessionUpdatePayload(room);
    expect(payload.session.instructions).toBe(buildVideoInstructions(room));
  });

  it("工具调用的视频身份：直播间与空上下文为 null，视频页保持三元组", () => {
    const video: MossLiveVideoContext = {
      url: "https://www.bilibili.com/video/BV1xx",
      bvid: "BV1xx",
      cid: "7",
      title: "t",
      pageIndex: 2,
      pageCount: 3,
      pageTitle: "",
      chapters: []
    };
    expect(toolCallVideoIdentity(room)).toBeNull();
    expect(toolCallVideoIdentity(null)).toBeNull();
    expect(toolCallVideoIdentity(video)).toEqual({ bvid: "BV1xx", cid: "7", pageIndex: 2 });
  });

  it("Gemini 直播间只声明联网搜索，视频页声明全集", () => {
    const roomTools = JSON.stringify(buildGeminiSetupTools(false, room));
    expect(roomTools).toContain("web_search");
    expect(roomTools).not.toContain("get_subtitles_around_time");
    expect(roomTools).not.toContain("control_bilibili_player");
    expect(JSON.stringify(buildGeminiSetupTools(true, room))).toBe(JSON.stringify([{ googleSearch: {} }]));
    expect(JSON.stringify(buildGeminiSetupTools(false, null))).toContain("get_subtitles_around_time");
  });
});


describe("直播间伴看开关按钮", () => {
  it("挂载到现行直播控制栏扩展位，复用伴看图标与无障碍标签", async () => {
    const host = document.createElement("div");
    host.id = "live-player";
    const controller = document.createElement("div");
    controller.className = "live-web-player-controller";
    const rightArea = document.createElement("div");
    rightArea.className = "right-area";
    const controls = document.createElement("div");
    controls.className = "ext-nodes";
    rightArea.appendChild(controls);
    controller.appendChild(rightArea);
    host.appendChild(controller);
    document.body.appendChild(host);

    await startLiveRoomCompanion();

    const btn = host.querySelector<HTMLButtonElement>(".biliscript-live-room-toggle");
    expect(btn).not.toBeNull();
    expect(btn?.parentElement).toBe(controls);
    expect(btn?.innerHTML).toBe(buildPlayerLiveQuickActionIconSvg());
    expect(btn?.getAttribute("aria-label")).toBe("实时伴看");
    expect(btn?.title).toBe("实时伴看");

    host.remove();
  });
});
