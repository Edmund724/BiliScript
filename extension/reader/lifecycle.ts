// Reader shell：reader 动态域的组装根——生命周期（进入/退出）、reader-bus 端口
// 单点注册、Presenter 通知接收表、字幕就绪副作用收口；并持有域内全部有状态实例
// （句内搜索、概览协调器、字幕工具条、渲染驱动），对外具名入口都转发到这些实例。
// 依赖 LAYOUT 层（video-bind.js + script-host.js）与 ./sync.js；两者不 import
// 本模块，依赖图保持无环：
//
//   reader-bus.ts   显式回调端口组 + 通知/命令槽
//   LAYOUT          video-bind.js + script-host.js → reader-bus 端口组
//   SYNC            sync.js                        → LAYOUT + reader-bus
//   LIFECYCLE       lifecycle.ts（本文件）          → SYNC + LAYOUT + reader-bus
//
// B 形态（右栏 文摘面板）：进入链只开壳、渲染并 openScriptHost（播放器
// 不动），close 拆 script-host 并清理会话态；reader-bus reset 通知只停同步。
import { state, transitionReaderShell } from "../core/state.js";
import { getReaderElement } from "../shared/dom-utils.js";
import { normalizeReaderTheme } from "../core/validators.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { requestSubtitleRefresh, persistReaderSettingsThroughSeam, subscribeReaderPresenter, notifyReaderPresenter, registerReaderPorts, readerPorts } from "./reader-bus.js";
import type { ReaderPresenterEvent } from "./reader-bus.js";
import { logWarn } from "../shared/logging.js";
// 副轨（双语第二路轨）的目标解析与装载事务：四个装载入口（本处自动装载、弹层开关
// 打开 / 跨上下文收敛、副列改选、副列重试）的唯一落点，判定与在飞登记都在那里。
import { ensureSecondarySubtitleLoaded } from "./secondary-subtitle.js";

// 分层惰性：启动接线（installReaderDebugHelpers / bindSettingsWatcher）与
// 启动期呈现（hydrate/apply/renderReadingStatus）在常驻微模块
// ./init-essentials.js、./presentation.js；本文件只保留 reader 域的重活：
// 进入/退出生命周期、偏好更新与 reader-bus 通知处理体；列表/meta 等渲染投影
// 知识收在 ./view-render.ts，本文件在装配点把会话态投影注进渲染驱动。
import {
  renderReadingStatus,
  hydrateReaderStateFromSettings,
  applyReadingViewPresentation
} from "./presentation.js";
import { READER_CLOSE_ATTRS, READER_READY_ATTR } from "./presentation-fields.js";

