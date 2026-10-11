// extension/chat/send-gate.ts — 发送闸（CONTEXT.md 词条「发送闸」）：发送前
// 上下文就绪事务。自 reader/chat-tab.ts 抽取（arch-review-2026-09 候选 1 下半），
// 逻辑与文案逐字保持，仅编排回调经 deps 注入。
//
// 吞下的事务：
//   1. ensureContextForSend（原 ensureCurrentContextForSend，G1-G7）——发送前
//      确保当前上下文就绪：pinned 对话补水（G1）/ 普通对话读当前页（G2）/
//      抓取未起跑或上一轮失败时主动起跑（G3）/ 字幕等待闸 poll-wait（G4）/
//      放行前重取快照（G5）/ 无字幕或抓取失败的空上下文拦截（G6）/ 历史回放
//      让位（G7，放行路径 await replayInFlight）。受理结论经 GateOutcome 显式
//      返回，不再用字符串哨兵与调用方的副作用推断。等待方向是单向的（C′ 复核）：
//      发送等回放让位，回放不等任何东西——在途回合的停流结算（turn-lifecycle
//      的 settled）由历史项点击接缝 await，不进本闸、也不进 replay（否则成结构死锁）。
//   2. subtitleWaiter 组装（等待闸状态机本体在 ./subtitle-wait.ts）：pollContext
//      的 live-first 快照读法、等待提示按「是否转写中」路由（转写并入状态行，
//      抓取走消息区 notice，带加载动画）、4 秒轮询定时器。判定要等待时本闸不等
//      首轮轮询，立即显示提示；等待区间经 deps.onWaitingChange 通知调用方
//      （发送键禁用 / placeholder 换文案）。
//   3. 字幕状态总线订阅（转写相位与 subtitle-ready → setAsrTranscribingActive
//      意图原语 + kick 等待闸 + 清抓取文案 notice）与转写状态行（asrNotice）。
//   4. startSubtitleFetchIfNeeded 的判定门（BV 匹配 / 字幕体已在 / 仅 idle 或
//      error 起跑），起跑动作本身（ensure 链 + 刷新请求）留在组合根，经
//      startSubtitleFetch 注入。
//
// 读侧闭包约定（与 chat-tab 原注释一致）：deps 里的页面级状态经惰性 getter
// 读取，回调执行时取值——不写死装配时刻的快照。
import { chatSessionState, setAsrTranscribingActive } from "./chat-state.js";
import { createSubtitleWaiter, isContextPending } from "./subtitle-wait.js";
import {
  buildNoSubtitleNotice,
  isNoSubtitleEmptyContext,
  isSubtitleFetchFailed,
  type NoSubtitleReason
} from "./no-subtitle.js";
import { CONTEXT_READ_FAILED_MESSAGE, isPinnedContextStrict } from "./context-policy.js";
import type { ViewResetIntent } from "./view-intent.js";
import type { ClipState } from "../core/state.js";

// 发送闸的受理结论（Q2-a 拍板）：显式返回值取代「boolean | 字符串哨兵」。
// 消费方（chat-runtime）只判 pass，kind 供调用方与测试区分拦截原因。
//   { pass: true }                        放行（上下文就绪，回放已让位）
//   { pass: false, kind: "read-failed" }  读取失败（已发视图意图清场）
//   { pass: false, kind: "no-subtitle" }  无字幕空上下文拦截（notice 已显示）
//   { pass: false, kind: "fetch-error" }  抓取失败空上下文拦截（notice 已显示）
export type GateOutcome =
  | { pass: true }
  | { pass: false; kind: "read-failed" | "no-subtitle" }
  | { pass: false; kind: "fetch-error" };

// 等待/状态行文案（自 chat-tab 原文件迁入，逐字保持）。
export const ASR_TRANSCRIBING_NOTICE = "该视频无字幕，正在音频转写…";
export const ASR_WAITING_NOTICE = "该视频无字幕，正在音频转写，完成后自动开始总结…";
export const SUBTITLE_FETCHING_NOTICE = "正在抓取字幕，完成后自动开始总结…";
export const SUBTITLE_FETCH_FAILED_NOTICE = "字幕抓取失败，请稍后重试。";

