// ASR offscreen 通道的页面侧客户端：两类任务共用同一个 "asr-decode" 端口——
// ① createOffscreenChunkHost：一次发起「下载 + 解码 + 切片 + 转写」，音频字节与
//    API Key 全程不出 offscreen（offscreen 自己 fetch、自己取配置），页面只收逐片
//    文本结果；
// ② probeAsrProviderViaOffscreen：连通性探针，把草稿 provider 交给 offscreen 的真
//    适配器跑一次（端口上表现为 asr-probe 动作，见 asr/protocol.js）。
// 仅在页面环境加载（bundle 链路：pipeline → fallback → content script，以及设置
// 抽屉的 provider 测试按钮 → asr/provider-test.js），协议常量与契约注释唯一地址
// 见 asr/protocol.js。

import { sendRuntimeMessage, sendOffloadMessage } from "../shared/messaging.js";
import { getErrorMessage, withTimeout } from "../shared/error-helpers.js";
import {
  ASR_DECODE_PORT_NAME,
  ASR_DECODE_ACTION,
  ASR_MSG_PROGRESS,
  ASR_MSG_CHUNK_RESULT,
  ASR_MSG_DONE,
  ASR_MSG_ERROR,
  ASR_TASK_PREPARE,
  ASR_TASK_CLEANUP,
  ASR_PROBE_ACTION,
  ASR_MSG_PROBE_RESULT,
  ASR_PROBE_TIMEOUT_MS
} from "./protocol.js";
import type { AsrProgressMessage, AsrChunkResultMessage, AsrDoneMessage, AsrErrorMessage, AsrProbeResultMessage } from "./protocol.js";

// ===== 页面侧任务契约类型 =====

// 适配器单片结果（port 透传的 JSON；叶子字段保持 unknown，页面侧只做
// 防御性读取——字段语义见 asr/protocol.js 的 chunk-result 注释）
export interface AsrChunkResult {
  text?: unknown;
  segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }>;
  _asrDiag?: unknown;
  durationSec?: unknown;
}

// 单片记录（offscreen 桥 done 后按片 index 排序）
export interface AsrChunkRecord {
  index: number;
  startSec: number;
  durationSec: number;
  result: AsrChunkResult | null;
}

// 任务入参：audioUrl 可缺省（音轨条目无 baseUrl 时由 offscreen 侧报错兜底）
export interface OffscreenChunkHostArgs {
  audioUrl: string | undefined;
  backupUrls?: string[];
  onProgress?: (message: string) => void;
}

// 任务结果：results 为按片 index 排序的单片记录；totalChunks 为产出片数，
// skippedSegments 为解码失败跳过的段数，failedChunks 为转写失败跳过的片数
// （Q8a 口径：个别失败不整体失败，全部段解码失败零片产出才算整体失败，
// 见 asr/protocol.js）。failedKind / failedStatus / failedDetail 为片级失败
// 摘要，**只在终态消息携带时出现**（键不存在 = 无失败信号；页面侧按严格形状
// 断言，不能凭空多出 undefined 键）。
export interface OffscreenChunkHostResult {
  results: AsrChunkRecord[];
  totalChunks: number;
  skippedSegments: number;
  failedChunks: number;
  failedKind?: string;
  failedStatus?: number;
  failedDetail?: string;
}

// 页面侧客户端契约：
//   async ({ audioUrl, backupUrls, onProgress? }) =>
//     { results, totalChunks, skippedSegments, failedChunks }
//     results 为按片 index 排序的 [{ index, startSec, durationSec, result }]，
//     result 是适配器单片结果 { text, segments?, _asrDiag? }（Q8a 口径与
//     完整结果形状见 asr/protocol.js）。
// onProgress 中继 offscreen 引擎产出的进度文本。失败 reject 带用户可读文案；
// 成功失败都会发 cleanup 清 dnr 规则（带上 prepare 响应带回的 ruleId，只清
// 本任务这条，不碰并发任务的）。
export type OffscreenChunkHost = (args: OffscreenChunkHostArgs) => Promise<OffscreenChunkHostResult>;

