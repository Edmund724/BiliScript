import { formatClock } from "../shared/clock-text.js";
import {
  MOSS_DOWNSTREAM_SAMPLE_RATE,
  MOSS_FRAME_DURATION_MS,
  MOSS_UPSTREAM_FRAME_BYTES,
  MOSS_UPSTREAM_FRAME_SAMPLES,
  MOSS_UPSTREAM_SAMPLE_RATE,
  createPcm16kFrameChunker,
  decodePcmS16LEToFloat32,
  encodeFloat32ToPcmS16LE,
  resampleMonoFloat32,
  type Pcm16kFrameChunker
} from "./pcm-capture-core.js";
import {
  LIVE_CONTEXT_CHARS_PER_TOKEN,
  LIVE_CONTEXT_COMPACT_MAX_CHARS,
  LIVE_CONTEXT_HARD_MAX_CHARS,
  LIVE_CONTEXT_TIER_B_MAX_CHAPTERS,
  LIVE_CONTEXT_TIER_B_SUMMARY_MAX_CHARS,
  LIVE_CONTEXT_TIER_C_MAX_ANCHORS,
  LIVE_CONTEXT_TIER_C_SUMMARY_MAX_CHARS,
  assembleLiveContextBudget,
  type LiveContextBudgetResult,
  type LiveContextBudgetTier
} from "./live-context-budget.js";
import { type MossVideoCaptureConfig, type MossVideoConfiguredReceipt } from "./moss-video-config.js";

export {
  LIVE_CONTEXT_CHARS_PER_TOKEN,
  LIVE_CONTEXT_COMPACT_MAX_CHARS,
  LIVE_CONTEXT_HARD_MAX_CHARS,
  LIVE_CONTEXT_TIER_B_MAX_CHAPTERS,
  LIVE_CONTEXT_TIER_B_SUMMARY_MAX_CHARS,
  LIVE_CONTEXT_TIER_C_MAX_ANCHORS,
  LIVE_CONTEXT_TIER_C_SUMMARY_MAX_CHARS,
  assembleLiveContextBudget,
  type LiveContextBudgetResult,
  type LiveContextBudgetTier
};

export const enum MossBinaryTag {
  AudioPcm = 0x00,
  CameraJpeg = 0x01,
  ScreenJpeg = 0x02
}

export type LiveProviderType = "moss-live" | "gemini-live";
export const DEFAULT_MOSS_LIVE_WS_URL = "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0";
export const MOSS_LIVE_PORT_NAME = "offscreen-moss-live";
export const MAX_MOSS_RECONNECT_ATTEMPTS = 3;
export const DEFAULT_MOSS_RECONNECT_DELAY_MS = 500;
export const DEFAULT_LIVE_HANDSHAKE_TIMEOUT_MS = 10000;

export {
  MOSS_UPSTREAM_SAMPLE_RATE,
  MOSS_DOWNSTREAM_SAMPLE_RATE,
  MOSS_FRAME_DURATION_MS,
  MOSS_UPSTREAM_FRAME_SAMPLES,
  MOSS_UPSTREAM_FRAME_BYTES,
  encodeFloat32ToPcmS16LE,
  decodePcmS16LEToFloat32,
  resampleMonoFloat32,
  createPcm16kFrameChunker,
  type Pcm16kFrameChunker
};

export function packTaggedBinary(
  tag: MossBinaryTag,
  payload: ArrayBufferLike | Uint8Array
): Uint8Array<ArrayBuffer> {
  const src = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const out = new Uint8Array(src.byteLength + 1);
  out[0] = tag;
  out.set(src, 1);
  return out;
}

export function unpackTaggedBinary(data: ArrayBufferLike): { tag: MossBinaryTag; payload: Uint8Array } | null {
  if (data.byteLength < 1) return null;
  const view = new Uint8Array(data);
  return {
    tag: view[0] as MossBinaryTag,
    payload: view.subarray(1)
  };
}

