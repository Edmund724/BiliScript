// extension/live/offscreen-gemini-live-client.ts
// 运行在 Offscreen Document 中的 Gemini Live (BidiGenerateContent) 协议适配器与客户端预设壳。
// 会话状态机、重连、工具超时与音频播放协调由 OffscreenLiveSessionRuntime 统一承载；
// 本文件仅负责 Gemini BidiGenerateContent JSON 帧、Session Resumption 句柄与增量字幕合成。

import {
  DEFAULT_LIVE_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_LIVE_OVERVIEW_TOOL_TIMEOUT_MS,
  DEFAULT_LIVE_PAGE_TOOL_TIMEOUT_MS,
  OffscreenLiveSessionRuntime,
  type LiveSessionClientState,
  type LiveWireProtocolAdapter,
  type LiveWireRuntimeCallbacks,
  type LiveWireSocketOpenContext,
  type LiveWireTransport,
  type OffscreenLiveSessionRuntimeOptions
} from "./offscreen-live-session-runtime.js";
import {
  DEFAULT_GEMINI_LIVE_WS_URL,
  buildVideoInstructions,
  decodeBase64Bytes,
  isLiveRoomContext,
  type MossLiveClientAction,
  type MossLiveSessionContext
} from "./moss-live-protocol.js";

export type GeminiLiveClientState = LiveSessionClientState;

export const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.8-live";
export const DEFAULT_GEMINI_HANDSHAKE_TIMEOUT_MS = DEFAULT_LIVE_HANDSHAKE_TIMEOUT_MS;
export const DEFAULT_GEMINI_OVERVIEW_TOOL_TIMEOUT_MS = DEFAULT_LIVE_OVERVIEW_TOOL_TIMEOUT_MS;
export const DEFAULT_GEMINI_PAGE_TOOL_TIMEOUT_MS = DEFAULT_LIVE_PAGE_TOOL_TIMEOUT_MS;

const GEMINI_LIVE_VIDEO_TASK_PARAMETERS = {
  type: "OBJECT",
  properties: {
    scope: {
      type: "STRING",
      enum: ["full", "time_range", "query"],
      description: "full：总结全片；time_range：总结指定时间段；query：检索全片字幕并回答特定问题。"
    },
    query: {
      type: "STRING",
      description: "用户关注的具体问题或主题；scope 为 query 时必填。"
    },
    start_sec: {
      type: "NUMBER",
      description: "时间段起始秒数；scope 为 time_range 时使用。"
    },
    end_sec: {
      type: "NUMBER",
      description: "时间段结束秒数；scope 为 time_range 时使用。"
    }
  },
  required: ["scope"]
} as const;

export const GEMINI_LIVE_PAGE_FUNCTION_DECLARATIONS = [
  {
    name: "control_bilibili_player",
    description:
      "控制当前 B 站视频播放器（跳转时间点 seek、暂停 pause、播放 play、调整倍速 rate）。",
    parameters: {
      type: "OBJECT",
      properties: {
        command: {
          type: "STRING",
          enum: ["seek", "pause", "play", "rate"],
          description: "播放器控制动作：seek（跳转）、pause（暂停）、play（播放）、rate（倍速）。"
        },
        time: {
          type: "NUMBER",
          description: "跳转目标秒数（仅 command 为 seek 时必填）。"
        },
        rate: {
          type: "NUMBER",
          description: "播放倍速（仅 command 为 rate 时必填，可选值 0.5/0.75/1/1.25/1.5/2）。"
        }
      },
      required: ["command"]
    }
  },
  {
    name: "get_subtitles_around_time",
    description: "读取当前视频指定秒数（不传则为当前播放位置）前后的字幕片段。",
    parameters: {
      type: "OBJECT",
      properties: {
        current_time: {
          type: "NUMBER",
          description: "中心时间点（秒），不传则取当前播放器进度。"
        },
        before_seconds: {
          type: "NUMBER",
          description: "向前读取的秒数窗口（默认 30，范围 1–300）。"
        },
        after_seconds: {
          type: "NUMBER",
          description: "向后读取的秒数窗口（默认 30，范围 1–300）。"
        }
      }
    }
  },
  {
    name: "summarize_video",
    behavior: "NON_BLOCKING",
    description:
      "在后台总结当前视频全片或指定时间段，梳理核心观点、内容脉络与关键细节。调用后可继续实时对话，完成后会自动播报结果。",
    parameters: GEMINI_LIVE_VIDEO_TASK_PARAMETERS
  },
  {
    name: "analyze_video_transcript",
    behavior: "NON_BLOCKING",
    description:
      "在后台检索并深入分析当前视频全片字幕，回答需要跨片段查证的具体问题。调用后可继续实时对话，完成后会自动播报结果。",
    parameters: GEMINI_LIVE_VIDEO_TASK_PARAMETERS
  }
] as const;