// LAYOUT (state) functions this module drives:
import { ids } from "./state.js";
// B 形态右栏 文摘面板定位器：进入时开始贴栏定位，关闭时拆除。LAYOUT 层
// 只剩 video-bind + script-host。
import { openScriptHost, closeScriptHost, waitForScriptAnchor } from "./script-host.js";
import { resetManualScrollPause, setProgrammaticScrollUntil } from "./state.js";
// tab 位置持久化叶子（2026-10 用户决议）：进入阅读模式时恢复上次所在标签，
// 不再一律重置回「字幕」——取值在 reader/script-tab-persistence（chrome.storage
// .local）。落值与二级激活单点在标签激活属主 reader/script-tab-activation
//（本域只做打开时机上的恢复触发；重渲 renderReadingView 不重置，避免打断用户
// 所在标签）。读者域仍不静态 import ui-renderer：属主经 reader-bus 投影命令
// 触达壳，壳未装载时命令静默丢弃，与原 DOM 缺失时 setter 空转同形。
import { loadReaderScriptTab } from "./script-tab-persistence.js";
import { activateScriptTab } from "./script-tab-activation.js";
// PR5：对话 tab 的二级惰性装载/断流收口经 ./lazy-chat-tab 叶子触达
//（本文件不静态依赖对话组合根；未装载 = 对话功能从未启用，清理 no-op）。
import { ensureReaderChatTab, isReaderChatTabLoaded } from "./lazy-chat-tab.js";
// 字幕分批渲染状态机（rAF 任务/游标/spacer 收敛）在 ./batched-render.ts；
// flush 端口实现与批次回执 hook 经下方 import 取用；关闭时取消未完成的
// 追加任务用 cancelReadingSubtitleAppend。
import {
  cancelReadingSubtitleAppend,
  ensureReadingSubtitleRenderedUpTo,
  setReadingSubtitleBatchHook
} from "./batched-render.js";
// 换轨进场动画的标记消费（用户主动换轨才播一次，口径见该模块头注）。
// 字幕 tab：句内搜索实例由本模块装配持有（批次回执 hook + 重渲重放 + 关闭
// 清理）、转写中间态横幅（相位订阅 + 渲染尾部收敛）、待解释意图契约（选区
// 解释卡片「去对话追问」写入、对话 tab 消费；会话收尾清除）。
import { createSubtitleSearch } from "./subtitle-search.js";
import { bindReadingTranscribeBanner, updateReadingTranscribeBanner } from "./transcribe-banner.js";
// 字幕工具条选轨控件（ui/custom-select 形态）的渲染入口与 change 绑定。模板/交互
// 归 subtitle-tab-ui 叶子持有，本域只做「渲染尾部投影一次」与「失败通知经
// reader-bus」两件组装根的事（与搜索/横幅同款分工：重活各归其域，本文件负责
// 时机与接线）。
import {
  createSubtitleToolbar,
  type SubtitleToolbar
} from "./subtitle-tab-ui.js";
import { clearPendingExplainIntent } from "./explain-intent.js";
// 选区「解释」卡片（面板内弹层）：会话收尾时关卡片并中止在飞解释请求。
import { closeReaderExplainCard } from "./explain-card.js";
import { closeQuoteShareModal } from "./quote-share-modal.js";
// 概览 tab：协调器实例由本模块装配持有——打开即自动生成（enter/subtitle-ready）、
// 投影格经 renderReadingOverview 包装驱动、关闭清理经 reset 归位。
import {
  createOverviewCoordinator,
  type ReaderOverviewCoordinator,
  type ReaderOverviewPhase,
  type ReaderOverviewSnapshot
} from "./overview-coordinator.js";
import {
  registerOverviewUiActions,
  renderReadingOverview as renderReadingOverviewUi
} from "./overview-ui.js";
import { resolveActiveProvider } from "../ai/active-provider.js";
import { confirmDialog } from "../ui/confirm-dialog.js";
import { createViewRender, renderReaderPanels } from "./view-render.js";
// 初始快捷问题的逐视频预热（字幕就绪即后台生成三个问题，对话 tab 直接取用）。
import { warmUpInitialQuickPrompts } from "./quick-prompts.js";

// ===== reader 域显式端口的单点注册 =====
//
// 本模块是 reader 域的组装根（合法依赖 SYNC + LAYOUT），在模块求值时把全部
// 端口实现一次性注册进 reader-bus 的端口组：
//   - syncReadingViewPlayback / noteManualReaderInteraction：SYNC 域实现
//    （LAYOUT 经端口回调，不静态 import SYNC）；
//   - flushReadingSubtitleToIndex → ensureReadingSubtitleRenderedUpTo：
//     本域的分批补渲染实现（实现在 ./batched-render.js，由本模块单点注册；
//     SYNC 经端口回调）。SYNC → LIFECYCLE 是依赖图禁止的边，经端口反转。
// 函数声明有提升，模块求值时表已完整；重复注册由注册入口报错拦截。
registerReaderPorts({
  syncReadingViewPlayback: syncReadingViewPlayback as (...args: unknown[]) => unknown,
  noteManualReaderInteraction: noteManualReaderInteraction as (...args: unknown[]) => unknown,
  flushReadingSubtitleToIndex: ensureReadingSubtitleRenderedUpTo as (...args: unknown[]) => unknown
});

