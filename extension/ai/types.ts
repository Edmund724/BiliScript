import type { AiProtocol } from "./protocol-adapter.js";
import type { L1VideoIndexCacheRecord } from "./long-video-hybrid-types.js";
import type { SiteId } from "../shared/site.js";
import type {
  ChapterItem,
  HotComment,
  NoSubtitleReason,
  SubtitleBodyItem,
  SubtitleFetchState,
  SubtitleOption,
  SubtitleTrack
} from "../shared/video-dto.js";

export type {
  ChapterItem,
  HotComment,
  NoSubtitleReason,
  SubtitleBodyItem,
  SubtitleFetchState,
  SubtitleOption,
  SubtitleTrack
} from "../shared/video-dto.js";

export type ChatMessageRole = "user" | "assistant" | "system" | "tool";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ImagePart {
  mime: string;
  data: string;
}

export interface CapturedVideoFrame {
  image: ImagePart;
  currentTime: number;
}

export type CaptureCurrentVideoFrame = (targetTime?: number, signal?: AbortSignal) => Promise<CapturedVideoFrame | CapturedVideoFrame[]>;

export type ThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export interface ChatMessage {
  role: ChatMessageRole;
  content: string;
  images?: ImagePart[];
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  thoughtSignature?: string;
  thinkingBlocks?: ThinkingBlock[];
  parts?: unknown[];
  thinking?: string;
  stopped?: boolean;
}

export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

export interface AiProvider {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  presetId?: string;
  sessionId?: string;
  requiresKey?: boolean;
  enabled?: boolean;
  protocol?: AiProtocol;
  [key: string]: unknown;
}

export interface ProviderRequest {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  presetId?: string;
  protocol?: AiProtocol;
  sessionId?: string;
}

export interface AiContext {
  site?: SiteId;
  title?: string;
  url?: string;
  author?: string;
  uploadDate?: string;
  description?: string;
  videoDescription?: string;
  bvid?: string;
  cid?: string;
  aid?: string;
  pageIndex?: number;
  pageCount?: number;
  pageTitle?: string;
  subtitleFetchState?: SubtitleFetchState;
  noSubtitleReason?: NoSubtitleReason;
  subtitleLang?: string;
  selectedSubtitleLang?: string;
  selectedSubtitleId?: string;
  selectedSubtitleUrl?: string;
  chapters?: ChapterItem[];
  videoDuration?: number;
  includeTimestampInBody?: boolean;
  subtitleBody?: SubtitleBodyItem[];
  subtitleOptions?: SubtitleOption[];
  hotComments?: HotComment[];
  isVideoContext?: boolean;
  signature?: string;
  compressedSummaryMarkdown?: string;
  hybridRetrievalMarkdown?: string;
  frameContextNote?: string;
  l1Index?: L1VideoIndexCacheRecord | null;
  aiSystemPrompt?: string;
  [key: string]: unknown;
}

export interface BudgetPlanSegment {
  index: number;
  from: number;
  to: number;
  chars: number;
  items: SubtitleBodyItem[];
}

export interface BudgetPlan {
  totalChars: number;
  estimatedTokens: number;
  mode: "single" | "map-reduce";
  segments: BudgetPlanSegment[];
  estimatedCalls: number;
  needsReduce: boolean;
  reduceGroupInputChars: number;
}

export interface SseEvent {
  type: "reasoning" | "content";
  data: string;
}

export interface SseToolCallFragmentEvent {
  type: "tool-call-fragment";
  index: number;
  id?: string;
  name?: string;
  argsFragment: string;
}

export interface SseFinishEvent {
  type: "finish";
  reason: string;
}

export interface StreamToolCallEvent {
  type: "tool-call";
  name: string;
  args: { query: string };
}

export interface StreamTokenEvent {
  type: "token";
  data: string;
}

export interface StreamReasoningEvent {
  type: "reasoning";
  data: string;
}

export interface StreamNoticeEvent {
  type: "notice";
  data: string;
}

export interface StreamResetEvent {
  type: "stream-reset";
}

export interface StreamDoneEvent {
  type: "done";
}

export interface StreamStoppedEvent {
  type: "stopped";
  reason: string;
}

export interface StreamErrorEvent {
  type: "error";
  error: string;
}

export type StreamChatEvent =
  | StreamTokenEvent
  | StreamReasoningEvent
  | StreamNoticeEvent
  | StreamResetEvent
  | StreamToolCallEvent
  | StreamDoneEvent
  | StreamStoppedEvent
  | StreamErrorEvent;