export const GEMINI_LIVE_WEB_SEARCH_DECLARATION = {
  name: "web_search",
  description:
    "当问题涉及视频字幕与画面之外的最新资讯、背景事实或外部信息时，调用联网搜索查证。",
  parameters: {
    type: "OBJECT",
    properties: {
      query: {
        type: "STRING",
        description: "联网搜索查询词。"
      }
    },
    required: ["query"]
  }
} as const;

export function buildGeminiSetupTools(
  liveGeminiNativeSearch: boolean,
  context?: MossLiveSessionContext | null
): unknown[] {
  if (isLiveRoomContext(context)) {
    return liveGeminiNativeSearch
      ? [{ googleSearch: {} }]
      : [{ functionDeclarations: [GEMINI_LIVE_WEB_SEARCH_DECLARATION] }];
  }
  if (liveGeminiNativeSearch) {
    return [
      { googleSearch: {} },
      { functionDeclarations: [...GEMINI_LIVE_PAGE_FUNCTION_DECLARATIONS] }
    ];
  }
  return [
    {
      functionDeclarations: [
        ...GEMINI_LIVE_PAGE_FUNCTION_DECLARATIONS,
        GEMINI_LIVE_WEB_SEARCH_DECLARATION
      ]
    }
  ];
}

export interface GeminiLiveClientOptions extends OffscreenLiveSessionRuntimeOptions {
  model?: string;
  liveGeminiNativeSearch?: boolean;
}

interface GeminiTurn {
  runId: string;
  turnId: string;
  inputText: string;
  interimInputText: string;
  outputText: string;
  inputDone: boolean;
  outputDone: boolean;
  hasOutput: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readErrorMessage(raw: Record<string, unknown>): string | null {
  if (raw.error === undefined) return null;
  if (typeof raw.error === "string") return raw.error;
  const error = asRecord(raw.error);
  return typeof error?.message === "string" && error.message
    ? error.message
    : "Gemini Live 会话发生未知错误";
}

function extractGeminiSearchQuery(args: unknown): string {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as { query?: unknown };
      return typeof parsed?.query === "string" ? parsed.query.trim() : "";
    } catch {
      return "";
    }
  }
  const record = asRecord(args);
  return typeof record?.query === "string" ? record.query.trim() : "";
}

function readGeminiArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      return asRecord(JSON.parse(args)) ?? {};
    } catch {
      return {};
    }
  }
  return asRecord(args) ?? {};
}

function buildGeminiVideoDelegation(callId: string, name: string, rawArgs: unknown) {
  const args = readGeminiArgs(rawArgs);
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const hasTimeRange =
    typeof args.start_sec === "number" || typeof args.end_sec === "number";
  const requestedScope = args.scope;
  const scope: "full" | "time_range" | "query" =
    requestedScope === "full" || requestedScope === "time_range" || requestedScope === "query"
      ? requestedScope
      : name === "analyze_video_transcript" || query
        ? "query"
        : hasTimeRange
          ? "time_range"
          : "full";
  const baseObjective = scope === "query"
    ? "检索当前视频全片字幕并回答用户关注的问题"
    : scope === "time_range"
      ? "总结当前视频指定时间段的内容，梳理核心观点与关键细节"
      : name === "analyze_video_transcript"
        ? "深入分析当前视频全片字幕，梳理核心观点与关键细节"
        : "总结当前视频全片内容，梳理核心观点与内容脉络";
  const objective = query ? `${baseObjective}：${query}` : baseObjective;
  const startSec = typeof args.start_sec === "number" ? args.start_sec : undefined;
  const endSec = typeof args.end_sec === "number" ? args.end_sec : undefined;
  return {
    delegationId: callId,
    objective,
    context: [] as string[],
    scope,
    ...(scope === "time_range" && (startSec !== undefined || endSec !== undefined)
      ? { timeRange: { startSec, endSec } }
      : {})
  };
}

