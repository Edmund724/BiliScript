// ladder.ts — 聊天「阶梯」分派策略（ADR-0001）的深模块：
// 预算内单次流式 → 超预算 Map-Reduce 分段编排（含追问压缩、成本护栏）→
// 单次溢出转 Map-Reduce 重试一次。所有依赖经 deps 注入（含 postMessage
// 所用的 port），便于在无 chrome 环境下逐分支注入 fake 做测试。
// offscreen.js 只负责接线：abort controller、空闲超时、cost-guard Promise 簿记。
// 溢出语义（候选 03 起）：streamChat 仅在 context-length 溢出时抛带
// .overflow 标记的错误，本模块 catch 查标记分流；其余失败经 port error 回吐。
import { streamChat as _streamChat } from "./client.js";
import { buildBudgetPlan as _buildBudgetPlan } from "./budgeter.js";
import { orchestrateMapReduce as _orchestrateMapReduce } from "./map-reduce.js";
import { resolveFollowupContext as _resolveFollowupContext } from "./followup-router.js";
import { trimRecentTurns as _trimRecentTurns } from "./followup-context.js";
import { buildCostGuardNotice as _buildCostGuardNotice } from "./cost-guard.js";
import { acquireSwKeepalive as _acquireSwKeepalive, type SwKeepaliveHandle } from "./sw-keepalive.js";
// 图片合法性白名单（image-input 路线 B）：与历史加载侧同一份判定（01 号票的
// 单点），port 载荷在阶梯入口归一后随 streamChat 下发。
import { normalizeImageParts } from "./conversation.js";
import type { ImagePart } from "./types.js";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatContext {
  subtitleBody?: unknown[];
  chapters?: unknown[];
  [key: string]: unknown;
}

export interface ChatMsg {
  context?: ChatContext;
  history?: ChatMessage[];
  prompt?: string;
  thinkingLevel?: string;
  // 图片输入（image-input 路线 B）：本轮用户消息的图片（宿主粘贴 → content 侧
  // 压缩后的 WebP base64）。port 载荷宽容解析（normalizeImageParts 白名单）。
  images?: unknown;
  [key: string]: unknown;
}

export interface ChatProvider {
  id?: string;
  apiKey?: string;
  [key: string]: unknown;
}

export interface ChatPort {
  postMessage(message: unknown): void;
}

// ladder deps 契约的预算计划窄面：mode 必选，估算字段可选（注入方假实现只给
// mode 也能过编译）。字段名单源自 ai/types 的同名全量定义，经 Pick 单源收窄。
export type BudgetPlan = Pick<import("./types.js").BudgetPlan, "mode"> &
  Partial<Pick<import("./types.js").BudgetPlan, "estimatedCalls" | "estimatedTokens">>;

// executeSearch 的窄面（ai/tool-loop.ts 的 ToolLoopSearchOutcome 同形，此处
// 结构化窄面，测试注入方少填字段也能过编译）。
export interface WebSearchRuntime {
  maxToolCalls: number;
  executeSearch: (query: string) => Promise<{ results: unknown[]; platform: string }>;
}

export interface StreamChatArgs {
  provider: ChatProvider;
  context: ChatContext;
  userPrompt: string;
  history: ChatMessage[];
  // 图片输入（image-input 路线 B）：本轮用户消息的图片（无图时 undefined）。
  userImages?: ImagePart[];
  thinkingLevel?: string;
  port: ChatPort;
  signal: AbortSignal | string | null;
  onActivity?: () => void;
  // 联网搜索管线（spec §2.3）：传入即走 ai/tool-loop 的工具循环；Map-Reduce
  // 归约轮剥离 + notice，追问压缩与单次路径透传。
  webSearch?: WebSearchRuntime;
}

export type StreamChatFn = (args: StreamChatArgs) => Promise<unknown>;

export interface OrchestrateMapReduceArgs {
  provider: ChatProvider;
  context: ChatContext;
  plan: BudgetPlan;
  port: ChatPort;
  signal: AbortSignal | string | null;
  thinkingLevel?: string;
  onProgress: (notice: string) => void;
}