// prepare/cleanup 响应（background 回包）：OffloadTaskResponse（协议单源，
// shared/messaging-protocol.ts）——prepare 成功带回本任务独立的防盗链规则 id。

// port 消息读取形状直接复用 protocol 的消息类型（线格式一致）。progress 的
// 文本字段是 text（entry/offscreen-asr.ts 的 postMessage 实发字段）。
type AsrPortMessageLike =
  | AsrProgressMessage
  | AsrChunkResultMessage
  | AsrDoneMessage
  | AsrErrorMessage;

export function createOffscreenChunkHost(): OffscreenChunkHost {
  return async function offscreenChunkHost({ audioUrl, backupUrls, onProgress }: OffscreenChunkHostArgs): Promise<OffscreenChunkHostResult> {
    // 先让 background 建 offscreen 文档 + 加防盗链规则（响应带回 ruleId），
    // 再直连文档传任务。响应形状由消息类型经 ResponseOf 推断（arch-slim-2/02）
    const prepared = await sendOffloadMessage({ type: "offload-task", taskType: ASR_TASK_PREPARE });
    if (!prepared?.ok) {
      throw new Error(prepared?.error || "音频解码服务启动失败");
    }
    const sessionRuleId = Number(prepared.ruleId) || 0;

    return new Promise((resolve, reject) => {
      const results: AsrChunkRecord[] = [];
      let done = false;
      let totalChunks = 0;
      let skippedSegments = 0;
      let failedChunks = 0;

      const cleanup = (): void => {
        sendOffloadMessage({ type: "offload-task", taskType: ASR_TASK_CLEANUP, ruleId: sessionRuleId }).catch(() => {
          // 规则清理失败不影响主流程（会话规则随浏览器重启自动清空）
        });
      };
      const finish = <V>(callback: (value: V) => void, value: V): void => {
        if (done) return;
        done = true;
        try {
          port.disconnect();
        } catch {
          // ignore
        }
        cleanup();
        callback(value);
      };

      const port = chrome.runtime.connect({ name: ASR_DECODE_PORT_NAME });
      port.onMessage.addListener((rawMsg: unknown) => {
        const msg = rawMsg as AsrPortMessageLike | null;
        if (!msg || typeof msg !== "object" || done) return;
        if (msg.type === ASR_MSG_PROGRESS) {
          // offscreen 引擎产出的进度文本（语音识别中 N 片…）原样中继
          try {
            onProgress?.(String(msg.text || ""));
          } catch {
            // 进度回调异常不影响收包
          }
          return;
        }
        if (msg.type === ASR_MSG_CHUNK_RESULT) {
          results.push({
            index: Number(msg.index) || 0,
            startSec: Number(msg.startSec) || 0,
            durationSec: Number(msg.durationSec) || 0,
            result: msg.result as AsrChunkResult | null
          });
          return;
        }
        if (msg.type === ASR_MSG_DONE) {
          totalChunks = Number(msg.totalChunks) || results.length;
          skippedSegments = Number(msg.skippedSegments) || 0;
          failedChunks = Number(msg.failedChunks) || 0;
          results.sort((a, b) => a.index - b.index);
          // 片级失败摘要：**有则附、无则不加**（下游 asr/pipeline 与 fallback 按
          // 键是否存在判定「有无失败信号」，凭空多出 undefined 键会让形状断言失真）
          const { failedKind, failedStatus, failedDetail } = msg;
          finish(resolve, {
            results,
            totalChunks,
            skippedSegments,
            failedChunks,
            ...(failedKind !== undefined ? { failedKind } : {}),
            ...(failedStatus !== undefined ? { failedStatus } : {}),
            ...(failedDetail !== undefined ? { failedDetail } : {})
          });
          return;
        }
        if (msg.type === ASR_MSG_ERROR) {
          const error: Error & { code?: string; reason?: string; kind?: string } = new Error(msg.error || "音频转写失败");
          if (msg.code) {
            error.code = msg.code;
          }
          // 结构化原因（asr-skip 的 "asr-disabled" / "no-asr-config"）随错误
          // 对象透传，最终落 clipState.noSubtitleReason（asr/fallback.js）
          if (msg.reason) {
            error.reason = msg.reason;
          }
          // 管线级失败类别（音轨下载/解码/切片/域名未授权/baseUrl 未配置）同款
          // 透传：归类点据 kind 落 noSubtitleReason，未携带则归 asr-unknown
          if (msg.kind) {
            error.kind = msg.kind;
          }
          finish(reject, error);
        }
      });
      port.onDisconnect.addListener(() => {
        if (!done) {
          finish(reject, new Error("音频解码中断：后台连接已断开"));
        }
      });

      port.postMessage({
        action: ASR_DECODE_ACTION,
        task: {
          audioUrl: String(audioUrl || "").trim(),
          backupUrls: Array.isArray(backupUrls) ? backupUrls : []
        }
      });
    });
  };
}

