import { MossAudioPlayer, type AudioContextLike } from "./moss-audio-player.js";
import {
  DEFAULT_GEMINI_LIVE_WS_URL,
  buildVideoInstructions,
  decodeBase64Bytes,
  type MossLiveClientAction,
  type MossLiveServerEvent,
  type MossLiveTranscriptEvent,
  type MossLiveVideoContext
} from "./moss-live-protocol.js";

export type GeminiLiveClientState = "idle" | "connecting" | "connected" | "closed" | "failed";

export const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.8-live";
export const DEFAULT_GEMINI_HANDSHAKE_TIMEOUT_MS = 10000;

export interface GeminiLiveClientOptions {
  wsUrl?: string;
  model?: string;
  videoContext?: MossLiveVideoContext | null;
  handshakeTimeoutMs?: number;
  createAudioContext?: () => AudioContextLike | null;
  onEvent?: (event: MossLiveServerEvent) => void;
  onConnecting?: () => void;
  onConnected?: () => void;
  onDuckVideo?: (active: boolean) => void;
  onTranscript?: (event: MossLiveTranscriptEvent) => void;
  onSpeakingState?: (speaking: boolean) => void;
  onError?: (error: Error) => void;
  onClosed?: (event?: { code?: number; reason?: string }) => void;
}

interface GeminiTurn {
  runId: string;
  turnId: string;
  inputText: string;
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
  private lastSentContextKey = "";
  private readonly handshakeTimeoutMs: number;
  private readonly options: GeminiLiveClientOptions;
  private readonly audioPlayer: MossAudioPlayer;
  private runId = "";
  private turnCounter = 0;
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
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_GEMINI_HANDSHAKE_TIMEOUT_MS;
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
      }
    });
  }

  getState(): GeminiLiveClientState {
    return this.state;
  }

  isSpeaking(): boolean {
    return this.state === "connected" && (this.activeTurnKey !== null || this.audioPlayer.isPlaying());
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
        this.connect();
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
        break;
    }
  }

  connect(): void {
    if (this.state === "connecting" || this.state === "connected") this.close();
    this.disposed = false;
    this.state = "connecting";
    this.currentTurn = null;
    this.discardOutputUntilInput = false;
    this.turnCounter = 0;
    this.audioChunkCounter = 0;
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
    const content = asRecord(raw.serverContent);
    if (content && this.state === "connected") {
      this.handleServerContent(content, generation);
    }
  }

  private getOrCreateTurn(kind: "input" | "output"): GeminiTurn | null {
    if (!this.currentTurn && kind === "output" && this.discardOutputUntilInput) return null;
    if (kind === "input" && this.currentTurn?.hasOutput) {
      this.finishTurn("completed");
    }
    if (!this.currentTurn) {
      if (kind === "input") this.discardOutputUntilInput = false;
      this.currentTurn = {
        runId: this.runId,
        turnId: `turn-${++this.turnCounter}`,
        inputText: "",
        outputText: "",
        inputDone: false,
        outputDone: false,
        hasOutput: false
      };
    }
    return this.currentTurn;
  }

  private handleServerContent(content: Record<string, unknown>, generation: number): void {
    const input = asRecord(content.inputTranscription);
    if (input && typeof input.text === "string" && input.text) {
      const turn = this.getOrCreateTurn("input");
      if (turn) {
        turn.inputText += input.text;
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
      this.finishTurn("completed");
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

    if (!turn.inputDone && turn.inputText) {
      turn.inputDone = true;
      this.emitTranscript({ kind: "input.done", text: turn.inputText });
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
    this.syncVideoDuck();
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
    return this.sendJson({ realtimeInput: { mediaChunks: [{ mimeType, data }] } });
  }

  updateVideoContext(context: MossLiveVideoContext | null): void {
    this.videoContext = context;
    if (this.state !== "connected") return;
    const contextKey = JSON.stringify(context);
    if (contextKey === this.lastSentContextKey) return;
    this.lastSentContextKey = contextKey;
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
