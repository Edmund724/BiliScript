import { consumeRuntimeLastError, sendRuntimeMessage, sendOffloadMessage } from "../shared/messaging.js";
import { bytesToBase64 } from "../shared/bytes.js";
import { getErrorMessage, withTimeout } from "../shared/error-helpers.js";
import {
  ASR_DECODE_PORT_NAME,
  ASR_DECODE_ACTION,
  ASR_STREAM_INIT_ACTION,
  ASR_STREAM_CHUNK_ACTION,
  ASR_STREAM_END_ACTION,
  ASR_STREAM_ERROR_ACTION,
  ASR_MSG_PROGRESS,
  ASR_MSG_CHUNK_RESULT,
  ASR_MSG_DONE,
  ASR_MSG_ERROR,
  ASR_MSG_STREAM_READY,
  ASR_MSG_STREAM_ACK,
  ASR_TASK_PREPARE,
  ASR_TASK_CLEANUP,
  ASR_PROBE_ACTION,
  ASR_MSG_PROBE_RESULT,
  ASR_PROBE_TIMEOUT_MS,
  readAsrFailureSummary,
  projectAsrFailureSummary
} from "./protocol.js";
import type { OffloadTaskResponse } from "../shared/messaging-protocol.js";
import type {
  AsrTriggerMode,
  AsrProgressMessage,
  AsrStreamReadyMessage,
  AsrStreamAckMessage,
  AsrChunkResultMessage,
  AsrDoneMessage,
  AsrErrorMessage,
  AsrProbeResultMessage,
  AsrFailureFields
} from "./protocol.js";

export type PushedAudioSegment =
  | { kind: "init"; bytes: Uint8Array }
  | { kind: "chunk"; bytes: Uint8Array };

export type AudioStreamSource = (ctx: {
  signal: AbortSignal;
}) => AsyncIterable<PushedAudioSegment>;

export interface AsrChunkResult {
  text?: unknown;
  segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }>;
  words?: Array<{ word?: unknown; start?: unknown; end?: unknown }>;
  _asrDiag?: unknown;
  durationSec?: unknown;
}

export interface AsrChunkRecord {
  index: number;
  startSec: number;
  durationSec: number;
  overlapLeadSec?: number;
  result: AsrChunkResult | null;
}

export interface OffscreenChunkHostArgs {
  audioUrl?: string | undefined;
  backupUrls?: string[];
  streamSource?: AudioStreamSource;
  trigger?: AsrTriggerMode;
  onProgress?: (message: string) => void;
  onChunkResult?: (record: AsrChunkRecord) => void;
  signal?: AbortSignal | null;
}

export interface OffscreenChunkHostResult extends AsrFailureFields {
  results: AsrChunkRecord[];
  totalChunks: number;
  skippedSegments: number;
  failedChunks: number;
}

export type OffscreenChunkHost = (args: OffscreenChunkHostArgs) => Promise<OffscreenChunkHostResult>;

export interface OffscreenChunkHostDeps {
  prepare?: () => Promise<OffloadTaskResponse>;
  prepareStream?: () => Promise<OffloadTaskResponse>;
  cleanup?: (ruleId: number) => Promise<OffloadTaskResponse>;
}

type AsrPortMessageLike =
  | AsrProgressMessage
  | AsrStreamReadyMessage
  | AsrStreamAckMessage
  | AsrChunkResultMessage
  | AsrDoneMessage
  | AsrErrorMessage;

const MAX_STREAM_INFLIGHT_CHUNKS = 4;