export class GeminiWireAdapter implements LiveWireProtocolAdapter {
  readonly defaultWsUrl = DEFAULT_GEMINI_LIVE_WS_URL;
  readonly handshakeTimeoutMessage =
    "Gemini Live 握手超时：未在规定时间内收到 setupComplete";
  readonly audioSampleRate = 24000;
  readonly enablePlaybackReceipts = false;

  private model: string;
  private liveGeminiNativeSearch: boolean;
  private runId = "";
  private turnCounter = 0;
  private toolCallCounter = 0;
  private audioChunkCounter = 0;
  private currentTurn: GeminiTurn | null = null;
  private discardOutputUntilInput = false;
  private readonly activeVideoTaskCalls = new Map<string, string>();
  private delegationVideoKey = "";

  constructor(options: { model?: string; liveGeminiNativeSearch?: boolean } = {}) {
    this.model = options.model || DEFAULT_GEMINI_LIVE_MODEL;
    this.liveGeminiNativeSearch = Boolean(options.liveGeminiNativeSearch ?? false);
  }

  onStartAction(msg: Extract<MossLiveClientAction, { action: "start" }>): void {
    if (msg.model !== undefined) {
      this.model = msg.model || DEFAULT_GEMINI_LIVE_MODEL;
    }
    if (msg.liveGeminiNativeSearch !== undefined) {
      this.liveGeminiNativeSearch = Boolean(msg.liveGeminiNativeSearch);
    }
  }

  onConnectReset(generation: number): void {
    this.currentTurn = null;
    this.discardOutputUntilInput = false;
    this.turnCounter = 0;
    this.toolCallCounter = 0;
    this.audioChunkCounter = 0;
    this.activeVideoTaskCalls.clear();
    this.runId = `gemini-live-${generation}`;
  }

  onResetPlayback(): void {
    this.currentTurn = null;
    this.activeVideoTaskCalls.clear();
  }

  onSocketOpen(context: LiveWireSocketOpenContext): void {
    const videoContext = context.videoContext;
    this.delegationVideoKey = videoContext && !("kind" in videoContext)
      ? `${videoContext.bvid}:${videoContext.cid}:${videoContext.pageIndex}`
      : "";
    context.markContextSent(context.videoContext);
    context.sendJson({
      setup: {
        model: `models/${this.model.replace(/^models\//, "")}`,
        generationConfig: { responseModalities: ["AUDIO"] },
        systemInstruction: {
          parts: [{ text: buildVideoInstructions(context.videoContext, true) }]
        },
        tools: buildGeminiSetupTools(this.liveGeminiNativeSearch, context.videoContext),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        sessionResumption: context.sessionId ? { handle: context.sessionId } : {}
      }
    });
  }

  async handleIncomingData(data: unknown, callbacks: LiveWireRuntimeCallbacks): Promise<void> {
    if (!callbacks.isCurrent()) return;
    let text = "";
    try {
      if (typeof data === "string") {
        text = data;
      } else if (data instanceof ArrayBuffer) {
        text = new TextDecoder().decode(data);
      } else if (ArrayBuffer.isView(data)) {
        text = new TextDecoder().decode(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        );
      } else if (typeof Blob !== "undefined" && data instanceof Blob) {
        text = new TextDecoder().decode(await data.arrayBuffer());
      } else {
        return;
      }
      if (!callbacks.isCurrent()) return;
      this.handleServerMessage(JSON.parse(text), callbacks);
    } catch {
      return;
    }
  }