// Presenter seam 的 reader 侧订阅（原常驻微模块 init-essentials 的
// bindReaderPresenter，随双实例缺陷修复搬进本域）：content 两轮构建
//（scripts/build-content.js）把常驻底座在懒加载区重复一份，reader-bus 因此有
// 两个实例——常驻侧注册的订阅收不到懒加载区（fetcher/commit 发布）的通知，
// 「抓取完成…」这类状态行文案永远写不进去（字幕已落账、状态行却停在
// 「正在获取可用字幕...」的根因）。订阅移进发布方所在的懒加载区：域装载 ⇔
// 阅读视图打开过，语义与原先「未装载且视图未打开则跳过」的门控等价，且通知
// 不再跨实例丢失。函数声明有提升，此处注册即完整；处理体直接收事件对象，
// 与发布方共用同一个 ReaderPresenterEvent 形状。
subscribeReaderPresenter(handleReaderPresenterNotification);

// 字幕 tab 的组装根单点接线（与上方端口注册同位）：
//   - 批次回执 hook：分批渲染每次 [from, to) 上屏后通知句内搜索补高亮
//     （batched-render 不 import subtitle-search，经此槽反转依赖，避免成环）；
//   - 转写相位订阅：asr-transcribing/done/failed 实时切换横幅（视图开着才碰 DOM）。
setReadingSubtitleBatchHook((fromIndex, toIndex) =>
  subtitleSearch.handleRangeAppended(fromIndex, toIndex)
);
bindReadingTranscribeBanner();
// 选轨控件：深 module 实例持有工具条 UI 相位与事件接线。
//   - 结果通知回调：切轨失败经 reader-bus 的 "status" 通道报错（构造注入，跨壳重建存活）；
//   - 事件订阅（相位 / 双语偏好）由实例 bindEvents() 承载，绑一次语义由实例唯一性保证；
//   - change 绑定不在这里：原生 select 由壳模板产出、随壳 forceRecreate 重建，
//     监听器随建壳接线（subtitle-tab-ui 经组件 initCustomSelect 的 onChange 交进去）。
export const subtitleToolbar: SubtitleToolbar = createSubtitleToolbar({
  onNotice: (text) => notifyReaderPresenter({ kind: "status", text })
});

// 句内搜索生产实例（工厂与依赖注入见 ./subtitle-search.ts）：DOM 访问绑 reader
// 的常驻 id，补渲染/手动交互绑端口与 SYNC。对外具名入口（refresh / move / clear）
// 是它的薄转发，reader 域入口与 tab-ui 回调消费具名入口，不感知实例存在。
const subtitleSearch = createSubtitleSearch({
  getSearchInput: () => document.getElementById(ids.readingSearchInput) as HTMLInputElement | null,
  getSubtitleList: () => document.getElementById(ids.readingSubtitleList),
  flushReadingSubtitleToIndex: (itemIndex) => readerPorts.flushReadingSubtitleToIndex(itemIndex),
  noteManualReaderInteraction: () => noteManualReaderInteraction()
});

// 重算并重放搜索（输入变化 / renderReadingView 重渲后由渲染尾部投影调用）。
export function refreshReadingSubtitleSearch(
  options: { preserveIndex?: boolean; scroll?: boolean } = {}
): void {
  subtitleSearch.refresh(options);
}

// 上/下一条循环导航（Enter=+1、Shift+Enter=-1、按钮同款），环绕像浏览器 Find。
export function moveReadingSubtitleSearch(direction: 1 | -1): void {
  subtitleSearch.move(direction);
}

// 清空搜索状态（清输入 + 还原文本 + 计数归零）。closeReadingView 的会话收尾
// 与「换视频」场景调用；输入框 DOM 常驻（tab 显隐不销毁），必须显式清值。
export function clearReadingSubtitleSearch(): void {
  subtitleSearch.clear();
}

// 概览协调器生产实例：注入生产依赖（state 读取、provider 解析、analysis 动态
// 装载、confirm 弹窗、UI 动作注册）。计时器经箭头转发：调用点才解析全局
// setInterval/clearInterval，测试环境在模块装载后替换全局计时器（fake timers）
// 也能生效。
const overviewCoordinator: ReaderOverviewCoordinator = createOverviewCoordinator({
  getClip: () => state.clip,
  isReadingViewOpen: () => state.reader.readingViewOpen,
  resolveProvider: () => resolveActiveProvider(),
  loadAnalysis: () => import("../ai/analysis.js"),
  confirm: (options) => confirmDialog(options),
  registerUiActions: (actions) => registerOverviewUiActions(actions),
  now: () => Date.now(),
  setInterval: (...args) => setInterval(...args),
  clearInterval: (...args) => clearInterval(...args)
});
export { overviewCoordinator };