export function createOffscreenChunkHost(deps: OffscreenChunkHostDeps = {}): OffscreenChunkHost {
  const prepare = deps.prepare || (() => sendOffloadMessage({ type: "offload-task", taskType: ASR_TASK_PREPARE }));
  const prepareStream =
    deps.prepareStream ||
    (async (): Promise<OffloadTaskResponse> => {
      const resp = await sendRuntimeMessage({ type: "ensure-offscreen-chat" });
      if (resp?.ok === false) {
        return { ok: false, error: resp.error || "音频解码服务启动失败" };
      }
      return { ok: true, ruleId: 0 };
    });
  const cleanupTask = deps.cleanup || ((ruleId) => sendOffloadMessage({ type: "offload-task", taskType: ASR_TASK_CLEANUP, ruleId }));
  return async function offscreenChunkHost({
    audioUrl,
    backupUrls,
    streamSource,
    trigger,
    onProgress,
    onChunkResult,
    signal
  }: OffscreenChunkHostArgs): Promise<OffscreenChunkHostResult> {
    if (signal?.aborted) {
      throw new Error("ASR 任务已中止");
    }
    const isStreamMode = typeof streamSource === "function";
    const prepared = isStreamMode ? await prepareStream() : await prepare();
    if (!prepared?.ok) {
      throw new Error(prepared?.error || "音频解码服务启动失败");
    }
    const sessionRuleId = isStreamMode ? 0 : Number(prepared.ruleId) || 0;

    return new Promise((resolve, reject) => {
      const results: AsrChunkRecord[] = [];
      let done = false;
      let totalChunks = 0;
      let skippedSegments = 0;
      let failedChunks = 0;
      const streamAbortController = isStreamMode ? new AbortController() : null;
      let sentSeq = 0;
      let ackedSeq = 0;
      let ackWaiter: (() => void) | null = null;
      let streamStarted = false;

      const wakeAck = (): void => {
        const fn = ackWaiter;
        ackWaiter = null;
        fn?.();
      };

      const cleanup = (): void => {
        if (sessionRuleId > 0) {
          cleanupTask(sessionRuleId).catch(() => {});
        }
      };
      const finish = <V>(callback: (value: V) => void, value: V): void => {
        if (done) return;
        done = true;
        streamAbortController?.abort();
        wakeAck();
        try {
          port.disconnect();
        } catch {
        }
        cleanup();
        callback(value);
      };

      if (signal) {
        signal.addEventListener("abort", () => {
          finish(reject, new Error("ASR 任务已中止"));
        }, { once: true });
      }

      const startStreamProducer = (): void => {
        if (!isStreamMode || streamStarted || done) return;
        streamStarted = true;
        void (async () => {
          try {
            const iterable = streamSource!({ signal: streamAbortController!.signal });
            for await (const seg of iterable) {
              if (done || streamAbortController!.signal.aborted) {
                return;
              }
              if (seg.kind === "init") {
                port.postMessage({
                  action: ASR_STREAM_INIT_ACTION,
                  dataBase64: bytesToBase64(seg.bytes)
                });
                continue;
              }
              while (!done && sentSeq - ackedSeq >= MAX_STREAM_INFLIGHT_CHUNKS) {
                await new Promise<void>((r) => {
                  ackWaiter = r;
                });
              }
              if (done || streamAbortController!.signal.aborted) {
                return;
              }
              sentSeq += 1;
              port.postMessage({
                action: ASR_STREAM_CHUNK_ACTION,
                seq: sentSeq,
                dataBase64: bytesToBase64(seg.bytes)
              });
            }
            if (!done && !streamAbortController!.signal.aborted) {
              port.postMessage({ action: ASR_STREAM_END_ACTION });
            }
          } catch (error) {
            if (done || streamAbortController!.signal.aborted) {
              return;
            }
            const errKind = typeof (error as { kind?: unknown })?.kind === "string"
              ? (error as { kind: string }).kind
              : undefined;
            try {
              port.postMessage({
                action: ASR_STREAM_ERROR_ACTION,
                error: getErrorMessage(error),
                ...(errKind ? { kind: errKind } : {})
              });
            } catch {
              finish(reject, error instanceof Error ? error : new Error(getErrorMessage(error)));
            }
          }
        })();
      };

      const port = chrome.runtime.connect({ name: ASR_DECODE_PORT_NAME });
      port.onMessage.addListener((rawMsg: unknown) => {
        const msg = rawMsg as AsrPortMessageLike | null;
        if (!msg || typeof msg !== "object" || done) return;
        if (msg.type === ASR_MSG_STREAM_READY) {
          startStreamProducer();
          return;
        }
        if (msg.type === ASR_MSG_STREAM_ACK) {
          const seq = Number(msg.seq) || 0;
          if (seq > ackedSeq) {
            ackedSeq = seq;
          }
          wakeAck();
          return;
        }
        if (msg.type === ASR_MSG_PROGRESS) {
          try {
            onProgress?.(String(msg.text || ""));
          } catch {
          }
          return;
        }
        if (msg.type === ASR_MSG_CHUNK_RESULT) {
          const hasOverlap =
            msg.overlapLeadSec !== undefined && Number.isFinite(Number(msg.overlapLeadSec));
          const record: AsrChunkRecord = {
            index: Number(msg.index) || 0,
            startSec: Number(msg.startSec) || 0,
            durationSec: Number(msg.durationSec) || 0,
            ...(hasOverlap ? { overlapLeadSec: Math.max(0, Number(msg.overlapLeadSec)) } : {}),
            result: msg.result as AsrChunkResult | null
          };
          results.push(record);
          try {
            onChunkResult?.(record);
          } catch {
          }
          return;
        }
        if (msg.type === ASR_MSG_DONE) {
          totalChunks = Number(msg.totalChunks) || results.length;
          skippedSegments = Number(msg.skippedSegments) || 0;
          failedChunks = Number(msg.failedChunks) || 0;
          results.sort((a, b) => a.index - b.index);
          finish(resolve, {
            results,
            totalChunks,
            skippedSegments,
            failedChunks,
            ...projectAsrFailureSummary(readAsrFailureSummary(msg))
          });
          return;
        }
        if (msg.type === ASR_MSG_ERROR) {
          const error: Error & { code?: string; reason?: string; kind?: string } = new Error(msg.error || "音频转写失败");
          if (msg.code) {
            error.code = msg.code;
          }
          if (msg.reason) {
            error.reason = msg.reason;
          }
          if (msg.kind) {
            error.kind = msg.kind;
          }
          finish(reject, error);
        }
      });
      port.onDisconnect.addListener(() => {
        consumeRuntimeLastError();
        if (!done) {
          finish(reject, new Error("音频解码中断：后台连接已断开"));
        }
      });

      if (isStreamMode) {
        port.postMessage({
          action: ASR_DECODE_ACTION,
          task: {
            sourceMode: "stream",
            ...(trigger ? { trigger } : {})
          }
        });
      } else {
        port.postMessage({
          action: ASR_DECODE_ACTION,
          task: {
            audioUrl: String(audioUrl || "").trim(),
            backupUrls: Array.isArray(backupUrls) ? backupUrls : [],
            ...(trigger ? { trigger } : {})
          }
        });
      }
    });
  };
}

