import { getErrorMessage, isRetryableNetworkError, retryAsync } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";
import { ASR_CONCURRENCY } from "../shared/offscreen-constants.js";
import { ASR_MAX_PENDING_CHUNKS } from "./protocol.js";

export const DEFAULT_RETRIES = 2;
export const DEFAULT_RETRY_DELAY_MS = 500;

export interface AsrTranscribeSegment {
  start: number;
  end: number;
  text: string;
}

export interface AsrTranscribeWord {
  word: string;
  start: number;
  end: number;
}

export interface AsrTranscribeResult {
  text: string;
  segments?: AsrTranscribeSegment[];
  words?: AsrTranscribeWord[];
  _asrDiag?: unknown;
}

export interface TranscribeChunk {
  index: number;
  startSec: number;
  durationSec: number;
  overlapLeadSec?: number;
  wavBlob: Blob;
}

export type TranscribeFn = (
  chunk: TranscribeChunk,
  ctx: { onProgress: () => void }
) => Promise<AsrTranscribeResult>;

export interface TranscribeChunkOptions {
  chunk: TranscribeChunk;
  transcribe: TranscribeFn;
  onProgress?: (text: string) => void;
  retries?: number;
  retryDelayMs?: number;
}

export interface TranscriptionEngineOptions {
  transcribe: TranscribeFn;
  isAborted?: () => boolean;
  onChunkResult?: (chunk: TranscribeChunk, result: AsrTranscribeResult & { durationSec: number }) => void;
  onProgress?: (text: string) => void;
  concurrency?: number;
  maxPendingChunks?: number;
  retries?: number;
  retryDelayMs?: number;
}

export interface TranscriptionEngineFailure {
  chunk: TranscribeChunk;
  error: unknown;
}

export interface TranscriptionEngineSummary {
  acceptedChunks: number;
  completedChunks: number;
  failedChunks: number;
  droppedByAbort: number;
  failures: TranscriptionEngineFailure[];
  representativeFailure: TranscriptionEngineFailure | null;
  aborted: boolean;
}

export interface TranscriptionEngine {
  push(chunk: TranscribeChunk): boolean;
  close(): Promise<TranscriptionEngineSummary>;
}

export async function transcribeChunk({
  chunk,
  transcribe,
  onProgress,
  retries = DEFAULT_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS
}: TranscribeChunkOptions): Promise<AsrTranscribeResult & { durationSec: number }> {
  if (typeof transcribe !== "function") {
    throw new Error("transcribeChunk 需要注入 transcribe 函数");
  }
  const task = () =>
    transcribe(chunk, {
      onProgress: () => onProgress?.(`语音识别中 ${chunk.index + 1} 片…`)
    });
  const result = await retryAsync(task, retries, retryDelayMs);
  return { ...result, durationSec: chunk.durationSec };
}

export function createTranscriptionEngine({
  transcribe,
  isAborted,
  onChunkResult,
  onProgress,
  concurrency = ASR_CONCURRENCY,
  maxPendingChunks = ASR_MAX_PENDING_CHUNKS,
  retries = DEFAULT_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS
}: TranscriptionEngineOptions): TranscriptionEngine {
  if (typeof transcribe !== "function") {
    throw new Error("createTranscriptionEngine 需要注入 transcribe 函数");
  }
  const aborted: () => boolean = typeof isAborted === "function" ? isAborted : () => false;
  const limit = Number(concurrency) > 0 ? Math.floor(Number(concurrency)) : ASR_CONCURRENCY;
  const maxPending = Number(maxPendingChunks) > 0 ? Math.floor(Number(maxPendingChunks)) : Infinity;

  const queue: TranscribeChunk[] = [];
  const failures: TranscriptionEngineFailure[] = [];
  let inFlight = 0;
  let closed = false;
  let closePromise: Promise<TranscriptionEngineSummary> | null = null;
  let closeResolve: ((summary: TranscriptionEngineSummary) => void) | null = null;
  let acceptedChunks = 0;
  let completedChunks = 0;
  let failedChunks = 0;
  let droppedByAbort = 0;

  function buildSummary(): TranscriptionEngineSummary {
    return {
      acceptedChunks,
      completedChunks,
      failedChunks,
      droppedByAbort,
      failures,
      representativeFailure: pickRepresentativeFailure(),
      aborted: aborted()
    };
  }

  function pickRepresentativeFailure(): TranscriptionEngineFailure | null {
    if (failures.length === 0) {
      return null;
    }
    return failures.find((failure) => !isRetryableNetworkError(failure.error)) || failures[0];
  }

  function drain(): void {
    while (inFlight < limit && queue.length > 0) {
      if (aborted()) {
        droppedByAbort += queue.length;
        queue.length = 0;
        break;
      }
      const chunk = queue.shift()!;
      inFlight += 1;
      runChunk(chunk);
    }
  }

  function settleIfDone(): void {
    if (!closeResolve || inFlight > 0) {
      return;
    }
    const resolve = closeResolve;
    closeResolve = null;
    resolve(buildSummary());
  }

  async function runChunk(chunk: TranscribeChunk): Promise<void> {
    try {
      const result = await transcribeChunk({ chunk, transcribe, retries, retryDelayMs });
      completedChunks += 1;
      onProgress?.(`语音识别已完成 ${completedChunks} 片…`);
      deliver(chunk, result);
    } catch (error) {
      failedChunks += 1;
      failures.push({ chunk, error });
      logWarn("[BILISCRIPT] asr chunk transcription failed, skipping", {
        chunkIndex: chunk?.index,
        error: getErrorMessage(error)
      });
    } finally {
      inFlight -= 1;
      drain();
      settleIfDone();
    }
  }

  function deliver(chunk: TranscribeChunk, result: AsrTranscribeResult & { durationSec: number }): void {
    if (typeof onChunkResult !== "function") {
      return;
    }
    try {
      onChunkResult(chunk, result);
    } catch {
    }
  }

  function push(chunk: TranscribeChunk): boolean {
    if (closed || aborted()) {
      return false;
    }
    if (queue.length >= maxPending) {
      return false;
    }
    acceptedChunks += 1;
    queue.push(chunk);
    drain();
    return true;
  }

  function close(): Promise<TranscriptionEngineSummary> {
    if (closePromise) {
      return closePromise;
    }
    closed = true;
    closePromise = new Promise((resolve) => {
      closeResolve = resolve;
      drain();
      settleIfDone();
    });
    return closePromise;
  }

  return { push, close };
}