export type OrchestrateMapReduceFn = (args: OrchestrateMapReduceArgs) => Promise<unknown>;

export interface ResolveFollowupContextArgs {
  context: ChatContext;
  plan: BudgetPlan;
  history: ChatMessage[];
  userPrompt: string;
}

export type ResolveFollowupContextFn = (args: ResolveFollowupContextArgs) => Promise<ChatContext | null>;

// 以下两个注入函数类型与 CostGuardNotice 仅本模块的 deps 契约使用（arch-slim-2/08
// 裁定：与 ai/analysis.ts 的同名私有声明形状不同——本侧严格（必选参数/number 档）、
// analysis 侧宽松（可选属性/unknown 档，供测试 fake 少填字段），刻意不合并、各自
// 私有，消除「同名平行导出」）。
type BuildBudgetPlanFn = (args: { body: unknown[]; chapters: unknown[] }) => BudgetPlan;

interface CostGuardNotice {
  shouldPrompt: boolean;
  message: string;
}

type BuildCostGuardNoticeFn = (args: { estimatedCalls?: number; estimatedTokens?: number }) => CostGuardNotice;

export type TrimRecentTurnsFn = (history?: ChatMessage[]) => ChatMessage[];

export interface RunLadderChatArgs {
  msg: ChatMsg;
  provider: ChatProvider;
  port: ChatPort;
  signal: AbortSignal | string | null;
  // 联网搜索运行时（spec §2.3）：offscreen 在 webSearchEnabled 且已配置激活
  // 平台时注入；undefined = 本轮无联网（toggle 关 / 未配置 / 解析失败）。
  webSearch?: WebSearchRuntime;
}

export interface RunLadderChatDeps {
  streamChat?: StreamChatFn;
  orchestrateMapReduce?: OrchestrateMapReduceFn;
  resolveFollowupContext?: ResolveFollowupContextFn;
  buildBudgetPlan?: BuildBudgetPlanFn;
  buildCostGuardNotice?: BuildCostGuardNoticeFn;
  trimRecentTurns?: TrimRecentTurnsFn;
  askCostGuard: (port: ChatPort, message: string) => Promise<unknown>;
  onActivity?: () => void;
  pauseIdleTimeout?: () => void;
  // 08 票 SW 保活缝：运行期间持有 offscreen → SW 长连端口防冷启动，
  // 缺省真实 acquire（无 chrome 环境返回 null，跳过保活）。
  acquireSwKeepalive?: () => SwKeepaliveHandle | null;
}

/**
 * 执行阶梯分派。args：
 * - msg: offscreen-chat 端口收到的 chat 消息（context / history / prompt / thinkingLevel）
 * - provider: 已注入 apiKey 的 provider 对象
 * - port: 回吐 notice / error / stopped 的端口
 * - signal: 本次请求的 AbortSignal（由 offscreen 的 abort controller 提供）
 * deps：streamChat / orchestrateMapReduce / resolveFollowupContext / buildBudgetPlan /
 *       buildCostGuardNotice / trimRecentTurns / askCostGuard，以及两个簿记回调：
 * - onActivity(): 收到流式活动时重挂空闲超时（offscreen.armIdleTimeout）
 * - pauseIdleTimeout(): 等待用户成本确认期间暂停空闲超时计时
 * 全部可注入（默认用真实模块），便于在无 chrome 环境下逐分支注入 fake 做测试；
 * askCostGuard 依赖 offscreen 的 Promise 簿记，必须由 offscreen 注入。
 */