const SUBTITLE_WAIT_POLL_MS = 4000;

export interface CreateSendGateDeps {
  // 静默加载当前上下文（context-load 实例方法，组合根惰性接线）。
  // preserveInput：本闸的调用链是「发送受理中」——闸内 apply-live 重启（上下文
  // 跟随）不得清输入框与附件区（附件在闸之后才被 takeInputImages 消费）。
  loadContextState: (opts: { forceRefresh: boolean; silent: boolean; preserveInput?: boolean }) => Promise<boolean>;
  // pinned 会话的历史补水（conversation-store 实例方法）。同样透传 preserveInput
  // 到其内部的 loadContextState（pinned 分支也可能触发闸内重启）。
  hydratePinned: (opts?: { preserveInput?: boolean }) => Promise<boolean>;
  // 上下文读取失败的清场（视图意图通道，view-intent.ts：执行体唯一住在
  // 组合根的 requestViewReset）。
  requestViewReset: (intent: ViewResetIntent) => void;
  // 消息区通知两件（showContextNotice 第三参为 no-subtitle 的「前往设置」链接
  // 开关与等待提示的加载动画开关）。
  showContextNotice: (
    message: string,
    durationMs: number,
    opts?: { openSettingsAction?: boolean; spinner?: boolean }
  ) => void;
  removeContextNotice: () => void;
  // 等待闸等待区间通知（可选，缺省不调）：true = 进了 subtitleWaiter.wait()，
  // false = 每个出口都已复位（含 read-failed / no-subtitle / fetch-error）。
  onWaitingChange?: (waiting: boolean) => void;
  // 历史回放让位（G7）：replay.inFlight 的惰性读法（回放实例后建时为 null）。
  replayInFlight: () => Promise<void> | null;
  // 会话关闭闸（pollContext 首行判定，关闭后等待立即兑现 false）。
  isSessionClosed: () => boolean;
  // 转写相位判定（与字幕 tab 横幅同源），等待提示路由与状态行共用。
  isReaderTranscribing: () => boolean;
  // 转写状态行元素（reader 壳的 asrNotice；null = 壳未提供，渲染为空操作）。
  asrNotice: HTMLElement | null;
  // 主动起跑字幕抓取的判定门输入：当前页 BV、进程内 clip 权威状态、起跑动作
  //（ensure 总结链 + reader 刷新请求，组合根实现，失败返回 false）。
  pageBvid: () => string | null;
  clip: () => ClipState;
  startSubtitleFetch: () => Promise<boolean>;
  // 字幕状态总线订阅具名入口（shared/subtitle-status-bus，测试注入假订阅）。
  subscribeStatusPhase: (listener: (phase: string) => void) => () => void;
  // 等待闸轮询间隔（测试注入短间隔；缺省 4 秒与迁移前一致）。
  pollIntervalMs?: number;
}

export interface SendGate {
  /** 发送前上下文就绪闸：{pass:true} 放行；{pass:false,kind:"read-failed"} 读取失败（已清场）；
   *  {pass:false,kind:"no-subtitle"} 无字幕拦截（notice 已显示）；
   *  {pass:false,kind:"fetch-error"} 抓取失败拦截（notice 已显示）。 */
  ensureContextForSend: () => Promise<GateOutcome>;
  /** 挂起中的等待闸立即补一轮（asr-done/failed 与 subtitle-ready 相位、会话关闭路径用）。 */
  kickSubtitleWait: () => void;
  /** 订阅字幕状态总线（幂等；重复调用不重复订阅）。 */
  bindStatusBus: () => void;
  unbindStatusBus: () => void;
  /** 转写状态行重渲（asrNotice 显隐 + 文案）。 */
  refreshAsrNotice: () => void;
}

