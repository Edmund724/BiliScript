// ASR「下载 + 解码 + 切片 + 转写」的跨 context 协议常量（唯一地址）。
// MV3 service worker 没有 AudioContext，且 chrome.runtime 消息是 JSON 序列化
// ——二进制（Uint8Array / Float32Array）跨 context 会变成数字键普通对象，
// 字节全损。因此下载、解码、切片、转写整体搬进 offscreen 文档（转写引擎
// asr/engine.js 与适配器与解码同 context 加载），跨 context 只传文本结果与
// 小 JSON；音频字节与 API Key 都不出 offscreen（Key 由 offscreen 直调
// background 的 get-asr-runtime-config 获取）。
//
// 数据流：runAsrPipeline → createOffscreenChunkHost()（page 侧，
// asr/offscreen-bridge.page.js）→ sendOffloadMessage({ taskType: ASR_TASK_PREPARE })
// → background 建 offscreen 文档 + 按任务分配独立 id 的 dnr 防盗链规则
// （响应带回 ruleId，见 asr/offscreen-bridge.bg.js）→ 页面连
// ASR_DECODE_PORT_NAME port 直连文档 → postMessage 任务
// { audioUrl, backupUrls } → 逐条收 ASR_MSG_PROGRESS / ASR_MSG_CHUNK_RESULT
// → ASR_MSG_DONE → 汇总按片
// index 对齐的文本结果返回 → 再发 { taskType: ASR_TASK_CLEANUP, ruleId } 只清自己
// 这条 dnr 规则（多任务并发时各删各的，互不影响）。
// 转写与视频切换解耦：页面侧不做 stale 复核（旧实现曾按注入的过期回调在
// 每条 port 消息到达时断连取消，已删）。任务取消只剩真断连——页面关闭/
// 扩展重载 → port.onDisconnect → offscreen 侧 aborted → 解码停止、引擎
// 停止调度（现成机制）。
//
// 页面侧客户端（createOffscreenChunkHost）在 asr/offscreen-bridge.page.js；
// background 侧执行器（DNR 规则簿记 + prepare/cleanup handler）在
// asr/offscreen-bridge.bg.js；offscreen 文档内 handler 侧接线在
// entry/offscreen.js / entry/offscreen-asr.js。两侧均 import 本模块取常量，
// 禁止手写协议字面量（注释除外）。

// 失败类别的词表与 asr/failure-kind.js 同源（**type-only**：编译期擦除，运行时
// 依赖边不变——本模块仍是零 import 的常量叶）。
import type { AsrFailureKind } from "./failure-kind.js";

// ===== 片级失败摘要 =====
//
// 一次转写尝试的代表性失败（类别 / 状态码 / 截断报文）：判定与投影只住在下面
// 两个函数里，四处载体（port DONE 消息、页面侧宿主结果、管线尝试结果、fallback
// 运行结果）由这两个类型派生。
//
// 判据：**类别是唯一存在判据**——类别缺失 / 非字符串 / 空串 ⇒ 整条摘要缺席，
// 状态码与报文不得脱离类别存在；两者用 !== undefined 携带（0 与空串都算携带）。
//
// 命名分工：域形态 kind / status / detail，wire 形态 failedKind / failedStatus /
// failedDetail（改名只发生在两个函数内部）。类别词表见 asr/failure-kind.js 的
// AsrFailureKind；管线级失败类别（ERROR.kind，下载/解码/切片等整体失败）是同
// 词表的**另一条路**，不并入本类型。

// 域摘要：类别必填，状态码 / 报文可选。类别取值来自 asr/failure-kind.js 的
// AsrFailureKind 词表（type-only 引用）；wire 是外来数据，未知串照收——判定层
// 不做成员校验（静默改掉旧/新宿主的类别会让归类点失去真因），收口在归类点
// core/asr-failure-notice 的 reasonFromFailureKind。
export interface AsrFailureSummary {
  kind: AsrFailureKind | (string & {});
  status?: number;
  detail?: string;
}

// wire 片段：三字段全可选（「有则带键」——缺席字段的键不出现，旧宿主不认得新
// 字段，凭空多出 undefined 键会破坏形状兼容）。类别与域形态同词表，同样照收未知串。
export interface AsrFailureFields {
  failedKind?: AsrFailureKind | (string & {});
  failedStatus?: number;
  failedDetail?: string;
}

// 判定：wire / 域形状的原文 → 摘要或 null（null = 无失败信号）。类别非空串即
// 成立；未知串照收（判定层不改值，归类点 reasonFromFailureKind 把不认识的串收口
// 成 asr-unknown）；状态码只在是数值时携带，报文只在是字符串时携带。
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
  if (typeof status === "number") {
    summary.status = status;
  }
  const detail = source.failedDetail !== undefined ? source.failedDetail : source.detail;
  if (typeof detail === "string") {
    summary.detail = detail;
  }
  return summary;
}

// 投影：域摘要 → wire 片段。null / undefined → 空片段；缺席字段的键**不出现**
// （绝不写 undefined）——「有则带键」的 spread 舞蹈只留在这里。
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