export const triggerReaderOverviewGeneration = (
  options?: { forceRefresh?: boolean }
): Promise<void> => overviewCoordinator.trigger(options);
export const cancelReaderOverview = (): void => overviewCoordinator.cancel();
export const resetReaderOverviewState = (): void => overviewCoordinator.reset();
export const getReaderOverviewPhase = (): ReaderOverviewPhase => overviewCoordinator.getPhase();
export const getReaderOverviewSnapshot = (): ReaderOverviewSnapshot =>
  overviewCoordinator.getSnapshot();
export const ensureReaderOverviewTab = (): void => overviewCoordinator.ensureTab();

/**
 * 渲染阅读视图概览 tab。若传入快照则按快照投影；未传参数时自动取协调器的当前快照。
 */
export function renderReadingOverview(snapshot?: ReaderOverviewSnapshot): void {
  if (snapshot) {
    renderReadingOverviewUi(snapshot);
  } else {
    renderReadingOverviewUi(overviewCoordinator.getSnapshot());
  }
}

// 阅读视图渲染驱动：base 投影（meta 行 / 字幕列表 / 设置面板 / 排版应用）在
// ./view-render.ts；会话态投影在装配点这里声明，追加在 base 之后——渲染尾部
// 的收敛次序：句内搜索重放（列表刚被整体重建，高亮/计数按当前输入重算；
// scroll:false 不打断阅读位置）→ 转写横幅 → 概览 → 字幕工具条。
const viewRender = createViewRender({
  sessionProjections: [
    { id: "subtitle-search", project: () => subtitleSearch.refresh({ scroll: false }) },
    { id: "transcribe-banner", project: updateReadingTranscribeBanner },
    { id: "overview", project: () => renderReadingOverview() },
    { id: "subtitle-toolbar", project: () => subtitleToolbar.render() }
  ]
});
export const renderReadingView = viewRender.render;
// 装配后的完整投影表（base + 会话态）：「渲染次序与投影身份」的声明面，
// render-projections 测试按它锁次序。
export const READER_VIEW_PROJECTIONS = viewRender.projections;

// SYNC functions this module drives (from sync.js):
import {
  startReadingViewSync,
  stopReadingViewSync,
  syncReadingViewPlayback,
  noteManualReaderInteraction,
  updateReaderFollowState
} from "./sync.js";

// 字幕抓取起跑序列（在手/在飞判定 → 等元数据 → 装链 → 刷新）收进
// subtitle/kick-subtitle-fetch 单源；本域只注入失败出口与收尾：经 reader-bus seam
// 转发刷新（reader → fetcher 依赖反转边，seam 只传话，handler 由链装载注册），
// 装载失败仅 logWarn 且照旧发起刷新（seam 无 handler 时空转），刷新失败写状态栏
//（stale 代次让位静默），两种落定都走 reconcile 对账收尾。
import { kickSubtitleFetch } from "../subtitle/kick-subtitle-fetch.js";

async function maybeRefreshReaderSubtitleInBackground() {
  // 后判定（等元数据期间字幕可能已被别处落账，再起一轮只是白刷一次——
  // refreshClip 固定 forceRefresh 走网络重取，状态行停在「正在获取可用字幕...」
  // 而列表已是本视频字幕）命中时照旧对账重渲：subtitle-ready 通知可能丢，
  // 列表需要按当前 state 投影一次。
  await kickSubtitleFetch(() => requestSubtitleRefresh(), {
    skipIfInHandOrInFlight: true,
    awaitVideoMetadata: true,
    recheckAfterVideoMetadata: true,
    onChainLoadFailed: (error) =>
      logWarn("[BILISCRIPT] subtitle refresh (summarize chain load) failed", { error }),
    continueAfterChainLoadFailed: true,
    onRefreshFailed: (error) => renderReadingStatus(`字幕加载失败：${getErrorMessage(error)}`),
    onInHandOrInFlight: reconcileReaderAfterSubtitleFetch,
    afterRefreshSettled: reconcileReaderAfterSubtitleFetch
  });
}

