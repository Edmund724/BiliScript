// extension/live/moss-live-protocol.ts
// MOSS-LIVE 全双工实时对话协议定义与二进制编解码工具。
// 官方实时接口规范：wss://api.mosi.cn/v1/realtime?model=moss-live-1.0
//
// 上行二进制帧（tagged-v1 协议）：
// 首字节为通道标签（Tag）：
//   0x00: 单声道 PCM S16LE 音频（16 kHz，每帧 20 ms = 320 采样 = 640 字节，加 1 字节 Tag 共 641 字节）
//   0x01: 摄像头画面帧（JPEG）
//   0x02: 屏幕/视频共享帧（JPEG）
// 后续字节为原始 payload。

import { formatClock } from "../shared/clock-text.js";
import { normalizeMossVideoConfig, type MossVideoCaptureConfig } from "./moss-video-config.js";

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

/** 上行麦克风音频采样率（16 kHz 单声道 S16LE） */
export const MOSS_UPSTREAM_SAMPLE_RATE = 16000;
/** 下行 AI 语音音频采样率（48 kHz 单声道 S16LE） */
export const MOSS_DOWNSTREAM_SAMPLE_RATE = 48000;
/** 上行音频分帧时长（20 ms） */
export const MOSS_FRAME_DURATION_MS = 20;
/** 每帧 20 ms 对应的 16 kHz 单声道采样点数（320） */
export const MOSS_UPSTREAM_FRAME_SAMPLES = (MOSS_UPSTREAM_SAMPLE_RATE * MOSS_FRAME_DURATION_MS) / 1000;
/** 每帧 20 ms 对应的 S16LE 字节数（640 字节） */
export const MOSS_UPSTREAM_FRAME_BYTES = MOSS_UPSTREAM_FRAME_SAMPLES * 2;

/** 打包 tagged-v1 二进制帧（首字节 Tag + 原始二进制 Payload） */
export function packTaggedBinary(tag: MossBinaryTag, payload: ArrayBufferLike): Uint8Array<ArrayBuffer> {
  const src = new Uint8Array(payload);
  const out = new Uint8Array(src.byteLength + 1);
  out[0] = tag;
  out.set(src, 1);
  return out;
}

/** 解包 tagged-v1 二进制帧 */
export function unpackTaggedBinary(data: ArrayBufferLike): { tag: MossBinaryTag; payload: Uint8Array } | null {
  if (data.byteLength < 1) return null;
  const view = new Uint8Array(data);
  return {
    tag: view[0] as MossBinaryTag,
    payload: view.subarray(1)
  };
}

/**
 * 将二进制字节编码为 Base64 字符串，用于跨 chrome.runtime Port 传输
 * （Chrome 消息通道使用 JSON 序列化，直接传 Uint8Array/ArrayBuffer 会退化为普通对象）。
 */
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

/** 将 Base64 字符串解码为 Uint8Array */
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

/** 将 [-1, 1] Float32 采样编码为小端序 PCM S16LE 字节流 */
export function encodeFloat32ToPcmS16LE(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const raw = Number.isFinite(samples[i]) ? samples[i] : 0;
    const clamped = Math.max(-1, Math.min(1, raw));
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.floor(clamped * 0x7fff);
    view.setInt16(i * 2, int16, true);
  }
  return new Uint8Array(buffer);
}

/** 将小端序 PCM S16LE 字节流解码为 [-1, 1] Float32 采样 */
export function decodePcmS16LEToFloat32(pcmBuffer: ArrayBufferLike): Float32Array {
  const sampleCount = Math.floor(pcmBuffer.byteLength / 2);
  if (sampleCount <= 0) {
    return new Float32Array(0);
  }
  const view = new DataView(pcmBuffer);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const int16 = view.getInt16(i * 2, true);
    out[i] = int16 / 0x8000;
  }
  return out;
}

/** 单声道 Float32 线性插值重采样（例如浏览器 AudioContext 48kHz -> 16kHz） */
export function resampleMonoFloat32(
  samples: Float32Array,
  srcSampleRate: number,
  targetSampleRate: number = MOSS_UPSTREAM_SAMPLE_RATE
): Float32Array {
  if (samples.length === 0) return new Float32Array(0);
  if (!Number.isFinite(srcSampleRate) || srcSampleRate <= 0 || srcSampleRate === targetSampleRate) {
    return samples;
  }
  const ratio = srcSampleRate / targetSampleRate;
  const outLength = Math.max(0, Math.round(samples.length / ratio));
  if (outLength === 0) return new Float32Array(0);

  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const leftIndex = Math.floor(srcPos);
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const frac = srcPos - leftIndex;
    out[i] = samples[leftIndex] * (1 - frac) + samples[rightIndex] * frac;
  }
  return out;
}

