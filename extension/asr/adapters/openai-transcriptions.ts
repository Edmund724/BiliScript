// extension/asr/adapters/openai-transcriptions.ts
// OpenAI 兼容语音转写适配器：POST {baseUrl}/audio/transcriptions。
// 适用 SiliconFlow（免费，只返回纯文本）/ 本地 Whisper（verbose_json
// 句级时间戳）/ 自定义（自动探测时间戳能力）。
//
// 关键约束（spec 6.7 / 7.1）：
//   - 用 FormData 上传，绝不手动设 Content-Type（浏览器自动带 boundary）；
//   - apiKey 存在才带 Authorization: Bearer（本地 Whisper 常无 Key）；
//   - 转写语言：provider.language 为 zh/en 时以查询参数 ?language=zh|english
//     传给平台（SiliconFlow 辰星/SenseVoice 的英文识别依赖该参数）；auto 省略，
//     交服务端自动检测；
//   - 成功/降级/失败三分（契约）：2xx 且有 segments → 成功返回；2xx 但无
//     segments（平台不支持 verbose_json，如 SiliconFlow 只回 { text }）→ 以
//     response_format=json 降级 POST 一次（只取 text），返回里省略 segments
//     表达"无时间戳"，调用方据此合成整片粗粒度字幕；HTTP 非 2xx → 直接抛
//     `HTTP <status>`（err.status 带状态码），不再降级——重试与否交给调用方
//     retryAsync 按状态码判定（408/429/5xx 可重试，其余 4xx 不重试），避免
//     38MB 级 wav 对注定失败的请求做第二次全量重传。
//
// 失败信号（票 03 / 04）：本模块是**唯一拿得到完整响应体**的一层，故类别判定
// （err.kind，规则住 asr/failure-kind.js）在这里做完——截断到 200 字符的
// err.detail 只作展示，判定喂的是未截断原文（429 的 error.type 可能落在第 200
// 字符之后）。响应体原文全量只进本 context（offscreen）的 logWarn，绝不跨 port。

import type { AsrProvider } from "../asr-provider-store.js";
import { classifyAsrFailure } from "../failure-kind.js";
import type { AsrFailureProviderLike } from "../failure-kind.js";
import { logWarn } from "../../shared/logging.js";
import { getErrorMessage } from "../../shared/error-helpers.js";

// 句级时间戳条目（verbose_json segments 归一化后的形状）
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

// 单片转写结果：segments 缺省表示该平台无时间戳，调用方（pipeline）据此
// 合成整片粗粒度字幕。带索引签名：结果以「未知字段的 JSON 记录」视角跨
// port/接线层透传（entry/offscreen-asr 的 transcribe 闭包以
// Promise<Record<string, unknown>> 承接）。
export interface TranscriptionResult {
  text: string;
  segments?: TranscriptSegment[];
  [key: string]: unknown;
}

// transcribe 的入参契约（startSec/durationSec 随注入面统一携带，本适配器
// POST 本体不使用；signal 透传给 fetch，onProgress 在每次请求成功后触发）
export interface TranscribeArgs {
  wavBlob: Blob;
  startSec?: number;
  durationSec?: number;
  provider: AsrProvider;
  signal?: AbortSignal | null;
  onProgress?: (text: string) => void;
}

// 单次 POST 的归一化结果：status=0 表示 2xx 且 JSON 解析成功；status=HTTP 码
// 表示非 2xx；status=-1 表示响应体解析失败。detail 为**展示用**上下文片段
// （截到 200 字符），raw 为响应体**原文**——判定类别必须基于完整报文（票 03
// 硬约束），截断后关键词可能已丢（如 429 的 error.type 落在第 200 字符之后）。
interface PostTranscriptionResult {
  status: number;
  detail: string;
  raw: string;
  text: string;
  segments?: TranscriptSegment[];
}

