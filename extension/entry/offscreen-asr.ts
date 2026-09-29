// offscreen-asr.ts — ASR 音频「下载 → 解码 → 切片 → 转写」全链路（自
// entry/offscreen.js 拆出）：service worker 无 AudioContext，解码 + 重采样在
// offscreen 文档里用 OfflineAudioContext 完成；转写引擎与适配器也加载在本
// context——音频字节与 API Key 都不出 offscreen，跨 port 只回传转写文本结果。
//
// 模块形状参照仓库注入惯例（如 asr/fallback.js 的 createAsrFallback(deps)）：
// createAsrDecodeHandler({ onTaskTerminal }) 返回 "asr-decode" 端口的任务执行
// 函数。文档生命周期簿记（存活 asr 端口集合 / 聊天端口计数 / 自关判定）留在
// entry/offscreen.ts，任务终态（断连取消 / done / error）经注入的
// onTaskTerminal(port) 回调通知入口层做自关判定——本模块不感知簿记状态。
// chrome.runtime / AudioContext 等全局在 offscreen 环境固定可直接用；纯逻辑
// （resolveAsrProvider / makeAsrSkipError）保持模块级可导出可测。
//
// 失败信号与快速中止（票 03 / 05）：
//   - 类别（kind）在本 context 判完——适配器用**完整报文**判平台的 HTTP 失败，
//     管线的下载/解码/切片抛出点按 media 来源判，两处配置抛出点自带 kind；
//     跨 port 只带 kind 这个小字符串（截断 detail 只作展示，响应体原文只进
//     本 context 的 logWarn）；
//   - 首个**不可重试**的片级失败即中止整轮（不再切完整条音轨、不再上传后续片）：
//     置位在注入的 transcribe 闭包内（fatalAbort），引擎经只读的 isAborted
//     消费它；stop() 同步抛 ASR_ABORT_SENTINEL 停掉上游切片流水（否则内存上限
//     文案会顶替真正的失败原因）；收尾走与普通空结果失败同一个出口（DONE）。

import {
  MAX_AUDIO_BYTES,
  ASR_DECODE_TIMEOUT_MS,
  ASR_MAX_CUMULATIVE_DOWNLOAD_BYTES,
  ASR_DOWNLOAD_LIMIT_MESSAGE,
  ASR_MSG_PROGRESS,
  ASR_MSG_CHUNK_RESULT,
  ASR_MSG_DONE,
  ASR_MSG_ERROR
} from "../asr/protocol.js";
import { buildChunkPlan } from "../asr/chunker.js";
import { classifyAsrFailure } from "../asr/failure-kind.js";
import { streamWavChunks } from "../asr/stream-chunker.js";
import { createTranscriptionEngine } from "../asr/engine.js";
import { transcribe as transcribeOpenAi } from "../asr/adapters/openai-transcriptions.js";
import { isFragmentedMp4, createAdtsExtractor, parseAudioSpecificConfig } from "../asr/adts.js";
import { hasHostPermissionFromOffscreen, HOST_PERMISSION_HINT } from "../core/host-permissions.js";
import { ASR_CONCURRENCY } from "../shared/offscreen-constants.js";
import { concatBytes } from "../shared/bytes.js";
import { getErrorMessage, isRetryableNetworkError, withTimeout } from "../shared/error-helpers.js";
import { safePostMessage } from "../shared/messaging.js";
import { logWarn } from "../shared/logging.js";
import type { AsrProvider } from "../asr/asr-provider-store.js";
import type { GetAsrRuntimeConfigResponse } from "../shared/messaging-protocol.js";

// ASR 解码任务中止哨兵：decodeSegment/onChunk 检查 aborted 后抛出，
// 外层 catch 识别后静默退出（不 post error），与「断连视为取消」语义一致。
// 真断连（aborted）与确定性失败中止（fatalAbort，票 05）共用本哨兵——两者都是
// 「停止一切新增工作」，但收尾不同：前者是用户已走（静默），后者要报出失败。
const ASR_ABORT_SENTINEL = Object.freeze({ asrAborted: true });

