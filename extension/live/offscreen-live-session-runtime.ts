// extension/live/offscreen-live-session-runtime.ts
// Offscreen 实时伴看会话统一运行时（Deep Module）。
// 独占持有：
// 1. WebSocket 代际防串音守卫、握手定时器与基于会话恢复句柄（sessionId / resumption handle）的自动重连状态机
// 2. 页面工具与内置 web_search 的统一生命周期（activeToolCalls、独立超时、轮次配额、打断取消）
// 3. MossAudioPlayer 播放队列、打断协调、视频音量压低（duck_video）与发言状态（speaking_state）同步
// 4. 发言/播放期上下文更新暂存（pendingVideoContext）与回合空闲自动下发
// 通过窄协议适配器接缝（LiveWireProtocolAdapter）分别接入 MOSS tagged-v1 与 Gemini BidiGenerateContent。

import { serializeSearchResults } from "../ai/tool-loop.js";
import { formatPaidFallbackNotice } from "../search/search-chain.js";
import { resolveWebSearchRuntime } from "../search/search-runtime.js";
import {
  MossAudioPlayer,
  type AudioBufferLike,
  type AudioBufferSourceNodeLike,
  type AudioContextLike
} from "./moss-audio-player.js";
import {
  DEFAULT_MOSS_RECONNECT_DELAY_MS,
  MAX_MOSS_RECONNECT_ATTEMPTS,
  decodeBase64Bytes,
  toolCallVideoIdentity,
  type MossLiveClientAction,
  type MossLiveServerEvent,
  type MossLiveSessionContext,
  type MossLiveToolCall,
  type MossLiveToolStatusEvent,
  type MossLiveTranscriptEvent
} from "./moss-live-protocol.js";

export type { AudioBufferLike, AudioBufferSourceNodeLike, AudioContextLike };

export type LiveSessionClientState = "idle" | "connecting" | "connected" | "closed" | "failed";

export const DEFAULT_LIVE_HANDSHAKE_TIMEOUT_MS = 10000;
export const DEFAULT_LIVE_PAGE_TOOL_TIMEOUT_MS = 10000;
export const DEFAULT_LIVE_OVERVIEW_TOOL_TIMEOUT_MS = 120000;

export interface LiveWebSearchOutcome {
  output: string;
  resultCount: number;
  platform?: string;
}

export type LiveWebSearchExecutor = (
  query: string,
  signal: AbortSignal,
  toolCallIndex?: number
) => Promise<LiveWebSearchOutcome>;

export async function executeLiveWebSearch(
  query: string,
  signal: AbortSignal,
  toolCallIndex = 0
): Promise<LiveWebSearchOutcome> {
  const resolution = await resolveWebSearchRuntime(signal);
  if (signal.aborted) {
    throw new Error("搜索已中止");
  }
  if (!resolution.runtime) {
    throw new Error(resolution.notice || "联网搜索不可用");
  }
  if (toolCallIndex >= resolution.runtime.maxToolCalls) {
    throw new Error(
      `本轮的搜索次数已达上限（${resolution.runtime.maxToolCalls} 次），请基于已有搜索结果作答。`
    );
  }

  const outcome = await resolution.runtime.executeSearch(query);
  if (signal.aborted) {
    throw new Error("搜索已中止");
  }
  const paidBadge = outcome.paid ? "（付费）" : "";
  const sourceNote = outcome.downgradedFrom
    ? `首选 ${outcome.downgradedFrom} 未成功，以下结果来自 ${outcome.platform}${paidBadge}。\n`
    : `以下结果来自 ${outcome.platform}${paidBadge}。\n`;
  const paidFallbackNote = outcome.paidFallback
    ? `${formatPaidFallbackNotice(outcome.paidFallback)}\n`
    : "";
  if (outcome.results.length === 0) {
    return {
      output: `${paidFallbackNote}${sourceNote}联网搜索完成，但没有找到与“${query}”相关的结果。请明确告诉用户没有查到相关事实，不要编造。`,
      resultCount: 0,
      platform: outcome.platform
    };
  }

  return {
    output: `${paidFallbackNote}${sourceNote}请根据以下来源回答用户，并保留可核验的标题与链接：\n${serializeSearchResults(outcome.results)}`,
    resultCount: outcome.results.length,
    platform: outcome.platform
  };
}

export interface LiveWireTransport {
  sendJson(payload: unknown): boolean;
  sendBinary(frame: Uint8Array<ArrayBuffer> | ArrayBufferLike): boolean;
}

export interface LiveWireSocketOpenContext extends LiveWireTransport {
  sessionId: string | null;
  videoContext: MossLiveSessionContext | null;
  micEnabled: boolean;
  // 当前选用的音色（空 = 平台默认音色）：协议适配器在 session_attached 后据此
  // 决定是否发 change_voice。
  voiceId: string;
  markContextSent(context: MossLiveSessionContext | null): void;
}

