import type { AiContext, ImagePart } from "../ai/types.js";
import type { LiveTextToolHistoryEntry } from "../live/live-text-tool-history.js";

export interface ChatSessionMessage {
  role: string;
  content: string;
  images?: ImagePart[];
  contextKey?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  thinking?: string;
  stopped?: boolean;
}

export interface OrdinaryConversation {
  id: string;
  title: string;
  contextKey: string;
  contextTitle: string;
  contextUrl: string;
  isVideoContext: boolean;
  createdAt: number;
  updatedAt: number;
  contextRef: AiContext | null;
  messages: ChatSessionMessage[];
}

export type ChatSessionSavedConversation = OrdinaryConversation | LiveTextToolHistoryEntry;