  private handleServerMessage(rawMessage: unknown, callbacks: LiveWireRuntimeCallbacks): void {
    if (!callbacks.isCurrent()) return;
    const raw = asRecord(rawMessage);
    if (!raw) return;

    const error = readErrorMessage(raw);
    if (error !== null) {
      callbacks.failOrReconnectOnServerError(error);
      return;
    }

    const resumption = asRecord(raw.sessionResumptionUpdate);
    if (resumption) {
      const resumable = resumption.resumable === true;
      const newHandle =
        typeof resumption.newHandle === "string" ? resumption.newHandle.trim() : "";
      if (resumable && newHandle) {
        callbacks.updateSessionHandle(newHandle);
      }
    }

    if (raw.setupComplete !== undefined) {
      if (callbacks.getState() !== "connecting") return;
      callbacks.completeHandshake();
      return;
    }

    if (callbacks.getState() !== "connected") return;

    const content = asRecord(raw.serverContent);
    if (content) {
      this.handleServerContent(content, callbacks);
    }
    const toolCall = asRecord(raw.toolCall);
    if (toolCall) {
      this.handleToolCall(toolCall, callbacks);
    }
    const cancellation = asRecord(raw.toolCallCancellation);
    if (cancellation) {
      this.handleToolCallCancellation(cancellation, callbacks);
    }
  }

  private getOrCreateTurn(
    kind: "input" | "output",
    callbacks: LiveWireRuntimeCallbacks
  ): GeminiTurn | null {
    if (!this.currentTurn && kind === "output" && this.discardOutputUntilInput) return null;
    if (kind === "input" && this.currentTurn?.hasOutput) {
      this.finishCompletedTurn(callbacks);
    }
    if (!this.currentTurn) {
      if (kind === "input") {
        this.discardOutputUntilInput = false;
      }
      this.currentTurn = {
        runId: this.runId,
        turnId: `turn-${++this.turnCounter}`,
        inputText: "",
        interimInputText: "",
        outputText: "",
        inputDone: false,
        outputDone: false,
        hasOutput: false
      };
    }
    return this.currentTurn;
  }

  private handleServerContent(
    content: Record<string, unknown>,
    callbacks: LiveWireRuntimeCallbacks
  ): void {
    const interimInput = asRecord(content.interimInputTranscription);
    if (interimInput && typeof interimInput.text === "string" && interimInput.text) {
      const turn = this.getOrCreateTurn("input", callbacks);
      if (turn) {
        turn.interimInputText = interimInput.text;
        callbacks.emitTranscript({
          kind: "input.updated",
          text: turn.inputText + turn.interimInputText
        });
      }
    }

    const input = asRecord(content.inputTranscription);
    if (input && typeof input.text === "string" && input.text) {
      const turn = this.getOrCreateTurn("input", callbacks);
      if (turn) {
        turn.inputText += input.text;
        turn.interimInputText = "";
        callbacks.emitTranscript({ kind: "input.updated", text: turn.inputText });
      }
    }

    const output = asRecord(content.outputTranscription);
    if (output && typeof output.text === "string" && output.text) {
      const turn = this.getOrCreateTurn("output", callbacks);
      if (turn) {
        turn.hasOutput = true;
        turn.outputText += output.text;
        callbacks.emitTranscript({
          kind: "output.updated",
          text: turn.outputText,
          runId: turn.runId,
          turnId: turn.turnId
        });
      }
    }

    const modelTurn = asRecord(content.modelTurn);
    if (modelTurn && Array.isArray(modelTurn.parts)) {
      this.handleModelTurn(modelTurn.parts, callbacks);
    }

    if (content.interrupted === true) {
      callbacks.interrupt();
      return;
    }

    if (content.turnComplete === true && this.currentTurn) {
      const interactionStatus =
        typeof content.interactionStatus === "string" ? content.interactionStatus : "";
      if (interactionStatus !== "IN_PROGRESS") {
        this.finishCompletedTurn(callbacks);
      }
    }
  }

