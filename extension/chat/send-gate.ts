// extension/chat/send-gate.ts — 发送闸（GLOSSARY.md 词条「发送闸」）：发送前
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
//      的 live-first 快照读法、4 秒轮询定时器。只有轮询确认 pending 后才经
//      deps.onWaitingChange 打开输入区等待卡；取消与每个终态成对复位，转写中
//      同步更新状态行。字幕就绪判定单源在 ./subtitle-readiness.ts（clip 与快照
//      两个入口），本闸只组装调用。
//   3. 字幕状态总线订阅（转写相位与 subtitle-ready → setAsrTranscribingActive
//      意图原语 + kick 等待闸 + 清上下文 notice）与转写状态行（asrNotice）。
//   4. startSubtitleFetchIfNeeded 的判定门（BV 匹配 / 字幕体已在 / 仅 idle 或
//      error 起跑），起跑动作本身（ensure 链 + 刷新请求）留在组合根，经
//      startSubtitleFetch 注入。
//
// 读侧闭包约定（与 chat-tab 原注释一致）：deps 里的页面级状态经惰性 getter
// 读取，回调执行时取值——不写死装配时刻的快照。
import { chatSessionState, setAsrTranscribingActive } from "./chat-state.js";
import { createSubtitleWaiter } from "./subtitle-wait.js";
import { buildNoSubtitleNotice, type NoSubtitleReason } from "./no-subtitle.js";
import { isConfigClassAsrReason } from "../core/asr-failure-notice.js";
import {
  isNoSubtitleEmpty,
  isPending,
  isSubtitleFetchFailed,
  readinessFromClip,
  readinessFromSnapshot
} from "./subtitle-readiness.js";
import { isPinnedContextStrict } from "./context-policy.js";
import type { ClipState } from "../core/state.js";

// 消费方（chat-runtime）只判 pass；kind 区分拦截、读取失败与用户取消。
export type GateOutcome =
  | { pass: true }
  | { pass: false; kind: "read-failed" | "no-subtitle" | "fetch-error" | "cancelled" };

export const ASR_TRANSCRIBING_NOTICE = "当前视频无字幕，正在进行语音转写…";
export const ASR_WAITING_NOTICE = "当前视频无字幕，正在进行语音转写，完成后自动开始总结…";
export const SUBTITLE_FETCH_FAILED_NOTICE = "字幕抓取失败，请稍后重试。";
export const SUBTITLE_READ_FAILED_NOTICE = "字幕读取失败，请重试。";

const SUBTITLE_WAIT_POLL_MS = 4000;

export interface CreateSendGateDeps {
  // 静默加载当前上下文（context-load 实例方法，组合根惰性接线）。
  // preserveInput：本闸的调用链是「发送受理中」——闸内 apply-live 重启（上下文
  // 跟随）不得清输入框与附件区（附件在闸之后才被 takeInputImages 消费）。
  loadContextState: (opts: { forceRefresh: boolean; silent: boolean; preserveInput?: boolean }) => Promise<boolean>;
  // pinned 会话的历史补水（conversation-store 实例方法）。同样透传 preserveInput
  // 到其内部的 loadContextState（pinned 分支也可能触发闸内重启）。
  hydratePinned: (opts?: { preserveInput?: boolean }) => Promise<boolean>;
  // 拦截通知落在输入区；动作只重抓/重读上下文，不替用户再次确认发送。
  showContextNotice: (
    message: string,
    durationMs: number,
    opts?: {
      openSettingsAction?: boolean;
      spinner?: boolean;
      settingsTarget?: "asr";
      placement?: "input";
      action?: { label: string; onClick: () => void };
    }
  ) => void;
  removeContextNotice: () => void;
  // 只有轮询确认 pending 才进入等待 UI；每个出口由等待器 finish 成对复位。
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
  /** 放行、拦截、读取失败与用户取消均经结构化结论返回。 */
  ensureContextForSend: () => Promise<GateOutcome>;
  /** 挂起中的等待闸立即补一轮（asr-done/failed 与 subtitle-ready 相位用）。 */
  kickSubtitleWait: () => void;
  /** 立即取消在飞发送等待，并作废尚未完成的轮询结果。 */
  cancel: () => void;
  /** 订阅字幕状态总线（幂等；重复调用不重复订阅）。 */
  bindStatusBus: () => void;
  unbindStatusBus: () => void;
  /** 转写状态行重渲（asrNotice 显隐 + 文案）。 */
  refreshAsrNotice: () => void;
}