// ===== 平台连通性探针（页面侧客户端） =====

// 探针入参：草稿 provider 的可变字段（Key 随任务过去——探针要能测「填了但还没
// 保存」的 Key）。
export interface AsrProbeInput {
  type: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  language?: string;
}

// 探针没等到回执时的两处可读文案：端口断连（offscreen 文档未就绪 / 已回收）与超时。
// 两者一律以失败收口——测试按钮宁可报错，也不把「没等到」显示成连接成功。
const PROBE_DISCONNECTED_MESSAGE = "探针通道已断开（转写服务未就绪或已回收），请重试";
const PROBE_TIMEOUT_MESSAGE = `探针超时（${ASR_PROBE_TIMEOUT_MS / 1000} 秒无响应），请重试`;

// 连通性探针：把草稿 provider 交给 offscreen 的真适配器跑一次静音转写，与实际
// 转写同一条链（权限预检 / 请求构造 / 失败分类全在 offscreen 侧，见 asr/protocol.js）。
// 页面侧自己发 fetch 做不到忠实：content script 没有 chrome.permissions（权限门
// 必然 fail-open），且其 fetch 受网页 CORS 约束、与扩展文档里「只受 host 权限
// 约束」的真出口不是一回事。
//
// 与解码链的差别只有两处：① 不经 offload-task 的 prepare/cleanup——探针不发音轨
// 请求，不需要防盗链 dnr 规则，故也不会占掉一个规则 id；offscreen 文档经
// "ensure-offscreen-chat" 幂等自愈（同一个文档，探针与解码共用三条通道）；② 只等
// 一条 probe-result 回执，超时/断连都以可读文案收口。
// 返回 { ok, error? }；error 为可直接展示的文案（未授权提示 / 平台 HTTP 报文 /
// 通道故障），本层不改写。
export async function probeAsrProviderViaOffscreen(
  input: AsrProbeInput
): Promise<{ ok: boolean; error?: string }> {
  try {
    const ensured = await sendRuntimeMessage({ type: "ensure-offscreen-chat" });
    if (ensured?.ok === false) {
      return { ok: false, error: ensured.error || "转写服务启动失败" };
    }
  } catch {
    // 自愈消息失败不短路：下面的端口断连会兜底成可读错误
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
    // 成功、失败、超时三条路径都断端口：探针不该在 offscreen 侧留活连接
    try {
      port.disconnect();
    } catch {
      // 已断连：忽略
    }
  }
}

// 等 offscreen 的唯一一条探针回执。端口断连（无回执）以错误拒绝，超时由外层的
// withTimeout 兜底——两条路径都不会把「没等到」兑现成通过。
function waitProbeResult(
  port: chrome.runtime.Port,
  input: AsrProbeInput
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    port.onMessage.addListener((rawMsg) => {
      if (settled) return;
      const msg = rawMsg as AsrProbeResultMessage | null;
      // 只认探针回执：同端口上还可能流过解码通道的消息（探针与真跑并发时）
      if (!msg || msg.type !== ASR_MSG_PROBE_RESULT) return;
      settled = true;
      resolve(msg.ok ? { ok: true } : { ok: false, error: msg.error || "转写请求失败" });
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      reject(new Error(PROBE_DISCONNECTED_MESSAGE));
    });
    port.postMessage({ action: ASR_PROBE_ACTION, task: { ...input } });
  });
}
