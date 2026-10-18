// 概览 tab 门面：协调器的生产装配点 + 既有对外导出契约的聚合出口。
// 协调逻辑（相位机/并发闸门/wait ticker/去重）在 reader/overview-coordinator.ts（工厂）；
// 呈现与交互（HTML 拼装/DOM 投影/点击分派）在 reader/overview-ui.ts。
// 本文件注入生产依赖（state 读取、provider 解析、analysis 动态装载、confirm 弹窗）
// 并导出单例的七件套窄接口，模块装载即完成 UI 动作注册。

import { state } from "../core/state.js";
import { resolveActiveProvider } from "../ai/active-provider.js";
import { confirmDialog } from "../ui/confirm-dialog.js";
import {
  createOverviewCoordinator,
  type ReaderOverviewPhase,
  type ReaderOverviewSnapshot,
  type ReaderOverviewCoordinator
} from "./overview-coordinator.js";

import {
  renderReadingOverview as renderReadingOverviewUi,
  registerOverviewUiActions
} from "./overview-ui.js";

export type {
  ReaderOverviewPhase,
  ReaderOverviewSnapshot,
  ReaderOverviewCoordinator
};

const overviewCoordinator: ReaderOverviewCoordinator = createOverviewCoordinator({
  getClip: () => state.clip,
  isReadingViewOpen: () => state.reader.readingViewOpen,
  resolveProvider: () => resolveActiveProvider(),
  loadAnalysis: () => import("../ai/analysis.js"),
  confirm: (options) => confirmDialog(options),
  registerUiActions: (actions) => registerOverviewUiActions(actions),
  now: () => Date.now(),
  // 计时器经箭头转发：调用点才解析全局 setInterval/clearInterval，
  // 测试环境在模块装载后替换全局计时器（fake timers）也能生效。
  setInterval: (...args) => setInterval(...args),
  clearInterval: (...args) => clearInterval(...args)
});

export const triggerReaderOverviewGeneration = overviewCoordinator.trigger;
export const cancelReaderOverview = overviewCoordinator.cancel;
export const resetReaderOverviewState = overviewCoordinator.reset;
export const getReaderOverviewPhase = overviewCoordinator.getPhase;
export const getReaderOverviewSnapshot = overviewCoordinator.getSnapshot;
export const ensureReaderOverviewTab = overviewCoordinator.ensureTab;

export { overviewCoordinator };

export {
  onReadingOverviewClick,
  buildOverviewTabBodyHtml,
  bindReadingOverviewEvents
} from "./overview-ui.js";

/**
 * 渲染阅读视图概览 tab。
 * 若传入快照则按快照投影；未传参数时自动取协调器的当前快照（兼容旧调用）。
 */
export function renderReadingOverview(snapshot?: ReaderOverviewSnapshot): void {
  if (snapshot) {
    renderReadingOverviewUi(snapshot);
  } else {
    renderReadingOverviewUi(getReaderOverviewSnapshot());
  }
}
