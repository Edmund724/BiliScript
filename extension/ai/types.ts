// AI 域共享类型（08 票迁移）。
// 只放纯类型与常量型字面量，不依赖运行时模块，供 ai/ 内部各模块复用。

export type ChatMessageRole = "user" | "assistant" | "system" | "tool";

// OpenAI 兼容 tool_calls 结构（联网搜索管线，spec §2.1）：assistant 消息随带
// tool_calls，tool 消息以 tool_call_id 回填结果。arguments 为 JSON 字符串原文。
export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatMessageRole;
  content: string;
  // 仅 assistant(tool_calls) / tool 消息使用；无 tools 的普通消息不带字段。
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface SubtitleBodyItem {
  from: number;
  to: number;
  content: string;
  [key: string]: unknown;
}

export interface ChapterItem {
  title: string;
  from: number;
  to: number;
  [key: string]: unknown;
}

export interface HotComment {
  uname?: string;
  like?: number;
  message?: string;
  [key: string]: unknown;
}

export interface AiProvider {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  requiresKey?: boolean;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface AiContext {
  title?: string;
  url?: string;
  author?: string;
  uploadDate?: string;
  bvid?: string;
  cid?: string;
  aid?: string;
  pageIndex?: number;
  pageCount?: number;
  pageTitle?: string;
  subtitleLang?: string;
  selectedSubtitleId?: string;
  selectedSubtitleUrl?: string;
  chapters?: ChapterItem[];
  videoDuration?: number;
  includeTimestampInBody?: boolean;
  subtitleBody?: SubtitleBodyItem[];
  subtitleOptions?: Array<{ id: string; url: string; lang: string }>;
  hotComments?: HotComment[];
  isVideoContext?: boolean;
  compressedSummaryMarkdown?: string;
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

// tool_calls SSE 片段（联网搜索管线）：同一 tool call 的 id/name/arguments 可能
// 跨多个 chunk 分片到达，聚合由消费方（completion 的 drainSseStream）按 index 拼接。
export interface SseToolCallFragmentEvent {
  type: "tool-call-fragment";
  index: number;
  id?: string;
  name?: string;
  argsFragment: string;
}

// 单条 SSE chunk 携带的 finish_reason（"stop" | "tool_calls" | ...）。
export interface SseFinishEvent {
  type: "finish";
  reason: string;
}

// tool_calls 流聚合完成后逐条吐出（spec §2.2）：args 从 arguments JSON 宽容解析，
// 非对象 JSON 以原文包 { query } 兜底。
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