export interface Pcm16kFrameChunker {
  push(samples: Float32Array, sampleRate?: number): void;
  reset(): void;
}

/**
 * 将任意块大小的 Float32 音频流按 16kHz / 20ms（320 采样 = 640 字节 S16LE）切帧输出。
 */
export function createPcm16kFrameChunker(
  onFrame: (pcmBytes: Uint8Array<ArrayBuffer>) => void
): Pcm16kFrameChunker {
  const ring = new Float32Array(MOSS_UPSTREAM_FRAME_SAMPLES);
  let offset = 0;

  return {
    push(samples: Float32Array, sampleRate: number = MOSS_UPSTREAM_SAMPLE_RATE): void {
      if (!samples || samples.length === 0) return;
      const resampled = resampleMonoFloat32(samples, sampleRate, MOSS_UPSTREAM_SAMPLE_RATE);
      let readIndex = 0;
      while (readIndex < resampled.length) {
        const needed = MOSS_UPSTREAM_FRAME_SAMPLES - offset;
        const available = resampled.length - readIndex;
        const copyCount = Math.min(needed, available);
        ring.set(resampled.subarray(readIndex, readIndex + copyCount), offset);
        offset += copyCount;
        readIndex += copyCount;

        if (offset === MOSS_UPSTREAM_FRAME_SAMPLES) {
          offset = 0;
          onFrame(encodeFloat32ToPcmS16LE(ring));
        }
      }
    },
    reset(): void {
      offset = 0;
    }
  };
}

/** 由 baseUrl 与 model 计算 WebSocket 连接地址 */
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
      // keep
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

/** 由 baseUrl 计算 Gemini Live BidiGenerateContent WebSocket 连接地址 */
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

/**
 * 推导实时伴看平台所需的双协议（HTTP(S) + WS(S)）权限源地址对。
 * Chromium DNR modifyHeaders 拦截 WebSocket 握手要求扩展同时持有 http(s):// 与 ws(s):// 源权限。
 */
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

/**
 * MOSS-LIVE 前台轻量工具清单。客户端通过 session.update.session.tools 声明，
 * 接收 tool.call / response.function_call_arguments.done 后在本地执行播放器控制与局部字幕查询。
 */
export const MOSS_LIVE_PAGE_FUNCTION_DECLARATIONS = [
  {
    type: "function",
    name: "control_bilibili_player",
    description: "控制当前B站播放器。暂停或继续播放、调整倍速、跳转到指定秒数；后台委派返回定位结果后，可使用其时间戳执行跳转。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", enum: ["seek", "pause", "play", "rate"], description: "控制命令" },
        time: { type: "number", description: "seek 的目标播放位置（秒），必须为非负数且不超出视频时长" },
        rate: { type: "number", enum: [0.5, 0.75, 1, 1.25, 1.5, 2], description: "rate 的目标倍速" }
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
  /** 真实时刻文本（formatClock 单源），引用章节时原样保留。 */
  time: string;
  title: string;
  summary: string;
}

export interface MossLiveOverviewQuote {
  from: number;
  time: string;
  content: string;
}

/**
 * 伴看上下文的概览事实面：只承载回答全片问题所需的简介、章节脉络、金句与
 * 覆盖完整性，不携带完整字幕或每秒变化的生成进度。
 */
export interface MossLiveOverviewContext {
  phase: MossLiveOverviewPhase;
  /** complete 仅当整份概览完整；partial = 分段或简介失败；none = 无可用产物。 */
  coverage: "complete" | "partial" | "none";
  summary: string;
  chapters: MossLiveOverviewChapter[];
  quotes: MossLiveOverviewQuote[];
  failedRanges?: Array<{ from: number; to: number }>;
  summaryFailed?: boolean;
  /** 未就绪/不完整时的如实说明与等待、重试方式；ready 完整覆盖时为空串。 */
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
}

/** 直播间伴看上下文：只有房间号与展示信息，没有视频身份、字幕与概览。 */
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

/** 工具调用携带的视频身份；直播间与未就绪上下文都没有视频身份。 */
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
  video?: MossLiveVideoIdentity | null;
}

/** 建立或刷新伴看会话的 session.update 载荷。 */
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
  const lines = [base, `当前直播间：${context.title || context.roomId}`];
  if (context.anchorName) {
    lines.push(`主播：${context.anchorName}`);
  }
  return lines.join("\n");
}

