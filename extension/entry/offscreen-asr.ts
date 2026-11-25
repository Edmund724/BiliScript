import {
  MAX_AUDIO_BYTES,
  ASR_DECODE_TIMEOUT_MS,
  ASR_MAX_CUMULATIVE_DOWNLOAD_BYTES,
  ASR_DOWNLOAD_LIMIT_MESSAGE,
  ASR_MSG_PROGRESS,
  ASR_MSG_CHUNK_RESULT,
  ASR_MSG_DONE,
  ASR_MSG_ERROR,
  ASR_MSG_PROBE_RESULT,
  ASR_MSG_STREAM_READY,
  ASR_MSG_STREAM_ACK,
  ASR_STREAM_INIT_ACTION,
  ASR_STREAM_CHUNK_ACTION,
  ASR_STREAM_END_ACTION,
  ASR_STREAM_ERROR_ACTION,
  projectAsrFailureSummary
} from "../asr/protocol.js";
import type {
  AsrDecodeSourceMode,
  AsrTriggerMode,
  AsrProbeTask,
  AsrProbeResultMessage,
  AsrFailureSummary
} from "../asr/protocol.js";
import { buildChunkPlan, encodeWav } from "../asr/chunker.js";
import { classifyAsrFailure } from "../asr/failure-kind.js";
import type { AsrFailureProviderLike } from "../asr/failure-kind.js";
import { streamWavChunks } from "../asr/stream-chunker.js";
import { createTranscriptionEngine } from "../asr/engine.js";
import { transcribe as transcribeOpenAi } from "../asr/adapters/openai-transcriptions.js";
import {
  isFragmentedMp4,
  createAdtsExtractor,
  parseAudioSpecificConfig,
  parseTrexDefaultSampleSize
} from "../asr/adts.js";
import {
  checkHostPermissionFromOffscreen,
  HOST_INVALID_ORIGIN_HINT,
  HOST_PERMISSION_HINT
} from "../core/host-permissions.js";
import { ASR_CONCURRENCY } from "../shared/offscreen-constants.js";
import { base64ToBytes, concatBytes } from "../shared/bytes.js";
import { getErrorMessage, isRetryableNetworkError, withTimeout } from "../shared/error-helpers.js";
import { consumeRuntimeLastError, safePostMessage } from "../shared/messaging.js";
import { logWarn } from "../shared/logging.js";
import { resolveActiveAsrProviderId, type AsrProvider } from "../asr/asr-provider-store.js";
import type { GetAsrRuntimeConfigResponse } from "../shared/messaging-protocol.js";

const ASR_ABORT_SENTINEL = Object.freeze({ asrAborted: true });

function summarizeFailure(error: unknown, provider: AsrProvider | null): AsrFailureSummary {
  const err = error as { kind?: unknown; status?: unknown; detail?: unknown } | null;
  const kind = typeof err?.kind === "string" && err.kind
    ? err.kind
    : classifyAsrFailure({ source: "platform", body: getErrorMessage(error), provider });
  const summary: AsrFailureSummary = { kind };
  const status = Number(err?.status);
  if (Number.isFinite(status)) {
    summary.status = status;
  }
  if (typeof err?.detail === "string") {
    summary.detail = err.detail;
  }
  return summary;
}

const ASR_ADAPTERS = {
  "openai-transcriptions": { adapter: transcribeOpenAi, concurrency: ASR_CONCURRENCY }
};

export interface AsrRuntimeConfig {
  asrAutoFallback?: boolean;
  activeAsrProviderId?: string;
  providers?: AsrProvider[];
  activeKey?: string;
  asrLanguage?: string;
}

async function requestAsrRuntimeConfig(timeoutMs = 5000): Promise<AsrRuntimeConfig> {
  const response = (await withTimeout(
    chrome.runtime.sendMessage({ type: "get-asr-runtime-config" }),
    timeoutMs,
    new Error("get-asr-runtime-config timeout")
  )) as GetAsrRuntimeConfigResponse | null;
  if (!response?.ok) {
    throw new Error(response?.error || "get-asr-runtime-config failed");
  }
  return response;
}

