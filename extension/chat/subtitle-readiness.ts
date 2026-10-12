// extension/chat/subtitle-readiness.ts — 发送前「字幕就绪」判定的单源视图。
//
// 为什么存在：发送闸要问的四个问题——「字幕还在抓/转写吗」（等待闸）、
// 「是不是确实没字幕」（无字幕拦截）、「抓取是不是失败了」（失败拦截）、
// 「要不要立刻出等待提示」（即时提示）——判据只有两个字段（字幕体是否为空 +
// subtitleFetchState，等待闸再叠加 asrTranscribingActive 兜底信号），但输入
// 形状有两个：content 侧进程内权威状态（clip，抓取发起方与落账方都写它）与
// 对话侧上下文快照（clip 在装配时刻的投影，发送闸放行前重取的是它）。本模块
// 把两个形状投影成同一份 SubtitleReadiness，四个谓词只读视图，判定不再按
// 形状各写一份。
//
// 空视图语义：快照为 null（读取失败）投影为 null 视图，四个谓词一律 false。
// 读取失败不是本模块的结论——调用方拿到读取成败（ok=false）后走各自失败路径。
//
// 口径（ADR-0017 决定 6，冻结）：即时等待提示 wantsWaitNotice 只看 clip 的
// loading，不看 asrTranscribingActive——转写等待并入转写状态行（另一条呈现
// 路由），消息区不重复提示。等待闸 isPending 反之：转写广播是它在快照状态被
// 清掉（resetClipState 置 idle）时的兜底信号。

import type { ChatSessionContextSnapshot } from "./chat-state.js";
import type { ClipState, SubtitleFetchState } from "../core/state.js";

// 就绪视图：判定的唯一输入。hasBody 是「字幕体非空」（非空即就绪，优先于一切
// 状态字段）；asrActive 只有快照入口能填（clip 侧没有转写广播信号）。
export interface SubtitleReadiness {
  hasBody: boolean;
  fetchState: SubtitleFetchState;
  asrActive: boolean;
}

// 字幕体的容错口径（与迁移前的判定一致）：非数组一律折算为空。
function hasSubtitleBody(body: unknown): boolean {
  return Array.isArray(body) && body.length > 0;
}

// 快照的状态字段经 AiContext 的开放索引签名读出为 unknown：只认联合内的字面量，
// 缺失/脏值折算 idle（与 core/context-payload 组装工厂的缺省口径一致）。
function normalizeFetchState(value: unknown): SubtitleFetchState {
  return value === "loading" || value === "ready" || value === "error" || value === "empty" ? value : "idle";
}

// clip 入口：content 侧进程内权威状态。asrActive 恒 false——转写广播
//（asrTranscribingActive）只活在对话侧 chat-state，不在 clip 上。
export function readinessFromClip(clip: Pick<ClipState, "subtitleBody" | "subtitleFetchState">): SubtitleReadiness {
  return {
    hasBody: hasSubtitleBody(clip.subtitleBody),
    fetchState: normalizeFetchState(clip.subtitleFetchState),
    asrActive: false
  };
}

// 快照入口：对话侧上下文快照（可空）。null/undefined → null 视图，谓词全 false。
export function readinessFromSnapshot(
  snapshot: ChatSessionContextSnapshot | null | undefined,
  { asrTranscribingActive = false }: { asrTranscribingActive?: boolean } = {}
): SubtitleReadiness | null {
  if (!snapshot) {
    return null;
  }
  return {
    hasBody: hasSubtitleBody(snapshot.subtitleBody),
    fetchState: normalizeFetchState(snapshot.subtitleFetchState),
    asrActive: asrTranscribingActive === true
  };
}

// 等待闸：还在抓取（loading）或还在音频转写（广播兜底）时挂住发送；字幕体非空
// 即视为就绪，不受两个信号影响。
export function isPending(view: SubtitleReadiness | null | undefined): boolean {
  return view != null && !view.hasBody && (view.fetchState === "loading" || view.asrActive);
}

// 无字幕收尾：抓完了、确实没有字幕（empty 且字幕体为空）。
export function isNoSubtitleEmpty(view: SubtitleReadiness | null | undefined): boolean {
  return view != null && !view.hasBody && view.fetchState === "empty";
}

// 抓取失败收尾：抓取过程失败、结果未知（error 且字幕体为空）。失败前落账的
// 完整字幕不受影响（字幕体非空即放行）。
export function isSubtitleFetchFailed(view: SubtitleReadiness | null | undefined): boolean {
  return view != null && !view.hasBody && view.fetchState === "error";
}

// 即时等待提示：clip 还在抓取且字幕体为空时，消息区立刻出提示条，不等等待闸
// 首轮轮询。快照被清但转写广播活跃的窗口不由本谓词呈现（见文件头注的口径）。
export function wantsWaitNotice(view: SubtitleReadiness | null | undefined): boolean {
  return view != null && !view.hasBody && view.fetchState === "loading";
}