export interface ReaderSubtitleReadyOptions {
  /** 状态行文案（可选，通知路径传入；未传则不更新状态行） */
  statusText?: string;
  /** 是否重启播放同步并立即定位（通知路径为 true，对账路径为 false） */
  syncPlayback?: boolean;
  /** 是否在视图未开时也尝试装载双语副轨（通知路径为 true，全局偏好且视图未开也照抓；对账路径为 false） */
  ensureSecondarySubtitle?: boolean;
  /**
   * 概览与预热的触发门控。
   * - "if-subtitles-present"（对账路径）：仅当 state.clip.subtitleBody 非空时触发；
   * - "always"（通知路径）：直接调用触发入口（由概览机内部判空态迁移，预热内部去重/判空）。
   */
  triggerMode?: "always" | "if-subtitles-present";
}

// 字幕就绪副作用单一收口入口（工单 arch-review-batch3/01）：
// 一处声明完整副作用串与次序：重投影 → 状态行 → 播放同步重启 → 概览触发 → 快捷问题预热。
// 视图未开时整条跳过（reconcile 路径）或部分跳过（通知路径的双语装载在视图外）以显式参数表达。
// 两路触发（subtitle-ready 通知、fetch 落定对账）共用同一份次序与守卫：
//  - renderReadingView 是纯 state 投影（幂等）；
//  - 概览触发（inflight + generatedFor 身份去重，重复触发安全）；
//  - 预热（视频身份去重，无字幕不起）；
//  - 双语副轨装载（视图未开也照抓，Q1 决议，通知路径独有）。
export function onReaderSubtitleReady(options: ReaderSubtitleReadyOptions = {}) {
  const {
    statusText,
    syncPlayback = false,
    ensureSecondarySubtitle = false,
    triggerMode = "always"
  } = options;

  if (state.reader.readingViewOpen) {
    // PR2：字幕列表已常驻右侧面板「字幕」tab，纯 state 幂等重投影
    renderReadingView();

    // 状态行：文案由调用方传入（通知路径独有）
    if (statusText) {
      renderReadingStatus(statusText);
    }

    // 播放同步重启（通知路径独有）
    if (syncPlayback) {
      startReadingViewSync();
      syncReadingViewPlayback(true);
    }

    // PR4：概览自动生成与快捷问题预热
    // 无字幕时保持诚实空态；生成中重复触发被状态机与管线 promise / 身份缓存去重
    const shouldTrigger = triggerMode === "always" || state.clip.subtitleBody.length > 0;
    if (shouldTrigger) {
      triggerReaderOverviewGeneration();
      warmUpReaderQuickPrompts();
    }
  }

  // 视图未开也照抓：双语是全局偏好，用户切到字幕 tab 时就该已经就绪
  // （Q1：开关开着就立刻并行抓，不依赖面板可见性，通知路径独有）。
  if (ensureSecondarySubtitle) {
    ensureSecondarySubtitleLoaded();
  }
}

// 抓取落定后的对账收尾：subtitle-ready/rerender 通知存在丢失形态（发射门控、
// init-essentials 分派链 catch 吞错），一旦丢失，列表渲染与概览自动生成只剩
// 切 tab 兜底——状态栏却照写「抓取完成」，出现「完成但无字幕」的面板态。这里
// 在 fetch 落定后按当前 state 走单一收口进行纯幂等重投影 + 条件触发。
function reconcileReaderAfterSubtitleFetch() {
  onReaderSubtitleReady({
    triggerMode: "if-subtitles-present"
  });
}