export function makeAsrSkipError(cause: unknown, reason = ""): Error & { code: string; reason?: string } {
  const error = new Error(String((cause as Error | undefined)?.message || cause || "ASR 配置缺失"));
  (error as Error & { code: string }).code = "asr-skip";
  if (reason) {
    (error as Error & { code: string; reason: string }).reason = reason;
  }
  return error as Error & { code: string; reason?: string };
}

export function resolveAsrProvider(
  config: AsrRuntimeConfig,
  options: { manual?: boolean } = {}
): AsrProvider {
  if (!options.manual && config.asrAutoFallback === false) {
    throw makeAsrSkipError("ASR 自动回退未开启", "asr-disabled");
  }
  const providers = config.providers || [];
  const activeId = resolveActiveAsrProviderId(providers, config.activeAsrProviderId);
  const activeProvider = providers.find((p) => p.id === activeId);
  if (!activeProvider) {
    throw makeAsrSkipError("没有激活的语音识别平台", "no-asr-config");
  }
  const provider = { ...activeProvider, apiKey: String(config.activeKey || "") };
  provider.language = config.asrLanguage || "auto";
  return provider;
}

export interface AsrTask {
  sourceMode?: AsrDecodeSourceMode;
  trigger?: AsrTriggerMode;
  audioUrl?: string;
  backupUrls?: string[];
}

export interface AsrDecodePort extends chrome.runtime.Port {}

export interface CreateAsrDecodeHandlerDeps {
  onTaskTerminal: (port: chrome.runtime.Port) => void;
}

const ASR_PROBE_PROVIDER_ID = "__asr-probe__";

function buildSilentProbeWavBlob(): Blob {
  return encodeWav(new Float32Array(16000), 16000);
}

function resolveAsrPermissionFailure(
  permission: { granted: boolean; status: "granted" | "denied" | "invalid-origin" },
  provider: AsrProvider
): { message: string; kind: ReturnType<typeof classifyAsrFailure> } {
  if (permission.status === "invalid-origin") {
    return { message: HOST_INVALID_ORIGIN_HINT, kind: "no-asr-config" };
  }
  return {
    message: HOST_PERMISSION_HINT,
    kind: classifyAsrFailure({
      source: "platform",
      body: HOST_PERMISSION_HINT,
      provider: provider as AsrFailureProviderLike
    })
  };
}

export function createAsrProbeHandler({ onTaskTerminal }: CreateAsrDecodeHandlerDeps) {
  return async function handleAsrProbeTask(rawTask: unknown, port: AsrDecodePort): Promise<void> {
    const task = (rawTask || {}) as AsrProbeTask;
    const reply = (payload: Omit<AsrProbeResultMessage, "type">): void => {
      safePostMessage(port, { type: ASR_MSG_PROBE_RESULT, ...payload });
      onTaskTerminal(port);
    };
    try {
      const type = String(task.type || "").trim();
      const adapterEntry = ASR_ADAPTERS[type as keyof typeof ASR_ADAPTERS];
      if (!adapterEntry) {
        reply({ ok: false, error: "暂不支持的平台类型：" + type });
        return;
      }
      const baseUrl = String(task.baseUrl || "").trim();
      if (!baseUrl) {
        reply({ ok: false, error: "请填写 baseUrl" });
        return;
      }
      const model = String(task.model || "").trim();
      if (!model) {
        reply({ ok: false, error: "请填写模型名" });
        return;
      }
      const provider: AsrProvider = {
        id: ASR_PROBE_PROVIDER_ID,
        presetId: "probe",
        name: "probe",
        type,
        baseUrl,
        model,
        supportsTimestamps: true,
        enabled: true,
        apiKey: String(task.apiKey || "").trim(),
        language: String(task.language || "auto")
      };
      const probePermission = await checkHostPermissionFromOffscreen(provider.baseUrl);
      if (!probePermission.granted) {
        const failure = resolveAsrPermissionFailure(probePermission, provider);
        reply({ ok: false, error: failure.message, kind: failure.kind });
        return;
      }
      await adapterEntry.adapter({ wavBlob: buildSilentProbeWavBlob(), provider, signal: undefined });
      reply({ ok: true });
    } catch (error) {
      const err = error as { kind?: unknown; status?: unknown };
      const status = Number(err?.status);
      reply({
        ok: false,
        error: getErrorMessage(error),
        ...(typeof err?.kind === "string" && err.kind ? { kind: err.kind } : {}),
        ...(Number.isFinite(status) ? { status } : {})
      });
    }
  };
}