export async function runLadderChat(
  { msg, provider, port, signal, webSearch }: RunLadderChatArgs,
  deps: RunLadderChatDeps
): Promise<void> {
  const streamChat: StreamChatFn = deps.streamChat ?? (_streamChat as unknown as StreamChatFn);
  const orchestrateMapReduce: OrchestrateMapReduceFn = deps.orchestrateMapReduce ?? (_orchestrateMapReduce as unknown as OrchestrateMapReduceFn);
  const resolveFollowupContext: ResolveFollowupContextFn = deps.resolveFollowupContext ?? (_resolveFollowupContext as unknown as ResolveFollowupContextFn);
  const buildBudgetPlan: BuildBudgetPlanFn = deps.buildBudgetPlan ?? (_buildBudgetPlan as unknown as BuildBudgetPlanFn);
  const buildCostGuardNotice: BuildCostGuardNoticeFn = deps.buildCostGuardNotice ?? (_buildCostGuardNotice as unknown as BuildCostGuardNoticeFn);
  const trimRecentTurns: TrimRecentTurnsFn = deps.trimRecentTurns ?? (_trimRecentTurns as unknown as TrimRecentTurnsFn);
  const { askCostGuard, onActivity, pauseIdleTimeout } = deps;

  // 08 票 SW 保活：本次运行（单次流式 / Map-Reduce / 追问压缩）全程持有
  // offscreen → SW 长连端口，防段缓存消息反复冷启动 SW（30s 空闲回收）；
  // 覆盖成本护栏等待与追问小结加载，结束/异常经 finally 释放。
  const keepalive = (deps.acquireSwKeepalive ?? _acquireSwKeepalive)();
  try {
    await runLadderChatDispatch({ msg, provider, port, signal, webSearch }, {
      streamChat,
      orchestrateMapReduce,
      resolveFollowupContext,
      buildBudgetPlan,
      buildCostGuardNotice,
      trimRecentTurns,
      askCostGuard,
      onActivity,
      pauseIdleTimeout
    });
  } finally {
    keepalive?.release();
  }
}

// 阶梯分派本体的依赖面：RunLadderChatDeps 的分派字段（保活缝由外层持有，不在列）。
type LadderDispatchDeps = Required<Pick<RunLadderChatDeps,
  "streamChat" | "orchestrateMapReduce" | "resolveFollowupContext" | "buildBudgetPlan" |
  "buildCostGuardNotice" | "trimRecentTurns" | "askCostGuard">> &
  Pick<RunLadderChatDeps, "onActivity" | "pauseIdleTimeout">;