// 初始快捷问题的预热触发（与概览生成同位同语义）：字幕已就绪就后台起跑，
// 无字幕时不起（没有素材可生成）；重复触发在 warmUpInitialQuickPrompts 内按
// 视频身份去重（缓存 + 在飞 promise），因此这里 fire-and-forget、不 await。
function warmUpReaderQuickPrompts() {
  if (!state.clip.subtitleBody.length) {
    return;
  }
  void warmUpInitialQuickPrompts({
    bvid: state.clip.bvid,
    cid: state.clip.cid,
    aid: state.clip.aid,
    title: state.clip.title,
    subtitleBody: state.clip.subtitleBody
  });
}

// ===== 双语副轨的自动装载（bilingual-subtitles/02 号票）=====
//
// 主轨就绪即副轨起点（Q1：开关开着就立刻并行抓——不做面板可见判定、不做滚动懒加载；
// Q7a：换视频后按全局偏好 lan 在新轨列表上重新匹配）。三重守卫（① 双语关 ⇒ 不动；
// ② 槽非 idle ⇒ 不动，在飞 / 已就绪 / 已失败三种都不重来；③ 本视频没有目标语言的轨、
// 或目标那一条就是主轨 ⇒ 不动）与装载链（ensureSummarizeChain → loadSecondarySubtitle）
// 都收在 reader/secondary-subtitle.ts：四个装载入口共用同一份判定与事务，弹层只保留
// 自己的 DOM 投影与在飞禁用。下面是 fire-and-forget：失败已由装载器写进副轨槽
//（error 态 + 弹层副列占位即重试入口），事务自己吞异常，不污染主轨的渲染路径。

// Presenter seam 通知的 reader 侧接收表（一 kind 一格，键集由 ReaderPresenterEvent
// 映射类型强制完整）：每个 kind 只有一个接收体，副轨到站不可能顺带混进主轨那串
// 副作用。注册接线在下方 subscribeReaderPresenter（域装载时单点注册）。
type ReaderPresenterReceivers = {
  [K in ReaderPresenterEvent["kind"]]: (event: Extract<ReaderPresenterEvent, { kind: K }>) => void;
};

const readerPresenterReceivers: ReaderPresenterReceivers = {
  reset() {
    stopReadingViewSync();
  },
  "subtitle-ready"(event) {
    onReaderSubtitleReady({
      statusText: String(event.text || "") || "抓取完成，阅读视图已同步最新字幕。",
      syncPlayback: true,
      ensureSecondarySubtitle: true,
      triggerMode: "always"
    });
  },
  rerender() {
    if (state.reader.readingViewOpen) {
      renderReadingView();
    }
  },
  "secondary-subtitle-ready"() {
    // 双语副轨到站（bilingual-subtitles/05 号票）：**只**重渲视图，不复制
    // subtitle-ready 那串副作用（状态行 / 播放同步重启 / 概览生成 / 快捷问题预热）
    // ——那些面只吃主轨（地图 Q6）。
    if (state.reader.readingViewOpen) {
      renderReadingView();
    }
  },
  status(event) {
    renderReadingStatus(String(event.text || ""));
  }
};

// 按事件自身的 kind 取那一格接收体。表键集与事件联合由映射类型对齐，此处只剩
// 「用联合事件调用单格接收体」这一处类型收窄（每格只接受自己的事件成员）。
export function handleReaderPresenterNotification(event: ReaderPresenterEvent) {
  const receive = readerPresenterReceivers[event.kind] as (event: ReaderPresenterEvent) => void;
  receive(event);
}