export function encodeBase64Bytes(bytes: Uint8Array | ArrayBufferLike): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength === 0) return "";
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < view.byteLength; i += chunkSize) {
    const sub = view.subarray(i, Math.min(i + chunkSize, view.byteLength));
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

export function decodeBase64Bytes(base64: string): Uint8Array<ArrayBuffer> {
  if (!base64 || typeof base64 !== "string") {
    return new Uint8Array(0);
  }
  try {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

export function resolveMossLiveWsUrl(baseUrl?: string, model?: string): string {
  const rawUrl = String(baseUrl || "").trim() || "https://api.mosi.cn";
  const selectedModel = String(model || "").trim() || "moss-live-1.0";
  try {
    const parsed = new URL(rawUrl);
    const wsProtocol = parsed.protocol === "http:" ? "ws:" : "wss:";
    const host = parsed.host;
    let path = parsed.pathname;
    if (!path || path === "/") {
      path = "/v1/realtime";
    } else if (path.endsWith("/realtime")) {
    } else if (path.endsWith("/v1")) {
      path = path + "/realtime";
    } else {
      path = path.replace(/\/+$/, "") + "/v1/realtime";
    }
    return `${wsProtocol}//${host}${path}?model=${encodeURIComponent(selectedModel)}`;
  } catch {
    return `wss://api.mosi.cn/v1/realtime?model=${encodeURIComponent(selectedModel)}`;
  }
}

export const DEFAULT_GEMINI_LIVE_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export function resolveGeminiLiveWsUrl(baseUrl?: string): string {
  const rawUrl = String(baseUrl || "").trim() || "https://generativelanguage.googleapis.com";
  try {
    const parsed = new URL(rawUrl);
    const wsProtocol = parsed.protocol === "http:" || parsed.protocol === "ws:" ? "ws:" : "wss:";
    const host = parsed.host || "generativelanguage.googleapis.com";
    return `${wsProtocol}//${host}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;
  } catch {
    return DEFAULT_GEMINI_LIVE_WS_URL;
  }
}

export function resolveMossLivePermissionOrigins(
  baseUrl?: string,
  model?: string,
  providerType?: "moss-live" | "gemini-live" | string
): [string, string] {
  const rawUrl = String(baseUrl || "").trim();
  const isGeminiType = providerType === "gemini-live";
  if (isGeminiType || rawUrl) {
    try {
      const fallbackUrl = isGeminiType ? "https://generativelanguage.googleapis.com" : "https://api.mosi.cn";
      const parsed = new URL(rawUrl || fallbackUrl);
      if (isGeminiType || parsed.hostname.toLowerCase() === "generativelanguage.googleapis.com") {
        const isHttp = parsed.protocol === "http:" || parsed.protocol === "ws:";
        const httpProtocol = isHttp ? "http:" : "https:";
        const wsProtocol = isHttp ? "ws:" : "wss:";
        return [`${httpProtocol}//${parsed.host}`, `${wsProtocol}//${parsed.host}`];
      }
    } catch {
      if (isGeminiType) {
        return ["https://generativelanguage.googleapis.com", "wss://generativelanguage.googleapis.com"];
      }
    }
  }
  const effectiveUrl = rawUrl || "https://api.mosi.cn";
  return [effectiveUrl, resolveMossLiveWsUrl(effectiveUrl, model)];
}

export const resolveLivePermissionOrigins = resolveMossLivePermissionOrigins;

export const MOSS_LIVE_PAGE_FUNCTION_DECLARATIONS = [
  {
    type: "function",
    name: "control_bilibili_player",
    description:
      "控制当前B站视频播放器：暂停/继续播放、调整倍速、精确跳转到指定秒数、按相对秒数快进/快退，或调整视频音量/静音（仅控制视频播放器音量，不影响伴看AI语音音量）。仅在用户明确要求控制播放时调用；后台委派或章节概览提供定位时间戳后，可使用 seek 执行跳转。",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: ["seek", "seekBy", "pause", "play", "rate", "volume"],
          description: "控制命令"
        },
        time: {
          type: "number",
          description: "seek 的目标播放位置（秒），超出 [0, 视频时长] 时自动钳制"
        },
        offset: {
          type: "number",
          description: "seekBy 的相对时间偏移秒数（正数快进、负数快退，如 15 快进 15 秒、-15 快退 15 秒），自动钳制在 [0, 视频时长] 内"
        },
        rate: {
          type: "number",
          description: "rate 的目标倍速（合法区间 0.5–4.0，如 0.5、0.75、1、1.25、1.5、2、3、4）"
        },
        volume: { type: "number", description: "volume 的目标视频音量百分比（0-100）；不能与 delta 同时传入" },
        delta: { type: "number", description: "volume 的相对音量变化量（-100 到 100，如 -15 降低 15%、15 提高 15%）；不能与 volume 同时传入" },
        muted: { type: "boolean", description: "volume 时是否静音视频播放器（true 静音，false 取消静音）" }
      },
      required: ["command"]
    }
  },
  {
    type: "function",
    name: "get_subtitles_around_time",
    description: "查询当前视频指定播放位置前后的局部字幕。未传 current_time 时使用当前播放位置；全片检索或总结必须改用后台委派。",
    read_only: true,
    parameters: {
      type: "object",
      properties: {
        current_time: { type: "number", description: "播放位置（秒），缺省为当前播放位置" },
        before_seconds: { type: "number", description: "向前查询秒数，默认 30，最大 300" },
        after_seconds: { type: "number", description: "向后查询秒数，默认 30，最大 300" }
      }
    }
  }
] as const;