export interface LiveWireRuntimeCallbacks extends LiveWireTransport {
  isCurrent(): boolean;
  getState(): LiveSessionClientState;
  getVideoContext(): MossLiveSessionContext | null;
  getMicEnabled(): boolean;
  completeHandshake(options?: { sessionId?: string | null; emitSessionAttached?: boolean }): void;
  updateSessionHandle(sessionId: string, options?: { emitSessionAttached?: boolean }): void;
  // change_voice 失败（音色已删/无权限）时由适配器上报：运行时清空当前音色并
  // 通知页面侧回退默认音色。
  reportVoiceFallback(voiceId: string): void;
  markContextSent(context: MossLiveSessionContext | null): void;
  applyOutputConfiguration(config: { volumeDb?: number; speed?: number }): void;
  emitTranscript(event: MossLiveTranscriptEvent, options?: { duckInput?: boolean }): void;
  enqueueAudioContext(chunkId: string, runId: string, turnId: string): boolean;
  enqueueAudioFrame(pcmBuffer: ArrayBufferLike): void;
  markResponseEnded(runId: string, turnId: string): void;
  handleAudioDone(runId: string, turnId: string): void;
  handleAudioStop(runId: string, turnId: string): void;
  finishActiveTurn(runId: string, turnId: string): void;
  startDelegation(delegation: { delegationId: string; objective: string; context: string[] }): void;
  cancelDelegation(delegationId: string): void;
  startPageToolCall(rawCall: MossLiveToolCall, runId: string, turnId: string): void;
  startFunctionCall(params: {
    callId: string;
    name: string;
    arguments: unknown;
    query: string;
    runId: string;
    turnId: string;
  }): void;
  cancelToolCallsByIds(ids: string[]): void;
  interrupt(): void;
  useLocalPlaybackRate(): void;
  fail(error: Error, code?: number | string): void;
  failOrReconnectOnServerError(message: string, code?: number | string): void;
}

export interface LiveWireProtocolAdapter {
  readonly defaultWsUrl: string;
  readonly handshakeTimeoutMessage: string;
  readonly audioSampleRate?: number;
  readonly enablePlaybackReceipts?: boolean;
  onStartAction?(msg: Extract<MossLiveClientAction, { action: "start" }>): void;
  onConnectReset(generation: number): void;
  onSocketOpen(context: LiveWireSocketOpenContext): void;
  handleIncomingData(data: unknown, callbacks: LiveWireRuntimeCallbacks): void | Promise<void>;
  sendAudio(
    pcmBase64: string,
    pcmBytes: Uint8Array<ArrayBuffer>,
    transport: LiveWireTransport
  ): boolean;
  sendVideo(
    jpegBase64: string,
    jpegBytes: Uint8Array<ArrayBuffer>,
    transport: LiveWireTransport
  ): boolean;
  onMicStateChanged(
    enabled: boolean,
    previousEnabled: boolean,
    connected: boolean,
    transport: LiveWireTransport
  ): void;
  onVideoContextUpdated?(context: MossLiveSessionContext | null): void;
  configureOutput?(
    output: { volumeDb: number; speed?: number },
    transport: LiveWireTransport
  ): boolean;
  // 通话中改音色：适配器在已附着会话上直接发 change_voice（下一轮回答生效），
  // 尚未附着时只记下选择、由 session_attached 的握手分支发送。
  changeVoice?(voiceId: string, transport: LiveWireTransport): boolean;
  sendContextUpdate(context: MossLiveSessionContext | null, transport: LiveWireTransport): void;
  sendToolResponse(
    call: { callId: string; name: string },
    result: unknown,
    transport: LiveWireTransport
  ): boolean;
  sendWebSearchResponse?(
    call: { callId: string; name: string },
    outcome:
      | { ok: true; output: string }
      | { ok: false; error: string; emptyQuery?: boolean },
    transport: LiveWireTransport
  ): void;
  onBeforeInterrupt?(callbacks: LiveWireRuntimeCallbacks): { runId: string; turnId: string } | null;
  onResetPlayback?(): void;
}

export interface OffscreenLiveSessionRuntimeOptions {
  wsUrl?: string;
  sessionId?: string | null;
  videoContext?: MossLiveSessionContext | null;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  handshakeTimeoutMs?: number;
  pageToolTimeoutMs?: number;
  overviewToolTimeoutMs?: number;
  executeWebSearch?: LiveWebSearchExecutor;
  createAudioContext?: () => AudioContextLike | null;
  onEvent?: (event: MossLiveServerEvent) => void;
  onConnecting?: () => void;
  onConnected?: (sessionId?: string) => void;
  onSessionAttached?: (sessionId: string) => void;
  onVoiceFallback?: (voiceId: string) => void;
  onReconnecting?: (
    attempt: number,
    maxAttempts: number,
    info?: { code?: number; reason?: string; error?: string }
  ) => void;
  onDuckVideo?: (active: boolean) => void;
  onTranscript?: (event: MossLiveTranscriptEvent) => void;
  onSpeakingState?: (speaking: boolean) => void;
  onToolCall?: (call: MossLiveToolCall) => void;
  onToolStatus?: (event: MossLiveToolStatusEvent) => void;
  onToolError?: (error: string) => void;
  onError?: (error: Error, code?: number | string) => void;
  onClosed?: (event?: { code?: number; reason?: string; error?: string }) => void;
}

