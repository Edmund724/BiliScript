// extension/live/offscreen-moss-client.ts
// 运行在 Offscreen Document 中的 MOSS-LIVE WebSocket 会话客户端。
// 持有与 wss://api.mosi.cn/v1/realtime 的真实 WebSocket 连接，负责：
// 1. 会话握手（attach_session -> session_attached -> media.mode + session.update -> session.updated -> mic_state）
// 2. 上行 16kHz 单声道 PCM S16LE 音频（tagged-v1 0x00）与视频 JPEG（0x02）、静音控制
// 3. 委托 MossAudioPlayer 驱动下行 48kHz 单声道 PCM S16LE 无缝队列播放与回执
// 4. 双端增量/终态字幕事件与视频音量压低（duck_video）状态机
// 5. 页面工具与内置 web_search 统一生命周期（共用 activeToolCalls、超时/打断取消与 speaking_state）

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
  DEFAULT_MOSS_LIVE_WS_URL,
  MossBinaryTag,
  buildMinimalSessionUpdatePayload,
  decodeBase64Bytes,
  packTaggedBinary,
  parseMossServerJsonEvent,
  type MossLiveClientAction,
  type MossLiveServerEvent,
  type MossLiveToolCall,
  type MossLiveToolStatusEvent,
  type MossLiveTranscriptEvent,
  type MossLiveVideoContext
} from "./moss-live-protocol.js";

export type { AudioBufferLike, AudioBufferSourceNodeLike, AudioContextLike };

export type MossLiveClientState = "idle" | "connecting" | "connected" | "closed" | "failed";

export const DEFAULT_MOSS_HANDSHAKE_TIMEOUT_MS = 10000;
export const DEFAULT_MOSS_PAGE_TOOL_TIMEOUT_MS = 10000;
export const DEFAULT_MOSS_OVERVIEW_TOOL_TIMEOUT_MS = 120000;

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

export interface OffscreenMossClientOptions {
  wsUrl?: string;
  videoContext?: MossLiveVideoContext | null;
  handshakeTimeoutMs?: number;
  pageToolTimeoutMs?: number;
  overviewToolTimeoutMs?: number;
  executeWebSearch?: LiveWebSearchExecutor;
  createAudioContext?: () => AudioContextLike | null;
  onEvent?: (event: MossLiveServerEvent) => void;
  onConnecting?: () => void;
  onConnected?: () => void;
  onDuckVideo?: (active: boolean) => void;
  onTranscript?: (event: MossLiveTranscriptEvent) => void;
  onSpeakingState?: (speaking: boolean) => void;
  onToolCall?: (call: MossLiveToolCall) => void;
  onToolStatus?: (event: MossLiveToolStatusEvent) => void;
  onError?: (error: Error) => void;
  onClosed?: (event?: { code?: number; reason?: string }) => void;
}

type ActiveToolCall =
  | {
      kind: "web_search";
      callId: string;
      query: string;
      runId: string;
      turnId: string;
      toolCallIndex: number;
      controller: AbortController;
    }
  | {
      kind: "page_tool";
      callId: string;
      runId: string;
      turnId: string;
      timer: ReturnType<typeof setTimeout>;
    };

export class OffscreenMossLiveClient {
  private ws: WebSocket | null = null;
  private state: MossLiveClientState = "idle";
  private disposed = false;
  private socketGeneration = 0;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private micEnabled = true;
  private readonly audioPlayer: MossAudioPlayer;
  private readonly activeToolCalls = new Map<string, ActiveToolCall>();
  private readonly handledToolCallIds = new Set<string>();
  private readonly webSearchCallCounts = new Map<string, number>();
  private wsUrl: string;
  private readonly handshakeTimeoutMs: number;
  private readonly pageToolTimeoutMs: number;
  private readonly overviewToolTimeoutMs: number;
  private readonly executeWebSearch: LiveWebSearchExecutor;
  private readonly options: OffscreenMossClientOptions;
  private videoContext: MossLiveVideoContext | null;
  private lastSentContextKey = "";
  private videoDucked = false;
  private inputDucked = false;
  private activeTurnKey: string | null = null;
  private speaking = false;
  private mediaStreamsInitialized = false;
  private latestVideoJpeg: ArrayBufferLike | null = null;