  private handleModelTurn(parts: unknown[], callbacks: LiveWireRuntimeCallbacks): void {
    const turn = this.getOrCreateTurn("output", callbacks);
    if (!turn) return;
    turn.hasOutput = true;
    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      const inlineData = asRecord(part?.inlineData);
      const mimeType = typeof inlineData?.mimeType === "string" ? inlineData.mimeType : "";
      const data = typeof inlineData?.data === "string" ? inlineData.data : "";
      if (!mimeType.startsWith("audio/pcm") || !data) continue;
      const bytes = decodeBase64Bytes(data);
      if (bytes.byteLength === 0) continue;
      const chunkId = `gemini-audio-${++this.audioChunkCounter}`;
      if (callbacks.enqueueAudioContext(chunkId, turn.runId, turn.turnId)) {
        callbacks.enqueueAudioFrame(bytes.buffer);
      }
    }
  }

  private finishCompletedTurn(callbacks: LiveWireRuntimeCallbacks): void {
    const turn = this.currentTurn;
    if (!turn) return;
    this.currentTurn = null;

    const fullInputText = (turn.inputText + turn.interimInputText).trim();
    if (!turn.inputDone && fullInputText) {
      turn.inputDone = true;
      callbacks.emitTranscript(
        { kind: "input.done", text: fullInputText },
        { duckInput: false }
      );
    }
    if (!turn.outputDone && turn.outputText) {
      turn.outputDone = true;
      callbacks.emitTranscript({
        kind: "output.done",
        text: turn.outputText,
        runId: turn.runId,
        turnId: turn.turnId
      });
    }

    callbacks.markResponseEnded(turn.runId, turn.turnId);
    callbacks.handleAudioDone(turn.runId, turn.turnId);
    callbacks.finishActiveTurn(turn.runId, turn.turnId);
    callbacks.emitTranscript({
      kind: "response.ended",
      status: "completed",
      runId: turn.runId,
      turnId: turn.turnId
    });
  }

  onBeforeInterrupt(
    callbacks: LiveWireRuntimeCallbacks
  ): { runId: string; turnId: string } | null {
    this.discardOutputUntilInput = true;
    for (const callId of this.activeVideoTaskCalls.keys()) {
      callbacks.cancelDelegation(callId);
    }
    this.activeVideoTaskCalls.clear();
    const turn = this.currentTurn;
    if (!turn) return null;
    this.currentTurn = null;

    const fullInputText = (turn.inputText + turn.interimInputText).trim();
    if (!turn.inputDone && fullInputText) {
      turn.inputDone = true;
      callbacks.emitTranscript(
        { kind: "input.done", text: fullInputText },
        { duckInput: false }
      );
    }
    if (!turn.outputDone && turn.outputText) {
      turn.outputDone = true;
      callbacks.emitTranscript({
        kind: "output.done",
        text: turn.outputText,
        runId: turn.runId,
        turnId: turn.turnId
      });
    }
    return { runId: turn.runId, turnId: turn.turnId };
  }

  private handleToolCall(
    toolCall: Record<string, unknown>,
    callbacks: LiveWireRuntimeCallbacks
  ): void {
    const functionCalls = Array.isArray(toolCall.functionCalls) ? toolCall.functionCalls : [];
    const turnId = this.currentTurn?.turnId ?? `turn-${this.turnCounter}`;
    for (const rawItem of functionCalls) {
      const item = asRecord(rawItem);
      if (!item) continue;
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (!name) continue;
      const callId =
        typeof item.id === "string" && item.id.trim()
          ? item.id.trim()
          : `gemini-tool-${++this.toolCallCounter}`;
      const args = item.args ?? {};
      if (name === "summarize_video" || name === "analyze_video_transcript") {
        if (this.activeVideoTaskCalls.has(callId)) continue;
        this.activeVideoTaskCalls.set(callId, name);
        callbacks.startDelegation(buildGeminiVideoDelegation(callId, name, args));
        continue;
      }
      callbacks.startFunctionCall({
        callId,
        name,
        arguments: args,
        query: name === "web_search" ? extractGeminiSearchQuery(args) : "",
        runId: this.runId,
        turnId
      });
    }
  }

  private handleToolCallCancellation(
    cancellation: Record<string, unknown>,
    callbacks: LiveWireRuntimeCallbacks
  ): void {
    const rawIds = Array.isArray(cancellation.ids) ? cancellation.ids : [];
    const ids = rawIds.filter((id): id is string => typeof id === "string" && id.length > 0);
    for (const id of ids) {
      if (this.activeVideoTaskCalls.delete(id)) {
        callbacks.cancelDelegation(id);
      }
    }
    if (ids.length > 0) {
      callbacks.cancelToolCallsByIds(ids);
    }
  }

  sendAudio(
    pcmBase64: string,
    _pcmBytes: Uint8Array<ArrayBuffer>,
    transport: LiveWireTransport
  ): boolean {
    return transport.sendJson({
      realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: pcmBase64 } }
    });
  }

  sendVideo(
    jpegBase64: string,
    _jpegBytes: Uint8Array<ArrayBuffer>,
    transport: LiveWireTransport
  ): boolean {
    return transport.sendJson({
      realtimeInput: { video: { mimeType: "image/jpeg", data: jpegBase64 } }
    });
  }

  onMicStateChanged(
    enabled: boolean,
    previousEnabled: boolean,
    connected: boolean,
    transport: LiveWireTransport
  ): void {
    if (previousEnabled !== enabled && !enabled && connected) {
      transport.sendJson({ realtimeInput: { audioStreamEnd: true } });
    }
  }

  onVideoContextUpdated(context: MossLiveSessionContext | null): void {
    const nextVideoKey = context && !("kind" in context)
      ? `${context.bvid}:${context.cid}:${context.pageIndex}`
      : "";
    if (nextVideoKey !== this.delegationVideoKey) {
      this.activeVideoTaskCalls.clear();
      this.delegationVideoKey = nextVideoKey;
    }
  }

  sendContextUpdate(context: MossLiveSessionContext | null, transport: LiveWireTransport): void {
    transport.sendJson({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: buildVideoInstructions(context, true) }] }],
        turnComplete: false
      }
    });
  }

  private sendVideoTaskResponse(
    delegationId: string,
    response: Record<string, unknown>,
    scheduling: "SILENT" | "WHEN_IDLE",
    transport: LiveWireTransport
  ): boolean {
    const name = this.activeVideoTaskCalls.get(delegationId);
    if (!name) return false;
    if (scheduling === "WHEN_IDLE") this.activeVideoTaskCalls.delete(delegationId);
    return transport.sendJson({
      toolResponse: {
        functionResponses: [
          {
            id: delegationId,
            name,
            response,
            scheduling
          }
        ]
      }
    });
  }

  sendDelegationSilent(
    delegationId: string,
    content: string,
    transport: LiveWireTransport
  ): boolean {
    return this.sendVideoTaskResponse(delegationId, { factText: content }, "SILENT", transport);
  }

  sendDelegationResult(
    delegationId: string,
    status: "completed" | "failed",
    content: string,
    transport: LiveWireTransport
  ): boolean {
    return this.sendVideoTaskResponse(
      delegationId,
      status === "completed" ? { spokenBriefing: content } : { error: content },
      "WHEN_IDLE",
      transport
    );
  }

  sendToolResponse(
    call: { callId: string; name: string },
    result: unknown,
    transport: LiveWireTransport
  ): boolean {
    return transport.sendJson({
      toolResponse: {
        functionResponses: [
          {
            id: call.callId,
            name: call.name,
            response: { result }
          }
        ]
      }
    });
  }

  sendWebSearchResponse(
    call: { callId: string; name: string },
    outcome:
      | { ok: true; output: string }
      | { ok: false; error: string; emptyQuery?: boolean },
    transport: LiveWireTransport
  ): void {
    if (outcome.ok) {
      this.sendToolResponse(call, outcome.output, transport);
      return;
    }
    const text = outcome.emptyQuery
      ? `联网搜索失败：${outcome.error}。请明确告诉用户本次查证失败，不要编造。`
      : `联网搜索失败：${outcome.error}。请明确告诉用户本次查证失败，不要编造外部事实。`;
    this.sendToolResponse(call, text, transport);
  }
}

export class OffscreenGeminiLiveClient extends OffscreenLiveSessionRuntime {
  private readonly geminiAdapter: GeminiWireAdapter;

  constructor(options: GeminiLiveClientOptions = {}) {
    const adapter = new GeminiWireAdapter({
      model: options.model,
      liveGeminiNativeSearch: options.liveGeminiNativeSearch
    });
    super(adapter, options);
    this.geminiAdapter = adapter;
  }

  handleAction(msg: MossLiveClientAction): void {
    if (msg.action === "delegation_silent") {
      this.geminiAdapter.sendDelegationSilent(msg.delegationId, msg.content, this.transport);
      return;
    }
    if (msg.action === "delegation_result") {
      this.geminiAdapter.sendDelegationResult(
        msg.delegationId,
        msg.status,
        msg.content,
        this.transport
      );
      return;
    }
    super.handleAction(msg);
  }
}
