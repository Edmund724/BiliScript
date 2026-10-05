// extension/chat/turn-lifecycle.ts — 回合生命周期（CONTEXT.md 词条「发送闸」与
// 「历史回放」的时序面收口）。
//
// 一个回合 = 「受理开始 → 终态落定」。本模块是这段时序与结算的唯一实现点，
// 调用方只剩两件事：
//   1. 交出文本（附件在受理点经注入的 provider 消费），拿回受理结论
//      （SendVerdict 语义不变：accepted / blocked / ignored）；
//   2. 订阅回合终态（settled —— 在途时请求停流，终态落定后兑现；不在途立即兑现）。
// 窗口判定、停流登记、终态兑现、看门狗兜底全部退回本模块的 implementation：
//   - 在途判据只有一条语义查询 isActive()（受理窗口 ∪ 流段），调用点不再拼
//     sendInFlight / activePort / activeUserPrompt；
//   - 「端口就绪即停」的登记与补发收在 stop() / flushDeferredStop() 一对里——
//     补发点必须是受理体 postMessage 之后（stop 早于 chat 到达会被 offscreen 当
//     无活动请求而空转，终态永不回来）；
//   - 结算的待决队列与看门狗只在 resolve() 一处兑现（幂等；任一落定出口：
//     终态收尾 / 端口断连 / 闸未放行未起流 / 拆除级清场 / 看门狗超时）。
//
// 与 chat-runtime 的分工（ADR-0005 红线：只收口「时序与判据的组合方式」，字段
// 本体住哪不动）：受理窗口标志（sendInFlight）与端口句柄（activePort）的声明处
// 仍在 chat-runtime —— 本模块经 accepting 槽位与 isStreaming 读法组合它们，不搬
// 归属；受理体本体（provider 检查 / 发送闸 / 上屏 / 附件消费 / 连端口 /
// postMessage）也仍在 chat-runtime，经 runAcceptance 注入 —— 本模块管它前后的
// 时序与全部结算。
//
// 方向纪律（CONTEXT.md「历史回放」词条）：等待是单向的 —— 发送等回放让位
//（send-gate 的 G7），回放不等任何东西；settled() 只由历史项点击接缝 await，
// 不进回放、不进发送闸（否则成结构死锁）。拆除类入口（删除 / 清空 / 新会话 /
// 关闭会话）不经 settled()，经 discard() 维持有意拆除语义。
//
// 顶层零副作用，可在 Node 测试环境直接 evaluate（见 tests/chat/turn-lifecycle.test.ts）。

// 发送受理结论（语义与 chat-runtime 的 SendVerdict 逐字一致）：
//   "accepted" 已受理（用户消息已 append、输入框已清、port 已发起，或 port 建立
//              失败但受理已完成）
//   "blocked"  被闸拦下（无可用平台 / 发送闸 GateOutcome 非 pass）——未追加用户
//              消息、未清输入框、未落 chatHistory、未发起 port
//   "ignored"  入口早退（空文本 / 回合在途）——输入框保持不清
export type SendVerdict = "accepted" | "blocked" | "ignored";

// 在途回合结算的看门狗兜底窗口（毫秒）。为什么必须有：settle 是历史项点击切换
// 的前置 await，而 offscreen 存在「永不回终态」的路径——请求已自然收尾时
// abortActiveRequest 是空操作，文档被回收时本侧也不保证收到断连通知。超窗即按
// 拆除级原语收口并兑现，settle 绝不悬挂（死锁红线）。
export const TURN_SETTLE_FALLBACK_MS = 4000;

// 受理窗口槽位：字段本体（chat-runtime 的 sendInFlight）声明与存储不动，本模块
// 只借用读写口做组合——「开启/关闭受理窗口」是时序语义，不是新的状态归属。
export interface TurnAcceptanceWindow {
  /** 受理窗口是否开启（= 发送流程已进入、尚未出结果）。 */
  get(): boolean;
  /** 开启/关闭受理窗口（唯一写方是本模块的 send / discard）。 */
  set(value: boolean): void;
}