// 单次转写尝试的失败面结果（pipeline 上报 / fallback 消费；两侧同形，声明唯一
// 住这里）：计数与耗时 + 片级失败摘要。管线侧经 read → project 产出本形状，
// fallback 侧经 read 取类别 / 状态码 / 报文。
export interface AsrAttemptOutcome extends AsrFailureFields {
  totalChunks: number;
  failedChunks: number;
  elapsedMs: number;
}

// ===== port 与任务消息 =====

// 页面 ↔ offscreen 文档直连的 port 名
export const ASR_DECODE_PORT_NAME = "asr-decode" as const;
// 页面经 port 首条消息派发任务的 action 字段取值（与 port 名同串、语义不同）
export const ASR_DECODE_ACTION = "asr-decode" as const;

// offload 任务类型：background 的 offload-task 通道按 taskType 分发
// （prepare 建文档 + 加规则，cleanup 删规则）
export const ASR_TASK_PREPARE = "asr-decode-prepare" as const;
export const ASR_TASK_CLEANUP = "asr-decode-cleanup" as const;

export type AsrTaskType = typeof ASR_TASK_PREPARE | typeof ASR_TASK_CLEANUP;

// ===== port 消息 type（offscreen handler → 页面） =====

// 引擎产出的进度文本（语音识别中 N 片…），页面原样中继 onProgress
export const ASR_MSG_PROGRESS = "progress" as const;
// 单片转写结果 { index, startSec, durationSec, result }，result 为适配器
// 单片结果 { text, segments?, _asrDiag? }，原样透传（纯 JSON 文本）
export const ASR_MSG_CHUNK_RESULT = "chunk-result" as const;
// 终态汇总 { totalChunks, skippedSegments, failedChunks } + 片级失败摘要
// （由 AsrFailureFields 派生，可选）。片级失败不挤进 error：
// 引擎「个别失败不整体失败」的既有口径（Q8a）不变，失败类别作为**附加信号**
// 随同一个终态消息到站。首片确定性失败触发的中止（票 05）也走本消息——它是
// 片级失败收尾，与普通空结果失败同一个出口，不借用 error 的管线级语义。
export const ASR_MSG_DONE = "done" as const;
// 终态错误 { error, code?, reason?, kind? }：code（如 "asr-skip"）与结构化
// reason（asr-skip 的 "asr-disabled" / "no-asr-config"）随错误对象透传，最终落
// clipState.noSubtitleReason（asr/fallback.js）。kind 为**管线级**失败的类别
// （音轨下载 / 解码 / 切片 / 域名未授权 / baseUrl 未配置，判定在 offscreen 侧
// 用完整报文做完）——逐片转写失败仍只走 done，不得挤进本条（语义会变）。
export const ASR_MSG_ERROR = "error" as const;

export type AsrPortMessageType =
  | typeof ASR_MSG_PROGRESS
  | typeof ASR_MSG_CHUNK_RESULT
  | typeof ASR_MSG_DONE
  | typeof ASR_MSG_ERROR;

// progress 的文本字段为 text（entry/offscreen-asr.ts 的 postMessage 实发字段）。
export type AsrProgressMessage = { type: typeof ASR_MSG_PROGRESS; text: string };
export type AsrChunkResultMessage = {
  type: typeof ASR_MSG_CHUNK_RESULT;
  index: number;
  startSec: number;
  durationSec: number;
  result: unknown;
};
export interface AsrDoneMessage extends AsrFailureFields {
  type: typeof ASR_MSG_DONE;
  totalChunks: number;
  skippedSegments: number;
  failedChunks: number;
  // 片级失败摘要的 wire 字段（failedKind / failedStatus / failedDetail，见
  // 「片级失败摘要」段）：kind 是判定类别（分类规则住 asr/failure-kind.js，判定在
  // 完整报文还在手上的 offscreen 侧做完），status / detail 只作展示。响应体**全量**
  // 只进 offscreen 的 logWarn，绝不跨 port（Q4）——这里过界的 detail 已被适配器
  // 截到 200 字符。
}
export type AsrErrorMessage = {
  type: typeof ASR_MSG_ERROR;
  error: string;
  code?: string;
  reason?: string;
  // 管线级失败的判定类别（如 no-asr-config / asr-media）：与 code / reason 同款，
  // 有则附、无则不加（旧宿主不认得本条，页面按 asr-unknown 收口）。
  kind?: string;
};

export type AsrPortMessage =
  | AsrProgressMessage
  | AsrChunkResultMessage
  | AsrDoneMessage
  | AsrErrorMessage;

// ===== 平台连通性探针（页面 → offscreen → 真适配器） =====
//
// 探针与实际转写走同一条链：页面侧（content script）把**草稿** provider 交给
// offscreen，offscreen 以 1 秒静音 WAV 调真实适配器（entry/offscreen-asr.js 的
// asr-probe 处理）。页面侧自己发 fetch 做不到忠实——content script 没有
// chrome.permissions（host 权限预检必然 fail-open，见 core/host-permissions.js），
// 且其 fetch 受网页 CORS 约束，与扩展文档里「只受 host 权限约束」的出口不是同一
// 件事：平台回一个 ACAO 就能让探针在域名未授权时照样 200。真转写的请求出口
// （asr/adapters/openai-transcriptions.js）及其权限预检都在 offscreen，故探针也
// 放在那里跑。
export const ASR_PROBE_ACTION = "asr-probe" as const;