export function buildVideoInstructions(
  context: MossLiveSessionContext | null | undefined,
  clientDelegation = false
): string {
  if (isLiveRoomContext(context)) {
    return buildLiveRoomInstructions(context);
  }
  const shortClock = formatClock(5, { hours: "auto" });
  const longClock = formatClock(3725, { hours: "auto" });
  const taskRouting = clientDelegation
    ? "当用户要求控制播放器（跳转进度、暂停/播放/倍速）时，请直接调用前台工具；当用户要求总结全片或片段内容、梳理视频脉络、或询问需要检索全片字幕才能回答的视频细节时，请通过后台委派（delegation）交由后台文本模型处理；普通日常闲聊或常识问题请直接回答。用户要求跳到刚才总结或分析中的某一点、某一章节时，直接读取该次后台委派已注入的带时间戳笔记，按播报顺序定位对应内容，把时间戳换算成秒数后调用 control_bilibili_player 的 seek，不要重复总结或重新检索全片。只有当前播放位置附近的局部字幕查询可使用 get_subtitles_around_time；不得用前台字幕工具或 web_search 代替后台委派。若上下文中已有覆盖完整的全片概览，可直接读取并回答，无需重复委派；概览覆盖不完整时必须明确说明。后台委派被取消或失败时如实说明，不得编造视频内容。"
    : "需要回顾、定位或检索视频内容时调用字幕工具，不要猜测字幕内容。需要暂停、继续、倍速或指定时间跳转时调用 control_bilibili_player。跳到某类内容或章节时必须先调用 search_video_subtitles，选择匹配结果并将其 from 作为 seek 的 time；检索无结果或失败时不得跳转。遇到全片总结、这期讲了什么、内容脉络或核心观点类问题时：若全片概览尚未生成或未就绪，调用 summarize_video 生成概览并等待结果，不得改用 web_search、search_video_subtitles 或平台内置联网搜索（如 googleSearch）拼凑全片结论；概览覆盖不完整（coverage=partial）时必须明确说明覆盖不完整，不得当作完整全片总结；无字幕、生成失败或取消时按工具返回如实说明并给出等待或重试方式，不得编造全片内容。";
  const base = `当前正在观看B站视频伴看会话。实时视频画面来自B站播放器屏幕抽帧（screen通道），并非用户摄像头（camera）；回答画面相关问题时直接依据当前屏幕帧，切勿提示用户打开摄像头。若上行音频中同时包含视频原声与用户麦克风声音：当检测到用户麦克风说话时，系统会自动把上行混音中的视频原声音量突然压低，因此只要听到背景视频声音突然被压低且出现前景人声，即代表是用户本人在对你说话；未发生音量压低的连续人声则是视频原声，不要误判为用户提问。${taskRouting}需要视频之外的外部事实、时效性信息或联网查证时调用 web_search。任何工具返回 ok:false、无结果、失败或超时时必须明确告知用户，不得声称操作已成功，不得编造外部事实。引用具体字幕时在回答中保留工具返回的 time 时刻文本（如 ${shortClock} 或 ${longClock}）。`;
  if (!context) {
    return `${base} 当前视频上下文尚未就绪或正在换片；此时不得沿用旧视频信息，工具不可用时明确说明并请用户稍后重试。`;
  }
  const part = `P${context.pageIndex}${context.pageTitle ? ` ${context.pageTitle}` : ""}`;
  const chapters = context.chapters.length
    ? context.chapters.map((chapter) => `${chapter.from}s ${chapter.title}`).join("；")
    : "无章节信息";
  return `${base}\n当前视频：${context.title || context.bvid}\nBV：${context.bvid}\nCID：${context.cid}\n当前分P：${part}${context.pageCount ? ` / 共${context.pageCount}P` : ""}\n章节：${chapters}\n${buildOverviewInstructions(context.overview, clientDelegation)}`;
}

function buildOverviewInstructions(
  overview: MossLiveOverviewContext | null | undefined,
  clientDelegation = false
): string {
  if (!overview) {
    return clientDelegation
      ? "全片概览：当前没有可用的本地概览；需要全片总结或脉络时发起后台委派，不得编造全片内容。"
      : "全片概览：当前没有可用的全片概览；遇到全片总结类问题时如实说明无法总结，不得编造全片内容。";
  }
  const lines = [`全片概览状态：${overview.phase}（覆盖：${overview.coverage}）`];
  if (overview.statusText) {
    lines.push(overview.statusText);
  }
  if (overview.summary) {
    lines.push(`全片简介：${overview.summary}`);
  }
  if (overview.chapters.length > 0) {
    lines.push("章节脉络（引用时保留以下时刻文本）：");
    for (const chapter of overview.chapters) {
      lines.push(`- ${chapter.time} ${chapter.title}${chapter.summary ? `：${chapter.summary}` : ""}`);
    }
  }
  if (overview.quotes.length > 0) {
    lines.push("金句（引用时保留以下时刻文本）：");
    for (const quote of overview.quotes) {
      lines.push(`- ${quote.time} ${quote.content}`);
    }
  }
  if (overview.failedRanges?.length) {
    const ranges = overview.failedRanges.map(
      (range) =>
        `${formatClock(range.from, { hours: "auto" })}–${formatClock(range.to, { hours: "auto" })}`
    );
    lines.push(`未覆盖区间：${ranges.join("、")}`);
  }
  return lines.join("\n");
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
      instructions: buildVideoInstructions(context, true),
      tools: isLiveRoomContext(context) ? [] : MOSS_LIVE_PAGE_FUNCTION_DECLARATIONS
    }
  };
}