export const MOSS_LIVE_OVERVIEW_PHASES = [
  "idle",
  "generating",
  "ready",
  "partial",
  "error",
  "empty",
  "cancelled"
] as const;

export type MossLiveOverviewPhase = (typeof MOSS_LIVE_OVERVIEW_PHASES)[number];

export interface MossLiveOverviewChapter {
  from: number;
  to: number;
  time: string;
  title: string;
  summary: string;
}

export interface MossLiveOverviewQuote {
  from: number;
  time: string;
  content: string;
}

export interface MossLiveOverviewContext {
  phase: MossLiveOverviewPhase;
  coverage: "complete" | "partial" | "none";
  summary: string;
  chapters: MossLiveOverviewChapter[];
  quotes: MossLiveOverviewQuote[];
  failedRanges?: Array<{ from: number; to: number }>;
  summaryFailed?: boolean;
  statusText: string;
}

export interface MossLiveVideoContext {
  url: string;
  bvid: string;
  cid: string;
  title: string;
  pageIndex: number;
  pageCount: number;
  pageTitle: string;
  chapters: Array<{ title: string; from: number; to?: number }>;
  overview?: MossLiveOverviewContext | null;
  compressedSummaryMarkdown?: string;
}

export interface MossLiveRoomContext {
  kind: "live-room";
  url: string;
  roomId: string;
  title: string;
  anchorName: string;
}

export type MossLiveSessionContext = MossLiveVideoContext | MossLiveRoomContext;

export function isLiveRoomContext(
  context: MossLiveSessionContext | null | undefined
): context is MossLiveRoomContext {
  return Boolean(context && "kind" in context && context.kind === "live-room");
}

export interface MossLiveVideoIdentity {
  bvid: string;
  cid: string;
  pageIndex: number;
}

export function toolCallVideoIdentity(
  context: MossLiveSessionContext | null | undefined
): MossLiveVideoIdentity | null {
  if (!context || isLiveRoomContext(context)) return null;
  return { bvid: context.bvid, cid: context.cid, pageIndex: context.pageIndex };
}

export interface MossLiveToolCall {
  callId: string;
  name: string;
  arguments: unknown;
  turnId?: string;
  video?: MossLiveVideoIdentity | null;
}

export interface MinimalSessionUpdatePayload {
  action: "session.update";
  session: {
    persona: {
      name: string;
      aliases: string[];
      prompt: string;
    };
    instructions: string;
    tools: readonly unknown[];
  };
}

function buildLiveRoomInstructions(context: MossLiveRoomContext): string {
  const base = "当前正在观看B站直播间伴看会话。实时画面来自B站播放器屏幕抽帧（screen通道），并非用户摄像头（camera）；回答画面相关问题时直接依据当前屏幕帧，切勿提示用户打开摄像头。若上行音频中同时包含直播间原声与用户麦克风声音：当检测到用户麦克风说话时，系统会自动把上行混音中的直播间原声音量突然压低，因此只要听到背景原声突然被压低且出现前景人声，即代表是用户本人在对你说话；未发生音量压低的连续人声则是直播间主播或嘉宾原声，不要误判为用户提问。直播没有字幕、概览与章节，也不可回看或跳转，不得调用字幕、概览与播放器控制工具，也不得编造直播中未出现的内容。需要直播之外的外部事实、时效性信息或联网查证时调用 web_search。任何工具返回 ok:false、无结果、失败或超时时必须明确告知用户，不得声称操作已成功，不得编造外部事实。";
  return `${base}\n${assembleLiveContextBudget(context).text}`;
}