type ActiveRuntimeToolCall =
  | {
      kind: "web_search";
      callId: string;
      name: string;
      query: string;
      runId: string;
      turnId: string;
      toolCallIndex: number;
      controller: AbortController;
    }
  | {
      kind: "page_tool";
      callId: string;
      name: string;
      runId: string;
      turnId: string;
      timer: ReturnType<typeof setTimeout>;
    };

export class OffscreenLiveSessionRuntime {
  protected ws: WebSocket | null = null;
  protected state: LiveSessionClientState = "idle";
  disposed = false;
  protected socketGeneration = 0;
  protected handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  protected micEnabled = true;
  protected readonly audioPlayer: MossAudioPlayer;
  protected readonly activeToolCalls = new Map<string, ActiveRuntimeToolCall>();
  protected readonly handledToolCallIds = new Set<string>();
  protected readonly webSearchCallCounts = new Map<string, number>();
  protected wsUrl: string;
  protected readonly handshakeTimeoutMs: number;
  protected readonly pageToolTimeoutMs: number;
  protected readonly overviewToolTimeoutMs: number;
  protected readonly executeWebSearch: LiveWebSearchExecutor;
  protected readonly options: OffscreenLiveSessionRuntimeOptions;
  protected readonly adapter: LiveWireProtocolAdapter;
  protected videoContext: MossLiveSessionContext | null;
  protected lastSentContextKey = "";
  protected pendingVideoContext: MossLiveSessionContext | null = null;
  protected hasPendingContext = false;
  protected videoDucked = false;
  protected inputDucked = false;
  protected activeTurnKey: string | null = null;
  protected speaking = false;
  protected sessionId: string | null = null;
  protected reconnectAttempts = 0;
  protected readonly maxReconnectAttempts: number;
  protected readonly reconnectDelayMs: number;
  protected reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  protected lastSocketError = "";
  protected outputVolume = 1;
  protected outputSpeed = 1;
  protected serverSpeedUnsupported = false;
  // 当前选用的音色（空 = 平台默认）；start/change_voice 动作写入，重连时随
  // onSocketOpen 交给适配器重发。
  protected voiceId = "";

  protected readonly transport: LiveWireTransport = {
    sendJson: (payload: unknown) => this.sendJson(payload),
    sendBinary: (frame: Uint8Array<ArrayBuffer> | ArrayBufferLike) => this.sendRawBinary(frame)
  };