export function createSendGate(deps: CreateSendGateDeps): SendGate {
  // 等待期间的提示相位：转写等待并入状态行（true），抓取等待走消息区 notice。
  let asrWaitingActive = false;
  let unsubscribeStatusBus: (() => void) | null = null;

  function updateAsrNotice(): void {
    if (!deps.asrNotice) {
      return;
    }
    // 转写判定与字幕 tab 横幅同源（isReaderTranscribing：相位 transcribing 且
    // 字幕体为空——防御切视频后的相位残留压住有字幕视频的对话栏）。
    deps.asrNotice.hidden = !deps.isReaderTranscribing() && !asrWaitingActive;
    deps.asrNotice.textContent = asrWaitingActive ? ASR_WAITING_NOTICE : ASR_TRANSCRIBING_NOTICE;
  }

  // 等待提示按原因路由：转写中的等待并入转写状态行（合成一句，不另起消息区
  // 通知，顺带清掉此前抓取文案残留的消息区通知）；仅字幕抓取中的等待（状态行
  // 隐藏）走消息区抓取文案（带加载动画），两者互斥不重复。等待闸的轮询路径与
  // 本闸的即时提示共用这一对具名出口。
  function showWaitNotice(): void {
    if (deps.isReaderTranscribing()) {
      asrWaitingActive = true;
      deps.removeContextNotice();
      updateAsrNotice();
      return;
    }
    deps.showContextNotice(SUBTITLE_FETCHING_NOTICE, 0, { spinner: true });
  }

  function clearWaitNotice(): void {
    if (asrWaitingActive) {
      asrWaitingActive = false;
      updateAsrNotice();
    }
    deps.removeContextNotice();
  }

  // 抓取/音频转写进行中（subtitleFetchState 为 loading 且字幕体为空）时等待其
  // 完成再放行发送流程，状态机本体在 ./subtitle-wait.ts。这里只组装 deps：
  // 轮询读当前上下文、提示走消息区 notice/状态行、定时器用 window。
  const subtitleWaiter = createSubtitleWaiter({
    pollIntervalMs: deps.pollIntervalMs ?? SUBTITLE_WAIT_POLL_MS,
    pollContext: async () => {
      // 会话已收尾：立即失败放行（wait 兑现 false → 发送流程提前返回），
      // 不让关闭后的后台轮询继续养着一次「迟早会发」的发送。
      if (deps.isSessionClosed()) {
        return { ok: false, pending: false };
      }
      const ok = await deps.loadContextState({ forceRefresh: false, silent: true }).catch(() => false);
      // loadContextState 无论走哪个分支都会先更新 liveContextData；等待期间
      // 可能有流式守卫冻结 contextData，读 liveContextData 保证数据不断供。
      const snapshot = ok ? (chatSessionState.liveContextData || chatSessionState.contextData) : null;
      return {
        ok: Boolean(snapshot),
        pending: isContextPending(snapshot, { asrTranscribingActive: chatSessionState.asrTranscribingActive })
      };
    },
    showWaitingNotice: showWaitNotice,
    removeNotice: clearWaitNotice,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle)
  });

  function bindStatusBus(): void {
    if (unsubscribeStatusBus) {
      return;
    }
    unsubscribeStatusBus = deps.subscribeStatusPhase((phase) => {
      if (phase === "asr-transcribing") {
        setAsrTranscribingActive(true);
        // 转写相位开始：清掉等待闸此前落下的「正在抓取字幕…」消息区通知。那条
        // 通知描述的是抓取阶段，与转写状态行同屏即为自相矛盾的两条提示（用户
        // 报障：一闪两条重复且不正确的提示）；等待期间的正确提示由下一轮轮询
        // 把状态行切到合并句，消息区不再需要通知。
        deps.removeContextNotice();
      } else if (phase === "asr-done" || phase === "asr-failed" || phase === "subtitle-ready") {
        // subtitle-ready 同属「等待理由已消失」：抓取落定即 kick，等待闸不必再
        // 空等最多一个轮询间隔（4 秒）才看到就绪。
        setAsrTranscribingActive(false);
        subtitleWaiter.kick();
      }
      if (phase !== "asr-transcribing") {
        // 转写相位结束（subtitle-ready 落账同属这一侧）：状态行从合并句回落
        // 基础句/隐藏，等待提示回消息区通知。
        asrWaitingActive = false;
      }
      updateAsrNotice();
    });
    // 订阅不回放当前相位：按当前相位恢复提示行呈现（打开晚于转写发起的窗口）。
    updateAsrNotice();
  }

  function unbindStatusBus(): void {
    unsubscribeStatusBus?.();
    unsubscribeStatusBus = null;
  }

  // 发送前主动起跑字幕抓取：等待闸（isContextPending）只认
  // subtitleFetchState === "loading"——面板打开后的后台抓取要等播放器元数据
  //（最多 5 秒）才起跑，这段「还没开始抓」的窗口里状态是 idle，闸判定「非
  // pending」直接放行，字幕体为空就发给模型，只能得到凭标题编造「无公开字幕」
  // 的总结。这里在发送路径上补上抓取发起方：idle（还没起跑）或 error（上一轮
  // 失败）且无字幕体时主动起跑一轮（error 重试一次），随后的 wait() 首轮轮询
  // 必见 loading，提示词被挂住直到抓取落定。loading 轮次上不起跑：那会用新代次
  // 顶掉在飞抓取，而等待闸本来就在等它。
  // 判定读 deps.clip（进程内权威状态）而非上下文快照：快照是「装配时刻的投影」
  // ——抓取发起前的快照不含刚落账的字幕，按快照判定会在「另一轮抓取刚好落账」
  // 时误判「还没抓」而多起一轮（顶成 STALE_RUN，终态文案丢失）。
  async function startSubtitleFetchIfNeeded(): Promise<boolean> {
    const pageBvid = deps.pageBvid();
    if (!pageBvid) {
      return true;
    }
    const clip = deps.clip();
    if (String(clip.bvid || "") === pageBvid && clip.subtitleBody.length > 0) {
      return true;
    }
    if (clip.subtitleFetchState !== "idle" && clip.subtitleFetchState !== "error") {
      return true;
    }
    // 起跑动作留在组合根（ensure 总结链装载 + reader 刷新请求；失败 = 抓取
    // 没能起跑，调用方按上下文读取失败拦截）。
    return deps.startSubtitleFetch();
  }

  // 【整段迁移自 sidepanel.ts】发送前确保当前上下文就绪（pinned 对话补水 /
  // 普通对话读当前页；抓取或音频转写进行中时先等待，避免空字幕上下文直接发
  // 给模型；还没起跑时主动起跑）。
  // 最终快照若是收尾为空的上下文——「无字幕」（empty 且字幕体为空）或「抓取
  // 失败」（error 且字幕体为空）——则拦截发送：返回 { pass: false, kind:
  // "no-subtitle" | "fetch-error" } 让受理体提前返回（不追加用户消息、不落
  // chatHistory、不发起 port），无字幕按 noSubtitleReason 显示对应 notice，
  // 抓取失败显示重试文案。
  async function ensureContextForSend(): Promise<GateOutcome> {
    // 本闸调用链上的每一次上下文装载都带 preserveInput（见 deps.loadContextState
    // 注记）：闸内 apply-live 的 restartChat 是上下文跟随，不得清输入框与附件区。
    // pinned 判定用与 loadContextState 同一个严格谓词 isPinnedContextStrict
    //（=== true）：本调用点历史上曾是真值判断，2026-10 已统一收口，疑义记录见
    // ./context-policy.ts 的 isPinnedContextStrict 注释与 ADR-0005 修订。
    if (isPinnedContextStrict(chatSessionState.currentConversationMeta)) {
      await deps.loadContextState({ forceRefresh: false, silent: true, preserveInput: true }).catch(() => null);
      if (!(await deps.hydratePinned({ preserveInput: true }))) {
        return { pass: false, kind: "read-failed" };
      }
      // G1 的提前返回同样要过回放让位点（Q3-a 查证结论）：hydratePinned 自身
      // 三支都不起回放——分支 1/3 只 applyContextToMain + emitChange()（仅历史
      // 列表），分支 2 经 loadContextState 在 pinned 会话上走 APPLY_PINNED
      //（context-load.ts:128-134，只落地 live 快照）；但在途回放确实可与本
      // 分支并存：applyById（历史项点击）经 emitChange({ resetView: true }) →
      // renderInitialState → replay.render() 起跑回放，紧随其后的发送仍走 pinned
      // 分支。不等待则新消息会插进未完成回放的中间。
      await deps.replayInFlight();
      return { pass: true };
    }
    // 失败闸把「无标签页」与「读取失败」合并为同一文案（与策略模块的
    // resolveNoTabPlan 语义不同：这里即使静默加载也会重置视图），保持原状。
    const ok = await deps.loadContextState({ forceRefresh: false, silent: true, preserveInput: true });
    if (!ok || !chatSessionState.contextData) {
      deps.requestViewReset({ kind: "state", html: CONTEXT_READ_FAILED_MESSAGE });
      return { pass: false, kind: "read-failed" };
    }
    // 抓取还没起跑（idle）或上一轮失败（error）时主动起跑，再进等待闸——否则
    // 等待闸见不到 loading，空字幕上下文会被直接放行。
    if (!(await startSubtitleFetchIfNeeded())) {
      deps.requestViewReset({ kind: "state", html: CONTEXT_READ_FAILED_MESSAGE });
      return { pass: false, kind: "read-failed" };
    }
    // 等待提示即时显示：判定要等待就立刻出通知条，不等 4 秒轮询的首拍。G3 起跑
    // 的抓取在 refreshClip 的同步前缀里已写 loading，本来就 loading 的轮次也命中；
    // ready/empty 等非等待态不显示，避免通知条一闪而过。
    const clip = deps.clip();
    if (clip.subtitleBody.length === 0 && clip.subtitleFetchState === "loading") {
      showWaitNotice();
    }
    // 等待区间通知调用方（发送键禁用 / placeholder 换文案）；try/finally 保证
    // read-failed、no-subtitle、fetch-error、pass 全部出口都复位。
    deps.onWaitingChange?.(true);
    let ready = false;
    try {
      ready = await subtitleWaiter.wait();
    } finally {
      deps.onWaitingChange?.(false);
    }
    if (!ready) {
      deps.requestViewReset({ kind: "state", html: CONTEXT_READ_FAILED_MESSAGE });
      return { pass: false, kind: "read-failed" };
    }
    // 等待期间 contextData 可能停在旧快照（守卫分支或就绪瞬间），放行前重取
    // 一次，确保发送出去的是转写完成后的完整字幕。
    await deps.loadContextState({ forceRefresh: false, silent: true, preserveInput: true }).catch(() => null);
    if (!chatSessionState.contextData) {
      deps.requestViewReset({ kind: "state", html: CONTEXT_READ_FAILED_MESSAGE });
      return { pass: false, kind: "read-failed" };
    }
    if (isNoSubtitleEmptyContext(chatSessionState.contextData)) {
      const notice = buildNoSubtitleNotice(chatSessionState.contextData.noSubtitleReason as NoSubtitleReason);
      deps.showContextNotice(notice.message, 0, { openSettingsAction: notice.openSettings });
      return { pass: false, kind: "no-subtitle" };
    }
    // 抓取失败收尾（error 且字幕体为空）：与无字幕拦截同一道门——把空字幕发给
    // 模型只会得到凭标题编造的总结。失败是可重试的暂时态，故给一条重试文案，
    // 不重置视图（用户可再点一次发送）。
    if (isSubtitleFetchFailed(chatSessionState.contextData)) {
      deps.showContextNotice(SUBTITLE_FETCH_FAILED_NOTICE, 0);
      return { pass: false, kind: "fetch-error" };
    }
    // 本函数内的 loadContextState 可能因上下文变化触发一轮新的历史回放
    //（applyContextPayload → renderInitialState）；等它落定再返回，否则调用方
    // 紧随的 appendUserMessage 会插进这轮回放的中间（P2-1）。拦截路径不需要
    // 让位（没有消息要 append），故只在放行前等待。
    await deps.replayInFlight();
    return { pass: true };
  }

  return {
    ensureContextForSend,
    kickSubtitleWait: () => subtitleWaiter.kick(),
    bindStatusBus,
    unbindStatusBus,
    refreshAsrNotice: updateAsrNotice
  };
}