  constructor(options: OffscreenMossClientOptions = {}) {
    this.options = options;
    this.wsUrl = options.wsUrl || DEFAULT_MOSS_LIVE_WS_URL;
    this.videoContext = options.videoContext || null;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_MOSS_HANDSHAKE_TIMEOUT_MS;
    this.pageToolTimeoutMs = options.pageToolTimeoutMs ?? DEFAULT_MOSS_PAGE_TOOL_TIMEOUT_MS;
    this.overviewToolTimeoutMs =
      options.overviewToolTimeoutMs ?? DEFAULT_MOSS_OVERVIEW_TOOL_TIMEOUT_MS;
    this.executeWebSearch = options.executeWebSearch ?? executeLiveWebSearch;
    this.audioPlayer = new MossAudioPlayer({
      createAudioContext: options.createAudioContext,
      onSendJson: (payload) => {
        this.sendJson(payload);
      },
      onTurnFinished: (runId, turnId) => {
        this.finishActiveTurn(runId, turnId);
      },
      onStateChange: () => {
        this.syncSpeakingState();
      }
    });
  }

  getState(): MossLiveClientState {
    return this.state;
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
      case "tool_call":
        this.options.onToolCall?.(event.call);
        break;
      case "tool_status":
        this.options.onToolStatus?.(event.event);
        break;
      case "error":
        this.options.onError?.(new Error(event.error));
        break;
      case "closed":
        this.options.onClosed?.({ code: closeCode, reason: event.reason });
        break;
    }
  }

  private hasPageToolHandler(): boolean {
    return Boolean(this.options.onEvent || this.options.onToolCall);
  }

  private setVideoDucked(active: boolean): void {
    if (this.videoDucked === active) return;
    this.videoDucked = active;
    this.emit({ type: "duck_video", active });
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private getTurnKey(runId: string, turnId: string): string {
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

  private activateTurn(runId: string, turnId: string): void {
    if (!this.audioPlayer.canActivateTurn(runId, turnId)) return;
    this.inputDucked = false;
    this.activeTurnKey = this.getTurnKey(runId, turnId);
    this.syncVideoDuck();
  }

  private finishActiveTurn(runId: string, turnId: string): void {
    if (this.activeTurnKey !== this.getTurnKey(runId, turnId)) return;
    this.activeTurnKey = null;
    this.syncVideoDuck();
  }

  private stopAllPlayback(): void {
    this.audioPlayer.stopAll();
    this.activeTurnKey = null;
    this.inputDucked = false;
    this.setVideoDucked(false);
    this.syncSpeakingState();
  }

  private stopAndResetAllPlayback(): void {
    this.audioPlayer.reset();
    this.activeTurnKey = null;
    this.inputDucked = false;
    this.webSearchCallCounts.clear();
    this.setVideoDucked(false);
    this.syncSpeakingState();
  }

  handleAction(msg: MossLiveClientAction): void {
    switch (msg.action) {
      case "start":
        if (msg.wsUrl !== undefined) {
          this.wsUrl = msg.wsUrl || DEFAULT_MOSS_LIVE_WS_URL;
        }
        if (msg.videoContext !== undefined) {
          this.videoContext = msg.videoContext || null;
        }
        if (msg.speed !== undefined) {
          this.audioPlayer.setPlaybackRate(msg.speed);
        }
        this.audioPlayer.setVolume(msg.volume ?? 1);
        this.connect();
        break;

      case "set_volume":
        this.audioPlayer.setVolume(msg.volume);
        break;

      case "set_speed":
        this.audioPlayer.setPlaybackRate(msg.speed);
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
        if (bytes.byteLength > 0) {
          this.sendAudioPcm(bytes.buffer);
        }
        break;
      }

      case "video": {
        if (!msg.jpegBase64) break;
        const bytes = decodeBase64Bytes(msg.jpegBase64);
        if (bytes.byteLength > 0) {
          this.sendVideoJpeg(bytes.buffer);
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
        this.close();
        this.emit({ type: "closed" });
        break;
    }
  }

  connect(): void {
    if (this.state === "connecting" || this.state === "connected") {
      this.close();
    }
    this.disposed = false;
    this.state = "connecting";
    this.mediaStreamsInitialized = false;
    this.latestVideoJpeg = null;
    this.handledToolCallIds.clear();
    this.socketGeneration += 1;
    const currentGeneration = this.socketGeneration;
    this.clearHandshakeTimer();

    this.emit({ type: "connecting" });

    if (this.handshakeTimeoutMs > 0) {
      this.handshakeTimer = setTimeout(() => {
        if (this.disposed || this.socketGeneration !== currentGeneration) {
          return;
        }
        if (this.state === "connecting") {
          this.fail(
            new Error("MOSS-LIVE 会话附着握手超时：未在规定时间内收到 session_attached")
          );
        }
      }, this.handshakeTimeoutMs);
    }

    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => {
        if (this.disposed || this.socketGeneration !== currentGeneration) return;
        this.sendJson({ action: "attach_session", memory_scope: "session" });
      };

      this.ws.onmessage = (event) => {
        if (this.disposed || this.socketGeneration !== currentGeneration) return;
        if (typeof event.data === "string") {
          let message: unknown;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          this.handleServerJson(message, currentGeneration);
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          this.handleServerBinaryAudio(event.data, currentGeneration);
          return;
        }
        if (ArrayBuffer.isView(event.data)) {
          const view = event.data;
          const slice = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
          this.handleServerBinaryAudio(slice, currentGeneration);
        }
      };

      this.ws.onerror = () => {
        if (this.disposed || this.socketGeneration !== currentGeneration) return;
        this.clearHandshakeTimer();
        this.fail(new Error("WebSocket 连接失败或握手鉴权被拒绝"));
      };

      this.ws.onclose = (event) => {
        if (this.disposed || this.socketGeneration !== currentGeneration || this.state === "failed") {
          return;
        }
        this.clearHandshakeTimer();
        if (this.state === "connecting") {
          this.fail(
            new Error(`WebSocket 连接关闭 (${event.code}: ${event.reason || "握手未完成"})`)
          );
        } else {
          this.state = "closed";
          this.cancelAllToolCalls();
          this.stopAndResetAllPlayback();
          this.emit({ type: "closed", reason: event.reason }, event.code);
        }
      };
    } catch (error) {
      this.clearHandshakeTimer();
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private cancelToolCall(call: ActiveToolCall): void {
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

  private cancelInterruptedToolCalls(runId: string, turnId: string): void {
    for (const call of [...this.activeToolCalls.values()]) {
      const hasNoTurnIdentity = call.kind === "page_tool" && !call.runId && !call.turnId;
      const matchesTurn =
        (!runId || call.runId === runId) && (!turnId || call.turnId === turnId);
      if (hasNoTurnIdentity || matchesTurn) {
        this.cancelToolCall(call);
      }
    }
  }

  private dispatchToolResultJson(_callId: string, _result: unknown): boolean {
    return true;
  }

  private withVideoIdentity(call: MossLiveToolCall): MossLiveToolCall {
    return {
      ...call,
      video: this.videoContext
        ? {
            bvid: this.videoContext.bvid,
            cid: this.videoContext.cid,
            pageIndex: this.videoContext.pageIndex
          }
        : null
    };
  }

  private startPageToolCall(
    rawCall: MossLiveToolCall,
    runId: string,
    turnId: string,
    generation: number
  ): void {
    const call = this.withVideoIdentity(rawCall);
    if (!this.hasPageToolHandler()) {
      this.dispatchToolResultJson(call.callId, {
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

    const entry: ActiveToolCall = {
      kind: "page_tool",
      callId: call.callId,
      runId,
      turnId,
      timer: setTimeout(() => {
        if (this.disposed || this.socketGeneration !== generation) return;
        if (this.activeToolCalls.get(call.callId) !== entry) return;
        this.activeToolCalls.delete(call.callId);
        this.syncSpeakingState();
        const error = "页面工具执行超时，请稍后重试";
        this.dispatchToolResultJson(call.callId, { ok: false, error });
        this.emit({ type: "tool_error", error });
      }, timeoutMs)
    };

    this.activeToolCalls.set(call.callId, entry);
    this.syncSpeakingState();
    this.emit({ type: "tool_call", call });
  }

  private handleFunctionCall(
    callId: string,
    name: string,
    argumentsText: string,
    runId: string,
    turnId: string,
    generation: number
  ): void {
    if (!callId || this.handledToolCallIds.has(callId)) return;
    this.handledToolCallIds.add(callId);

    if (name !== "web_search") {
      this.startPageToolCall(
        { callId, name, arguments: argumentsText },
        runId,
        turnId,
        generation
      );
      return;
    }

    let query = "";
    try {
      const args = JSON.parse(argumentsText) as { query?: unknown };
      query = typeof args.query === "string" ? args.query.trim() : "";
    } catch {}
    if (!query) {
      const error = "搜索关键词为空或工具参数无效";
      this.emit({
        type: "tool_status",
        event: { tool: "web_search", status: "failed", query, error }
      });
      return;
    }

    const turnKey = this.getTurnKey(runId, turnId);
    const toolCallIndex = this.webSearchCallCounts.get(turnKey) ?? 0;
    this.webSearchCallCounts.set(turnKey, toolCallIndex + 1);
    const controller = new AbortController();
    const call: ActiveToolCall = {
      kind: "web_search",
      callId,
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

  private async runWebSearch(
    call: Extract<ActiveToolCall, { kind: "web_search" }>,
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

  private handleServerJson(rawMessage: unknown, generation: number): void {
    if (this.disposed || this.socketGeneration !== generation) return;
    const parsed = parseMossServerJsonEvent(rawMessage);
    if (!parsed) return;
    const isCurrent = () => !this.disposed && this.socketGeneration === generation;

    switch (parsed.kind) {
      case "session_attached":
        this.clearHandshakeTimer();
        this.state = "connected";
        this.sendJson({ action: "media.mode", binary_protocol: "tagged-v1" });
        this.lastSentContextKey = JSON.stringify(this.videoContext);
        this.sendJson(buildMinimalSessionUpdatePayload(this.videoContext));
        this.emit({ type: "connected" });
        break;

      case "session.updated":
        if (parsed.error) {
          this.clearHandshakeTimer();
          this.fail(new Error(`MOSS-LIVE 会话配置失败：${parsed.error}`));
          return;
        }
        if (!this.mediaStreamsInitialized) {
          this.mediaStreamsInitialized = true;
          this.sendJson({ action: "video.state", source: "screen", enabled: true });
          this.sendJson({ action: "video.stream_focus", source: "screen" });
          this.sendJson({ action: "mic_state", enabled: this.micEnabled });
          if (this.latestVideoJpeg) {
            this.sendBinary(MossBinaryTag.ScreenJpeg, this.latestVideoJpeg);
          }
        }
        break;

      case "transcript": {
        const event = parsed.event;
        if (event.kind === "input.updated" || event.kind === "input.done") {
          this.inputDucked = true;
          this.syncVideoDuck();
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
        break;
      }

      case "audio.context": {
        const accepted = this.audioPlayer.enqueueAudioContext(
          parsed.chunkId,
          parsed.runId,
          parsed.turnId,
          isCurrent
        );
        if (accepted) {
          this.activateTurn(parsed.runId, parsed.turnId);
        }
        break;
      }

      case "audio.done": {
        this.audioPlayer.handleAudioDone(parsed.runId, parsed.turnId);
        break;
      }

      case "audio.stop": {
        this.audioPlayer.handleAudioStop(parsed.runId, parsed.turnId);
        break;
      }

      case "tool.call":
        this.startPageToolCall(parsed.call, "", "", generation);
        break;

      case "function_call.done":
        this.handleFunctionCall(
          parsed.callId,
          parsed.name,
          parsed.argumentsText,
          parsed.runId,
          parsed.turnId,
          generation
        );
        break;

      case "error":
        this.clearHandshakeTimer();
        this.fail(new Error(parsed.message));
        break;
    }
  }

  private handleServerBinaryAudio(pcmBuffer: ArrayBufferLike, generation: number): void {
    if (this.disposed || this.socketGeneration !== generation) return;
    const isCurrent = () => !this.disposed && this.socketGeneration === generation;
    this.audioPlayer.enqueueAudioFrame(pcmBuffer, isCurrent);
  }

  private fail(error: Error): void {
    this.clearHandshakeTimer();
    this.state = "failed";
    this.latestVideoJpeg = null;
    this.socketGeneration += 1;
    this.cancelAllToolCalls();
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
    this.latestVideoJpeg = null;
    this.cancelAllToolCalls();
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

  setMicEnabled(enabled: boolean): void {
    this.micEnabled = Boolean(enabled);
    if (this.state === "connected") {
      this.sendJson({ action: "mic_state", enabled: this.micEnabled });
    }
  }

  sendAudioPcm(pcmBuffer: ArrayBufferLike): boolean {
    if (!this.micEnabled || this.state !== "connected") {
      return false;
    }
    return this.sendBinary(MossBinaryTag.AudioPcm, pcmBuffer);
  }

  updateVideoContext(context: MossLiveVideoContext | null): void {
    this.videoContext = context;
    if (!context) {
      this.latestVideoJpeg = null;
    }
    if (this.state !== "connected") return;
    const contextKey = JSON.stringify(context);
    if (contextKey === this.lastSentContextKey) return;
    this.lastSentContextKey = contextKey;
    this.sendJson(buildMinimalSessionUpdatePayload(context));
  }

  sendToolResult(callId: string, result: unknown): boolean {
    const active = this.activeToolCalls.get(callId);
    if (!active || active.kind !== "page_tool") {
      return false;
    }
    clearTimeout(active.timer);
    this.activeToolCalls.delete(callId);
    this.syncSpeakingState();
    return this.dispatchToolResultJson(callId, result);
  }

  sendVideoJpeg(jpegBuffer: ArrayBufferLike): boolean {
    if (this.state !== "connected") {
      return false;
    }
    this.latestVideoJpeg = jpegBuffer;
    return this.sendBinary(MossBinaryTag.ScreenJpeg, jpegBuffer);
  }

  interrupt(): void {
    if (this.disposed || this.state !== "connected") return;
    this.cancelAllToolCalls();

    const interruptedTurns = this.audioPlayer.interruptActiveTurns();
    for (const turn of interruptedTurns) {
      this.emit({
        type: "transcript",
        event: {
          kind: "response.interrupted",
          runId: turn.runId,
          turnId: turn.turnId
        }
      });
    }

    if (this.activeTurnKey) {
      const [runId, turnId] = this.activeTurnKey.split(":");
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

  sendBinary(tag: MossBinaryTag, payload: ArrayBufferLike): boolean {
    if (this.disposed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      const frame = packTaggedBinary(tag, payload);
      this.ws.send(frame as unknown as Parameters<WebSocket["send"]>[0]);
      return true;
    } catch {
      return false;
    }
  }
}
