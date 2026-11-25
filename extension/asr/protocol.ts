import type { AsrFailureKind } from "./failure-kind.js";

export interface AsrFailureSummary {
  kind: AsrFailureKind | (string & {});
  status?: number | string | null;
  detail?: string | number | null;
}

export interface AsrFailureFields {
  failedKind?: AsrFailureKind | (string & {});
  failedStatus?: number | string | null;
  failedDetail?: string | number | null;
}

export function readAsrFailureSummary(raw: unknown): AsrFailureSummary | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const source = raw as {
    failedKind?: unknown;
    failedStatus?: unknown;
    failedDetail?: unknown;
    kind?: unknown;
    status?: unknown;
    detail?: unknown;
  };
  const kind = source.failedKind !== undefined ? source.failedKind : source.kind;
  if (typeof kind !== "string" || kind === "") {
    return null;
  }
  const summary: AsrFailureSummary = { kind };
  const status = source.failedStatus !== undefined ? source.failedStatus : source.status;
  if (status !== undefined) {
    summary.status = status as number | string | null;
  }
  const detail = source.failedDetail !== undefined ? source.failedDetail : source.detail;
  if (detail !== undefined) {
    summary.detail = detail as string | number | null;
  }
  return summary;
}

export function projectAsrFailureSummary(summary: AsrFailureSummary | null | undefined): AsrFailureFields {
  if (!summary) {
    return {};
  }
  return {
    failedKind: summary.kind,
    ...(summary.status !== undefined ? { failedStatus: summary.status } : {}),
    ...(summary.detail !== undefined ? { failedDetail: summary.detail } : {})
  };
}

export interface AsrAttemptOutcome extends AsrFailureFields {
  totalChunks: number;
  failedChunks: number;
  elapsedMs: number;
}

export const ASR_DECODE_PORT_NAME = "asr-decode" as const;
export const ASR_DECODE_ACTION = "asr-decode" as const;

export const ASR_STREAM_INIT_ACTION = "asr-stream-init" as const;
export const ASR_STREAM_CHUNK_ACTION = "asr-stream-chunk" as const;
export const ASR_STREAM_END_ACTION = "asr-stream-end" as const;
export const ASR_STREAM_ERROR_ACTION = "asr-stream-error" as const;

export type AsrDecodeSourceMode = "url" | "stream";
export type AsrTriggerMode = "auto" | "manual";

export const ASR_TASK_PREPARE = "asr-decode-prepare" as const;
export const ASR_TASK_CLEANUP = "asr-decode-cleanup" as const;

export type AsrTaskType = typeof ASR_TASK_PREPARE | typeof ASR_TASK_CLEANUP;

export const ASR_MSG_PROGRESS = "progress" as const;
export const ASR_MSG_CHUNK_RESULT = "chunk-result" as const;
export const ASR_MSG_DONE = "done" as const;
export const ASR_MSG_ERROR = "error" as const;
export const ASR_MSG_STREAM_READY = "stream-ready" as const;
export const ASR_MSG_STREAM_ACK = "stream-ack" as const;

export type AsrPortMessageType =
  | typeof ASR_MSG_PROGRESS
  | typeof ASR_MSG_CHUNK_RESULT
  | typeof ASR_MSG_DONE
  | typeof ASR_MSG_ERROR
  | typeof ASR_MSG_STREAM_READY
  | typeof ASR_MSG_STREAM_ACK;

export type AsrProgressMessage = { type: typeof ASR_MSG_PROGRESS; text: string };
export type AsrStreamReadyMessage = { type: typeof ASR_MSG_STREAM_READY };
export type AsrStreamAckMessage = { type: typeof ASR_MSG_STREAM_ACK; seq: number };
export type AsrChunkResultMessage = {
  type: typeof ASR_MSG_CHUNK_RESULT;
  index: number;
  startSec: number;
  durationSec: number;
  overlapLeadSec?: number;
  result: unknown;
};
export interface AsrDoneMessage extends AsrFailureFields {
  type: typeof ASR_MSG_DONE;
  totalChunks: number;
  skippedSegments: number;
  failedChunks: number;
}
export type AsrErrorMessage = {
  type: typeof ASR_MSG_ERROR;
  error: string;
  code?: string;
  reason?: string;
  kind?: string;
};

export type AsrPortMessage =
  | AsrProgressMessage
  | AsrStreamReadyMessage
  | AsrStreamAckMessage
  | AsrChunkResultMessage
  | AsrDoneMessage
  | AsrErrorMessage;

export const ASR_PROBE_ACTION = "asr-probe" as const;

export const ASR_MSG_PROBE_RESULT = "probe-result" as const;

export type AsrProbeTask = {
  type?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  language?: string;
};

export type AsrProbeResultMessage = {
  type: typeof ASR_MSG_PROBE_RESULT;
  ok: boolean;
  error?: string;
  kind?: string;
  status?: number;
};

export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
export const ASR_DECODE_TIMEOUT_MS = 10 * 60 * 1000;

export const ASR_PROBE_TIMEOUT_MS = 30 * 1000;

export const ASR_MAX_CUMULATIVE_DOWNLOAD_BYTES = MAX_AUDIO_BYTES;

export const ASR_DOWNLOAD_LIMIT_MESSAGE = "音频下载量超出上限（>200MB），已停止下载" as const;

export const ASR_MAX_PENDING_CHUNKS = 100;

export const ASR_PENDING_CHUNKS_LIMIT_MESSAGE =
  "待处理转写分片超出内存上限，已停止新增转写任务，请稍后重试或缩短视频" as const;

export const ASR_OFFSCREEN_REJECTION_MESSAGE = "仅接受 offscreen 文档发送" as const;
