// client.ts — 预算内单次总结的流式 port 适配器（候选 03 后）。
// 职责只剩两块：① 预算策略（resolveSubtitleForContext 判定发送物与超预算回落，
// 「预算判定属策略、溢出检测属协议」——协议细节在 ai/completion.js 接缝）；
// ② port 回吐适配（把 chatCompletion 的 onEvent/onRetry/完成值/类型化错误
// 映射回 offscreen port 协议：token/reasoning/notice/done/stopped/error）。
// 请求构造、SSE 解析、溢出判定、重试策略全部下沉到 ai/completion.js。

import { buildMessages, clipSubtitleForContext } from "./context.js";
import { buildBudgetPlan, estimateTokens, MATERIAL_BUDGET_CHARS } from "./budgeter.js";
import { buildSubtitlePrompt } from "./subtitle-prompt.js";
import { chatCompletion, makeOverflowError, validateProviderBasics } from "./completion.js";
import { runToolLoop, type ToolStatusPayload, type ToolLoopSearchOutcome } from "./tool-loop.js";
import type { AiContext, AiProvider, ImagePart, StreamChatEvent } from "./types.js";
// 出向 port 协议单源（ticket 08）：port 回吐点经 ChatPortMessage 联合标注，
// 裸 postMessage 字面量获得编译期约束（事件名 typo / 形状漂移编译被拒）。
import type { ChatPort, ChatPortMessage } from "../chat/protocol.js";
// 07 票 token 合帧：流式 token 按窗口预算批传，削减结构化克隆次数；
// 单 token 批次仍走普通 token 事件（慢速流线格式与旧一致）。
import { TokenBatcher } from "./token-batcher.js";

// 超预算回落时的提示文案：如实描述——本次单次调用不发，ladder 收到
// overflow 标记错误后立即转 Map-Reduce 分段整理（对用户表现为进度逐段推进）。
export const OVER_BUDGET_NOTICE = "字幕过长，已切换为分段整理模式";

// 截断提示（finishReason="length"）：命中 max_tokens 后 SSE 只是结束，界面上没有
// 任何迹象——不提示的话用户只会觉得「模型没答完」。文案只陈述事实，不猜是思考
// 吃掉了预算还是问题本身太长。
export const TRUNCATED_NOTICE = "回答被截断（达到模型输出上限）";

interface SubtitleResolution {
  markdown: string;
  mode: "single" | "map-reduce";
  notice: string;
  overflowMarked: boolean;
}

/**
 * 决定给模型的字幕：素材预算内（≤200k 字符）整篇原样；超预算回落 50k 硬截断并打标记。
 * 纯函数，streamChat 只负责消费返回的 { markdown, mode, notice, overflowMarked }。
 * 预算输入与发送物同源：发送物由 subtitle-prompt 的 buildSubtitlePrompt 从
 * subtitleBody 现场渲染（追问压缩路径则直接用 compressedSummaryMarkdown 文本产物）；
 * body 缺失/空时退化为对实际发送物（空渲染或压缩摘要）的 estimateTokens 判定。
 */
export function resolveSubtitleForContext(context: AiContext | null | undefined): SubtitleResolution {
  const ctx = context || {};
  const body = Array.isArray(ctx.subtitleBody) ? ctx.subtitleBody : [];
  // 追问压缩路径：压缩摘要本身就是最终发送物，预算按其实际长度估 token。
  const markdown = String(ctx.compressedSummaryMarkdown || "")
    || buildSubtitlePrompt({
      body,
      chapters: ctx.chapters,
      videoDuration: ctx.videoDuration,
      includeTimestampInBody: ctx.includeTimestampInBody
    });

  let mode: "single" | "map-reduce";
  if (body.length > 0) {
    mode = buildBudgetPlan({ body, chapters: ctx.chapters }).mode;
  } else {
    // body 缺失/空：对实际发送物估 token（空渲染 ≈ 0 → single；压缩摘要按其长度判定）。
    mode = estimateTokens(markdown) > MATERIAL_BUDGET_CHARS ? "map-reduce" : "single";
  }

  if (mode === "single") {
    return { markdown, mode, notice: "", overflowMarked: false };
  }

  return {
    markdown: clipSubtitleForContext(markdown),
    mode,
    notice: OVER_BUDGET_NOTICE,
    overflowMarked: true
  };
}