// 探针回执（offscreen → 页面，同一端口）：error / kind / status 三者都取自适配器
// 抛出的失败信号（文案与实际转写同一串），页面只展示 error。
export const ASR_MSG_PROBE_RESULT = "probe-result" as const;

// 探针任务：草稿 provider 的可变字段（Key 随任务过来——要能测「填了但还没保存」的
// Key；解码链不受影响，那边仍由 offscreen 直读运行时配置）。
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

// ===== 页面侧任务结果形状（createOffscreenChunkHost 的 resolve 值） =====
//   { results, totalChunks, skippedSegments, failedChunks,
//     failedKind?, failedStatus?, failedDetail? }
//   results 为按片 index 排序的 [{ index, startSec, durationSec, result }]；
//   totalChunks 为产出片数，skippedSegments 为解码失败跳过的段数，
//   failedChunks 为转写失败跳过的片数（Q8a 口径：个别失败不整体失败，
//   全部段解码失败零片产出才算整体失败）。
//   三个 failed* 字段是片级失败摘要，**只在终态消息携带时出现**（键不存在 =
//   无失败信号，页面据此判定空结果的原因）；失败类别在此只作搬运，归类点
//   （asr/fallback.js）按 kind 落 noSubtitleReason。页面侧声明
//   （offscreen-bridge.page.js 的 OffscreenChunkHostResult）由 AsrFailureFields
//   派生，「有则带键」的判定 → 投影经 readAsrFailureSummary / projectAsrFailureSummary。

// ===== 共享数值常量 =====

// 音频体积上限 200MB（offscreen 文档侧下载时 HEAD 探大小据此拒绝超长视频）
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
// offscreen 文档内的任务超时（解码与下载共用）
export const ASR_DECODE_TIMEOUT_MS = 10 * 60 * 1000;

// 探针回执的等待上限（页面侧）：1 秒静音 WAV 的转写往返本应秒级，超时只防
// offscreen 文档未就绪/适配器挂死时测试按钮永远转圈——到点以可读文案收口，
// 绝不把「没等到」当成通过。
export const ASR_PROBE_TIMEOUT_MS = 30 * 1000;

// 累计下载量上限（工单 04）：GET 流式读的累计字节最大值（主备 URL 合计）。
// HEAD 探大小只在 CDN 诚实返回 Content-Length 时预拒超长视频；头部撒谎或
// 缺失时由本上限兜底——超限即中止下载（连接 cancel）、报可读错误。取值与
// MAX_AUDIO_BYTES 同级（64kbps 音轨 ≈ 7 小时）。
export const ASR_MAX_CUMULATIVE_DOWNLOAD_BYTES = MAX_AUDIO_BYTES;

// 累计下载量超限的可读错误文案（entry/offscreen-asr.js streamAudioSegments
// 计数超限后抛出，沿 port 错误消息直达页面 UI）。
export const ASR_DOWNLOAD_LIMIT_MESSAGE = "音频下载量超出上限（>200MB），已停止下载" as const;

// 待处理音频分片上限（工单 04）：转写引擎活队列（已接受未启动）的最大深度。
// 每片 WAV（300s @16kHz/16bit/mono ≈ 9.6MB）在转写完成前常驻内存，排队越深
// 内存峰值越高；取 2×ASR_CONCURRENCY（offscreen-constants 的并发 10）≈ 在途
// 10 片 + 排队 20 片 < 300MB，offscreen 渲染进程的显式安全线。超限 push 返回
// false，消费方（entry/offscreen-asr.js 的 onChunk）停止新增工作并报可读错误
// ——静默丢弃会丢字幕，错误路径才能让用户重试。
export const ASR_MAX_PENDING_CHUNKS = 20;

// 待处理分片超限的可读错误文案（asr/stream-chunker 检测到 onChunk 拒绝后抛出，
// 沿 port 错误消息直达页面 UI）。
export const ASR_PENDING_CHUNKS_LIMIT_MESSAGE =
  "待处理转写分片超出内存上限，已停止新增转写任务，请稍后重试或缩短视频" as const;

// ===== 来源拒绝文案（消息入口守卫的字面量单源） =====

// 只接受 offscreen 文档发送的消息（协议层名单 OFFSCREEN_ONLY_MESSAGE_TYPES）被
// 其它来源调起时的拒绝文案。两个消费点取同一字面量：消息入口守卫
// （core/message-router 的 createMessageRouter，文案由组合根经 rejectionMessage
// 注入）与关闭执行器（asr/offscreen-bridge.bg.js 的 handleOffscreenRequestClose，
// 该处理器是导出面，直调时自带同一判据）。
export const ASR_OFFSCREEN_REJECTION_MESSAGE = "仅接受 offscreen 文档发送" as const;