export async function enterReaderMode(mode: "open" | "restore" = "open") {
  const readingView = getReaderElement(ids.readingView);
  // 视图打开走状态机迁移（entering→open；直开路径 closed→open）
  transitionReaderShell("open");
  document.body.setAttribute("data-biliscript-reading-active", "1");
  hydrateReaderStateFromSettings(state.settings);
  applyReadingViewPresentation();
  // 2026-10 用户决议：打开阅读视图恢复上次所在标签（概览/AI 对话的停留状态
  // 跨刷新与跨视频保留；无记录或脏值回落「字幕」）。读取失败静默回落，不新增
  // 进入失败面；恢复经标签激活属主（reader/script-tab-activation）落地——状态位、
  // 投影与二级激活一处收口，persist:false 表示「恢复不是一次用户切换」、不写回
  // 存储。进入链内的恢复先于 shell chat 档的对话激活（单飞事务队列保证），故
  // 「AI 键进对话」仍以对话 tab 收尾。
  const restoredScriptTab = await loadReaderScriptTab();
  await activateScriptTab(restoredScriptTab, { persist: false });
  // 首载等待锚点就绪：宽屏下若页面 DOM 仍在水合（如自动展开或 URL 直达），
  // 暂缓打开视图壳并等锚点就绪，防止首拍降级为全屏居中浮层后闪漂贴栏。
  await waitForScriptAnchor();
  openReaderViewShell(readingView, mode);
  renderReadingView();
  // 打开即启动播放同步并立即定位：subtitle-ready 只在字幕新抓取落定时到达，
  // 重开（字幕命中缓存）时不会再有该通知——缺了这两行，同步 tick 停在
  // closeReadingView 停止的状态，关闭期间拖动的进度不会反映到字幕列表。
  // 首开路径随后 subtitle-ready 会再 start 一次（幂等：清旧 interval 重启）。
  startReadingViewSync();
  syncReadingViewPlayback(true);
  // B 形态：面板贴右栏 fixed 定位（script-host 负责算 rect/降级浮层）；
  // 播放器保持 B 站原生布局不动，无需等挂载。
  openScriptHost();
  // 字幕未抓取时的后台兜底抓取（原 finishEnterReaderMode 链保留项）：B 形态
  // 面板以字幕为主内容，不依赖播放器挂载成功，直达路径也必须有数据来源。
  maybeRefreshReaderSubtitleInBackground();
  // PR4：打开阅读模式即自动生成概览（基线决议；字幕已就绪的直接生成，缓存命中
  // 免重付费。字幕未就绪时为诚实空态，subtitle-ready 通知到达后再触发；切到
  // 概览 tab 也有兜底触发。生成中重复触发被状态机与管线 promise 复用去重）。
  triggerReaderOverviewGeneration();
  // 同理：打开阅读模式即预热本视频的初始问题（字幕已就绪的直接起跑；未就绪时
  // subtitle-ready 到达后再触发；重复触发由缓存与在飞 promise 去重）。字幕在面板
  // 打开前就已落定（页面预抓取，不再有 subtitle-ready）时，这是唯一的起跑点。
  warmUpReaderQuickPrompts();
}

function openReaderViewShell(
  readingView = getReaderElement(ids.readingView),
  mode: "open" | "restore" = "open"
) {
  if (!readingView) {
    return;
  }
  if (mode === "restore") {
    readingView.setAttribute("data-biliscript-reader-restore", "1");
    requestAnimationFrame(() => {
      readingView.removeAttribute("data-biliscript-reader-restore");
    });
  }
  readingView.classList.remove("closing");
  readingView.classList.add("open", "reader-page");
  readingView.setAttribute("aria-hidden", "false");
  setReadingViewReady(true);
}

// syncReaderModeAfterMount / settleReaderModePresentation 已随整页接管退役
//（B 形态）：播放器挂载/布局/呈现稳定链不再由阅读模式驱动，同步的
// 启动收敛到 subtitle-ready 通知路径（handleReaderPresenterNotification）。
//（waitForVideoMetadata 已出装配根到 bilibili/video-probe 叶子，由
// subtitle/kick-subtitle-fetch 的起跑序列消费。）

export function beginClosingReadingView(): boolean {
  const readingView = getReaderElement(ids.readingView);
  const wasOpen = readingView.classList.contains("open");
  readingView.classList.remove("open");
  readingView.classList.add("closing");
  readingView.setAttribute("aria-hidden", "true");
  return wasOpen;
}

