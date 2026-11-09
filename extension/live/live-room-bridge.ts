// extension/live/live-room-bridge.ts
// 直播间伴看上下文：只有房间号与展示信息。直播没有字幕、概览与章节，也不可回看，
// 页面工具一律不可用（MOSS-LIVE 的工具声明在服务端，客户端只能拒绝执行）。

import { parseLiveRoomId } from "../bilibili/video-id-shared.js";
import type { MossLiveRoomContext, MossLiveToolCall } from "./moss-live-protocol.js";

export interface LiveRoomBridgeDeps {
  getUrl?: () => string;
  getTitle?: () => string;
  getAnchorName?: () => string;
}

export interface LiveRoomBridge {
  getVideoContext(): MossLiveRoomContext | null;
  executeTool(call: MossLiveToolCall): Promise<Record<string, unknown>>;
}

const ANCHOR_NAME_SELECTORS = [
  ".room-owner-username",
  ".header-info-ctnr .room-owner-username",
  ".upper-row .room-owner-username"
];

function readDocumentTitle(): string {
  return String(document.title || "")
    .replace(/\s*[-_|]\s*哔哩哔哩直播.*$/, "")
    .trim();
}

function readAnchorName(): string {
  for (const selector of ANCHOR_NAME_SELECTORS) {
    const text = document.querySelector(selector)?.textContent?.trim();
    if (text) return text;
  }
  return "";
}

export function createLiveRoomBridge(deps: LiveRoomBridgeDeps = {}): LiveRoomBridge {
  const getUrl = deps.getUrl ?? (() => location.href);
  const getTitle = deps.getTitle ?? readDocumentTitle;
  const getAnchorName = deps.getAnchorName ?? readAnchorName;

  function getVideoContext(): MossLiveRoomContext | null {
    const url = getUrl();
    const roomId = parseLiveRoomId(url);
    if (!roomId) return null;
    return {
      kind: "live-room",
      url,
      roomId,
      title: getTitle(),
      anchorName: getAnchorName()
    };
  }

  async function executeTool(call: MossLiveToolCall): Promise<Record<string, unknown>> {
    throw new Error(`直播间不支持页面工具：${String(call?.name || "未知").trim()}`);
  }

  return { getVideoContext, executeTool };
}
