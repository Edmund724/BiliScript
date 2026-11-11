export const AGENT_BRIDGE_URL = "ws://127.0.0.1:18492";
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