export function buildVideoInstructions(
  context: MossLiveSessionContext | null | undefined
): string {
  if (isLiveRoomContext(context)) {
    return buildLiveRoomInstructions(context);
  }
  const shortClock = formatClock(5, { hours: "auto" });
  const longClock = formatClock(3725, { hours: "auto" });
  const volumeBoundary = "control_bilibili_player 的 volume 仅控制 B 站视频播放器音量，不影响伴看 AI 语音音量；若用户觉得伴看 AI 自身说话太大声或太小声，请提示用户在伴看浮窗音频设置中调节「伴看音量」，不要误调视频音量。";
  const playerControlRule = "仅当用户明确表达播放控制意图时才调用 control_bilibili_player，普通讲解、回答或提及时间点时绝不擅自跳播或改变播放状态；快进或快退相对秒数请调用 seekBy（offset 正数快进、负数快退），上下文已有章节时间点时可直接调用 seek 跳章。";
  const taskRouting = `当用户要求控制播放器（跳转进度、暂停/播放/倍速/调节视频音量或静音）时，请直接调用前台工具；${playerControlRule}${volumeBoundary}常规脉络与章节大意直接根据上下文中的概览或章节骨架秒答（若已有覆盖完整的全片概览，可直接读取并回答，无需重复委派；概览覆盖不完整时必须明确说明）；仅在概览未就绪且用户要求总结全片或片段内容，或用户追问具体某段原话细节需跨片查证时，请通过后台委派（delegation）交由后台文本模型处理，普通日常闲聊或常识问题请直接回答。用户要求跳到刚才总结或分析中的某一点、某一章节时，直接读取已注入的带时间戳笔记或章节骨架，把时间戳换算成秒数后调用 control_bilibili_player 的 seek，不要重复总结或重新检索全片。当前播放位置附近的局部台词查证可使用 get_subtitles_around_time；不得用前台字幕工具或 web_search 代替后台委派。后台委派被取消或失败时如实说明，不得编造视频内容。`;
  const base = `当前正在观看B站视频伴看会话。实时视频画面来自B站播放器屏幕抽帧（screen通道），并非用户摄像头（camera）；回答画面相关问题时直接依据当前屏幕帧，切勿提示用户打开摄像头。若上行音频中同时包含视频原声与用户麦克风声音：当检测到用户麦克风说话时，系统会自动把上行混音中的视频原声音量突然压低，因此只要听到背景视频声音突然被压低且出现前景人声，即代表是用户本人在对你说话；未发生音量压低的连续人声则是视频原声，不要误判为用户提问。${taskRouting}需要视频之外的外部事实、时效性信息或联网查证时调用 web_search。任何工具返回 ok:false、无结果、失败或超时时必须明确告知用户，不得声称操作已成功，不得编造外部事实。引用具体字幕时在回答中保留工具返回的 time 时刻文本（如 ${shortClock} 或 ${longClock}）。`;
  if (!context) {
    return `${base} 当前视频上下文尚未就绪或正在换片；此时不得沿用旧视频信息，工具不可用时明确说明并请用户稍后重试。`;
  }
  const budgeted = assembleLiveContextBudget(context);
  return `${base}\n${budgeted.text}`;
}

export function buildMinimalSessionUpdatePayload(
  context?: MossLiveSessionContext | null
): MinimalSessionUpdatePayload {
  return {
    action: "session.update",
    session: {
      persona: {
        name: "Bili伴看助手",
        aliases: ["伴看助手", "小助手"],
        prompt: "你是BiliScript内置的B站视频伴看AI助手，正在和用户一起观看视频。回答应当自然口语化、简明扼要，像朋友一起看视频聊天。"
      },
      instructions: buildVideoInstructions(context),
      tools: isLiveRoomContext(context) ? [] : MOSS_LIVE_PAGE_FUNCTION_DECLARATIONS
    }
  };
}