/** 会话建立后的客户端上下文上报：只带设备时区，不上报设备位置。 */
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

/** 双端字幕与回合生命周期事件（经 Offscreen 转发至页面侧归并器） */
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
  scope?: "full" | "time_range" | "query";
  timeRange?: { startSec?: number; endSec?: number };
}

/** change_voice 载荷：voice_name 为音色列表返回的 data[].id（官方文档字段名）。 */
export interface ChangeVoicePayload {
  action: "change_voice";
  voice_name: string;
}

export function buildChangeVoicePayload(voiceId: string): ChangeVoicePayload {
  return { action: "change_voice", voice_name: String(voiceId || "").trim() };
}

/** MOSS-LIVE 服务端 JSON 事件结构化解析结果 */
export type MossParsedServerEvent =
  | { kind: "session_attached"; sessionId: string }
  | { kind: "voice_changed"; voiceId: string }
  | { kind: "session.updated"; error: string }
  | { kind: "client_context.updated"; accepted: boolean }
  | { kind: "output.configured"; volumeDb?: number; speed?: number }
  | { kind: "media.configured"; video: MossVideoCaptureConfig; error: string }
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

/** 解析 MOSS-LIVE WebSocket 下行 JSON 消息 */
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
      // 官方文档：data.name 为当前会话设置成功的音色 ID；兼容 voice_name / voice_id 变体。
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
      // 画面参数回执：video 可能只回部分字段，缺省字段按 standard 默认补齐。
      const error = readStr(data, obj, "error");
      return {
        kind: "media.configured",
        video: normalizeMossVideoConfig(data?.video ?? obj.video),
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
      return {
        kind: "delegation.created",
        delegation: {
          delegationId: typeof delegation?.id === "string" ? delegation.id : "",
          objective: readStr(data, obj, "objective"),
          context
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

/** Offscreen 端口上行（Client -> Offscreen）消息 */
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
      status: "completed" | "failed";
      content: string;
    }
  | { action: "interrupt" }
  | { action: "stop" }
  | { action: "audio"; pcmBase64: string }
  | { action: "video"; jpegBase64: string }
  | { action: "mic_state"; enabled: boolean };

/** Offscreen 端口下行（Offscreen -> Client）消息 */
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
  | { type: "duck_video"; active: boolean }
  | { type: "transcript"; event: MossLiveTranscriptEvent }
  | { type: "delegation_created"; delegation: MossLiveDelegationRequest }
  | { type: "delegation_cancelled"; delegationId: string }
  | { type: "tool_call"; call: MossLiveToolCall }
  | { type: "tool_error"; error: string }
  | { type: "tool_status"; event: MossLiveToolStatusEvent };

export interface LiveCloseDiagnosticsOptions {
  isReconnect?: boolean;
  attempt?: number;
  maxAttempts?: number;
  code?: number | string;
  reason?: string;
  error?: string;
}

/**
 * 格式化伴看连接断开、失败与自动重连的中文诊断提示，明确展示关闭码、服务端原因及错误详情。
 */
export function formatLiveCloseDiagnostics(options: LiveCloseDiagnosticsOptions): string {
  const parts: string[] = [];
  if (options.code !== undefined && options.code !== null && String(options.code).trim() !== "") {
    parts.push(`关闭码: ${options.code}`);
  }
  if (options.reason && options.reason.trim()) {
    parts.push(`原因: ${options.reason.trim()}`);
  }
  if (options.error && options.error.trim()) {
    const trimmedErr = options.error.trim();
    if (trimmedErr !== options.reason?.trim()) {
      parts.push(`错误详情: ${trimmedErr}`);
    }
  }
  const detailStr = parts.length > 0 ? `（${parts.join("，")}）` : "";

  if (options.isReconnect) {
    const attemptStr = options.attempt ? ` (第 ${options.attempt}/${options.maxAttempts ?? MAX_MOSS_RECONNECT_ATTEMPTS} 次)` : "";
    return `伴看连接已断开${detailStr}，正在尝试自动重连${attemptStr}...`;
  }

  if (options.attempt && options.maxAttempts && options.attempt >= options.maxAttempts) {
    return `伴看连接已断开，自动重连 ${options.maxAttempts} 次均失败${detailStr}。`;
  }

  if (options.code !== undefined || (options.reason && options.reason.trim())) {
    return `伴看连接已断开${detailStr}。`;
  }

  return options.error?.trim() || "伴看连接已断开。";
}