// 确定性失败中止时捕获的失败摘要（片级失败信号，随 ASR_MSG_DONE 过界）。
interface AsrFatalFailure {
  kind?: string;
  status?: number;
  detail?: string;
}

// 把抛出的错误投影为片级失败信号：kind 由产出侧判定好（适配器在完整报文上判的）；
// 没带 kind 的（注入的 transcribe 未标注、旧适配器）在此就地补一次分类——错误
// 消息是那时唯一还在手上的文本，故按 platform 来源走关键词/无状态码分支。
function summarizeFailure(error: unknown, provider: AsrProvider | null): AsrFatalFailure {
  const err = error as { kind?: unknown; status?: unknown; detail?: unknown } | null;
  const kind = typeof err?.kind === "string" && err.kind
    ? err.kind
    : classifyAsrFailure({ source: "platform", body: getErrorMessage(error), provider });
  const status = Number(err?.status);
  const summary: AsrFatalFailure = { kind };
  if (Number.isFinite(status)) {
    summary.status = status;
  }
  if (typeof err?.detail === "string" && err.detail) {
    summary.detail = err.detail;
  }
  return summary;
}

// type → 适配器映射（原 pipeline.js ADAPTERS 表随转写迁入 offscreen）。
// 映射表缺 type 时发 error，页面显示「暂不支持的平台类型」。并发上限与
// asr/engine.js 调度默认共用 shared/offscreen-constants.js 的 ASR_CONCURRENCY。
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

// ASR 运行时配置：offscreen 直调 background 的 get-asr-runtime-config 取
// provider + Key + 语言（与 AI 聊天 resolveProviderWithKey 走同一通道）。
// Key 只进本 context，不经过页面、也不放进 port 任务消息。5s 超时竞速镜像
// 原 fetcher requestAsrRuntimeConfig 的 race 模式；超时原语走 shared/
// error-helpers 的 withTimeout（arch-slim-2/03 单源），超时以 timeoutError
// 拒绝、由调用方按配置缺失收口，与原手搓 race 拒绝语义一致。响应形状引用
// 协议单源（arch-slim-2/02，原手猜形状断言移除）：本 context 保留 Promise
// 风格直发（MV3 无回调签名，见 tests/entry/offscreen-asr-skip.test.ts 的
// stub 说明），await 的 unknown 回包在传输边界收窄为协议响应类型。
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

// 配置级缺失/关闭/无激活 provider → code "asr-skip"：页面 fallback catch 后
// 映射为静默 skip（与设置闸门 skip 同语义，零用户可见错误）。reason 为结构化
// 原因（"asr-disabled" / "no-asr-config"），随 port 错误消息透传回页面、最终落
// clipState.noSubtitleReason 供 sidepanel 按原因提示；消息失败/超时的 asr-skip
// 不带 reason（未知，页面归 null 走通用文案）。
export function makeAsrSkipError(cause: unknown, reason = ""): Error & { code: string; reason?: string } {
  const error = new Error(String((cause as Error | undefined)?.message || cause || "ASR 配置缺失"));
  (error as Error & { code: string }).code = "asr-skip";
  if (reason) {
    (error as Error & { code: string; reason: string }).reason = reason;
  }
  return error as Error & { code: string; reason?: string };
}

// 从运行时快照解析 provider（附 Key 与生效语言）。快照关闭 / 无激活平台 /
// 激活平台不在列表中 → 抛 asr-skip（带结构化 reason，见 makeAsrSkipError）。
export function resolveAsrProvider(config: AsrRuntimeConfig): AsrProvider {
  if (config.asrAutoFallback === false) {
    throw makeAsrSkipError("ASR 自动回退未开启", "asr-disabled");
  }
  const activeId = String(config.activeAsrProviderId || "").trim();
  const activeProvider = (config.providers || []).find((p) => p.id === activeId);
  if (!activeProvider) {
    throw makeAsrSkipError("没有激活的语音识别平台", "no-asr-config");
  }
  // 生效转写语言：全局 asrLanguage 设置（popup 顶部切换，默认 auto）；
  // auto 不传语言参数，交服务端自动检测。
  const provider = { ...activeProvider, apiKey: String(config.activeKey || "") };
  provider.language = config.asrLanguage || "auto";
  return provider;
}

