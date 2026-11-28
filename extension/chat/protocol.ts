import type {
  ChatMessage,
  ConversationSummaryAnchor,
  StreamDoneEvent,
  StreamErrorEvent,
  StreamNoticeEvent,
  StreamReasoningEvent,
  StreamResetEvent,
  StreamStoppedEvent,
  StreamTokenEvent
} from "../ai/types.js";

export const OFFSCREEN_CHAT_PORT_NAME = "offscreen-chat" as const;

export type ChatTurnKind = "user" | "player-ai" | "video-note";

export type ChatTranscriptMode = "full" | "hybrid";

interface ChatReceipt {
  cachedContextKey?: string;
  transcriptMode?: ChatTranscriptMode;
}

type PortErrorEvent = StreamErrorEvent & { code?: string };

type PortStreamResetEvent = StreamResetEvent & { generation?: number };

type PortNoticeEvent = StreamNoticeEvent & { code?: "truncated" };

export interface ChatCostGuardEvent {
  type: "cost-guard";
  data?: { message?: string };
}

export interface ChatTokenBatchEvent {
  type: "token-batch";
  data: string[];
}

import type { ChatSearchSource } from "./search-sources.js";
import type { CapturedVideoFrame } from "../ai/types.js";
export type ChatToolStatusSource = ChatSearchSource;

export interface ChatToolStatusEvent {
  type: "tool-status";
  status: "searching" | "done" | "failed" | "cancelled";
  query: string;
  tool?: "read_subtitles" | "web_search" | "capture_video_frame_at_time";
  callId?: string;
  generation?: number;
  targetTime?: number;
  targetTimes?: number[];
  spanSeconds?: number;
  resultCount?: number;
  expectedCount?: number;
  frames?: CapturedVideoFrame[];
  platform?: string;
  sources?: ChatToolStatusSource[];
  paid?: boolean;
  paidFallbackNotice?: string;
}

export type ToolStatusMessage = ChatToolStatusEvent;

export interface ChatVideoFrameRequestEvent {
  type: "video-frame-request";
  requestId: string;
  targetTime?: number;
  times?: number[];
  spanSeconds?: number;
  maxFrames?: number;
}
export interface ChatVideoFrameCancelEvent {
  type: "video-frame-cancel";
  requestId: string;
}

export interface ChatToolTurnEvent {
  type: "tool-turn";
  messages: ChatMessage[];
  generation?: number;
}

export interface ChatCompactHistoryResultEvent {
  type: "compact-history-result";
  conversationId: string;
  ok: boolean;
  updated?: boolean;
  summaryAnchor?: ConversationSummaryAnchor;
}

export type ChatPortMessage =
  | (StreamTokenEvent & ChatReceipt)
  | (ChatTokenBatchEvent & ChatReceipt)
  | (StreamReasoningEvent & ChatReceipt)
  | (PortNoticeEvent & ChatReceipt)
  | (PortStreamResetEvent & ChatReceipt)
  | (ChatToolTurnEvent & ChatReceipt)
  | (ChatToolStatusEvent & ChatReceipt)
  | (ChatVideoFrameRequestEvent & ChatReceipt)
  | (ChatVideoFrameCancelEvent & ChatReceipt)
  | (StreamDoneEvent & ChatReceipt)
  | (StreamStoppedEvent & ChatReceipt)
  | (PortErrorEvent & ChatReceipt)
  | (ChatCostGuardEvent & ChatReceipt)
  | (ChatCompactHistoryResultEvent & ChatReceipt);

export interface ChatPort {
  postMessage(message: ChatPortMessage): void;
}

export const CHAT_SPEECH_PORT_NAME = "chat-speech" as const;
export const TTS_UNSUPPORTED_ERROR = "TTS_UNSUPPORTED" as const;

export interface ChatSpeechVoice {
  voiceName?: string;
  lang?: string;
  remote?: boolean;
}

export interface ChatSpeechEvent {
  type: string;
  errorMessage?: string;
}

export type ChatSpeechRequest =
  | { type: "get-voices"; requestId: number }
  | { type: "speak"; requestId: number; text: string; voiceName?: string; lang?: string; volume?: number }
  | { type: "stop" };

export type ChatSpeechPortMessage =
  | { type: "voices"; requestId: number; voices: ChatSpeechVoice[] }
  | { type: "event"; requestId: number; event: ChatSpeechEvent }
  | { type: "error"; requestId: number; message: string };
