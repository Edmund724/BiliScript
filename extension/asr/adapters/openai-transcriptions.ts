import type { AsrProvider } from "../asr-provider-store.js";
import { classifyAsrFailure } from "../failure-kind.js";
import type { AsrFailureProviderLike } from "../failure-kind.js";
import { logWarn } from "../../shared/logging.js";
import { getErrorMessage } from "../../shared/error-helpers.js";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptionResult {
  text: string;
  segments?: TranscriptSegment[];
  words?: TranscriptWord[];
  [key: string]: unknown;
}

export interface TranscribeArgs {
  wavBlob: Blob;
  startSec?: number;
  durationSec?: number;
  provider: AsrProvider;
  signal?: AbortSignal | null;
  onProgress?: (text: string) => void;
}

interface PostTranscriptionResult {
  status: number;
  detail: string;
  raw: string;
  text: string;
  segments?: TranscriptSegment[];
  words?: TranscriptWord[];
}

type AsrTranscriptionError = Error & { status?: number; detail?: string; kind?: string };

function makeTranscriptionError(
  message: string,
  { status, detail, kind }: { status?: number; detail: string; kind: string }
): AsrTranscriptionError {
  const error = new Error(message) as AsrTranscriptionError;
  if (status !== undefined) {
    error.status = status;
  }
  error.detail = detail;
  error.kind = kind;
  return error;
}

function classifyPlatformFailure(
  provider: AsrProvider,
  status: number | null | undefined,
  body: string
): string {
  return classifyAsrFailure({
    source: "platform",
    status,
    body,
    provider: provider as AsrFailureProviderLike
  });
}

function logPlatformFailure(status: number, raw: string): void {
  logWarn("[BILISCRIPT] asr platform rejected transcription request", { status, body: raw });
}

export function buildTranscriptionUrl(baseUrl: string, language?: string): string {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  const lang = String(language || "").trim().toLowerCase();
  if (lang !== "zh" && lang !== "en") {
    return `${normalized}/audio/transcriptions`;
  }
  return `${normalized}/audio/transcriptions?language=${lang === "zh" ? "zh" : "english"}`;
}

function buildTranscriptionForm(wavBlob: Blob, provider: AsrProvider, responseFormat: string): FormData {
  const form = new FormData();
  form.append("file", wavBlob, "chunk.wav");
  form.append("model", provider?.model || "");
  form.append("response_format", responseFormat || "verbose_json");
  return form;
}

function normalizeSegments(segments: unknown): TranscriptSegment[] | undefined {
  if (!Array.isArray(segments) || segments.length === 0) {
    return undefined;
  }
  const list = segments as Array<{ start?: unknown; end?: unknown; text?: unknown }>;
  const normalized: TranscriptSegment[] = [];
  for (const seg of list) {
    const start = Number(seg?.start);
    const end = Number(seg?.end);
    const text = String(seg?.text || "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) {
      continue;
    }
    normalized.push({ start, end, text });
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeWords(words: unknown): TranscriptWord[] | undefined {
  if (!Array.isArray(words) || words.length === 0) {
    return undefined;
  }
  const list = words as Array<{ word?: unknown; start?: unknown; end?: unknown }>;
  const normalized: TranscriptWord[] = [];
  for (const item of list) {
    const start = Number(item?.start);
    const end = Number(item?.end);
    const word = String(item?.word ?? "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || !word) {
      continue;
    }
    normalized.push({ word, start, end });
  }
  return normalized.length > 0 ? normalized : undefined;
}

async function postTranscription({ wavBlob, provider, signal, responseFormat }: {
  wavBlob: Blob;
  provider: AsrProvider;
  signal?: AbortSignal | null;
  responseFormat: string;
}): Promise<PostTranscriptionResult> {
  const baseUrl = String(provider?.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw makeTranscriptionError("平台 baseUrl 未配置", {
      detail: "平台 baseUrl 未配置",
      kind: classifyPlatformFailure(provider, undefined, "平台 baseUrl 未配置")
    });
  }
  const form = buildTranscriptionForm(wavBlob, provider, responseFormat);
  const headers: Record<string, string> = {};
  const apiKey = String(provider?.apiKey || "").trim();
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(buildTranscriptionUrl(baseUrl, provider?.language), {
      method: "POST",
      headers,
      body: form,
      signal
    });
  } catch (error) {
    if (signal?.aborted) {
      const abortError = new Error("已停止生成");
      abortError.name = "AbortError";
      throw abortError;
    }
    (error as AsrTranscriptionError).kind = classifyPlatformFailure(
      provider,
      undefined,
      getErrorMessage(error)
    );
    throw error;
  }

  if (!response.ok) {
    let raw = "";
    try {
      raw = await response.text();
    } catch {
    }
    const detail = raw.slice(0, 200);
    logPlatformFailure(response.status, raw);
    return { status: response.status, detail, raw, text: "", segments: undefined };
  }

  try {
    const data: { text?: unknown; segments?: unknown; words?: unknown } = await response.json();
    return {
      status: 0,
      detail: "",
      raw: "",
      text: String(data?.text || "").trim(),
      segments: normalizeSegments(data?.segments),
      words: normalizeWords(data?.words)
    };
  } catch {
    return { status: -1, detail: "响应体不是合法 JSON", raw: "", text: "", segments: undefined };
  }
}

export async function transcribe({ wavBlob, startSec, durationSec, provider, signal, onProgress }: TranscribeArgs): Promise<TranscriptionResult> {
  const notifyProgress = onProgress as (() => void) | undefined;
  const first = await postTranscription({ wavBlob, provider, signal, responseFormat: "verbose_json" });
  if (first.status === 0) {
    notifyProgress?.();
    return {
      text: first.text,
      ...(first.segments ? { segments: first.segments } : {}),
      ...(first.words ? { words: first.words } : {})
    };
  }

  if (first.status > 0 && first.status !== 400 && first.status !== 422) {
    throw makeTranscriptionError(`HTTP ${first.status}${first.detail ? `: ${first.detail}` : ""}`, {
      status: first.status,
      detail: first.detail,
      kind: classifyPlatformFailure(provider, first.status, first.raw)
    });
  }

  const second = await postTranscription({ wavBlob, provider, signal, responseFormat: "json" });
  if (second.status === 0) {
    notifyProgress?.();
    return {
      text: second.text,
      ...(second.segments ? { segments: second.segments } : {}),
      ...(second.words ? { words: second.words } : {})
    };
  }

  const err = makeTranscriptionError(
    second.status > 0 ? `HTTP ${second.status}${second.detail ? `: ${second.detail}` : ""}` : (second.detail || "转写请求失败"),
    {
      status: second.status,
      detail: second.detail,
      kind: classifyPlatformFailure(provider, second.status, second.raw || second.detail)
    }
  );
  if (second.status > 0) {
    logPlatformFailure(second.status, second.raw);
  }
  throw err;
}