// 阶梯分派本体：与保活生命周期解耦，runLadderChat 统一 try/finally 释放端口。
async function runLadderChatDispatch(
  { msg, provider, port, signal, webSearch }: RunLadderChatArgs,
  {
    streamChat,
    orchestrateMapReduce,
    resolveFollowupContext,
    buildBudgetPlan,
    buildCostGuardNotice,
    trimRecentTurns,
    askCostGuard,
    onActivity,
    pauseIdleTimeout
  }: LadderDispatchDeps
): Promise<void> {
  // 阶梯分派：预算内（≤200k 字符）走单次流式；超预算走 Map-Reduce 分段编排。
  const plan = buildBudgetPlan({
    body: Array.isArray(msg.context?.subtitleBody) ? msg.context.subtitleBody : [],
    chapters: Array.isArray(msg.context?.chapters) ? msg.context.chapters : []
  });
  // 图片输入（image-input 路线 B）：本轮用户消息的图片经白名单归一后随两条
  // streamChat 路径（追问压缩 / 单次）下发；非法项丢弃、空则 undefined。
  // Map-Reduce 主路径不进 history、各段现造 user 消息，图片不参与（04 号票）。
  const userImages = normalizeImageParts(msg.images);
  if (plan.mode === "map-reduce") {
    // 追问压缩：已有成稿笔记 + 分段小结时，改走「压缩摘要 + 检索注入 + 单次调用」，
    // 不再重跑 Map-Reduce（token 随追问近乎常数）。
    const followupContext = await resolveFollowupContext({
      context: msg.context || {},
      plan,
      history: Array.isArray(msg.history) ? msg.history : [],
      userPrompt: msg.prompt || ""
    });
    if (followupContext) {
      // 近 N 轮 verbatim 封顶：只带最近几轮历史，token 不随追问轮数增长。
      const trimmedHistory = trimRecentTurns(msg.history);
      try {
        await streamChat({
          provider,
          context: followupContext,
          userPrompt: msg.prompt || "",
          history: trimmedHistory,
          userImages,
          thinkingLevel: msg.thinkingLevel,
          port,
          signal,
          onActivity,
          // 追问压缩路径是单次流式调用（非归约轮），联网可用（spec Q12）。
          webSearch
        });
      } catch (e) {
        // 兜底：压缩摘要 + 检索注入仍意外溢出（HTTP context-length）时，绝不静默无输出。
        // streamChat 仅在溢出时抛带 .overflow 标记的错误（其余失败经 port error 回吐）。
        if (!(e as { overflow?: boolean }).overflow) {
          throw e;
        }
        port.postMessage({ type: "error", error: "追问内容仍超出上下文预算，请换个更具体的问题重试" });
      }
      return;
    }

    // 成本护栏：发起 Map-Reduce 前预估 ≥5 次调用 → 弹确认，可取消。
    const guard = buildCostGuardNotice({
      estimatedCalls: plan.estimatedCalls,
      estimatedTokens: plan.estimatedTokens
    });
    if (guard.shouldPrompt) {
      // 等待用户成本确认期间暂停空闲超时计时。
      pauseIdleTimeout?.();
      const confirmed = Boolean(await askCostGuard(port, guard.message));
      if (!confirmed) {
        port.postMessage({ type: "stopped", reason: "已取消" });
        return;
      }
    }

    // 编排期间整体暂停空闲超时：Map-Reduce 全部为非流式 chatCompletion，段调用
    // 期间没有任何流式活动可重挂 90 秒窗口，慢模型单段超窗会误杀整个运行（根治
    // [90s-idle] 诊断）。进度仍逐段回吐；真正挂死由用户「停止」兜底。
    pauseIdleTimeout?.();
    // 联网开关开启时归约轮静默禁用搜索（spec Q12：归约轮不联网）。
    if (webSearch) {
      port.postMessage({ type: "notice", data: "超长内容归约中，本轮不联网" });
    }
    await orchestrateMapReduce({
      provider,
      context: msg.context || {},
      plan,
      port,
      signal,
      thinkingLevel: msg.thinkingLevel,
      onProgress: function (notice: string) {
        // 进度回吐；不重挂空闲超时（本路径计时已整体暂停，见上）。
        port.postMessage({ type: "notice", data: notice });
      }
    });
    return;
  }

  // 单次路径 context-length 溢出 → 自动转 Map-Reduce 重试一次
  //（仅一次：map-reduce 各调用自身更短，再溢出就抛出错误；abort controller 复用，stop 仍可中止）。
  // streamChat 仅在溢出（预算内超限 / HTTP context-length）时抛带 .overflow 标记的错误。
  try {
    await streamChat({
      provider,
      context: msg.context || {},
      userPrompt: msg.prompt || "",
      history: Array.isArray(msg.history) ? msg.history : [],
      userImages,
      thinkingLevel: msg.thinkingLevel,
      port,
      signal,
      onActivity,
      webSearch
    });
  } catch (e) {
    if (!(e as { overflow?: boolean }).overflow) {
      throw e;
    }
    // 编排期间整体暂停空闲超时（语义同上方 map-reduce 主路径）。
    pauseIdleTimeout?.();
    // 溢出转 Map-Reduce 同为归约轮：静默禁用搜索 + notice（spec Q12）。
    if (webSearch) {
      port.postMessage({ type: "notice", data: "超长内容归约中，本轮不联网" });
    }
    await orchestrateMapReduce({
      provider,
      context: msg.context || {},
      plan,
      port,
      signal,
      thinkingLevel: msg.thinkingLevel,
      onProgress: function (notice: string) {
        // 进度回吐；不重挂空闲超时（本路径计时已整体暂停，见上）。
        port.postMessage({ type: "notice", data: notice });
      }
    });
  }
}