export function createAsrDecodeHandler({ onTaskTerminal }: CreateAsrDecodeHandlerDeps) {
  return async function handleAsrDecodeTask(rawTask: unknown, port: AsrDecodePort): Promise<void> {
    const task = rawTask as AsrTask;
    let aborted = false;
    const abortState: { fatal: boolean; failure: AsrFailureSummary | null } = {
      fatal: false,
      failure: null
    };
    let providerRef: AsrProvider | null = null;
    let skippedSegments = 0;
    port.onDisconnect.addListener(() => {
      consumeRuntimeLastError();
      aborted = true;
      onTaskTerminal(port);
    });
    try {
      const sourceMode: AsrDecodeSourceMode = task?.sourceMode === "stream" ? "stream" : "url";
      const manual = task?.trigger === "manual";
      const audioUrl = String(task?.audioUrl || "").trim();
      if (sourceMode === "url" && !audioUrl) {
        throw new Error("asr-decode 任务参数不完整");
      }

      let provider: AsrProvider;
      try {
        provider = resolveAsrProvider(await requestAsrRuntimeConfig(), { manual });
        providerRef = provider;
      } catch (error) {
        if ((error as { code?: string }).code === "asr-skip") {
          throw error;
        }
        logWarn("[BILISCRIPT] get-asr-runtime-config failed, skipping asr task", {
          error: getErrorMessage(error)
        });
        throw makeAsrSkipError(error);
      }

      const decodePermission = await checkHostPermissionFromOffscreen(provider.baseUrl);
      if (!decodePermission.granted) {
        const failure = resolveAsrPermissionFailure(decodePermission, provider);
        throw Object.assign(new Error(failure.message), { kind: failure.kind });
      }

      const adapterEntry = ASR_ADAPTERS[provider.type as keyof typeof ASR_ADAPTERS];
      if (!adapterEntry) {
        throw new Error("暂不支持的平台类型：" + provider.type);
      }
      const chunkSeconds = buildChunkPlan(provider.type).chunkSeconds;

      const engine = createTranscriptionEngine({
        transcribe: async (chunk, { onProgress }) => {
          try {
            return await adapterEntry.adapter({
              wavBlob: chunk.wavBlob,
              startSec: chunk.startSec,
              durationSec: chunk.durationSec,
              provider,
              signal: undefined,
              onProgress
            });
          } catch (error) {
            if (!aborted && !isRetryableNetworkError(error)) {
              abortState.fatal = true;
              abortState.failure = summarizeFailure(error, provider);
            }
            throw error;
          }
        },
        isAborted: () => aborted || abortState.fatal,
        concurrency: adapterEntry.concurrency,
        onChunkResult: (chunk, result) => {
          const { durationSec, ...adapterResult } = result;
          port.postMessage({
            type: ASR_MSG_CHUNK_RESULT,
            index: chunk.index,
            startSec: chunk.startSec,
            durationSec,
            overlapLeadSec: chunk.overlapLeadSec ?? 0,
            result: adapterResult
          });
        },
        onProgress: (text) => {
          safePostMessage(port, { type: ASR_MSG_PROGRESS, text });
        }
      });

      const source =
        sourceMode === "stream"
          ? streamPushedAudioSegments(port, () => aborted || abortState.fatal)
          : streamAudioSegments([audioUrl, ...(task?.backupUrls || [])], () => aborted);
      const first = await source.next();
      if (first.done) {
        return;
      }

      let totalChunks: number | undefined;
      const AudioCtor = (globalThis as typeof globalThis & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext || (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) {
        throw new Error("当前环境没有 AudioContext，无法解码");
      }
      const audioCtx = new AudioCtor();
      try {
        const stop = () => {
          if (aborted || abortState.fatal) throw ASR_ABORT_SENTINEL;
        };
        async function* segmentSource() {
          yield (first.value as StreamAudioYield).segment!;
          for await (const item of source) {
            if (aborted) return;
            yield item.segment!;
          }
        }
        const stream = await streamWavChunks(segmentSource(), {
          chunkSeconds,
          decodeSegment: (seg) => {
            stop();
            return resampleTo16kMono(audioCtx, seg as Uint8Array);
          },
          onChunk: (chunk) => {
            stop();
            return engine.push(chunk);
          },
          decodeRetries: 1,
          skipFailedSegments: true,
          isAbortError: (error) => error === ASR_ABORT_SENTINEL
        });
        totalChunks = stream.totalChunks;
        skippedSegments = stream.skippedSegments;
      } finally {
        audioCtx.close();
      }
      if (aborted) return;

      const summary = await engine.close();
      if (aborted) return;
      if (!(summary.acceptedChunks > 0)) {
        throw new Error("音频切片为空，无法转写");
      }
      const failedSummary = summary.representativeFailure
        ? summarizeFailure(summary.representativeFailure.error, provider)
        : null;
      port.postMessage({
        type: ASR_MSG_DONE,
        totalChunks: summary.acceptedChunks,
        skippedSegments,
        failedChunks: summary.failedChunks,
        ...projectAsrFailureSummary(failedSummary)
      });
      onTaskTerminal(port);
    } catch (e) {
      if (aborted) {
        return;
      }
      if (abortState.fatal) {
        safePostMessage(port, {
          type: ASR_MSG_DONE,
          totalChunks: 0,
          skippedSegments,
          failedChunks: 1,
          ...projectAsrFailureSummary(abortState.failure)
        });
        onTaskTerminal(port);
        return;
      }
      const payload: Record<string, unknown> = { type: ASR_MSG_ERROR, error: String((e as Error | undefined)?.message || e) };
      if ((e as { code?: string }).code) {
        payload.code = (e as { code: string }).code;
      }
      if ((e as { reason?: string }).reason) {
        payload.reason = (e as { reason: string }).reason;
      }
      if ((e as { code?: string }).code !== "asr-skip") {
        payload.kind = (e as { kind?: string }).kind
          || classifyAsrFailure({ source: "media", body: getErrorMessage(e), provider: providerRef });
      }
      safePostMessage(port, payload);
      onTaskTerminal(port);
    }
  };
}

interface StreamAudioYield {
  segment?: Uint8Array;
}

type PushedStreamQueueItem =
  | { kind: "init"; bytes: Uint8Array }
  | { kind: "chunk"; seq: number; bytes: Uint8Array }
  | { kind: "end" }
  | { kind: "error"; error: string; failureKind?: string };

const STREAM_MOOFS_PER_SEGMENT = 2;

export async function* streamPushedAudioSegments(
  port: AsrDecodePort,
  isAborted: () => boolean,
  { downloadCapBytes = ASR_MAX_CUMULATIVE_DOWNLOAD_BYTES }: { downloadCapBytes?: number } = {}
): AsyncGenerator<StreamAudioYield, void, unknown> {
  const queue: PushedStreamQueueItem[] = [];
  let notify: (() => void) | null = null;
  let closed = false;

  const wake = () => {
    const fn = notify;
    notify = null;
    fn?.();
  };

  const enqueue = (item: PushedStreamQueueItem) => {
    if (closed) return;
    queue.push(item);
    wake();
  };

  const onMessage = (rawMsg: unknown) => {
    const msg = rawMsg as {
      action?: unknown;
      dataBase64?: unknown;
      seq?: unknown;
      error?: unknown;
      kind?: unknown;
    } | null;
    if (!msg || typeof msg !== "object") return;
    if (msg.action === ASR_STREAM_INIT_ACTION) {
      try {
        enqueue({ kind: "init", bytes: base64ToBytes(String(msg.dataBase64 || "")) });
      } catch (err) {
        enqueue({ kind: "error", error: `音频初始化段解码失败：${getErrorMessage(err)}` });
      }
      return;
    }
    if (msg.action === ASR_STREAM_CHUNK_ACTION) {
      try {
        enqueue({
          kind: "chunk",
          seq: Number(msg.seq) || 0,
          bytes: base64ToBytes(String(msg.dataBase64 || ""))
        });
      } catch (err) {
        enqueue({ kind: "error", error: `音频分片解码失败：${getErrorMessage(err)}` });
      }
      return;
    }
    if (msg.action === ASR_STREAM_END_ACTION) {
      enqueue({ kind: "end" });
      return;
    }
    if (msg.action === ASR_STREAM_ERROR_ACTION) {
      enqueue({
        kind: "error",
        error: String(msg.error || "音频流采集失败"),
        ...(typeof msg.kind === "string" && msg.kind ? { failureKind: msg.kind } : {})
      });
    }
  };

  const onDisconnect = () => {
    closed = true;
    wake();
  };

  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
  safePostMessage(port, { type: ASR_MSG_STREAM_READY });

  let totalBytes = 0;
  let extractor: ReturnType<typeof createAdtsExtractor> | null = null;

  try {
    while (true) {
      if (isAborted() || closed) return;
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        continue;
      }
      const item = queue.shift()!;
      if (item.kind === "error") {
        const err = new Error(item.error);
        if (item.failureKind) {
          (err as Error & { kind?: string }).kind = item.failureKind;
        }
        throw err;
      }
      if (item.kind === "end") {
        if (!extractor) {
          throw new Error("音频解码失败：未收到有效的 fMP4 音轨数据");
        }
        for (const seg of extractor.flush()) {
          if (isAborted()) return;
          yield { segment: seg };
        }
        if (extractor.frameCount === 0) {
          throw new Error("音频解码失败：无法从 fMP4 提取音帧");
        }
        return;
      }

      if (item.bytes.length === 0) {
        if (item.kind === "chunk") {
          safePostMessage(port, { type: ASR_MSG_STREAM_ACK, seq: item.seq });
        }
        continue;
      }

      totalBytes += item.bytes.length;
      if (totalBytes > downloadCapBytes) {
        throw new Error(ASR_DOWNLOAD_LIMIT_MESSAGE);
      }

      if (item.kind === "init") {
        const asc = parseAudioSpecificConfig(item.bytes) || {};
        const defaultSampleSize = parseTrexDefaultSampleSize(item.bytes);
        extractor = createAdtsExtractor({
          ...asc,
          defaultSampleSize,
          moofsPerSegment: STREAM_MOOFS_PER_SEGMENT
        });
        for (const seg of extractor.push(item.bytes)) {
          if (isAborted()) return;
          yield { segment: seg };
        }
        continue;
      }

      if (!extractor) {
        const asc = parseAudioSpecificConfig(item.bytes) || {};
        const defaultSampleSize = parseTrexDefaultSampleSize(item.bytes);
        extractor = createAdtsExtractor({
          ...asc,
          defaultSampleSize,
          moofsPerSegment: STREAM_MOOFS_PER_SEGMENT
        });
      }
      for (const seg of extractor.push(item.bytes)) {
        if (isAborted()) return;
        yield { segment: seg };
      }
      safePostMessage(port, { type: ASR_MSG_STREAM_ACK, seq: item.seq });
    }
  } finally {
    closed = true;
    try {
      port.onMessage.removeListener(onMessage);
    } catch {
    }
    try {
      port.onDisconnect.removeListener(onDisconnect);
    } catch {
    }
  }
}