// 适配器抛出物的失败信号（票 03）：status 供重试判定（isRetryableNetworkError），
// detail 截到 200 字符只作展示，kind 是判定类别——跨 port 只带得走这个小字符串。
type AsrTranscriptionError = Error & { status?: number; detail?: string; kind?: string };

// 统一挂失败信号：本适配器有四处抛出点（非 2xx / 降级失败 / 非 JSON 哨兵 /
// 未配置 baseUrl），标签组装收在一处，四个调用点各只声明自己的 status 与报文。
// status 可选：**只有真的是 HTTP 失败才带**（票 02/04：`平台 baseUrl 未配置`
// 无状态码、无网络交互，凭空造一个 -1 会让 isRetryableNetworkError 走进状态码
// 分支，改变重试判定）。
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

// 分类输入：完整报文（未截断）+ status + provider（baseUrl 决定 429 的 host
// 分流）。source 恒为 platform——音轨 CDN 的 403/404 走的是 offscreen 管线
// 抛出点，绝不在本模块判定，否则 CDN 拦截会被误报成「API Key 无效」。
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

// 全量响应体只进 offscreen 的日志：跨 port 只带 kind / 截断 detail，报文原文
// 全文留在这里（页面侧的 logWarn 拿不到它，也不该拿到）。平台错误报文不含音频
// 与 Key（Q4 已评估过这条风险）。
function logPlatformFailure(status: number, raw: string): void {
  logWarn("[BILISCRIPT] asr platform rejected transcription request", { status, body: raw });
}

// 把识别语言转成平台查询参数：?language=zh / ?language=english。
// SiliconFlow 辰星 / SenseVoice 系列的英文识别依赖 ?language=english（multipart
// 字段不生效），只有显式选择 zh/en 才附带；auto 省略让服务端自动检测
// （本地 Whisper 也无此参数，其语言自动识别）。
export function buildTranscriptionUrl(baseUrl: string, language?: string): string {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  const lang = String(language || "").trim().toLowerCase();
  if (lang !== "zh" && lang !== "en") {
    return `${normalized}/audio/transcriptions`;
  }
  return `${normalized}/audio/transcriptions?language=${lang === "zh" ? "zh" : "english"}`;
}

// 构造 FormData（纯函数便于单测断言字段）
function buildTranscriptionForm(wavBlob: Blob, provider: AsrProvider, responseFormat: string): FormData {
  const form = new FormData();
  form.append("file", wavBlob, "chunk.wav");
  form.append("model", provider?.model || "");
  form.append("response_format", responseFormat || "verbose_json");
  // 不把 language 放 multipart 字段——SiliconFlow 辰星/SenseVoice 只认查询
  // 参数 ?language=zh|english，字段会被忽略；语言参数由 buildTranscriptionUrl
  // 附加到 URL（auto 省略，服务端自动检测，兼容中英混排与外语视频）。
  return form;
}

// 归一化 segments 列表：只保留 { start, end, text } 且 text 非空白，
// start/end 转数字；无有效 segments 返回 undefined（调用方按无时间戳处理）。
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

// 单次 POST 请求。HTTP 2xx 且 JSON 解析成功 → status=0 并带 text/segments；
// 否则 status=HTTP 码（-1 表示响应体解析失败）并附响应体片段 detail 与原文 raw。
// 不抛错，交给调用方决定降级或重试（网络错误/Abort 除外）。
async function postTranscription({ wavBlob, provider, signal, responseFormat }: {
  wavBlob: Blob;
  provider: AsrProvider;
  signal?: AbortSignal | null;
  responseFormat: string;
}): Promise<PostTranscriptionResult> {
  const baseUrl = String(provider?.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    // 同步抛出、无网络交互：配置类（no-asr-config），补救动作是「去设置填 baseUrl」。
    // **不带 status**——票 02/04 明确这条「无状态码、无网络交互」。
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
    // 网络层错误原样上抛（instanceof / message 不变，交 retryAsync 消息启发式
    // 判定可重试），只**附加** kind 供归类点用：AbortError 分支在上方已返回，
    // 用户取消绝不在这里被重新贴标签。
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
      // 忽略响应体读取失败：raw 留空，判定按无报文走
    }
    const detail = raw.slice(0, 200);
    logPlatformFailure(response.status, raw);
    return { status: response.status, detail, raw, text: "", segments: undefined };
  }

  try {
    const data: { text?: unknown; segments?: unknown } = await response.json();
    return {
      status: 0,
      detail: "",
      raw: "",
      text: String(data?.text || "").trim(),
      segments: normalizeSegments(data?.segments)
    };
  } catch {
    return { status: -1, detail: "响应体不是合法 JSON", raw: "", text: "", segments: undefined };
  }
}