export interface AsrTask {
  audioUrl?: string;
  backupUrls?: string[];
}

export interface AsrDecodePort extends chrome.runtime.Port {}

export interface CreateAsrDecodeHandlerDeps {
  onTaskTerminal: (port: chrome.runtime.Port) => void;
}

// 收 { task: { audioUrl, backupUrls } }：在 offscreen 文档内完成「下载（HEAD
// 探大小、主备 URL 轮换）→ 解码 → 校验 → 切片 → 逐片转写」，每片转写完成
// 即把文本结果经 port 发回页面（chrome.runtime 消息是 JSON 序列化，二进制
// 跨 context 会变成数字键对象字节全损——音频字节与 API Key 都不出本 context，
// 跨 port 只传文本结果与小 JSON）。provider/Key/语言由本侧直调 background
// 获取，配置级问题以 code "asr-skip" 结束。
export function createAsrDecodeHandler({ onTaskTerminal }: CreateAsrDecodeHandlerDeps) {
  return async function handleAsrDecodeTask(rawTask: unknown, port: AsrDecodePort): Promise<void> {
    const task = rawTask as AsrTask;
    let aborted = false;
    // 确定性失败中止（票 05）：首个不可重试的片级失败即中止整轮，不再为注定
    // 失败的任务切完整条音轨、逐片上传（2 小时视频上限 200MB，见 PRIVACY.md）。
    // 与 aborted（真断连）分开记：收尾不同——aborted 静默取消，fatalAbort 要
    // 把失败原因报出去。
    let fatalAbort = false;
    let fatalFailure: AsrFatalFailure | null = null;
    // 闭包写入、catch 读取：控制流分析在 catch 处只看得到初值 null（transcribe
    // 闭包里的赋值不改外层收窄），直接写 fatalFailure?.kind 会被判成 never。
    // 经函数读取即绕过收窄（函数返回值不参与 CFA）。
    const readFatalFailure = (): AsrFatalFailure | null => fatalFailure;
    // provider 引用供外层 catch 做管线级失败分类（分类要 baseUrl 判 host）。
    let providerRef: AsrProvider | null = null;
    // 已跳过的解码失败段数：中止收尾（catch 的 fatalAbort 分支）也要如实上报它，
    // 故在 try 之外声明——作用域留在 try 内会让中止路径拿不到这个计数。
    let skippedSegments = 0;
    port.onDisconnect.addListener(() => {
      // 断连视为取消：下载/解码/调度各处检查标志并静默退出（原 asr-audio 通道风格）
      aborted = true;
      // 断连即终态：页面已不再等结果，通知入口层做自关判定。下方各早退点
      // （下载/解码/引擎关闭后的 aborted 分支）都经由本监听覆盖，不再各自挂判定。
      onTaskTerminal(port);
    });
    try {
      const audioUrl = String(task?.audioUrl || "").trim();
      if (!audioUrl) {
        throw new Error("asr-decode 任务参数不完整");
      }

      // 运行时配置先行：配置级问题不做任何下载/解码。
      let provider: AsrProvider;
      try {
        provider = resolveAsrProvider(await requestAsrRuntimeConfig());
        providerRef = provider;
      } catch (error) {
        if ((error as { code?: string }).code === "asr-skip") {
          throw error;
        }
        // 消息失败/超时也按配置缺失处理（页面静默 skip，与原 fallback 同语义）
        logWarn("[BILISCRIPT] get-asr-runtime-config failed, skipping asr task", {
          error: getErrorMessage(error)
        });
        throw makeAsrSkipError(error);
      }

      // host 权限预检（ADR-0010 收口）：转写请求在本文档内直发，而 offscreen 查不了
      // chrome.permissions——经 hasHostPermissionFromOffscreen 走 SW 代查一跳，未授权
      // 即以可操作文案失败，连音频都不下载（否则白下载解码一场，最后只报一个看不出
      // 原因的「网络错误：Failed to fetch」）。
      if (!(await hasHostPermissionFromOffscreen(provider.baseUrl))) {
        // 域名未授权归 no-asr-config（票 04 Q1：平台/模型不可用，补救动作是去设置）
        throw Object.assign(new Error(HOST_PERMISSION_HINT), {
          kind: classifyAsrFailure({ source: "platform", body: HOST_PERMISSION_HINT, provider })
        });
      }

      // 适配器与切片计划由 provider.type 决定（原 pipeline 的 ADAPTERS 表与
      // buildChunkPlan 调用随转写迁入 offscreen，页面不再感知平台类型）。
      const adapterEntry = ASR_ADAPTERS[provider.type as keyof typeof ASR_ADAPTERS];
      if (!adapterEntry) {
        throw new Error("暂不支持的平台类型：" + provider.type);
      }
      const chunkSeconds = buildChunkPlan(provider.type).chunkSeconds;

      // 转写调度引擎：解码流式产片 push 进活队列（解码与转写流水线重叠），
      // 每片完成即经 onChunkResult 把文本结果发回页面，不等全部完成。
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
            // 首个不可重试失败 → 中止整轮（票 05）。置位点在这里而不在 engine.ts：
            // engine 的 isAborted 是**只读注入**（设计如此，且票 05 明确禁止给它加
            // 新选项），engine 只消费它——push 拒绝、排队片丢弃并计 droppedByAbort。
            // 本闭包正是「重试耗尽后的那片」所在处（retryAsync 在 engine 的
            // transcribeChunk 内层），故这就是「首个非重试失败中止整轮」的落点。
            if (!aborted && !isRetryableNetworkError(error)) {
              fatalAbort = true;
              fatalFailure = summarizeFailure(error, provider);
            }
            throw error;
          }
        },
        isAborted: () => aborted || fatalAbort,
        concurrency: adapterEntry.concurrency,
        onChunkResult: (chunk, result) => {
          // engine 交付的单片形状 AsrTranscribeResult & { durationSec }；拆开
          // 回传，result 只含适配器结果（text/segments?/…），durationSec 为
          // 兄弟字段。
          const { durationSec, ...adapterResult } = result;
          port.postMessage({
            type: ASR_MSG_CHUNK_RESULT,
            index: chunk.index,
            startSec: chunk.startSec,
            durationSec,
            result: adapterResult
          });
        },
        // 引擎产出的进度文本（语音识别中 N 片…）原样中继给页面
        onProgress: (text) => {
          safePostMessage(port, { type: ASR_MSG_PROGRESS, text });
        }
      });

      // 下载侧流式化：fetch + getReader 增量读，fMP4 判定收满 4MB（或流结束）
      // 判一次，ADTS 段完成即产出——峰值内存 O(下载缓冲窗口 + 单段 + 单片），
      // 音轨长度与内存解耦。主备 URL 轮换、HEAD 探大小、abort 检查与错误文案
      // 语义与原 fetchAudioBytes（整段 arrayBuffer 常驻 ≤200MB）逐行对应。
      // 累计下载量上限（工单 04）：HEAD 探大小只挡 CDN 诚实返回 Content-Length
      // 的超长视频，GET 流式读由 downloadCapBytes（asr/protocol.js 单源常量）
      // 兜底——跨主备 URL 累计，超限即 cancel 连接、报可读错误。
      const source = streamAudioSegments([audioUrl, ...(task?.backupUrls || [])], () => aborted);
      const first = await source.next();
      if (first.done) {
        // 生成器耗尽只发生在 abort 早退（全部 URL 失败/空体时直接抛「音频下载失败」）
        return;
      }

      let totalChunks: number | undefined;
      // fMP4 音轨拆 ADTS 分段，逐段解码 + 流式切片喂入转写引擎（有界
      // 内存）。历史背景：旧实现把整条音轨一次性 decodeAudioData——4 小时视频在
      // 48kHz 双声道下产出 ~6.4GB Float32 AudioBuffer，offscreen 渲染进程被 OOM
      // 击杀，扩展整包崩溃。分段后峰值降到 O(单段 + 单片），音轨长度不再受内存
      // 限制。段级解码降级（Q8a）：单段失败重试 1 次，仍失败跳过计数继续。
      const AudioCtor = (globalThis as typeof globalThis & { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext || (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) {
        throw new Error("当前环境没有 AudioContext，无法解码");
      }
      const audioCtx = new AudioCtor();
      try {
        const stop = () => {
          // fatalAbort 也在这里抛哨兵：中止必须**同时停上游切片**（票 05 义务 1）——
          // 否则 stream-chunker 会把 push() 的 false 变成 ASR_PENDING_CHUNKS_LIMIT_MESSAGE，
          // 用内存上限文案顶替真正的失败原因。下载生成器的 finally 会 cancel 连接。
          if (aborted || fatalAbort) throw ASR_ABORT_SENTINEL;
        };
        // 段来源：首个已就绪的段 + 下载流后续段（下载/提帧/解码/切片全流水，
        // 任何时刻至多持有一个待解码段）。判为 fMP4 但整流后无音帧时生成器
        // 抛「无法从 fMP4 提取音帧」——显式失败。
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
            // streamWavChunks 契约把段声明为 unknown（解码器输入）；本链路的
            // 段恒为 ADTS 提取的 Uint8Array，此处唯一收窄点。
            return resampleTo16kMono(audioCtx, seg as Uint8Array);
          },
          onChunk: (chunk) => {
            stop();
            // 待处理分片上限（工单 04）：push 拒绝（排队深度达 maxPendingChunks）
            // 返回 false，stream-chunker 据此停止新增工作并抛可读错误——
            // 静默丢弃会丢字幕，错误路径让用户重试。
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

      // close() 汇总：acceptedChunks/completedChunks/failedChunks/droppedByAbort。
      // 等待全部在途片消化（最后一片的转写可能晚于解码结束数秒）。
      const summary = await engine.close();
      if (aborted) return;
      // 全部段解码失败（零片产出）才算整体失败；个别段/片失败已跳过计数。
      if (!(summary.acceptedChunks > 0)) {
        throw new Error("音频切片为空，无法转写");
      }
      // 片级失败摘要随 DONE 过界（票 03 Q2：不新开消息类型，ERROR 的管线级语义
      // 不动）：代表失败取首个不可重试的那片（engine 侧已选好），无失败则三个
      // 字段都不出现——页面据此区分「真无人声」与「说得出原因的失败」。
      const failedSummary = summary.representativeFailure
        ? summarizeFailure(summary.representativeFailure.error, provider)
        : null;
      port.postMessage({
        type: ASR_MSG_DONE,
        totalChunks: summary.acceptedChunks,
        skippedSegments,
        failedChunks: summary.failedChunks,
        ...(failedSummary?.kind ? { failedKind: failedSummary.kind } : {}),
        ...(failedSummary?.status !== undefined ? { failedStatus: failedSummary.status } : {}),
        ...(failedSummary?.detail ? { failedDetail: failedSummary.detail } : {})
      });
      // 终态消息发完才通知入口层自关判定（文档关闭后无法再 postMessage）
      onTaskTerminal(port);
    } catch (e) {
      // 收尾次序不可调换（票 05 义务 2：中止必须优先判，否则会被别的文案顶替）：
      // 1) 真断连 → 静默退出（用户已走，与既有语义一致）；
      // 2) 确定性失败中止 → 走**与普通空结果失败相同的出口**：发 DONE（带
      //    failedChunks: 1 与片级失败摘要）而不是 ERROR。中止是片级失败，借
      //    ERROR 会改变它「管线级错误」的语义（票 03 Q2）；而两条路径在 fallback
      //    的同一条空结果分支上落到同一个无字幕出口与同一个 reason（票 05 锁的
      //    是出口与 reason，不锁消息类型）；
      // 3) 其余管线错误 → ERROR + 管线级 kind（媒体来源：下载/解码/切片/空片/
      //    排队上限；未带 kind 的按 media 来源就地补一次分类）。
      if (aborted) {
        return;
      }
      if (fatalAbort) {
        const failure = readFatalFailure();
        safePostMessage(port, {
          type: ASR_MSG_DONE,
          totalChunks: 0,
          skippedSegments,
          failedChunks: 1,
          ...(failure?.kind ? { failedKind: failure.kind } : {}),
          ...(failure?.status !== undefined ? { failedStatus: failure.status } : {}),
          ...(failure?.detail ? { failedDetail: failure.detail } : {})
        });
        onTaskTerminal(port);
        return;
      }
      // error 终态消息经 safePostMessage 收口（port 已断开则吞掉异常），发完
      // 再通知入口层自关判定（断连取消已在上方 aborted 早退 + 断连监听处覆盖，
      // 走不到这里）
      const payload: Record<string, unknown> = { type: ASR_MSG_ERROR, error: String((e as Error | undefined)?.message || e) };
      if ((e as { code?: string }).code) {
        payload.code = (e as { code: string }).code;
      }
      if ((e as { reason?: string }).reason) {
        payload.reason = (e as { reason: string }).reason;
      }
      // 管线级 kind：两处配置抛出点（域名未授权 / baseUrl 未配置）与适配器已自
      // 带 kind，其余（媒体来源的下载/解码/切片）在此就地分类。asr-skip 是
      // 「配置级跳过」而非失败（页面按 code 静默走 skip，reason 归 noSubtitleReason），
      // 不贴失败类别——它与 ERROR 的失败语义是两条路，贴了反而会被误当失败展示。
      // 注意「暂不支持的平台类型：…」**不特判**：票 04 没给规则，故故意落 asr-unknown。
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

// 流式下载音频并产出 ADTS 段（导出仅供测试；fetch/probeSize 为全局注入面，
// 第三参 options.downloadCapBytes 为累计下载量上限的注入面，默认
// ASR_MAX_CUMULATIVE_DOWNLOAD_BYTES）。
// 替代原 fetchAudioBytes 的「整段 response.arrayBuffer() 常驻」：GET 后用
// response.body.getReader() 增量读，每个 chunk 先喂 fMP4 头部判定所需的缓冲
// （收满 HEAD_PROBE_LIMIT 或流结束时判一次，结果缓存），判为 fMP4 则把攒下
// 的头部与后续 chunk 逐个喂 createAdtsExtractor，段完成即 yield（不攒全量）。
// 产出形状：
//   { segment } — 一个已完成分组的 ADTS 段（Uint8Array）
// 下载侧语义与原 fetchAudioBytes 一致：HEAD 仅在首个 URL 前探一次大小；任一
// GET 非 ok 或空体换下一个地址；全部失败抛「音频下载失败」。判为 fMP4 但整流
// 后无音帧：抛「无法从 fMP4 提取音帧」；非 fMP4：抛「音频解码失败：仅支持
// fMP4 音轨」（B 站 fnval=16 音轨均为 fMP4，理论不会走到，历史的全量解码
// 兜底已删）。累计字节跨主备 URL 合计，超 downloadCapBytes 即 cancel 连接并抛
// ASR_DOWNLOAD_LIMIT_MESSAGE（工单 04）。
export async function* streamAudioSegments(
  urls: string[],
  isAborted: () => boolean,
  { downloadCapBytes = ASR_MAX_CUMULATIVE_DOWNLOAD_BYTES }: { downloadCapBytes?: number } = {}
): AsyncGenerator<StreamAudioYield, void, unknown> {
  // 头部判定缓冲上限：4MB，与 isFragmentedMp4 自身的扫描上限（1 << 22）一致
  const HEAD_PROBE_LIMIT = 1 << 22;
  let headDone = false;
  // 累计下载量（工单 04）：跨主备 URL 合计，超过 downloadCapBytes 即中止
  let totalBytes = 0;
  const overDownloadCap = (): boolean => totalBytes > downloadCapBytes;
  for (const url of urls) {
    if (isAborted()) return;
    if (!headDone) {
      await probeSize(url);
      headDone = true;
    }
    if (isAborted()) return;
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      continue;
    }
    const body = response.body;
    if (!(body && typeof body.getReader === "function")) {
      // 异常环境没有流式 body：退回一次性读取（行为等价旧的全量缓冲实现）
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
      // 增量读状态：判定前字节攒进 head（≤4MB）；判为 fMP4 后一次性喂解析器、
      // 后续 chunk 直通；判为非 fMP4 直接抛显式错误（无全量收集兜底）。
      let extractor: ReturnType<typeof createAdtsExtractor> | null = null;
      let head: Uint8Array | null = null;
      let decided = false;
      let isFmp4 = false;
      const decide = () => {
        isFmp4 = isFragmentedMp4(head || new Uint8Array(0));
        decided = true;
        if (isFmp4) {
          // moov 在头部缓冲里（B 站 moov 极小，必在首个 moof 前），ASC 判定
          // 失败由 extractor 默认配置兜底（与原 parseAudioSpecificConfig || {} 一致）
          extractor = createAdtsExtractor(parseAudioSpecificConfig(head || new Uint8Array(0)) || {});
        } else {
          throw new Error("音频解码失败：仅支持 fMP4 音轨");
        }
        // head 留给下方在判定后统一转交解析器
      };
      while (true) {
        if (isAborted()) {
          return; // finally 里 cancel 连接，静默退出
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value && value.length > 0)) continue;
        // 累计下载量超限（工单 04）：停止新增下载，抛可读错误——finally 里
        // cancel 连接，不再拉取后续字节
        totalBytes += value.length;
        if (overDownloadCap()) {
          throw new Error(ASR_DOWNLOAD_LIMIT_MESSAGE);
        }
        if (!decided) {
          head = head ? concatBytes(head, value) : value;
          if (head.length >= HEAD_PROBE_LIMIT) decide();
        }
        if (decided && isFmp4 && head) {
          // 判定后把攒下的头部一次性喂入解析器（头部包含刚到的 value）
          const headBytes = head;
          head = null;
          for (const seg of extractor!.push(headBytes)) yield { segment: seg };
        } else if (decided && isFmp4) {
          for (const seg of extractor!.push(value)) yield { segment: seg };
        }
      }
      if (!decided) {
        // 流结束仍未收满 4MB：用已有头部判定（零字节空体视为本次 GET 失败，
        // 换下一个 URL）
        if (!head) continue;
        decide();
      }
      // 收尾：把头部缓冲喂给解析器 + 最后不足 10 moof 的段
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
        // 流已结束/已关闭，忽略
      }
    }
  }
  throw new Error("音频下载失败");
}

// HEAD 探大小：Content-Length 超上限直接拒绝（超长视频不下载不解码）。
// 探大小只是优化，失败一律让位于 GET：部分 CDN/中间层不支持 HEAD——既有实现
// 只处理了「HEAD 返回非 ok」，但同一批环境里 HEAD 可能直接断连（fetch 抛
// TypeError「Failed to fetch」）而同一 URL 的 GET 正常；那时异常会穿出本函数、
// 终结整个转写任务（表现为「无字幕视频转写瞬间失败」）。异常与「非 ok」同义，
// 都交给 GET 兜底。
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

// 共用解码管线：音频字节 → 16kHz 单声道 Float32Array（decodeAudioData 解码 +
// OfflineAudioContext 重采样 + 空采样校验）。复用调用方传入的 AudioContext：
// fMP4 分段路径整条音轨共用一个、由 handleAsrDecodeTask 在 finally 里统一
// close。decodeAudioData 是 detach 语义，
// bytesToArrayBuffer 传副本避免破坏数据。段级解码 + 段级重采样：Chrome 的
// decodeAudioData 对超长 ADTS 流（完整音轨 ~46MB / 96min）解码失败，实测每段
// （~10 moof / 1MB）可正常解码。
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