export function closeReadingView() {
  // 收尾清理在收回过渡结束后执行；直关与 restore 失整收敛也复用此入口。
  transitionReaderShell("closed");
  state.reader.setViewReady(false);
  state.reader.setSettingsExpanded(false);
  state.reader.setNextScrollBehavior("smooth");
  // Scroll deadlines moved to sync.js with the sync domain; reset them there
  // so a later manual interaction is never swallowed by stale deadlines.
  resetManualScrollPause();
  setProgrammaticScrollUntil(0);
  const readingView = getReaderElement(ids.readingView);
  readingView.classList.remove("open", "closing", "reader-page");
  readingView.setAttribute("aria-hidden", "true");
  readingView.setAttribute(READER_READY_ATTR, "0");
  readingView.removeAttribute("data-biliscript-reader-restore");
  // 移除清单从呈现属性表派生（presentation-fields.js 的 clearOnClose 标志），
  // 不再手抄。视图就绪态 ready 在主表中声明为 clearViewOnClose:false（close 时复位基线
  // 值 "0" 而非 removeAttribute）；移除清单含 theme/follow。
  for (const attr of READER_CLOSE_ATTRS.readingView) {
    readingView.removeAttribute(attr);
  }
  for (const attr of READER_CLOSE_ATTRS.body) {
    document.body.removeAttribute(attr);
  }
  for (const attr of READER_CLOSE_ATTRS.html) {
    document.documentElement.removeAttribute(attr);
  }
  // PR2：字幕列表常驻面板 tab，不再有内联宿主需要恢复。
  // 候选10 批2：关闭阅读视图时取消未完成的字幕分批追加（rAF 与任务一并作废），
  // 避免关闭后还往已脱离上下文的列表追加节点。
  cancelReadingSubtitleAppend();
  // PR3：字幕 tab 的会话态随视图关闭一并清掉——搜索（输入框值 + 高亮 + 计数）
  // 与待解释意图（不跨会话残留；下次打开按空态渲染）。
  clearReadingSubtitleSearch();
  clearPendingExplainIntent();
  // 选区「解释」卡片：关卡片（内部会 abort 在飞解释请求，避免关闭后回执落 DOM）。
  closeReaderExplainCard();
  closeQuoteShareModal();
  // PR5：对话 tab 的断流收口（工单 08 决议：关闭即断流——resetStreamState 断
  // port、挂起的 subtitle-wait 失效、摘全局触发源；重开从会话历史恢复，由对话
  // tab 的激活路径负责）。未装载 = 对话功能从未启用，no-op（不触发懒加载）。
  // 收口失败静默：不影响视图关闭本身。
  if (isReaderChatTabLoaded()) {
    void closeChatSessionQuietly();
  }
  // PR4：概览 tab 的会话态一并归位（状态机回 idle、产物引用丢弃；进行中的
  // 生成不取消——管线后台跑完落缓存，重开阅读模式读缓存命中）。
  resetReaderOverviewState();
  stopReadingViewSync();
  closeScriptHost();
}

// 对话 tab 会话关闭的静默收尾（closeReadingView 的 fire-and-forget 半边）：
// 装载/关闭失败不外抛，与迁移前的 `.catch(() => {})` 口径一致。
async function closeChatSessionQuietly(): Promise<void> {
  try {
    const chat = await ensureReaderChatTab();
    await chat.closeChatSession();
  } catch {
    // 静默：收口失败不影响视图关闭。
  }
}

// ===== 偏好更新（仅在阅读视图交互时执行，常驻侧经 ensureReaderDomain 转发到这些导出） =====

export function updateReaderPreferences(next: Partial<Record<string, unknown>>, { persist = true } = {}) {
  state.reader.setTheme(normalizeReaderTheme(next.readerTheme ?? state.reader.readingTheme));
  state.setSettings({
    ...state.settings,
    readerTheme: state.reader.readingTheme,
    // header 按钮是唯一手动主题入口：落哨兵后，此后水合（启动/跨页同步）
    // 不再按系统偏好覆盖用户选择。
    readerThemeUserSet: true
  });
  applyReadingViewPresentation();
  renderReaderPanels();
  if (persist) {
    persistReaderSettings();
  }
}

function persistReaderSettings() {
  persistReaderSettingsThroughSeam();
}

function setReadingViewReady(ready: boolean) {
  state.reader.setViewReady(Boolean(ready));
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  readingView.setAttribute(READER_READY_ATTR, state.reader.readingViewReady ? "1" : "0");
  readingView.setAttribute("aria-busy", state.reader.readingViewReady ? "false" : "true");
}