export interface ClientContextUpdatePayload {
  action: "client_context.update";
  context: {
    time_zone: string;
  };
}

export function buildClientContextUpdatePayload(
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone
): ClientContextUpdatePayload {
  return {
    action: "client_context.update",
    context: { time_zone: timeZone }
  };
}

export type MossLiveTranscriptEvent =
  | { kind: "input.updated"; text: string }
  | { kind: "input.done"; text: string }
  | { kind: "output.updated"; text: string; runId: string; turnId: string }
  | { kind: "output.done"; text: string; runId: string; turnId: string }
  | { kind: "response.interrupted"; runId: string; turnId: string }
  | { kind: "response.ended"; status: string; runId: string; turnId: string };

export interface MossLiveToolStatusEvent {
  tool: "web_search";
  status: "searching" | "done" | "no_results" | "failed";
  query: string;
  resultCount?: number;
  platform?: string;
  error?: string;
}

export interface MossLiveDelegationRequest {
  delegationId: string;
  objective: string;
  context: string[];
  purpose?: "task" | "reasoning";
  timeoutMs?: number;
  scope?: "full" | "time_range" | "query";
  timeRange?: { startSec?: number; endSec?: number };
}

export interface ChangeVoicePayload {
  action: "change_voice";
  voice_name: string;
}

export function buildChangeVoicePayload(voiceId: string): ChangeVoicePayload {
  return { action: "change_voice", voice_name: String(voiceId || "").trim() };
}