export function createSendGate(deps: CreateSendGateDeps): SendGate {
  let asrWaitingActive = false;
  let waitingUiActive = false;
  let waitGeneration = 0;
  let cancelledWaitGeneration = -1;
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

  function showWaitNotice(): void {
    if (!waitingUiActive) {
      waitingUiActive = true;
      deps.onWaitingChange?.(true);
    }
    if (deps.isReaderTranscribing()) {
      asrWaitingActive = true;
      updateAsrNotice();
    }
  }

  function clearWaitNotice(): void {
    deps.removeContextNotice();
    if (asrWaitingActive) {
      asrWaitingActive = false;
      updateAsrNotice();
    }
    if (waitingUiActive) {
      waitingUiActive = false;
      deps.onWaitingChange?.(false);
    }
  }

  // 抓取/音频转写进行中（subtitleFetchState 为 loading 且字幕体为空）时等待其
  // 完成再放行发送流程，状态机本体在 ./subtitle-wait.ts。这里只组装 deps：
  // 轮询读当前上下文、输入区等待卡/转写状态行、定时器用 window。
  const subtitleWaiter = createSubtitleWaiter({
    pollIntervalMs: deps.pollIntervalMs ?? SUBTITLE_WAIT_POLL_MS,
    pollContext: async () => {
      // 会话已收尾：立即失败放行（wait 兑现 false → 发送流程提前返回），
      // 不让关闭后的后台轮询继续养着一次「迟早会发」的发送。
      if (deps.isSessionClosed()) {
        return { ok: false, pending: false };
      }
      const ok = await deps.loadContextState({ forceRefresh: false, silent: true, preserveInput: true }).catch(() => false);
      // loadContextState 无论走哪个分支都会先更新 liveContextData；等待期间
      // 可能有流式守卫冻结 contextData，读 liveContextData 保证数据不断供。
      const snapshot = ok ? (chatSessionState.liveContextData || chatSessionState.contextData) : null;
      const readiness = readinessFromSnapshot(snapshot, {
        asrTranscribingActive: chatSessionState.asrTranscribingActive
      });
      return {
        ok: Boolean(snapshot),
        pending: isPending(readiness)
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
        // 清理可能残留的拦截通知；等待卡与转写状态行分别呈现等待和转写。
        deps.removeContextNotice();
      } else if (phase === "asr-done" || phase === "asr-failed" || phase === "subtitle-ready") {
        // subtitle-ready 同属「等待理由已消失」：抓取落定即 kick，等待闸不必再
        // 空等最多一个轮询间隔（4 秒）才看到就绪。
        setAsrTranscribingActive(false);
        subtitleWaiter.kick();
      }
      if (phase !== "asr-transcribing") {
        // 转写相位结束后，状态行从合并句回落基础句或隐藏，等待卡保持不变。
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

  // 发送前主动起跑字幕抓取：等待闸（subtitle-readiness 的 isPending）只认
  // subtitleFetchState === "loading"——面板打开后的后台抓取要等播放器元数据
  //（最多 5 秒）才起跑，这段「还没开始抓」的窗口里状态是 idle，闸判定「非
  // pending」直接放行，字幕体为空就发给模型，只能得到凭标题编造「无公开字幕」
  // 的总结。这里在发送路径上补上抓取发起方：idle（还没起跑）或 error（上一轮
  // 失败）且无字幕体时主动起跑一轮（error 重试一次），随后的 wait() 首轮轮询
  // 必见 loading，提示词被挂住直到抓取落定。loading 轮次上不起跑：那会用新代次
  // 顶掉在飞抓取，而等待闸本来就在等它。
  // 配置类 empty（未配置 / 停用 / 缺 Key；票 04）同样允许重新起跑：用户经
  // 设置动作修好配置后回到对话再发送，必须重新进入抓取才能拿到字幕——否则
  // 永远停在上一轮的「无字幕」快照。非配置类 empty（无人声、音轨失败、额度、
  // 限流）与未归类（null）仍按原规则拦截，不反复重抓。
  // 判定读 deps.clip（进程内权威状态）而非上下文快照：快照是「装配时刻的投影」
  // ——抓取发起前的快照不含刚落账的字幕，按快照判定会在「另一轮抓取刚好落账」
  // 时误判「还没抓」而多起一轮（顶成 STALE_RUN，终态文案丢失）。
  async function startSubtitleFetchIfNeeded(): Promise<boolean> {
    const pageBvid = deps.pageBvid();
    if (!pageBvid) {
      return true;
    }
    const clip = deps.clip();
    const readiness = readinessFromClip(clip);
    if (String(clip.bvid || "") === pageBvid && readiness.hasBody) {
      return true;
    }
    if (readiness.fetchState !== "idle" && readiness.fetchState !== "error") {
      const configClassEmpty =
        readiness.fetchState === "empty" &&
        !readiness.hasBody &&
        isConfigClassAsrReason(clip.noSubtitleReason);
      if (!configClassEmpty) {
        return true;
      }
    }
    // 起跑动作留在组合根（ensure 总结链装载 + reader 刷新请求；失败 = 抓取
    // 没能起跑，调用方按上下文读取失败拦截）。
    return deps.startSubtitleFetch();
  }

  function retryContextRead(): void {
    void (async () => {
      const ok = await deps.loadContextState({ forceRefresh: true, silent: true, preserveInput: true }).catch(() => false);
      if (!ok) {
        return;
      }
      if (isPinnedContextStrict(chatSessionState.currentConversationMeta) && !(await deps.hydratePinned({ preserveInput: true }))) {
        return;
      }
      if (chatSessionState.contextData) {
        deps.removeContextNotice();
      }
    })();
  }

  function showReadFailedNotice(): void {
    deps.showContextNotice(SUBTITLE_READ_FAILED_NOTICE, 0, {
      placement: "input",
      action: { label: "重试读取", onClick: retryContextRead }
    });
  }

  function retrySubtitleFetch(): void {
    void deps.startSubtitleFetch().then((started) => {
      if (started) {
        deps.removeContextNotice();
      }
    });
  }

  async function ensureContextForSend(): Promise<GateOutcome> {
    if (isPinnedContextStrict(chatSessionState.currentConversationMeta)) {
      await deps.loadContextState({ forceRefresh: false, silent: true, preserveInput: true }).catch(() => null);
      if (!(await deps.hydratePinned({ preserveInput: true }))) {
        showReadFailedNotice();
        return { pass: false, kind: "read-failed" };
      }
      await deps.replayInFlight();
      return { pass: true };
    }
    const ok = await deps.loadContextState({ forceRefresh: false, silent: true, preserveInput: true });
    if (!ok || !chatSessionState.contextData) {
      showReadFailedNotice();
      return { pass: false, kind: "read-failed" };
    }
    if (!(await startSubtitleFetchIfNeeded())) {
      showReadFailedNotice();
      return { pass: false, kind: "read-failed" };
    }
    const currentWaitGeneration = ++waitGeneration;
    const ready = await subtitleWaiter.wait();
    if (!ready) {
      if (cancelledWaitGeneration === currentWaitGeneration) {
        return { pass: false, kind: "cancelled" };
      }
      showReadFailedNotice();
      return { pass: false, kind: "read-failed" };
    }
    // 放行前重取，确保发送的是等待结束后的完整字幕。
    await deps.loadContextState({ forceRefresh: false, silent: true, preserveInput: true }).catch(() => null);
    if (!chatSessionState.contextData) {
      showReadFailedNotice();
      return { pass: false, kind: "read-failed" };
    }
    const finalReadiness = readinessFromSnapshot(chatSessionState.contextData, {
      asrTranscribingActive: chatSessionState.asrTranscribingActive
    });
    if (isNoSubtitleEmpty(finalReadiness)) {
      const notice = buildNoSubtitleNotice(chatSessionState.contextData.noSubtitleReason as NoSubtitleReason);
      deps.showContextNotice(notice.message, 0, {
        placement: "input",
        action: { label: "重新抓取", onClick: retrySubtitleFetch },
        openSettingsAction: notice.openSettings,
        settingsTarget: "asr"
      });
      return { pass: false, kind: "no-subtitle" };
    }
    if (isSubtitleFetchFailed(finalReadiness)) {
      deps.showContextNotice(SUBTITLE_FETCH_FAILED_NOTICE, 0, {
        placement: "input",
        action: { label: "重试读取", onClick: retryContextRead }
      });
      return { pass: false, kind: "fetch-error" };
    }
    await deps.replayInFlight();
    return { pass: true };
  }

  return {
    ensureContextForSend,
    kickSubtitleWait: () => subtitleWaiter.kick(),
    cancel: () => {
      cancelledWaitGeneration = waitGeneration;
      subtitleWaiter.cancel();
    },
    bindStatusBus,
    unbindStatusBus,
    refreshAsrNotice: updateAsrNotice
  };
}
