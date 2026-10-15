// PR4 概览 tab 门面（arch-review-batch3/02）：
// 协调逻辑（相位机/并发闸门/wait ticker/去重）收在 reader/overview-coordinator.ts；
// 呈现与交互（HTML 拼装/DOM 投影/点击分派）收在 reader/overview-ui.ts。
// 本文件作为向后兼容聚合门面保留，维持现有对外导出契约。

import * as self from "./overview.js";
import {
  triggerReaderOverviewGeneration as coordinatorTrigger,
  cancelReaderOverview as coordinatorCancel,
  resetReaderOverviewState as coordinatorReset,
  getReaderOverviewPhase as coordinatorGetPhase,
  getReaderOverviewSnapshot as coordinatorGetSnapshot,
  ensureReaderOverviewTab as coordinatorEnsureTab,
  type ReaderOverviewPhase,
  type ReaderOverviewSnapshot,
  type ReaderOverviewCoordinator
} from "./overview-coordinator.js";

import { renderReadingOverview as renderReadingOverviewUi } from "./overview-ui.js";

export type {
  ReaderOverviewPhase,
  ReaderOverviewSnapshot,
  ReaderOverviewCoordinator
};

export const triggerReaderOverviewGeneration = coordinatorTrigger;
export const cancelReaderOverview = coordinatorCancel;
export const resetReaderOverviewState = coordinatorReset;
export const getReaderOverviewPhase = coordinatorGetPhase;
export const getReaderOverviewSnapshot = coordinatorGetSnapshot;
export const ensureReaderOverviewTab = coordinatorEnsureTab;

export const overviewCoordinator: ReaderOverviewCoordinator = {
  trigger(options) {
    return self.triggerReaderOverviewGeneration(options);
  },
  cancel() {
    self.cancelReaderOverview();
  },
  reset() {
    self.resetReaderOverviewState();
  },
  getPhase() {
    return self.getReaderOverviewPhase();
  },
  getSnapshot() {
    return self.getReaderOverviewSnapshot();
  },
  render() {
    self.renderReadingOverview();
  },
  ensureTab() {
    self.ensureReaderOverviewTab();
  }
};

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
    renderReadingOverviewUi(self.getReaderOverviewSnapshot());
  }
}