// 错误对象的可读文本（网络层失败的关键词判定）走 shared/error-helpers 的单源
// 实现——不在这里另抄一份近似版本；它是 shared 叶子，本 context 的 engine 已引它。

// 统一入口。返回 { text, segments? }；segments 缺省表示该平台无时间戳，
// 调用方（pipeline）据此合成整片粗粒度字幕。
//
// 成功/降级/失败三分（契约）：
//   - 2xx 且有 segments → 成功返回（带句级时间戳）；
//   - 2xx 但无 segments，或 2xx 但响应体不是合法 JSON（响应到了、体不符，
//     属平台兼容问题）→ json 降级第二次 POST（降级的唯一合法场景）；
//   - HTTP 非 2xx（status>0）→ 直接抛 `HTTP <status>: <detail>`（err.status
//     带状态码，消息格式与降级失败路径一致），不发第二次 POST；
//   - fetch 抛错（网络层）→ 原样上抛，保持可被 isRetryableNetworkError
//     消息启发式命中的形态（如 "Failed to fetch"）。
export async function transcribe({ wavBlob, startSec, durationSec, provider, signal, onProgress }: TranscribeArgs): Promise<TranscriptionResult> {
  // 进度通知：引擎注入的 onProgress thunk 自带文案闭包，适配器仅以零参触发
  //（注入面签名见 entry/offscreen-asr 的 TranscriptionEngineOptions）。
  const notifyProgress = onProgress as (() => void) | undefined;
  // 首次尝试 verbose_json：平台支持则带句级时间戳。
  const first = await postTranscription({ wavBlob, provider, signal, responseFormat: "verbose_json" });
  if (first.status === 0 && first.segments) {
    notifyProgress?.();
    return { text: first.text, segments: first.segments };
  }

  // HTTP 非 2xx：确定性失败直接抛，不再发第二次全量 POST（单片 wav 38MB 级，
  // 对 401/403/400 这类重试也注定失败的请求是纯浪费）。可重试性（408/429/5xx）
  // 由调用方 retryAsync 按 err.status 判定；kind 的判定在**完整报文**上做完
  //（first.raw 未截断），消息格式与 err.status 保持不变（既有断言锁定）。
  if (first.status > 0) {
    throw makeTranscriptionError(`HTTP ${first.status}${first.detail ? `: ${first.detail}` : ""}`, {
      status: first.status,
      detail: first.detail,
      kind: classifyPlatformFailure(provider, first.status, first.raw)
    });
  }

  // 兼容性降级（唯一合法场景）：2xx 但响应体无 segments（平台不支持
  // verbose_json，如 SiliconFlow 只回 { text }），或 2xx 但响应体不是合法
  // JSON（status=-1，体不符）→ 以 response_format=json 重试一次，只取 text。
  const second = await postTranscription({ wavBlob, provider, signal, responseFormat: "json" });
  notifyProgress?.();
  if (second.status === 0) {
    return { text: second.text };
  }

  // json 降级也失败：抛 HTTP 错误（5xx/网络错误由调用方 retryAsync 重试）。
  // status=-1（两次都是 2xx 但体不是合法 JSON）走判定次序 0a：asr-unknown。
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