export async function* streamAudioSegments(
  urls: string[],
  isAborted: () => boolean,
  { downloadCapBytes = ASR_MAX_CUMULATIVE_DOWNLOAD_BYTES }: { downloadCapBytes?: number } = {}
): AsyncGenerator<StreamAudioYield, void, unknown> {
  const HEAD_PROBE_LIMIT = 1 << 22;
  let headDone = false;
  let totalBytes = 0;
  const overDownloadCap = (): boolean => totalBytes > downloadCapBytes;
  for (const url of urls) {
    if (isAborted()) return;
    if (!headDone) {
      await probeSize(url);
      headDone = true;
    }
    if (isAborted()) return;
    let response: Response;
    try {
      response = await fetch(url, { method: "GET" });
    } catch {
      continue;
    }
    if (!response.ok) {
      continue;
    }
    const body = response.body;
    if (!(body && typeof body.getReader === "function")) {
      const raw = new Uint8Array(await response.arrayBuffer());
      if (raw.length === 0) {
        continue;
      }
      totalBytes += raw.length;
      if (overDownloadCap()) {
        throw new Error(ASR_DOWNLOAD_LIMIT_MESSAGE);
      }
      if (isFragmentedMp4(raw)) {
        const extractor = createAdtsExtractor(parseAudioSpecificConfig(raw) || {});
        for (const seg of extractor.push(raw)) yield { segment: seg };
        for (const seg of extractor.flush()) yield { segment: seg };
        if (extractor.frameCount === 0) {
          throw new Error("音频解码失败：无法从 fMP4 提取音帧");
        }
      } else {
        throw new Error("音频解码失败：仅支持 fMP4 音轨");
      }
      return;
    }
    const reader = body.getReader();
    try {
      let extractor: ReturnType<typeof createAdtsExtractor> | null = null;
      let head: Uint8Array | null = null;
      let decided = false;
      let isFmp4 = false;
      const decide = () => {
        isFmp4 = isFragmentedMp4(head || new Uint8Array(0));
        decided = true;
        if (isFmp4) {
          extractor = createAdtsExtractor(parseAudioSpecificConfig(head || new Uint8Array(0)) || {});
        } else {
          throw new Error("音频解码失败：仅支持 fMP4 音轨");
        }
      };
      while (true) {
        if (isAborted()) {
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value && value.length > 0)) continue;
        totalBytes += value.length;
        if (overDownloadCap()) {
          throw new Error(ASR_DOWNLOAD_LIMIT_MESSAGE);
        }
        if (!decided) {
          head = head ? concatBytes(head, value) : value;
          if (head.length >= HEAD_PROBE_LIMIT) decide();
        }
        if (decided && isFmp4 && head) {
          const headBytes = head;
          head = null;
          for (const seg of extractor!.push(headBytes)) yield { segment: seg };
        } else if (decided && isFmp4) {
          for (const seg of extractor!.push(value)) yield { segment: seg };
        }
      }
      if (!decided) {
        if (!head) continue;
        decide();
      }
      if (head) {
        const headBytes = head;
        head = null;
        for (const seg of extractor!.push(headBytes)) yield { segment: seg };
      }
      for (const seg of extractor!.flush()) yield { segment: seg };
      if (extractor!.frameCount === 0) {
        throw new Error("音频解码失败：无法从 fMP4 提取音帧");
      }
      return;
    } finally {
      try {
        reader.cancel();
      } catch {
      }
    }
  }
  throw new Error("音频下载失败");
}

async function probeSize(url: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { method: "HEAD" });
  } catch {
    return;
  }
  if (!response.ok) {
    return;
  }
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > 0 && length > MAX_AUDIO_BYTES) {
    throw new Error("视频过长");
  }
}

async function resampleTo16kMono(audioCtx: AudioContext, audioBytes: Uint8Array): Promise<Float32Array> {
  const targetRate = 16000;
  const decoded = await withTimeout(
    audioCtx.decodeAudioData(bytesToArrayBuffer(audioBytes)),
    ASR_DECODE_TIMEOUT_MS,
    new Error("音频解码超时")
  );
  if (!decoded) {
    throw new Error("音频解码失败：无法解码音频数据");
  }
  const outLength = Math.max(1, Math.round(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, outLength, targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const mono = (await withTimeout(offline.startRendering(), ASR_DECODE_TIMEOUT_MS, new Error("音频解码超时"))).getChannelData(0);
  if (!(mono.length > 0)) {
    throw new Error("音频解码失败：解码结果为空采样");
  }
  return mono;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) {
    return (bytes as unknown as ArrayBuffer).slice(0);
  }
  if (ArrayBuffer.isView(bytes)) {
    return (bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  throw new Error("无法识别的音频数据格式");
}