interface StreamChatInput {
  provider: AiProvider;
  context?: AiContext | null;
  userPrompt?: string;
  history?: unknown[];
  // 图片输入（image-input 路线 B）：本轮用户消息的图片（宿主粘贴 → content 侧
  // 压缩后的 WebP base64），透传给 buildMessages 挂在末条 user 消息上。
  userImages?: ImagePart[];
  port: ChatPort;
  signal?: AbortSignal | null;
  onActivity?: () => void;
  thinkingLevel?: string;
  // 联网搜索管线（spec §2.3）：传入即走 ai/tool-loop.ts 的工具循环（对话 tab
  // toggle 开启且已配置搜索平台时由 offscreen 注入；Map-Reduce 轮由 ladder 剥离）。
  webSearch?: { maxToolCalls: number; executeSearch: (query: string) => Promise<ToolLoopSearchOutcome> };
}

/**
 * 流式 port 适配器：对外签名不变（ladder 消费点最小改动），内部经
 * ai/completion.js 接缝发请求。port 协议不变（token 之外）：
 * - token 事件经 TokenBatcher 按 30~50ms 窗口预算批传（07 票，削减结构化克隆
 *   次数；单 token 批次仍走普通 token 事件）；reasoning 等其余事件前先把积压
 *   token 收口，全局顺序与逐 token 传输一致；每个原始事件重挂空闲超时（onActivity）；
 * - 读流中断重试：新流事件前回吐一条 stream-reset（代际重置信号，渲染层
 *   清空本条消息缓冲整体重放，避免两代流拼接成重复文本）；
 * - 重试提示经 notice（读流中断重试保持旧现状：不打扰用户）；
 * - 截断提示经 notice 的 code 分支（不新增事件类型）：最后一轮 finishReason="length"
 *   （max_tokens 命中）时在 done 之前补一条 { data: TRUNCATED_NOTICE, code:"truncated" }，
 *   宿主据此渲染消息尾部的常驻徽标（不再走 4 秒通知条）；
 * - 成功回吐 done；中止回吐 stopped；其余失败回吐 error；
 * - 仅 context-length 溢出（含预算内超限）以带 .overflow 标记的错误上抛，
 *   供 ladder「catch 查标记」分流（单次转 Map-Reduce / 追问报错）。
 */