export type MossParsedServerEvent =
  | { kind: "session_attached"; sessionId: string }
  | { kind: "voice_changed"; voiceId: string }
  | { kind: "session.updated"; error: string }
  | { kind: "client_context.updated"; accepted: boolean }
  | { kind: "output.configured"; volumeDb?: number; speed?: number }
  | { kind: "media.configured"; video: MossVideoConfiguredReceipt; error: string }
  | { kind: "transcript"; event: MossLiveTranscriptEvent }
  | { kind: "audio.context"; chunkId: string; runId: string; turnId: string }
  | { kind: "audio.done"; runId: string; turnId: string }
  | { kind: "audio.stop"; runId: string; turnId: string }
  | { kind: "delegation.created"; delegation: MossLiveDelegationRequest }
  | { kind: "delegation.cancelled"; delegationId: string }
  | { kind: "tool.call"; call: MossLiveToolCall }
  | {
      kind: "function_call.done";
      callId: string;
      name: string;
      argumentsText: string;
      runId: string;
      turnId: string;
    }
  | { kind: "error"; message: string; code: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readStr(data: Record<string, unknown> | null, obj: Record<string, unknown>, key: string): string {
  const fromData = data?.[key];
  if (typeof fromData === "string") return fromData;
  const fromObj = obj[key];
  if (typeof fromObj === "string") return fromObj;
  return "";
}

export function parseMossServerJsonEvent(raw: unknown): MossParsedServerEvent | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const action = typeof obj.type === "string"
    ? obj.type
    : typeof obj.action === "string"
      ? obj.action
      : "";
  if (!action) return null;
  const data = asRecord(obj.data);

  switch (action) {
    case "session_attached": {
      const sessionId = readStr(data, obj, "session_id");
      return { kind: "session_attached", sessionId };
    }
    case "voice_changed": {
      const voiceId =
        readStr(data, obj, "name") || readStr(data, obj, "voice_name") || readStr(data, obj, "voice_id");
      return { kind: "voice_changed", voiceId };
    }
    case "session.updated": {
      const error = readStr(data, obj, "error");
      return { kind: "session.updated", error };
    }
    case "client_context.updated": {
      const accepted = data?.accepted ?? obj.accepted;
      return { kind: "client_context.updated", accepted: accepted !== false };
    }
    case "media.output.configured": {
      const volumeDb = data?.volume_db ?? obj.volume_db;
      const speed = data?.speed ?? obj.speed;
      return {
        kind: "output.configured",
        ...(typeof volumeDb === "number" && Number.isFinite(volumeDb) ? { volumeDb } : {}),
        ...(typeof speed === "number" && Number.isFinite(speed) ? { speed } : {})
      };
    }
    case "media.configured": {
      const error = readStr(data, obj, "error");
      const video = asRecord(data?.video) ?? asRecord(obj.video) ?? {};
      return {
        kind: "media.configured",
        video,
        error
      };
    }
    case "input.transcript.updated": {
      const text = readStr(data, obj, "text");
      return { kind: "transcript", event: { kind: "input.updated", text } };
    }
    case "input.transcript.done": {
      const text = readStr(data, obj, "text");
      return { kind: "transcript", event: { kind: "input.done", text } };
    }
    case "output.transcript.updated": {
      const text = readStr(data, obj, "text");
      const runId = readStr(data, obj, "run_id");
      const turnId = readStr(data, obj, "turn_id");
      return { kind: "transcript", event: { kind: "output.updated", text, runId, turnId } };
    }
    case "output.transcript.done": {
      const text = readStr(data, obj, "text");
      const runId = readStr(data, obj, "run_id");
      const turnId = readStr(data, obj, "turn_id");
      return { kind: "transcript", event: { kind: "output.done", text, runId, turnId } };
    }
    case "response.interrupted": {
      const runId = readStr(data, obj, "run_id");
      const turnId = readStr(data, obj, "turn_id");
      return { kind: "transcript", event: { kind: "response.interrupted", runId, turnId } };
    }
    case "response.ended": {
      const status = readStr(data, obj, "status") || "completed";
      const runId = readStr(data, obj, "run_id");
      const turnId = readStr(data, obj, "turn_id");
      return { kind: "transcript", event: { kind: "response.ended", status, runId, turnId } };
    }
    case "response.audio.context": {
      const chunkId = readStr(data, obj, "chunk_id");
      const runId = readStr(data, obj, "run_id");
      const turnId = readStr(data, obj, "turn_id");
      return { kind: "audio.context", chunkId, runId, turnId };
    }
    case "response.audio.done": {
      const runId = readStr(data, obj, "run_id");
      const turnId = readStr(data, obj, "turn_id");
      return { kind: "audio.done", runId, turnId };
    }
    case "response.audio.stop": {
      const runId = readStr(data, obj, "run_id");
      const turnId = readStr(data, obj, "turn_id");
      return { kind: "audio.stop", runId, turnId };
    }
    case "session.delegation.created": {
      const delegation = asRecord(data?.delegation);
      const context = Array.isArray(data?.context)
        ? data.context.flatMap((item): string[] => {
            if (typeof item === "string") return [item];
            const line = asRecord(item);
            return typeof line?.content === "string" && line.content
              ? [typeof line.role === "string" && line.role ? `${line.role}：${line.content}` : line.content]
              : [];
          })
        : [];
      const purpose = data?.purpose ?? obj.purpose;
      const timeoutMs = data?.timeout_ms ?? obj.timeout_ms;
      return {
        kind: "delegation.created",
        delegation: {
          delegationId: typeof delegation?.id === "string" ? delegation.id : "",
          objective: readStr(data, obj, "objective"),
          context,
          purpose: purpose === "reasoning" ? "reasoning" : "task",
          ...(typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
            ? { timeoutMs }
            : {})
        }
      };
    }
    case "session.delegation.cancelled":
      return { kind: "delegation.cancelled", delegationId: readStr(data, obj, "delegation_id") };
    case "tool.call": {
      const callId = readStr(data, obj, "call_id") || readStr(data, obj, "tool_call_id") || readStr(data, obj, "id");
      const name = readStr(data, obj, "name");
      const args = data?.arguments ?? obj.arguments ?? data?.args ?? obj.args ?? {};
      return { kind: "tool.call", call: { callId, name, arguments: args } };
    }
    case "response.function_call_arguments.done": {
      return {
        kind: "function_call.done",
        callId: readStr(data, obj, "call_id"),
        name: readStr(data, obj, "name"),
        argumentsText: readStr(data, obj, "arguments"),
        runId: readStr(data, obj, "run_id"),
        turnId: readStr(data, obj, "turn_id")
      };
    }
    case "error": {
      const nestedErr = asRecord(data?.error);
      const code =
        typeof nestedErr?.code === "string"
          ? nestedErr.code
          : typeof data?.code === "string"
            ? data.code
            : "";
      const message =
        typeof nestedErr?.message === "string" && nestedErr.message
          ? nestedErr.message
          : typeof data?.message === "string" && data.message
            ? data.message
            : typeof obj.message === "string" && obj.message
              ? obj.message
              : typeof obj.error === "string" && obj.error
                ? obj.error
                : "实时会话发生未知错误";
      return { kind: "error", message, code };
    }
    default:
      return null;
  }
}

