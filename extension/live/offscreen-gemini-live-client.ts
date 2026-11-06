import { MossAudioPlayer, type AudioContextLike } from "./moss-audio-player.js";
import {
  DEFAULT_GEMINI_LIVE_WS_URL,
  buildVideoInstructions,
  decodeBase64Bytes,
  type MossLiveClientAction,
  type MossLiveServerEvent,
  type MossLiveToolCall,
  type MossLiveToolStatusEvent,
  type MossLiveTranscriptEvent,
  type MossLiveVideoContext
} from "./moss-live-protocol.js";
import {
  DEFAULT_MOSS_PAGE_TOOL_TIMEOUT_MS,
  executeLiveWebSearch,
  type LiveWebSearchExecutor
} from "./offscreen-moss-client.js";

export type GeminiLiveClientState = "idle" | "connecting" | "connected" | "closed" | "failed";

export const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.8-live";
export const DEFAULT_GEMINI_HANDSHAKE_TIMEOUT_MS = 10000;
export const DEFAULT_GEMINI_OVERVIEW_TOOL_TIMEOUT_MS = 120000;

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
    name: "search_video_subtitles",
    description: "在当前视频/分P的全部字幕中按关键词检索。",
    parameters: {
      type: "OBJECT",
      properties: {
        query: {
          type: "STRING",
          description: "字幕检索关键词。"
        },
        max_results: {
          type: "NUMBER",
          description: "最大返回条数（默认 12，范围 1–30）。"
        }
      },
      required: ["query"]
    }
  },
  {
    name: "summarize_video",
    description:
      "生成或获取当前视频的全片概览（包含全片简介、章节脉络与金句）。当用户要求总结全片、询问这期视频讲了什么、或者当前没有概览时调用。概览生成可能需要一定时间。",
    parameters: {
      type: "OBJECT",
      properties: {}
    }
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

export function buildGeminiSetupTools(liveGeminiNativeSearch: boolean): unknown[] {
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

export interface GeminiLiveClientOptions {
  wsUrl?: string;
  model?: string;
  videoContext?: MossLiveVideoContext | null;
  liveGeminiNativeSearch?: boolean;
  handshakeTimeoutMs?: number;
  pageToolTimeoutMs?: number;
  overviewToolTimeoutMs?: number;
  createAudioContext?: () => AudioContextLike | null;
  executeWebSearch?: LiveWebSearchExecutor;
  onEvent?: (event: MossLiveServerEvent) => void;
  onConnecting?: () => void;
  onConnected?: () => void;
  onDuckVideo?: (active: boolean) => void;
  onTranscript?: (event: MossLiveTranscriptEvent) => void;
  onSpeakingState?: (speaking: boolean) => void;
  onToolStatus?: (event: MossLiveToolStatusEvent) => void;
  onToolCall?: (call: MossLiveToolCall) => void;
  onToolError?: (error: string) => void;
  onError?: (error: Error) => void;
  onClosed?: (event?: { code?: number; reason?: string }) => void;
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

type ActiveGeminiToolCall =
  | {
      kind: "page_tool";
      callId: string;
      name: string;
      timer: ReturnType<typeof setTimeout>;
    }
  | {
      kind: "web_search";
      callId: string;
      name: string;
      query: string;
      toolCallIndex: number;
      controller: AbortController;
    };

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

function withVideoIdentity(
  call: MossLiveToolCall,
  videoContext: MossLiveVideoContext | null
): MossLiveToolCall {
  return {
    ...call,
    video: videoContext
      ? {
          bvid: videoContext.bvid,
          cid: videoContext.cid,
          pageIndex: videoContext.pageIndex
        }
      : null
  };
}

export class OffscreenGeminiLiveClient {
  private ws: WebSocket | null = null;
  private state: GeminiLiveClientState = "idle";
  private disposed = false;
  private socketGeneration = 0;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private micEnabled = true;
  private wsUrl: string;
  private model: string;
  private videoContext: MossLiveVideoContext | null;
  private liveGeminiNativeSearch: boolean;
  private lastSentContextKey = "";
  private pendingVideoContext: MossLiveVideoContext | null = null;
  private hasPendingContext = false;
  private readonly handshakeTimeoutMs: number;
  private readonly pageToolTimeoutMs: number;
  private readonly overviewToolTimeoutMs: number;
  private readonly executeWebSearch: LiveWebSearchExecutor;
  private readonly options: GeminiLiveClientOptions;
  private readonly audioPlayer: MossAudioPlayer;
  private readonly activeToolCalls = new Map<string, ActiveGeminiToolCall>();
  private readonly handledToolCallIds = new Set<string>();
  private runId = "";
  private turnCounter = 0;
  private toolCallCounter = 0;
  private webSearchCallIndex = 0;
  private audioChunkCounter = 0;
  private currentTurn: GeminiTurn | null = null;
  private discardOutputUntilInput = false;
  private videoDucked = false;
  private inputDucked = false;
  private activeTurnKey: string | null = null;
  private speaking = false;

  constructor(options: GeminiLiveClientOptions = {}) {
    this.options = options;
    this.wsUrl = options.wsUrl || DEFAULT_GEMINI_LIVE_WS_URL;
    this.model = options.model || DEFAULT_GEMINI_LIVE_MODEL;
    this.videoContext = options.videoContext || null;
    this.liveGeminiNativeSearch = Boolean(options.liveGeminiNativeSearch ?? false);
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_GEMINI_HANDSHAKE_TIMEOUT_MS;
    this.pageToolTimeoutMs = options.pageToolTimeoutMs ?? DEFAULT_MOSS_PAGE_TOOL_TIMEOUT_MS;
    this.overviewToolTimeoutMs =
      options.overviewToolTimeoutMs ?? DEFAULT_GEMINI_OVERVIEW_TOOL_TIMEOUT_MS;
    this.executeWebSearch = options.executeWebSearch ?? executeLiveWebSearch;
    this.audioPlayer = new MossAudioPlayer({
      sampleRate: 24000,
      enablePlaybackReceipts: false,
      createAudioContext: options.createAudioContext,
      onTurnFinished: (runId, turnId) => this.finishActiveTurn(runId, turnId),
      onStateChange: () => {
        const currentTurnKey = this.currentTurn
          ? this.getTurnKey(this.currentTurn.runId, this.currentTurn.turnId)
          : null;
        if (
          this.activeTurnKey &&
          this.activeTurnKey !== currentTurnKey &&
          !this.audioPlayer.isPlaying()
        ) {
          this.activeTurnKey = null;
        }
        this.syncVideoDuck();
        this.flushPendingVideoContextIfIdle();
      }
    });
  }

  getState(): GeminiLiveClientState {
    return this.state;
  }

  isSpeaking(): boolean {
    return (
      this.state === "connected" &&
      (this.activeTurnKey !== null ||
        this.activeToolCalls.size > 0 ||
        this.audioPlayer.isPlaying())
    );
  }

  private hasPageToolHandler(): boolean {
    return Boolean(this.options.onEvent || this.options.onToolCall);
  }

  private emit(event: MossLiveServerEvent, closeCode?: number): void {
    this.options.onEvent?.(event);
    switch (event.type) {
      case "connecting":
        this.options.onConnecting?.();
        break;
      case "connected":
        this.options.onConnected?.();
        break;
      case "duck_video":
        this.options.onDuckVideo?.(event.active);
        break;
      case "speaking_state":
        this.options.onSpeakingState?.(event.speaking);
        break;
      case "transcript":
        this.options.onTranscript?.(event.event);
        break;
      case "tool_status":
        this.options.onToolStatus?.(event.event);
        break;
      case "tool_call":
        this.options.onToolCall?.(event.call);
        break;
      case "tool_error":
        this.options.onToolError?.(event.error);
        break;
      case "error":
        this.options.onError?.(new Error(event.error));
        break;
      case "closed":
        this.options.onClosed?.({ code: closeCode, reason: event.reason });
        break;
    }
  }

  private emitTranscript(event: MossLiveTranscriptEvent): void {
    this.emit({ type: "transcript", event });
  }

  private setVideoDucked(active: boolean): void {
    if (this.videoDucked === active) return;
    this.videoDucked = active;
    this.emit({ type: "duck_video", active });
  }

  private syncSpeakingState(): void {
    const nextSpeaking = this.isSpeaking();
    if (this.speaking === nextSpeaking) return;
    this.speaking = nextSpeaking;
    this.emit({ type: "speaking_state", speaking: nextSpeaking });
  }

  private syncVideoDuck(): void {
    this.setVideoDucked(this.inputDucked || this.activeTurnKey !== null);
    this.syncSpeakingState();
  }

  private getTurnKey(runId: string, turnId: string): string {
    return `${runId}:${turnId}`;
  }

  private activateTurn(turn: GeminiTurn): void {
    if (!this.audioPlayer.canActivateTurn(turn.runId, turn.turnId)) return;
    this.inputDucked = false;
    this.activeTurnKey = this.getTurnKey(turn.runId, turn.turnId);
    this.syncVideoDuck();
  }

  private finishActiveTurn(runId: string, turnId: string): void {
    if (this.activeTurnKey !== this.getTurnKey(runId, turnId)) return;
    if (this.audioPlayer.isPlaying()) return;
    this.activeTurnKey = null;
    this.syncVideoDuck();
    this.flushPendingVideoContextIfIdle();
  }

  private flushPendingVideoContextIfIdle(): void {
    if (
      this.hasPendingContext &&
      this.state === "connected" &&
      !this.isSpeaking() &&
      this.activeTurnKey === null &&
      !this.audioPlayer.isPlaying()
    ) {
      const context = this.pendingVideoContext;
      this.hasPendingContext = false;
      this.pendingVideoContext = null;
      this.flushVideoContext(context);
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  handleAction(msg: MossLiveClientAction): void {
    switch (msg.action) {
      case "start":
        if (msg.wsUrl !== undefined) this.wsUrl = msg.wsUrl || DEFAULT_GEMINI_LIVE_WS_URL;
        if (msg.model !== undefined) this.model = msg.model || DEFAULT_GEMINI_LIVE_MODEL;
        if (msg.videoContext !== undefined) this.videoContext = msg.videoContext || null;
        if (msg.liveGeminiNativeSearch !== undefined) {
          this.liveGeminiNativeSearch = Boolean(msg.liveGeminiNativeSearch);
        }
        this.audioPlayer.setVolume(msg.volume ?? 1);
        this.connect();
        break;
      case "set_volume":
        this.audioPlayer.setVolume(msg.volume);
        break;
      case "context_update":
        this.updateVideoContext(msg.videoContext);
        break;
      case "audio":
        if (msg.pcmBase64) this.sendRealtimeMedia("audio/pcm;rate=16000", msg.pcmBase64, true);
        break;
      case "video":
        if (msg.jpegBase64) this.sendRealtimeMedia("image/jpeg", msg.jpegBase64);
        break;
      case "mic_state":
        this.setMicEnabled(Boolean(msg.enabled));
        break;
      case "interrupt":
        this.interrupt();
        break;
      case "stop":
        this.close();
        this.emit({ type: "closed" });
        break;
      case "tool_result":
        this.sendToolResult(msg.callId, msg.result);
        break;
    }
  }

  connect(): void {
    if (this.state === "connecting" || this.state === "connected") this.close();
    this.disposed = false;
    this.state = "connecting";
    this.currentTurn = null;
    this.hasPendingContext = false;
    this.pendingVideoContext = null;
    this.discardOutputUntilInput = false;
    this.turnCounter = 0;
    this.toolCallCounter = 0;
    this.webSearchCallIndex = 0;
    this.audioChunkCounter = 0;
    this.handledToolCallIds.clear();
    this.inputDucked = false;
    this.activeTurnKey = null;
    this.socketGeneration += 1;
    const generation = this.socketGeneration;
    this.runId = `gemini-live-${generation}`;
    this.clearHandshakeTimer();
    this.emit({ type: "connecting" });

    if (this.handshakeTimeoutMs > 0) {
      this.handshakeTimer = setTimeout(() => {
        if (this.disposed || this.socketGeneration !== generation || this.state !== "connecting") return;
        this.fail(new Error("Gemini Live 握手超时：未在规定时间内收到 setupComplete"));
      }, this.handshakeTimeoutMs);
    }

    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.binaryType = "arraybuffer";
      this.ws.onopen = () => {
        if (this.disposed || this.socketGeneration !== generation) return;
        this.lastSentContextKey = JSON.stringify(this.videoContext);
        this.sendJson({
          setup: {
            model: `models/${this.model.replace(/^models\//, "")}`,
            generationConfig: { responseModalities: ["AUDIO"] },
            systemInstruction: {
              parts: [{ text: buildVideoInstructions(this.videoContext) }]
            },
            tools: buildGeminiSetupTools(this.liveGeminiNativeSearch),
            inputAudioTranscription: {},
            outputAudioTranscription: {}
          }
        });
      };
      this.ws.onmessage = (event) => {
        void this.handleIncomingData(event.data, generation);
      };
      this.ws.onerror = () => {
        if (this.disposed || this.socketGeneration !== generation) return;
        this.fail(new Error("WebSocket 连接失败或握手鉴权被拒绝"));
      };
      this.ws.onclose = (event) => {
        if (this.disposed || this.socketGeneration !== generation || this.state === "failed") return;
        this.clearHandshakeTimer();
        if (this.state === "connecting") {
          this.fail(new Error(`WebSocket 连接关闭 (${event.code}: ${event.reason || "握手未完成"})`));
          return;
        }
        this.state = "closed";
        this.currentTurn = null;
        this.stopAndResetAllPlayback();
        this.emit({ type: "closed", reason: event.reason }, event.code);
      };
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async handleIncomingData(data: unknown, generation: number): Promise<void> {
    if (this.disposed || this.socketGeneration !== generation) return;
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
      if (this.disposed || this.socketGeneration !== generation) return;
      this.handleServerMessage(JSON.parse(text), generation);
    } catch {
      return;
    }
  }

  private handleServerMessage(rawMessage: unknown, generation: number): void {
    if (this.disposed || this.socketGeneration !== generation) return;
    const raw = asRecord(rawMessage);
    if (!raw) return;
    const error = readErrorMessage(raw);
    if (error !== null) {
      this.fail(new Error(error));
      return;
    }
    if (raw.setupComplete !== undefined) {
      if (this.state !== "connecting") return;
      this.clearHandshakeTimer();
      this.state = "connected";
      this.emit({ type: "connected" });
      return;
    }
    if (this.state !== "connected") return;
    const voiceActivity = asRecord(raw.voiceActivity);
    if (voiceActivity) {
      const type = typeof voiceActivity.type === "string" ? voiceActivity.type : "";
      if (type === "ACTIVITY_START") {
        this.inputDucked = true;
        this.syncVideoDuck();
      }
    }
    const content = asRecord(raw.serverContent);
    if (content) {
      this.handleServerContent(content, generation);
    }
    const toolCall = asRecord(raw.toolCall);
    if (toolCall) {
      this.handleToolCall(toolCall, generation);
    }
    const cancellation = asRecord(raw.toolCallCancellation);
    if (cancellation) {
      this.handleToolCallCancellation(cancellation);
    }
  }

  private cancelToolCall(call: ActiveGeminiToolCall): void {
    if (this.activeToolCalls.get(call.callId) !== call) return;
    this.activeToolCalls.delete(call.callId);
    if (call.kind === "web_search") {
      call.controller.abort();
    } else {
      clearTimeout(call.timer);
    }
    this.syncSpeakingState();
  }

  private cancelAllToolCalls(): void {
    for (const call of [...this.activeToolCalls.values()]) {
      this.cancelToolCall(call);
    }
  }

  private sendToolResponse(id: string, name: string, result: unknown): boolean {
    return this.sendJson({
      toolResponse: {
        functionResponses: [
          {
            id,
            name,
            response: { result }
          }
        ]
      }
    });
  }

  private startPageToolCall(rawCall: MossLiveToolCall, generation: number): void {
    const call = withVideoIdentity(rawCall, this.videoContext);
    if (!this.hasPageToolHandler()) {
      this.sendToolResponse(call.callId, call.name, {
        ok: false,
        error: "当前客户端未接入页面工具执行器"
      });
      return;
    }

    const existing = this.activeToolCalls.get(call.callId);
    if (existing) {
      this.cancelToolCall(existing);
    }

    const timeoutMs =
      call.name === "summarize_video" ? this.overviewToolTimeoutMs : this.pageToolTimeoutMs;

    const entry: ActiveGeminiToolCall = {
      kind: "page_tool",
      callId: call.callId,
      name: call.name,
      timer: setTimeout(() => {
        if (this.disposed || this.socketGeneration !== generation) return;
        if (this.activeToolCalls.get(call.callId) !== entry) return;
        this.activeToolCalls.delete(call.callId);
        this.syncSpeakingState();
        const error = "页面工具执行超时，请稍后重试";
        this.sendToolResponse(call.callId, call.name, { ok: false, error });
        this.emit({ type: "tool_error", error });
      }, timeoutMs)
    };

    this.activeToolCalls.set(call.callId, entry);
    this.syncSpeakingState();
    this.emit({ type: "tool_call", call });
  }

  private handleToolCall(toolCall: Record<string, unknown>, generation: number): void {
    const functionCalls = Array.isArray(toolCall.functionCalls) ? toolCall.functionCalls : [];
    for (const rawItem of functionCalls) {
      const item = asRecord(rawItem);
      if (!item) continue;
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (!name) continue;
      const callId =
        typeof item.id === "string" && item.id.trim()
          ? item.id.trim()
          : `gemini-tool-${++this.toolCallCounter}`;
      if (this.handledToolCallIds.has(callId)) continue;
      this.handledToolCallIds.add(callId);

      const args = item.args ?? {};
      if (name !== "web_search") {
        this.startPageToolCall({ callId, name, arguments: args }, generation);
        continue;
      }

      const query = extractGeminiSearchQuery(args);
      if (!query) {
        const error = "搜索关键词为空或工具参数无效";
        this.emit({
          type: "tool_status",
          event: { tool: "web_search", status: "failed", query, error }
        });
        this.sendToolResponse(
          callId,
          name,
          `联网搜索失败：${error}。请明确告诉用户本次查证失败，不要编造。`
        );
        continue;
      }

      const toolCallIndex = this.webSearchCallIndex++;
      const controller = new AbortController();
      const entry: Extract<ActiveGeminiToolCall, { kind: "web_search" }> = {
        kind: "web_search",
        callId,
        name,
        query,
        toolCallIndex,
        controller
      };
      this.activeToolCalls.set(callId, entry);
      this.syncSpeakingState();
      this.emit({
        type: "tool_status",
        event: { tool: "web_search", status: "searching", query }
      });
      void this.runWebSearch(entry, generation);
    }
  }

  private async runWebSearch(
    call: Extract<ActiveGeminiToolCall, { kind: "web_search" }>,
    generation: number
  ): Promise<void> {
    const isCurrent = () =>
      !this.disposed &&
      this.socketGeneration === generation &&
      this.activeToolCalls.get(call.callId) === call;

    try {
      const outcome = await this.executeWebSearch(
        call.query,
        call.controller.signal,
        call.toolCallIndex
      );
      if (!isCurrent()) return;
      this.sendToolResponse(call.callId, call.name, outcome.output);
      this.emit({
        type: "tool_status",
        event: {
          tool: "web_search",
          status: outcome.resultCount > 0 ? "done" : "no_results",
          query: call.query,
          resultCount: outcome.resultCount,
          ...(outcome.platform ? { platform: outcome.platform } : {})
        }
      });
    } catch (error) {
      if (!isCurrent()) return;
      const reason = String((error as { message?: unknown } | null)?.message || error || "未知错误");
      this.sendToolResponse(
        call.callId,
        call.name,
        `联网搜索失败：${reason}。请明确告诉用户本次查证失败，不要编造外部事实。`
      );
      this.emit({
        type: "tool_status",
        event: {
          tool: "web_search",
          status: "failed",
          query: call.query,
          error: reason
        }
      });
    } finally {
      if (this.activeToolCalls.get(call.callId) === call) {
        this.activeToolCalls.delete(call.callId);
        this.syncSpeakingState();
      }
    }
  }

  private handleToolCallCancellation(cancellation: Record<string, unknown>): void {
    const ids = Array.isArray(cancellation.ids) ? cancellation.ids : [];
    for (const rawId of ids) {
      if (typeof rawId !== "string" || !rawId) continue;
      const active = this.activeToolCalls.get(rawId);
      if (active) {
        this.cancelToolCall(active);
      }
    }
  }

  sendToolResult(callId: string, result: unknown): boolean {
    const active = this.activeToolCalls.get(callId);
    if (!active || active.kind !== "page_tool") {
      return false;
    }
    clearTimeout(active.timer);
    this.activeToolCalls.delete(callId);
    this.syncSpeakingState();
    return this.sendToolResponse(callId, active.name, result);
  }

  private getOrCreateTurn(kind: "input" | "output"): GeminiTurn | null {
    if (!this.currentTurn && kind === "output" && this.discardOutputUntilInput) return null;
    if (kind === "input" && this.currentTurn?.hasOutput) {
      this.finishTurn("completed");
    }
    if (!this.currentTurn) {
      if (kind === "input") {
        this.discardOutputUntilInput = false;
        this.webSearchCallIndex = 0;
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

  private handleServerContent(content: Record<string, unknown>, generation: number): void {
    const interimInput = asRecord(content.interimInputTranscription);
    if (interimInput && typeof interimInput.text === "string" && interimInput.text) {
      const turn = this.getOrCreateTurn("input");
      if (turn) {
        turn.interimInputText = interimInput.text;
        this.inputDucked = true;
        this.syncVideoDuck();
        this.emitTranscript({
          kind: "input.updated",
          text: turn.inputText + turn.interimInputText
        });
      }
    }

    const input = asRecord(content.inputTranscription);
    if (input && typeof input.text === "string" && input.text) {
      const turn = this.getOrCreateTurn("input");
      if (turn) {
        turn.inputText += input.text;
        turn.interimInputText = "";
        this.inputDucked = true;
        this.syncVideoDuck();
        this.emitTranscript({ kind: "input.updated", text: turn.inputText });
      }
    }

    const output = asRecord(content.outputTranscription);
    if (output && typeof output.text === "string" && output.text) {
      const turn = this.getOrCreateTurn("output");
      if (turn) {
        turn.hasOutput = true;
        turn.outputText += output.text;
        this.activateTurn(turn);
        this.emitTranscript({
          kind: "output.updated",
          text: turn.outputText,
          runId: turn.runId,
          turnId: turn.turnId
        });
      }
    }

    const modelTurn = asRecord(content.modelTurn);
    if (modelTurn && Array.isArray(modelTurn.parts)) {
      this.handleModelTurn(modelTurn.parts, generation);
    }

    if (content.interrupted === true) {
      this.interrupt();
      return;
    }
    if (content.turnComplete === true && this.currentTurn) {
      const interactionStatus =
        typeof content.interactionStatus === "string" ? content.interactionStatus : "";
      if (interactionStatus !== "IN_PROGRESS") {
        this.finishTurn("completed");
      }
    }
  }

  private handleModelTurn(parts: unknown[], generation: number): void {
    const turn = this.getOrCreateTurn("output");
    if (!turn) return;
    turn.hasOutput = true;
    this.activateTurn(turn);
    const isCurrent = () => !this.disposed && this.socketGeneration === generation;
    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      const inlineData = asRecord(part?.inlineData);
      const mimeType = typeof inlineData?.mimeType === "string" ? inlineData.mimeType : "";
      const data = typeof inlineData?.data === "string" ? inlineData.data : "";
      if (!mimeType.startsWith("audio/pcm") || !data) continue;
      const bytes = decodeBase64Bytes(data);
      if (bytes.byteLength === 0) continue;
      const chunkId = `gemini-audio-${++this.audioChunkCounter}`;
      if (this.audioPlayer.enqueueAudioContext(chunkId, turn.runId, turn.turnId, isCurrent)) {
        this.audioPlayer.enqueueAudioFrame(bytes.buffer, isCurrent);
      }
    }
  }

  private finishTurn(kind: "completed" | "interrupted"): void {
    const turn = this.currentTurn;
    if (!turn) return;
    this.currentTurn = null;
    this.inputDucked = false;

    const fullInputText = (turn.inputText + turn.interimInputText).trim();
    if (!turn.inputDone && fullInputText) {
      turn.inputDone = true;
      this.emitTranscript({ kind: "input.done", text: fullInputText });
    }
    if (!turn.outputDone && turn.outputText) {
      turn.outputDone = true;
      this.emitTranscript({
        kind: "output.done",
        text: turn.outputText,
        runId: turn.runId,
        turnId: turn.turnId
      });
    }

    if (kind === "interrupted") {
      this.audioPlayer.stopAll();
      this.finishActiveTurn(turn.runId, turn.turnId);
      this.emitTranscript({
        kind: "response.interrupted",
        runId: turn.runId,
        turnId: turn.turnId
      });
    } else {
      this.audioPlayer.markResponseEnded(turn.runId, turn.turnId);
      this.audioPlayer.handleAudioDone(turn.runId, turn.turnId);
      this.finishActiveTurn(turn.runId, turn.turnId);
      this.emitTranscript({
        kind: "response.ended",
        status: "completed",
        runId: turn.runId,
        turnId: turn.turnId
      });
    }
    if (this.activeToolCalls.size === 0) {
      this.webSearchCallIndex = 0;
    }
    this.syncVideoDuck();
    this.flushPendingVideoContextIfIdle();
  }

  setMicEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    if (this.micEnabled === next) return;
    this.micEnabled = next;
    if (!next && this.state === "connected") {
      this.sendJson({ realtimeInput: { audioStreamEnd: true } });
    }
  }

  private sendRealtimeMedia(mimeType: string, data: string, audio = false): boolean {
    if (this.state !== "connected" || (audio && !this.micEnabled)) return false;
    if (audio) {
      return this.sendJson({ realtimeInput: { audio: { mimeType, data } } });
    }
    return this.sendJson({ realtimeInput: { video: { mimeType, data } } });
  }

  updateVideoContext(context: MossLiveVideoContext | null): void {
    this.videoContext = context;
    if (this.state !== "connected") return;
    const contextKey = JSON.stringify(context);
    if (contextKey === this.lastSentContextKey) return;
    if (this.isSpeaking() || this.activeTurnKey !== null || this.audioPlayer.isPlaying()) {
      this.pendingVideoContext = context;
      this.hasPendingContext = true;
      return;
    }
    this.flushVideoContext(context);
  }

  private flushVideoContext(context: MossLiveVideoContext | null): void {
    this.hasPendingContext = false;
    this.pendingVideoContext = null;
    this.lastSentContextKey = JSON.stringify(context);
    this.sendJson({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: buildVideoInstructions(context) }] }],
        turnComplete: false
      }
    });
  }

  interrupt(): void {
    if (this.disposed || this.state !== "connected") return;
    this.discardOutputUntilInput = true;
    this.cancelAllToolCalls();
    this.webSearchCallIndex = 0;
    if (this.currentTurn) {
      this.finishTurn("interrupted");
      return;
    }
    this.audioPlayer.stopAll();
    this.inputDucked = false;
    this.activeTurnKey = null;
    this.setVideoDucked(false);
    this.syncSpeakingState();
  }

  private stopAndResetAllPlayback(): void {
    this.hasPendingContext = false;
    this.pendingVideoContext = null;
    this.cancelAllToolCalls();
    this.webSearchCallIndex = 0;
    this.audioPlayer.reset();
    this.currentTurn = null;
    this.activeTurnKey = null;
    this.inputDucked = false;
    this.setVideoDucked(false);
    this.syncSpeakingState();
  }

  private fail(error: Error): void {
    this.clearHandshakeTimer();
    this.state = "failed";
    this.disposed = true;
    this.socketGeneration += 1;
    this.stopAndResetAllPlayback();
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {}
    }
    this.emit({ type: "error", error: error.message });
  }

  close(): void {
    this.disposed = true;
    this.socketGeneration += 1;
    this.clearHandshakeTimer();
    this.state = "idle";
    this.stopAndResetAllPlayback();
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {}
    }
  }

  sendJson(payload: unknown): boolean {
    if (this.disposed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }
}