export interface CreateTurnLifecycleDeps {
  // 字段本体槽位（见 TurnAcceptanceWindow 注记）。
  accepting: TurnAcceptanceWindow;
  // 流段存在性（activePort !== null；端口句柄本体住 chat-runtime）。与受理窗口
  // 合成唯一的在途判据。
  isStreaming: () => boolean;
  // 停流动作本体：端口在途时发 stop + 进「停止中」按钮态。端口未建时不调用
  //（本模块登记「端口就绪即停」，见 stop / flushDeferredStop）。
  stopStream: () => void;
  // 兜底拆除：拆端口 + 清在途状态 + 退出流式 UI（看门狗到点用；调用方按拆除级
  // 原语收口，不负责兑现 settle——兑现仍归本模块）。
  forceReset: () => void;
  // 受理体本体（chat-runtime 的发送流程）：provider 检查 → 发送闸 → 上屏 →
  // 附件消费 → 连端口 → postMessage（受理体内部在 postMessage 之后调
  // flushDeferredStop）。返回受理结论。
  runAcceptance: (text: string) => Promise<SendVerdict>;
  // 看门狗窗口（缺省 TURN_SETTLE_FALLBACK_MS）。
  watchdogMs?: number;
  // 定时器（测试注入手动推进；缺省 window）。
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

export interface TurnLifecycle {
  /** 受理一条消息：text 经 trim 后为非空且回合不在途才进入受理体；否则 ignored。 */
  send: (text: string) => Promise<SendVerdict>;
  /** 在途判据（受理窗口 ∪ 流段）：调用点唯一的语义查询。 */
  isActive: () => boolean;
  /** 回合终态订阅：不在途立即兑现；在途则请求停流并在终态落定后兑现（绝不悬挂）。 */
  settled: () => Promise<void>;
  /** 停流请求（停止按钮 / settled）：端口在途即发，未就绪则登记「端口就绪即停」。 */
  stop: () => void;
  /** 「端口就绪即停」补发点：受理体在 postMessage 之后调用。返回是否补发了 stop。 */
  flushDeferredStop: () => boolean;
  /** 回合终态落定的唯一兑现点（幂等）。 */
  resolve: () => void;
  /** 拆除级清场：关闭受理窗口 + 兑现待决 settle。 */
  discard: () => void;
}

export function createTurnLifecycle(deps: CreateTurnLifecycleDeps): TurnLifecycle {
  const watchdogMs = deps.watchdogMs ?? TURN_SETTLE_FALLBACK_MS;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: number) => window.clearTimeout(handle));

  // 待决兑现队列：落定点单一收在 resolve()。同一回合可被重入 settle 多次，整批兑现。
  let pendingSettles: Array<() => void> = [];
  // 发送流程已在途、但端口尚未建立（闸 / opt-in 弹层 / connectPort 的 await 窗口）
  // 时收到的停流请求：此刻无处发 stop，登记后在端口就绪、chat 消息发出之后补发。
  // 不登记即静默丢失——settle 要等整段流自然结束才兑现。
  let stopWhenPortReady = false;
  let watchdogTimer = 0;

  // 在途判据（受理窗口 ∪ 流段）：两者都假 = 回合已落定（无流可停、无写回在途）。
  function isActive(): boolean {
    return deps.accepting.get() || deps.isStreaming();
  }

  // 结算待决 settle（幂等）：回合落定的各出口统一经此兑现，并撤下看门狗与
  // 「端口就绪即停」登记（回合已终结，端口不会再为它就绪）。
  function resolve(): void {
    if (watchdogTimer) {
      clearTimer(watchdogTimer);
      watchdogTimer = 0;
    }
    stopWhenPortReady = false;
    if (!pendingSettles.length) {
      return;
    }
    const resolvers = pendingSettles;
    pendingSettles = [];
    for (const resolveSettle of resolvers) {
      resolveSettle();
    }
  }

  function stop(): void {
    if (!deps.isStreaming()) {
      // 端口未建立：此刻无处发 stop。回合仍在受理窗口内时登记，受理体在
      // postMessage 之后经 flushDeferredStop 补发；窗口外（回合已落定）为无害空操作。
      if (deps.accepting.get()) {
        stopWhenPortReady = true;
      }
      return;
    }
    deps.stopStream();
  }

  function flushDeferredStop(): boolean {
    if (!stopWhenPortReady) {
      return false;
    }
    stopWhenPortReady = false;
    stop();
    return true;
  }

  // 在途回合体面结算（C′：流式中点历史项 = 先停流落盘、再切换）：不在途时立即
  // 兑现——调用方（历史项点击接缝）零延迟零行为差；在途时发停流，并在
  // stopped/done/error 终态落定后兑现（终态路径把在途一问一答含 partial 正文写回
  // **原**会话）。绝不悬挂：端口尚未建立时的停流请求由 flushDeferredStop 在端口
  // 就绪后补发，另有断连与看门狗两条兜底。
  function settled(): Promise<void> {
    if (!isActive()) {
      return Promise.resolve();
    }
    const settledPromise = new Promise<void>((resolveSettle) => {
      pendingSettles.push(resolveSettle);
    });
    stop();
    if (!watchdogTimer) {
      watchdogTimer = setTimer(() => {
        watchdogTimer = 0;
        // 兜底放弃：按拆除级原语收口（断端口、取消挂起渲染帧、清在途状态）、退出
        // 流式 UI；紧随的 applyById 会重建消息区，故 forceReset 不清 DOM。兑现
        // settle 仍归本模块 resolve()。
        deps.forceReset();
        resolve();
      }, watchdogMs);
    }
    return settledPromise;
  }

  // 受理入口（唯一的双发闸）：空文本 / 回合在途直接 ignored——窗口包含「发送流程
  // 在途、端口未建」这段此前由各调用点手拼判据、漏判即静默发不出去的窗口。
  async function send(text: string): Promise<SendVerdict> {
    const prompt = String(text ?? "").trim();
    if (!prompt || isActive()) {
      return "ignored";
    }
    deps.accepting.set(true);
    let verdict: SendVerdict;
    try {
      verdict = await deps.runAcceptance(prompt);
    } finally {
      // 受理窗口的关闭先于 blocked 的结算兑现（与旧 finishBlockedTurn 的次序一致）。
      deps.accepting.set(false);
    }
    if (verdict === "blocked") {
      // 未起流的回合终结（无终态事件会再来）：在此兑现待决 settle。
      resolve();
    }
    return verdict;
  }

  // 拆除级清场（会话关闭 / 会话拆除 / 看门狗之外的清场路径）：复位受理窗口并兑现
  // 待决 settle（不留悬挂）。字段清理由调用方的 forceReset 侧负责。
  function discard(): void {
    deps.accepting.set(false);
    resolve();
  }

  return { send, isActive, settled, stop, flushDeferredStop, resolve, discard };
}