export type MossLiveClientAction =
  | {
      action: "start";
      wsUrl?: string;
      providerType?: LiveProviderType;
      model?: string;
      liveGeminiNativeSearch?: boolean;
      lowBandwidth?: boolean;
      voiceId?: string;
      volume?: number;
      speed?: number;
      videoContext?: MossLiveSessionContext | null;
      sessionId?: string | null;
    }
  | { action: "change_voice"; voiceId: string }
  | { action: "set_volume"; volume: number }
  | { action: "set_speed"; speed: number }
  | { action: "context_update"; videoContext: MossLiveSessionContext | null }
  | { action: "tool_result"; callId: string; result: unknown }
  | { action: "delegation_silent"; delegationId: string; content: string }
  | {
      action: "delegation_result";
      delegationId: string;
      status: "in_progress" | "completed" | "failed";
      content: string;
    }
  | { action: "barge_in" }
  | { action: "interrupt" }
  | { action: "stop" }
  | { action: "audio"; pcmBase64: string }
  | { action: "video"; jpegBase64: string }
  | { action: "realtime_text"; text: string }
  | { action: "user_text"; text: string; jpegBase64?: string }
  | { action: "mic_state"; enabled: boolean };

export interface LiveReconnectingEvent {
  type: "reconnecting";
  attempt: number;
  maxAttempts: number;
  code?: number;
  reason?: string;
  error?: string;
}

export type MossLiveServerEvent =
  | { type: "connecting" }
  | { type: "connected"; sessionId?: string }
  | { type: "session_attached"; sessionId: string }
  | { type: "voice_fallback"; voiceId: string }
  | LiveReconnectingEvent
  | { type: "speaking_state"; speaking: boolean }
  | { type: "output_configured"; volume: number; speed: number }
  | { type: "video_configured"; video: MossVideoCaptureConfig; error?: string }
  | { type: "error"; error: string; code?: number | string; reason?: string }
  | { type: "closed"; code?: number; reason?: string; error?: string }
  | { type: "transcript"; event: MossLiveTranscriptEvent }
  | { type: "delegation_created"; delegation: MossLiveDelegationRequest }
  | { type: "delegation_cancelled"; delegationId: string }
  | { type: "tool_call"; call: MossLiveToolCall }
  | { type: "tool_error"; error: string; callId?: string }
  | { type: "tool_status"; event: MossLiveToolStatusEvent };

export interface LiveCloseDiagnosticsOptions {
  isReconnect?: boolean;
  attempt?: number;
  maxAttempts?: number;
  code?: number | string;
  reason?: string;
  error?: string;
}

export function formatLiveCloseDiagnostics(options: LiveCloseDiagnosticsOptions): string {
  const rawCode = typeof options.code === "number" ? options.code : String(options.code || "").trim();
  const safeCode = typeof rawCode === "number"
    ? Number.isInteger(rawCode) ? String(rawCode) : ""
    : /^\d+$/.test(rawCode) ? rawCode : "";
  const detailStr = safeCode ? `（关闭码: ${safeCode}）` : "";

  if (options.isReconnect) {
    const attemptStr = options.attempt ? ` (第 ${options.attempt}/${options.maxAttempts ?? MAX_MOSS_RECONNECT_ATTEMPTS} 次)` : "";
    return `伴看连接已断开${detailStr}，正在尝试自动重连${attemptStr}...`;
  }

  if (options.attempt && options.maxAttempts && options.attempt >= options.maxAttempts) {
    return `伴看连接已断开，自动重连 ${options.maxAttempts} 次均失败${detailStr}。`;
  }

  return `伴看连接已断开${detailStr}。`;
}
