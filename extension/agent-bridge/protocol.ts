import { DEFAULT_SETTINGS } from "../core/defaults.js";

export const AGENT_BRIDGE_URL = DEFAULT_SETTINGS.agentBridgeUrl;
export const AGENT_BRIDGE_PROTOCOL = "biliscript-extension-v1";
export const AGENT_BRIDGE_ALARM = "biliscript-agent-bridge-reconnect";

export interface AgentBridgeTabSnapshot {
  tabId: number;
  bvid: string;
  cid: string;
  title: string;
  currentTime: number;
  duration: number;
  subtitlesReady: boolean;
}

export interface AgentBridgeTabsResult {
  tabs: AgentBridgeTabSnapshot[];
}

export interface AgentBridgeRequestOptions {
  tabId?: number;
  bvid?: string;
  from?: number;
  to?: number;
  targetTime?: number;
}

export interface AgentBridgeFrame {
  data: string;
  targetTime: number;
  currentTime: number;
}

export interface AgentBridgeFramesResult {
  bvid: string;
  cid: string;
  frames: AgentBridgeFrame[];
}

export interface AgentBridgeOffscreenFrameMessage {
  type: "agent-bridge-offscreen-frame";
  bvid: string;
  cid: string;
  targetTime: number;
}

export interface AgentBridgeOffscreenFrameResponse {
  ok: boolean;
  result?: AgentBridgeFramesResult;
  error?: string;
}

export const AGENT_BRIDGE_FRAME_TASK_PREPARE = "agent-bridge-frame-prepare";

export interface AgentBridgeSubtitleItem {
  from: number;
  to: number;
  content: string;
}

export interface AgentBridgeVideo {
  bvid: string;
  aid: string;
  cid: string;
  title: string;
  author: string;
  description: string;
  uploadDate: string;
  duration: number;
  page: number;
  pageCount: number;
}

export interface AgentBridgePage {
  cid: string;
  page: number;
  part: string;
  duration: number;
}

export interface AgentBridgeChapter {
  title: string;
  from: number;
  to: number;
  source: string;
}

export interface AgentBridgeSubtitle {
  source: string;
  trackId: string;
  language: string;
  items: AgentBridgeSubtitleItem[];
}

export interface AgentBridgeSubtitlesResult {
  video: AgentBridgeVideo;
  pages: AgentBridgePage[];
  chapters: AgentBridgeChapter[];
  subtitle: AgentBridgeSubtitle;
}

export interface AgentBridgeComment {
  uname: string;
  like: number;
  message: string;
  subMessages?: string[];
}

export interface AgentBridgeCommentsResult {
  video: AgentBridgeVideo;
  comments: AgentBridgeComment[];
}

export interface AgentBridgeContentSubtitlesResult {
  bvid: string;
  cid: string;
  pageIndex: number;
  chapters: AgentBridgeChapter[];
  subtitle: AgentBridgeSubtitle;
}