  constructor(adapter: LiveWireProtocolAdapter, options: OffscreenLiveSessionRuntimeOptions = {}) {
    this.adapter = adapter;
    this.options = options;
    this.wsUrl = options.wsUrl || adapter.defaultWsUrl;
    this.videoContext = options.videoContext || null;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_LIVE_HANDSHAKE_TIMEOUT_MS;
    this.pageToolTimeoutMs = options.pageToolTimeoutMs ?? DEFAULT_LIVE_PAGE_TOOL_TIMEOUT_MS;
    this.overviewToolTimeoutMs =
      options.overviewToolTimeoutMs ?? DEFAULT_LIVE_OVERVIEW_TOOL_TIMEOUT_MS;
    this.executeWebSearch = options.executeWebSearch ?? executeLiveWebSearch;
    this.sessionId = options.sessionId || null;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? MAX_MOSS_RECONNECT_ATTEMPTS;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_MOSS_RECONNECT_DELAY_MS;
    this.audioPlayer = new MossAudioPlayer({
      sampleRate: adapter.audioSampleRate,
      enablePlaybackReceipts: adapter.enablePlaybackReceipts,
      createAudioContext: options.createAudioContext,
      onSendJson: (payload) => {
        this.sendJson(payload);
      },
      onTurnFinished: (runId, turnId) => {
        this.finishActiveTurn(runId, turnId);
      },
      onStateChange: () => {
        this.syncSpeakingState();
        this.flushPendingVideoContextIfIdle();
      }
    });
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  getState(): LiveSessionClientState {
    return this.state;
  }

  protected emit(event: MossLiveServerEvent): void {
    this.options.onEvent?.(event);
    switch (event.type) {
      case "connecting":
        this.options.onConnecting?.();
        break;
      case "connected":
        this.options.onConnected?.(event.sessionId);
        break;
      case "session_attached":
        this.options.onSessionAttached?.(event.sessionId);
        break;
      case "voice_fallback":
        this.options.onVoiceFallback?.(event.voiceId);
        break;
      case "reconnecting":
        this.options.onReconnecting?.(event.attempt, event.maxAttempts, {
          code: event.code,
          reason: event.reason,
          error: event.error
        });
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
      case "tool_call":
        this.options.onToolCall?.(event.call);
        break;
      case "tool_status":
        this.options.onToolStatus?.(event.event);
        break;
      case "tool_error":
        this.options.onToolError?.(event.error);
        break;
      case "error": {
        const err = new Error(event.error);
        if (event.code !== undefined) {
          (err as Error & { code?: number | string }).code = event.code;
        }
        this.options.onError?.(err);
        break;
      }
      case "closed":
        this.options.onClosed?.({
          code: event.code,
          reason: event.reason,
          error: event.error
        });
        break;
    }
  }

  protected hasPageToolHandler(): boolean {
    return Boolean(this.options.onEvent || this.options.onToolCall);
  }

  protected setVideoDucked(active: boolean): void {
    if (this.videoDucked === active) return;
    this.videoDucked = active;
    this.emit({ type: "duck_video", active });
  }

  protected clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  protected clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  protected getTurnKey(runId: string, turnId: string): string {
    return `${runId}:${turnId}`;
  }

  isSpeaking(): boolean {
    if (this.state !== "connected") return false;
    return (
      this.activeTurnKey !== null ||
      this.activeToolCalls.size > 0 ||
      this.audioPlayer.isPlaying()
    );
  }

  protected syncSpeakingState(): void {
    const nextSpeaking = this.isSpeaking();
    if (this.speaking === nextSpeaking) return;
    this.speaking = nextSpeaking;
    this.emit({ type: "speaking_state", speaking: nextSpeaking });
  }

  protected syncVideoDuck(): void {
    this.setVideoDucked(this.inputDucked || this.activeTurnKey !== null);
    this.syncSpeakingState();
  }

  protected activateTurn(runId: string, turnId: string): void {
    if (!this.audioPlayer.canActivateTurn(runId, turnId)) return;
    this.inputDucked = false;
    this.activeTurnKey = this.getTurnKey(runId, turnId);
    this.syncVideoDuck();
  }

  protected finishActiveTurn(runId: string, turnId: string): void {
    if (this.activeTurnKey !== this.getTurnKey(runId, turnId)) return;
    this.activeTurnKey = null;
    this.syncVideoDuck();
    this.flushPendingVideoContextIfIdle();
  }

  protected flushPendingVideoContextIfIdle(): void {
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

  protected flushVideoContext(context: MossLiveSessionContext | null): void {
    this.hasPendingContext = false;
    this.pendingVideoContext = null;
    this.lastSentContextKey = JSON.stringify(context);
    this.adapter.sendContextUpdate(context, this.transport);
  }

  protected stopAllPlayback(): void {
    this.audioPlayer.stopAll();
    this.activeTurnKey = null;
    this.inputDucked = false;
    this.setVideoDucked(false);
    this.syncSpeakingState();
  }

  protected stopAndResetAllPlayback(): void {
    this.hasPendingContext = false;
    this.pendingVideoContext = null;
    this.adapter.onResetPlayback?.();
    this.audioPlayer.reset();
    this.activeTurnKey = null;
    this.inputDucked = false;
    this.webSearchCallCounts.clear();
    this.setVideoDucked(false);
    this.syncSpeakingState();
  }

  protected configureOutput(): void {
    const output: { volumeDb: number; speed?: number } = {
      volumeDb: Math.max(0, (this.outputVolume - 1) * 16)
    };
    if (!this.serverSpeedUnsupported) output.speed = this.outputSpeed;
    this.adapter.configureOutput?.(output, this.transport);
  }

  handleAction(msg: MossLiveClientAction): void {
    switch (msg.action) {
      case "start":
        this.serverSpeedUnsupported = false;
        if (this.adapter.configureOutput) this.audioPlayer.setPlaybackRate(1);
        if (msg.wsUrl !== undefined) {
          this.wsUrl = msg.wsUrl || this.adapter.defaultWsUrl;
        }
        if (msg.videoContext !== undefined) {
          this.videoContext = msg.videoContext || null;
        }
        if (msg.sessionId !== undefined) {
          this.sessionId = msg.sessionId || null;
        }
        this.adapter.onStartAction?.(msg);
        if (msg.speed !== undefined && Number.isFinite(msg.speed) && msg.speed > 0) {
          this.outputSpeed = msg.speed;
          if (!this.adapter.configureOutput) this.audioPlayer.setPlaybackRate(msg.speed);
        }
        if (msg.volume !== undefined && Number.isFinite(msg.volume)) {
          this.outputVolume = Math.max(0, Math.min(2, msg.volume));
        }
        // 每次 start 都是新选择：省略 voiceId 表示回到平台默认音色，不能沿用
        // 上一条会话遗留的旧音色。
        this.voiceId = msg.voiceId !== undefined ? String(msg.voiceId || "").trim() : "";
        this.audioPlayer.setVolume(Math.min(1, this.outputVolume));
        this.connect();
        break;

      case "change_voice":
        // 通话中改音色：直接下发，服务端从下一轮回答开始使用；未附着时由
        // session_attached 的握手分支带上。
        this.voiceId = String(msg.voiceId || "").trim();
        this.adapter.changeVoice?.(this.voiceId, this.transport);
        break;

      case "set_volume":
        if (Number.isFinite(msg.volume)) {
          this.outputVolume = Math.max(0, Math.min(2, msg.volume));
        }
        this.audioPlayer.setVolume(Math.min(1, this.outputVolume));
        this.configureOutput();
        break;

      case "set_speed":
        if (Number.isFinite(msg.speed) && msg.speed > 0) {
          this.outputSpeed = msg.speed;
        }
        if (this.adapter.configureOutput && !this.serverSpeedUnsupported) {
          this.configureOutput();
        } else {
          this.audioPlayer.setPlaybackRate(this.outputSpeed);
        }
        break;

      case "context_update":
        this.updateVideoContext(msg.videoContext);
        break;

      case "tool_result":
        this.sendToolResult(msg.callId, msg.result);
        break;

      case "audio": {
        if (!msg.pcmBase64) break;
        const bytes = decodeBase64Bytes(msg.pcmBase64);
        if (bytes.byteLength > 0 && this.micEnabled && this.state === "connected") {
          this.adapter.sendAudio(msg.pcmBase64, bytes, this.transport);
        }
        break;
      }

      case "video": {
        if (!msg.jpegBase64) break;
        const bytes = decodeBase64Bytes(msg.jpegBase64);
        if (bytes.byteLength > 0 && this.state === "connected") {
          this.adapter.sendVideo(msg.jpegBase64, bytes, this.transport);
        }
        break;
      }

      case "mic_state":
        this.setMicEnabled(Boolean(msg.enabled));
        break;

      case "interrupt":
        this.interrupt();
        break;

      case "stop":
        this.sessionId = null;
        this.reconnectAttempts = 0;
        this.clearReconnectTimer();
        this.close();
        this.emit({ type: "closed" });
        break;
    }
  }

  connect(): void {
    this.clearReconnectTimer();
    if (this.state === "connecting" || this.state === "connected") {
      this.closeSocket();
    }
    this.disposed = false;
    this.state = "connecting";
    this.hasPendingContext = false;
    this.pendingVideoContext = null;
    this.handledToolCallIds.clear();
    this.activeTurnKey = null;
    this.socketGeneration += 1;
    const currentGeneration = this.socketGeneration;
    this.adapter.onConnectReset(currentGeneration);
    this.clearHandshakeTimer();

    this.emit({ type: "connecting" });

    if (this.handshakeTimeoutMs > 0) {
      this.handshakeTimer = setTimeout(() => {
        if (this.disposed || this.socketGeneration !== currentGeneration) {
          return;
        }
        if (this.state === "connecting") {
          this.fail(new Error(this.adapter.handshakeTimeoutMessage));
        }
      }, this.handshakeTimeoutMs);
    }

    const callbacks = this.createRuntimeCallbacks(currentGeneration);

    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => {
        if (this.disposed || this.socketGeneration !== currentGeneration) return;
        this.adapter.onSocketOpen({
          sessionId: this.sessionId,
          videoContext: this.videoContext,
          micEnabled: this.micEnabled,
          voiceId: this.voiceId,
          sendJson: this.transport.sendJson,
          sendBinary: this.transport.sendBinary,
          markContextSent: (ctx) => {
            this.lastSentContextKey = JSON.stringify(ctx);
          }
        });
      };

      this.ws.onmessage = (event) => {
        if (this.disposed || this.socketGeneration !== currentGeneration) return;
        void this.adapter.handleIncomingData(event.data, callbacks);
      };

      this.ws.onerror = () => {
        if (this.disposed || this.socketGeneration !== currentGeneration) return;
        this.clearHandshakeTimer();
        this.lastSocketError = "WebSocket 连接失败或握手鉴权被拒绝";
        if (!this.sessionId) {
          this.fail(new Error("WebSocket 连接失败或握手鉴权被拒绝"));
        }
      };

      this.ws.onclose = (event) => {
        if (
          this.disposed ||
          this.socketGeneration !== currentGeneration ||
          this.state === "failed"
        ) {
          return;
        }
        this.handleConnectionDrop(event.code, event.reason, null, currentGeneration);
      };
    } catch (error) {
      this.clearHandshakeTimer();
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  protected createRuntimeCallbacks(generation: number): LiveWireRuntimeCallbacks {
    const isCurrent = () => !this.disposed && this.socketGeneration === generation;
    return {
      isCurrent,
      getState: () => this.state,
      getVideoContext: () => this.videoContext,
      getMicEnabled: () => this.micEnabled,
      sendJson: this.transport.sendJson,
      sendBinary: this.transport.sendBinary,
      completeHandshake: (options) => {
        if (!isCurrent()) return;
        this.clearHandshakeTimer();
        if (options?.sessionId) {
          this.sessionId = options.sessionId;
        }
        this.reconnectAttempts = 0;
        this.state = "connected";
        if (options?.emitSessionAttached && options.sessionId) {
          this.emit({ type: "session_attached", sessionId: options.sessionId });
        }
        this.emit({ type: "connected", sessionId: this.sessionId || undefined });
        this.configureOutput();
      },
      updateSessionHandle: (sessionId, options) => {
        if (!isCurrent() || !sessionId) return;
        this.sessionId = sessionId;
        if (options?.emitSessionAttached !== false) {
          this.emit({ type: "session_attached", sessionId });
        }
      },
      reportVoiceFallback: (voiceId) => {
        if (!isCurrent()) return;
        // 回退默认音色：清空当前选择，避免重连时再次下发已失效音色。
        this.voiceId = "";
        this.emit({ type: "voice_fallback", voiceId });
      },
      markContextSent: (context) => {
        this.lastSentContextKey = JSON.stringify(context);
      },
      applyOutputConfiguration: (config) => {
        if (!isCurrent()) return;
        if (config.volumeDb !== undefined && Number.isFinite(config.volumeDb)) {
          if (config.volumeDb !== 0 || this.outputVolume >= 1) {
            this.outputVolume = Math.max(0, Math.min(2, 1 + config.volumeDb / 16));
          }
          this.audioPlayer.setVolume(Math.min(1, this.outputVolume));
        }
        if (config.speed !== undefined && Number.isFinite(config.speed) && config.speed > 0) {
          this.outputSpeed = config.speed;
          if (this.serverSpeedUnsupported) this.audioPlayer.setPlaybackRate(config.speed);
        }
        this.emit({ type: "output_configured", volume: this.outputVolume, speed: this.outputSpeed });
      },
      emitTranscript: (event, options) => {
        if (!isCurrent()) return;
        if (event.kind === "input.updated" || event.kind === "input.done") {
          if (options?.duckInput !== false) {
            this.inputDucked = true;
            this.syncVideoDuck();
          }
        } else if (event.kind === "output.updated" || event.kind === "output.done") {
          this.activateTurn(event.runId, event.turnId);
        } else if (event.kind === "response.ended") {
          this.audioPlayer.markResponseEnded(event.runId, event.turnId);
          this.finishActiveTurn(event.runId, event.turnId);
        } else if (event.kind === "response.interrupted") {
          this.audioPlayer.stopTurn(event.runId, event.turnId);
          this.cancelInterruptedToolCalls(event.runId, event.turnId);
        }
        this.emit({ type: "transcript", event });
      },
      enqueueAudioContext: (chunkId, runId, turnId) => {
        if (!isCurrent()) return false;
        const accepted = this.audioPlayer.enqueueAudioContext(chunkId, runId, turnId, isCurrent);
        if (accepted) {
          this.activateTurn(runId, turnId);
        }
        return accepted;
      },
      enqueueAudioFrame: (pcmBuffer) => {
        if (!isCurrent()) return;
        this.audioPlayer.enqueueAudioFrame(pcmBuffer, isCurrent);
      },
      markResponseEnded: (runId, turnId) => {
        if (!isCurrent()) return;
        this.audioPlayer.markResponseEnded(runId, turnId);
      },
      handleAudioDone: (runId, turnId) => {
        if (!isCurrent()) return;
        this.audioPlayer.handleAudioDone(runId, turnId);
      },
      handleAudioStop: (runId, turnId) => {
        if (!isCurrent()) return;
        this.audioPlayer.handleAudioStop(runId, turnId);
      },
      finishActiveTurn: (runId, turnId) => {
        if (!isCurrent()) return;
        this.finishActiveTurn(runId, turnId);
      },
      startDelegation: (delegation) => {
        if (!isCurrent()) return;
        this.emit({ type: "delegation_created", delegation });
      },
      cancelDelegation: (delegationId) => {
        if (!isCurrent()) return;
        this.emit({ type: "delegation_cancelled", delegationId });
      },
      startPageToolCall: (rawCall, runId, turnId) => {
        if (!isCurrent()) return;
        this.startPageToolCall(rawCall, runId, turnId, generation);
      },
      startFunctionCall: (params) => {
        if (!isCurrent()) return;
        this.handleFunctionCall(params, generation);
      },
      cancelToolCallsByIds: (ids) => {
        if (!isCurrent()) return;
        for (const id of ids) {
          const active = this.activeToolCalls.get(id);
          if (active) {
            this.cancelToolCall(active);
          }
        }
      },
      interrupt: () => {
        if (!isCurrent()) return;
        this.interrupt();
      },
      useLocalPlaybackRate: () => {
        if (!isCurrent()) return;
        this.serverSpeedUnsupported = true;
        this.audioPlayer.setPlaybackRate(this.outputSpeed);
      },
      fail: (error, code) => {
        if (!isCurrent()) return;
        this.fail(error, code);
      },
      failOrReconnectOnServerError: (message, code) => {
        if (!isCurrent()) return;
        this.clearHandshakeTimer();
        this.lastSocketError = message;
        if (this.sessionId && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.handleConnectionDrop(1006, message, new Error(message), generation);
        } else {
          this.fail(new Error(message), code);
        }
      }
    };
  }

  protected handleConnectionDrop(
    code: number,
    reason: string,
    error: Error | null,
    generation: number
  ): void {
    if (this.disposed || this.socketGeneration !== generation) {
      return;
    }
    this.clearHandshakeTimer();
    const wasConnected = this.state === "connected";
    const errorText = error?.message || this.lastSocketError || "";
    this.lastSocketError = "";

    if (code === 1000) {
      this.state = "closed";
      this.sessionId = null;
      this.reconnectAttempts = 0;
      this.cancelAllToolCalls();
      this.stopAndResetAllPlayback();
      this.closeSocket();
      this.emit({ type: "closed", code, reason });
      return;
    }

    if (this.sessionId && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts += 1;
      const attempt = this.reconnectAttempts;
      const maxAttempts = this.maxReconnectAttempts;
      this.cancelAllToolCalls();
      this.stopAllPlayback();
      this.closeSocket();
      this.state = "connecting";
      this.emit({
        type: "reconnecting",
        attempt,
        maxAttempts,
        code,
        reason,
        error: errorText || undefined
      });
      if (this.reconnectDelayMs > 0) {
        this.reconnectTimer = setTimeout(() => {
          if (this.disposed) return;
          this.connect();
        }, this.reconnectDelayMs);
      } else {
        this.connect();
      }
      return;
    }

    const exhausted = Boolean(
      this.sessionId && this.reconnectAttempts >= this.maxReconnectAttempts
    );
    this.reconnectAttempts = 0;
    this.cancelAllToolCalls();
    this.stopAndResetAllPlayback();
    this.closeSocket();

    const exhaustedMsg = `已达最大重连次数 (${this.maxReconnectAttempts} 次)`;
    const finalDetail = exhausted
      ? errorText
        ? `${errorText}，${exhaustedMsg}`
        : exhaustedMsg
      : errorText;

    if (wasConnected || exhausted) {
      this.state = "closed";
      this.emit({
        type: "closed",
        code,
        reason,
        error: finalDetail || undefined
      });
    } else {
      this.state = "failed";
      const failureMsg = errorText
        ? `WebSocket 连接失败：${errorText} (${code}: ${reason || "握手未完成"})`
        : `WebSocket 连接关闭 (${code}: ${reason || "握手未完成"})`;
      this.emit({
        type: "error",
        error: failureMsg,
        code,
        reason
      });
    }
  }

  protected cancelToolCall(call: ActiveRuntimeToolCall): void {
    if (this.activeToolCalls.get(call.callId) !== call) return;
    this.activeToolCalls.delete(call.callId);
    if (call.kind === "web_search") {
      call.controller.abort();
    } else {
      clearTimeout(call.timer);
    }
    this.syncSpeakingState();
    this.flushPendingVideoContextIfIdle();
  }

  protected cancelAllToolCalls(): void {
    for (const call of [...this.activeToolCalls.values()]) {
      this.cancelToolCall(call);
    }
  }

  protected cancelInterruptedToolCalls(runId: string, turnId: string): void {
    for (const call of [...this.activeToolCalls.values()]) {
      const hasNoTurnIdentity = call.kind === "page_tool" && !call.runId && !call.turnId;
      const matchesTurn =
        (!runId || call.runId === runId) && (!turnId || call.turnId === turnId);
      if (hasNoTurnIdentity || matchesTurn) {
        this.cancelToolCall(call);
      }
    }
  }

  protected withVideoIdentity(call: MossLiveToolCall): MossLiveToolCall {
    return {
      ...call,
      video: toolCallVideoIdentity(this.videoContext)
    };
  }

  protected startPageToolCall(
    rawCall: MossLiveToolCall,
    runId: string,
    turnId: string,
    generation: number
  ): void {
    const call = this.withVideoIdentity(rawCall);
    if (!this.hasPageToolHandler()) {
      this.adapter.sendToolResponse(
        { callId: call.callId, name: call.name },
        {
          ok: false,
          error: "当前客户端未接入页面工具执行器"
        },
        this.transport
      );
      return;
    }

    const existing = this.activeToolCalls.get(call.callId);
    if (existing) {
      this.cancelToolCall(existing);
    }

    const timeoutMs =
      call.name === "summarize_video" ? this.overviewToolTimeoutMs : this.pageToolTimeoutMs;

    const entry: ActiveRuntimeToolCall = {
      kind: "page_tool",
      callId: call.callId,
      name: call.name,
      runId,
      turnId,
      timer: setTimeout(() => {
        if (this.disposed || this.socketGeneration !== generation) return;
        if (this.activeToolCalls.get(call.callId) !== entry) return;
        this.activeToolCalls.delete(call.callId);
        this.syncSpeakingState();
        this.flushPendingVideoContextIfIdle();
        const error = "页面工具执行超时，请稍后重试";
        this.adapter.sendToolResponse(
          { callId: call.callId, name: call.name },
          { ok: false, error },
          this.transport
        );
        this.emit({ type: "tool_error", error });
      }, timeoutMs)
    };

    this.activeToolCalls.set(call.callId, entry);
    this.syncSpeakingState();
    this.emit({ type: "tool_call", call });
  }

  protected handleFunctionCall(
    params: {
      callId: string;
      name: string;
      arguments: unknown;
      query: string;
      runId: string;
      turnId: string;
    },
    generation: number
  ): void {
    const { callId, name, arguments: rawArgs, query, runId, turnId } = params;
    if (!callId || this.handledToolCallIds.has(callId)) return;
    this.handledToolCallIds.add(callId);

    if (name !== "web_search") {
      this.startPageToolCall({ callId, name, arguments: rawArgs }, runId, turnId, generation);
      return;
    }

    if (!query) {
      const error = "搜索关键词为空或工具参数无效";
      this.emit({
        type: "tool_status",
        event: { tool: "web_search", status: "failed", query, error }
      });
      this.adapter.sendWebSearchResponse?.(
        { callId, name },
        { ok: false, error, emptyQuery: true },
        this.transport
      );
      return;
    }

    const turnKey = this.getTurnKey(runId, turnId);
    const toolCallIndex = this.webSearchCallCounts.get(turnKey) ?? 0;
    this.webSearchCallCounts.set(turnKey, toolCallIndex + 1);
    const controller = new AbortController();
    const call: Extract<ActiveRuntimeToolCall, { kind: "web_search" }> = {
      kind: "web_search",
      callId,
      name,
      query,
      runId,
      turnId,
      toolCallIndex,
      controller
    };
    this.activeToolCalls.set(callId, call);
    this.syncSpeakingState();
    this.emit({
      type: "tool_status",
      event: { tool: "web_search", status: "searching", query }
    });
    void this.runWebSearch(call, generation);
  }

  protected async runWebSearch(
    call: Extract<ActiveRuntimeToolCall, { kind: "web_search" }>,
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
      this.adapter.sendWebSearchResponse?.(
        { callId: call.callId, name: call.name },
        { ok: true, output: outcome.output },
        this.transport
      );
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
      const reason = String(
        (error as { message?: unknown } | null)?.message || error || "未知错误"
      );
      this.adapter.sendWebSearchResponse?.(
        { callId: call.callId, name: call.name },
        { ok: false, error: reason },
        this.transport
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
        this.flushPendingVideoContextIfIdle();
      }
    }
  }

  protected closeSocket(): void {
    this.clearHandshakeTimer();
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

  protected fail(error: Error, code?: number | string): void {
    this.clearHandshakeTimer();
    this.clearReconnectTimer();
    this.state = "failed";
    this.socketGeneration += 1;
    this.cancelAllToolCalls();
    this.stopAndResetAllPlayback();
    this.closeSocket();
    this.emit({ type: "error", error: error.message, code });
  }

  close(): void {
    this.disposed = true;
    this.sessionId = null;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.socketGeneration += 1;
    this.clearHandshakeTimer();
    this.state = "idle";
    this.cancelAllToolCalls();
    this.stopAndResetAllPlayback();
    this.closeSocket();
  }

  setMicEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    const prev = this.micEnabled;
    this.micEnabled = next;
    this.adapter.onMicStateChanged(next, prev, this.state === "connected", this.transport);
  }

  updateVideoContext(context: MossLiveSessionContext | null): void {
    this.videoContext = context;
    this.adapter.onVideoContextUpdated?.(context);
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

  sendToolResult(callId: string, result: unknown): boolean {
    const active = this.activeToolCalls.get(callId);
    if (!active || active.kind !== "page_tool") {
      return false;
    }
    clearTimeout(active.timer);
    this.activeToolCalls.delete(callId);
    this.syncSpeakingState();
    this.flushPendingVideoContextIfIdle();
    return this.adapter.sendToolResponse(
      { callId, name: active.name },
      result,
      this.transport
    );
  }

  interrupt(): void {
    if (this.disposed || this.state !== "connected") return;
    this.cancelAllToolCalls();

    const activeTurnBeforeStop = this.activeTurnKey;
    const callbacks = this.createRuntimeCallbacks(this.socketGeneration);
    const adapterInterruptedTurn = this.adapter.onBeforeInterrupt?.(callbacks) ?? null;

    const interruptedTurns = this.audioPlayer.interruptActiveTurns();
    const emittedTurnKeys = new Set<string>();

    for (const turn of interruptedTurns) {
      const key = this.getTurnKey(turn.runId, turn.turnId);
      emittedTurnKeys.add(key);
      this.emit({
        type: "transcript",
        event: {
          kind: "response.interrupted",
          runId: turn.runId,
          turnId: turn.turnId
        }
      });
    }

    if (adapterInterruptedTurn) {
      const key = this.getTurnKey(adapterInterruptedTurn.runId, adapterInterruptedTurn.turnId);
      if (!emittedTurnKeys.has(key)) {
        emittedTurnKeys.add(key);
        this.emit({
          type: "transcript",
          event: {
            kind: "response.interrupted",
            runId: adapterInterruptedTurn.runId,
            turnId: adapterInterruptedTurn.turnId
          }
        });
      }
    }

    const fallbackTurnKey = this.activeTurnKey || activeTurnBeforeStop;
    if (fallbackTurnKey && !emittedTurnKeys.has(fallbackTurnKey)) {
      const [runId, turnId] = fallbackTurnKey.split(":");
      if (runId && turnId) {
        this.emit({
          type: "transcript",
          event: {
            kind: "response.interrupted",
            runId,
            turnId
          }
        });
      }
    }

    this.stopAllPlayback();
    this.syncSpeakingState();
    this.flushPendingVideoContextIfIdle();
  }

  sendJson(payload: unknown): boolean {
    if (this.disposed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  protected sendRawBinary(frame: Uint8Array<ArrayBuffer> | ArrayBufferLike): boolean {
    if (this.disposed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(frame as unknown as Parameters<WebSocket["send"]>[0]);
      return true;
    } catch {
      return false;
    }
  }
}