export interface AsrProbeInput {
  type: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  language?: string;
}

const PROBE_DISCONNECTED_MESSAGE = "探针通道已断开（转写服务未就绪或已回收），请重试";
const PROBE_TIMEOUT_MESSAGE = `探针超时（${ASR_PROBE_TIMEOUT_MS / 1000} 秒无响应），请重试`;

export async function probeAsrProviderViaOffscreen(
  input: AsrProbeInput
): Promise<{ ok: boolean; error?: string }> {
  try {
    const ensured = await sendRuntimeMessage({ type: "ensure-offscreen-chat" });
    if (ensured?.ok === false) {
      return { ok: false, error: ensured.error || "转写服务启动失败" };
    }
  } catch {
  }
  const port = chrome.runtime.connect({ name: ASR_DECODE_PORT_NAME });
  try {
    return await withTimeout(
      waitProbeResult(port, input),
      ASR_PROBE_TIMEOUT_MS,
      new Error(PROBE_TIMEOUT_MESSAGE)
    );
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  } finally {
    try {
      port.disconnect();
    } catch {
    }
  }
}

function waitProbeResult(
  port: chrome.runtime.Port,
  input: AsrProbeInput
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    port.onMessage.addListener((rawMsg) => {
      if (settled) return;
      const msg = rawMsg as AsrProbeResultMessage | null;
      if (!msg || msg.type !== ASR_MSG_PROBE_RESULT) return;
      settled = true;
      resolve(msg.ok ? { ok: true } : { ok: false, error: msg.error || "转写请求失败" });
    });
    port.onDisconnect.addListener(() => {
      consumeRuntimeLastError();
      if (settled) return;
      settled = true;
      reject(new Error(PROBE_DISCONNECTED_MESSAGE));
    });
    port.postMessage({ action: ASR_PROBE_ACTION, task: { ...input } });
  });
}
