// extension/reader/script-tab-activation.ts — 文摘面板「切标签并激活」的 reader 属主。
//
// 为什么收口到 reader 域（工单：标签激活属主收口）：收口前「激活」机器全在 ui 侧
//（ui-renderer 的 setReaderScriptTab 写状态位 + 写穿持久化 + DOM/样式投影，
// activateReaderScriptTab 做二级激活），reader 域只能经 reader-bus 发
// fire-and-forget 的壳命令（无回执、无排序）触达壳，再各自 await 二级激活
//（explain-card 的 set-tab:chat 甚至游离在壳单飞事务队列之外）。而两级激活对象
//（对话组合根、概览生成）本就都在 reader 域——写手在外、对象在内，竞态既无从
// 判定也无从排序。收口后本模块是「当前标签」的唯一写手：状态位 + 持久化写穿 +
// 投影命令 + 二级激活同处一条串行队列，「并发意图串行化，最终状态 = 最后意图」。
//
// 单次激活顺序（写手单点）：
//   ① reader/state.ts 的 setReaderActiveScriptTab（唯一状态位，DOM 只是投影）
//   ② reader/script-tab-persistence 的 saveReaderScriptTab（写穿；persist:false
//      跳过——进入阅读模式的恢复路径不该把「恢复」再记成一次用户切换）
//   ③ reader-bus 的 requestUiCommand("project-tab", { tab })（壳做纯 DOM 三通道
//      投影 + 对话分区表挂载；壳缺席时命令静默丢弃，与旧 setter 的 DOM 缺失空转同形）
//   ④ await 二级激活：chat → chat seam 的 ensureChatTabActivated({ consumeIntent })；
//      overview → reader 域的 ensureReaderOverviewTab（经既有 ensureReaderDomain
//      懒缝取用，不新增静态边）
//
// 串行队列与 reader/shell.ts 的进入/退出事务单飞队列同构：后到调用等先到调用
// 落定（含失败）再起跑，每个调用自己的 promise 在其激活落定后 resolve。二级
// 激活失败只 logWarn、不污染队列（promise 照常 resolve）——与收口前 ui-renderer
// 的 logWarn-only 口径一致（对话/概览不可用不拖垮另一 tab）。
//
// 反向槽（ui → reader 意图上报）：tab 按钮与面板 DOM 都在 ui 壳里，点击是「用户
// 意图」而非状态写手，壳经 reader-bus 的 reportTabIntent 上报，本模块在模块求值
// 时注册 handler（tabIntent → void activateScriptTab）。973b366 红线：reader 域
// 不得静态 import ui/ui-renderer——本文件只消费 reader-bus 两个方向相反的槽，
// 不含任何 ui 静态边。
//
// 双实例纪律：本模块只进轮 B 懒加载区（reader 域 + shell/chat-tab 的共享
// chunk），无跨实例消费方，模块级串行队列不挂 globalThis 槽（对照
// docs/adr/0008 与 scripts/build-content.js 的双实例对账）。

import { logWarn } from "../shared/logging.js";
import { requestUiCommand, subscribeTabIntent } from "./reader-bus.js";
import { saveReaderScriptTab } from "./script-tab-persistence.js";
import { setReaderActiveScriptTab, type ReaderScriptTab } from "./state.js";
// 二级激活对象都在 reader 域内：对话组合根走既有二级惰性缝（本模块不静态依赖
// chat-tab 重域）；reader 域走既有 ensureReaderDomain 懒缝（与收口前 ui 侧
// withReader 的等价路径，不再需要 ui 域中转）。
import { ensureReaderChatTab } from "./lazy-chat-tab.js";
import { ensureReaderDomain } from "./lazy-reader.js";

export interface ActivateScriptTabOptions {
  /** 对话 tab 是否消费待解释意图（快捷动作路径传 false，与快捷发送互不踩踏） */
  consumeIntent?: boolean;
  /** 是否写穿持久化（进入阅读模式的恢复路径传 false） */
  persist?: boolean;
}

// reader/lazy-reader.ts 只声明启动期窄接口；ensureReaderOverviewTab 是 reader 域
// 入口面的导出之一，此处按 ui/reader-gate.ts 同款手法交叉收口（运行时对象不变）。
type ReaderDomain = Awaited<ReturnType<typeof ensureReaderDomain>> & typeof import("./index.js");
const loadReaderDomain = ensureReaderDomain as () => Promise<ReaderDomain>;

// 串行队列（promise 链顺延）：settled 先于任何 await 同步捕获链头，后到调用不会
// 等错前序；前序失败不阻断后序。
let activationChain: Promise<void> = Promise.resolve();

/**
 * 切到某标签并激活（唯一入口，禁止各自手抄状态位/持久化/投影/二级激活组合）。
 * 并发调用排队；返回的 promise 在本次激活（含二级激活）落定后 resolve。
 */
export function activateScriptTab(
  tab: ReaderScriptTab,
  { consumeIntent = true, persist = true }: ActivateScriptTabOptions = {}
): Promise<void> {
  const settled = activationChain.catch(() => {});
  const next = (async () => {
    await settled;
    await runActivation(tab, { consumeIntent, persist });
  })();
  activationChain = next.catch(() => {});
  return next;
}

async function runActivation(
  tab: ReaderScriptTab,
  { consumeIntent, persist }: Required<ActivateScriptTabOptions>
): Promise<void> {
  // ① 状态位（唯一真源）先落，DOM 三通道随后只是它的投影。
  setReaderActiveScriptTab(tab);
  // ② 写穿持久化（2026-10 用户决议：当前标签跨刷新/跨视频保留）。
  if (persist) {
    saveReaderScriptTab(tab);
  }
  // ③ 投影命令：壳只做 DOM（含对话分区表挂载），不写状态位、不落盘、不做二级激活。
  requestUiCommand("project-tab", { tab });
  // ④ 二级激活（按标签）：失败只记日志——激活不了对话/概览不拖垮面板其余 tab。
  if (tab === "chat") {
    try {
      const chat = await ensureReaderChatTab();
      await chat.ensureChatTabActivated({ consumeIntent });
    } catch (error) {
      logWarn("[BILISCRIPT] chat tab activate failed", error);
    }
    return;
  }
  if (tab === "overview") {
    try {
      const reader = await loadReaderDomain();
      reader.ensureReaderOverviewTab();
    } catch (error) {
      logWarn("[BILISCRIPT] overview tab enter failed", error);
    }
  }
}

// ui 壳的 tab 点击经反向槽上报意图（fire-and-forget）：调用方无需等装载/恢复，
// DOM 反馈由本次激活的投影命令同步完成。
subscribeTabIntent((tab) => {
  void activateScriptTab(tab);
});