export async function streamChat({ provider, context, userPrompt, history, userImages, port, signal, onActivity, thinkingLevel, webSearch }: StreamChatInput): Promise<{ done: true } | undefined> {
  if (!port) return;

  // 基础校验单点下沉 completion（arch-slim-3/09）：port 适配层 catch 后转回吐，
  // 两条错误文案与 chatCompletion 同源，不再双抄。
  try {
    validateProviderBasics(provider);
  } catch (error) {
    port.postMessage({ type: "error", error: (error as Error).message } satisfies ChatPortMessage);
    return;
  }

  const subtitleResolution = resolveSubtitleForContext(context);
  if (subtitleResolution.notice) {
    port.postMessage({ type: "notice", data: subtitleResolution.notice } satisfies ChatPortMessage);
  }
  if (subtitleResolution.overflowMarked) {
    // 超预算：仍先提示，再以 overflow 标记错误上抛供 ladder 转 Map-Reduce。
    throw makeOverflowError(OVER_BUDGET_NOTICE);
  }

  const messages = buildMessages({
    // buildMessages 与 resolveSubtitleForContext 从同一份 subtitleBody /
    // compressedSummaryMarkdown 渲染，无需再注入任何渲染产物字段。
    context,
    userPrompt,
    history,
    // 图片输入（image-input 路线 B）：挂在本轮 user 消息上（无图时不带字段）。
    images: userImages,
    systemPrompt: context?.aiSystemPrompt,
    // 联网轮保留历史中的 assistant(tool_calls)/tool 消息（OpenAI 协议合法）；
    // 无 tools 轮整体丢弃（部分平台对无 tools 请求里的 tool 消息报 4xx）。
    includeToolHistory: Boolean(webSearch)
  });

  // 07 票 token 合帧：token 事件经窗口预算批传（削减 port 结构化克隆次数），
  // 其余事件（reasoning/notice/reset/done/stopped/error）前先把积压 token 收口，
  // 全局顺序与逐 token 传输一致；单 token 批次回落普通 token 事件。
  const tokenBatcher = new TokenBatcher({
    onFlush: (tokens) => {
      if (tokens.length === 1) {
        port.postMessage({ type: "token", data: tokens[0] } satisfies ChatPortMessage);
      } else {
        port.postMessage({ type: "token-batch", data: tokens } satisfies ChatPortMessage);
      }
    }
  });
  const flushTokens = () => tokenBatcher.flush();

  // 最近一轮的 finishReason（"length" = 输出被 max_tokens 截断）：逐轮回调只写、
  // 收口时读一次——联网轮中间工具轮的 reason 会被最终轮覆盖，不误标最终回答。
  let lastFinishReason: string | null = null;

  try {
    // 逐轮共用的流事件适配（单次与工具循环同款）：流式活动重挂空闲超时、
    // token 合帧、非 token 事件先 flush 再回吐。
    const streamCallbacks = {
      onEvent: (event: StreamChatEvent) => {
        // 流式活动：重挂空闲超时（每个原始事件一次，合帧窗口内活动信号不丢）。
        onActivity?.();
        if (event.type === "token") {
          tokenBatcher.push(event.data);
          return;
        }
        // 非 token 事件不得越过积压 token（渲染顺序）：先 flush 再回吐。
        flushTokens();
        if (event.type === "tool-call") {
          // 引擎级 tool-call 事件（spec §2.2）不出 port：UI 面向的 tool-status
          // 由 tool-loop 的 onToolStatus 回吐（查询/结果数/平台语义更全）。
          return;
        }
        port.postMessage(event);
      },
      onStreamReset: () => {
        // 读流中断重试：先吐出旧流尾巴（不丢 token），再通知渲染层清空本条
        // 消息缓冲，从头接收重试流。
        onActivity?.();
        flushTokens();
        port.postMessage({ type: "stream-reset" } satisfies ChatPortMessage);
      },
      onRetry: ({ attempt, maxRetries, kind, error }: { attempt: number; maxRetries: number; kind: string; error: Error }) => {
        if (kind === "stream") {
          // 读流中断重试保持旧现状：不额外打扰用户。
          return;
        }
        port.postMessage({
          type: "notice",
          data: kind === "http"
            ? `${error.message}，正在重试...`
            : `连接中断，正在重新连接（${attempt}/${maxRetries}）...`
        } satisfies ChatPortMessage);
      },
      onFinishReason: (reason: string | null) => {
        // 只记最近一轮的 finishReason，收口时再发（见 done 前那条 notice）：命中
        // max_tokens 时 SSE 只是结束、界面没有任何迹象；而联网轮的中间工具轮也走
        // 这个回调，"last wins" 保证被后续正常轮覆盖，不误标最终回答。
        lastFinishReason = reason;
      }
    };

    if (webSearch) {
      // 联网轮：ai/tool-loop.ts 编排多轮 chatCompletion；notice / tool-status /
      // tool-turn 同走「先 flush 再回吐」纪律，tool-turn 为宿主持久化副本
      //（spec §2.5，tool 内容已截断）。
      await runToolLoop({
        provider,
        messages,
        stream: true,
        signal,
        thinkingLevel,
        maxToolCalls: webSearch.maxToolCalls,
        executeSearch: webSearch.executeSearch,
        ...streamCallbacks,
        onNotice: (text) => {
          onActivity?.();
          flushTokens();
          port.postMessage({ type: "notice", data: text } satisfies ChatPortMessage);
        },
        onToolStatus: (payload: ToolStatusPayload) => {
          onActivity?.();
          flushTokens();
          port.postMessage({ type: "tool-status", ...payload } satisfies ChatPortMessage);
        },
        onToolTurn: (toolMessages) => {
          port.postMessage({ type: "tool-turn", messages: toolMessages } satisfies ChatPortMessage);
        }
      });
    } else {
      await chatCompletion({
        provider,
        messages,
        stream: true,
        signal,
        thinkingLevel,
        ...streamCallbacks
      });
    }
  } catch (e) {
    if ((e as { overflow?: boolean })?.overflow) {
      // 溢出上抛：ladder 据标记分流（单次转 Map-Reduce / 追问报错），不经 port error。
      throw e;
    }
    if ((e as { aborted?: boolean })?.aborted || signal?.aborted) {
      // 中止收束：对齐旧 streamChat 的停止 UX，不串错误。先 flush 尾巴不丢 token。
      flushTokens();
      port.postMessage({ type: "stopped", reason: "已停止生成" } satisfies ChatPortMessage);
      return;
    }
    flushTokens();
    port.postMessage({ type: "error", error: String((e as { message?: unknown })?.message ?? e) } satisfies ChatPortMessage);
    return;
  }

  // 流正常收口：先 flush 最后一批 token，再发 done。
  flushTokens();
  // 截断（最后一轮 finishReason="length"）：在 done 之前补一条带 code 的 notice，
  // 宿主据此在消息尾部渲染常驻徽标（不走 4 秒通知条）。只提示，不重试。
  if (lastFinishReason === "length") {
    port.postMessage({ type: "notice", data: TRUNCATED_NOTICE, code: "truncated" } satisfies ChatPortMessage);
  }
  port.postMessage({ type: "done" } satisfies ChatPortMessage);
  return { done: true };
}
