// 面板 header 状态行（#biliscript-reading-status，阅读视图内 header 下方的
// 唯一状态宿主）的显示策略（2026-09 用户决议）：
//   - 播放进度不再写入（原每 250ms tick 覆盖该行；字幕列表自动高亮本身就是
//     位置反馈）；
//   - 错误/失败类文案常驻：用户明确要求错误不自动消失，直到下一条文案覆盖；
//   - 其余提示/进度/操作反馈类文案写入即显示，5s 后清空并 hidden；
//   - 空文案：立即清空并 hidden（空闲态整行收起，面板网格第 2 行 auto 塌为 0）；
//   - 转写中的进度文案不落 header 行（字幕 tab 的转写横幅有独立进度行），
//     只经 state.ui.statusText 供横幅消费；错误文案不受此抑制。
//
// 两个写入方（core/ui-status 的 setStatus/setMessage、reader/presentation 的
// renderReadingStatus）共用本模块，避免各写一套显隐口径。
//
// 本模块是双实例（常驻包 + 懒加载区各一份，见 docs/adr/0008）且**不含模块级
// 可变状态**：自动收起的计时句柄挂在状态行元素本身（__biliscriptStatusHideTimer），
// 而不是模块级变量——两侧实例写的是同一个 DOM 节点，句柄随节点共享，后写的
// 文案才能取消先写的计时（模块级变量会各自计时，旧计时器会把新实例的文案提前
// 清掉）。元素被整体替换时旧节点连同其句柄一起被丢弃，新节点天然无遗留计时。
//
// 转写中判定经 shared/subtitle-status-bus.js 的相位镜像：该叶子因此被常驻包
// 引入成为双实例（已入 build-content.js 清单 mutable: true + 头注标记）。发布方
// （subtitle/fetcher）与全部转写相位消费方（reader 域横幅/判定、转写编排
// asr/*）都在懒加载区同一实例内，读写闭环不被拆散；常驻侧副本镜像恒为空串
// （常驻侧不产生 ASR 进度文案），只让常驻侧的状态行判定走「非转写中」分支。

import { isReaderTranscribing } from "./reader-transcribing.js";

// 自动收起时长：错误类文案以外的状态文案在有下一件事发生前的最长停留时间。
export const STATUS_LINE_AUTO_HIDE_MS = 5000;

// 常驻（不自动收起）的错误/失败类词表。状态行文案是展示层字符串，写入方分散在
// subtitle/asr/reader/ai 各域，分类集中在此裁决；语料锁在
// tests/reader/reading-status-line.test.ts（常驻语料表）。新增错误文案若不含
// 下列词，需在此登记，否则会被当成普通提示 5s 收起。
const PERSISTENT_STATUS_PATTERNS: readonly RegExp[] = [
  /失败/,
  /错误/,
  /无法/,
  /没有找到/,
  /没有可/,
  /未找到/,
  /无字幕/
];

export function isPersistentStatusText(text: unknown): boolean {
  const value = String(text ?? "");
  return PERSISTENT_STATUS_PATTERNS.some((pattern) => pattern.test(value));
}

// 状态行元素及其上的计时句柄（跨实例共享：两侧拿到的是同一个 DOM 节点）。
type StatusLineNode = HTMLElement & { __biliscriptStatusHideTimer?: number | undefined };

function cancelAutoHide(node: StatusLineNode): void {
  const timer = node.__biliscriptStatusHideTimer;
  if (timer !== undefined) {
    clearTimeout(timer);
    delete node.__biliscriptStatusHideTimer;
  }
}

// 节点由调用方解析（core/ui-status 走 getElementById 允许缺失，reader/presentation
// 走 getReaderElement 缺失即抛错——两侧原行为都保留）。节点缺失时无可写对象，
// 直接返回（状态本体仍由调用方写进 state）。
export function writeReadingStatusLine(node: HTMLElement | null, text: unknown): void {
  const next = String(text ?? "");
  // 转写进度不落 header 行（横幅已显示同一进度）；错误文案照常显示，空文案
  //（清除）也不受抑制——否则转写期间的清除调用会让旧文案赖在 header 上。
  // 此处不取消失效计时器：转写前遗留的提示文案按原定时间正常收起。
  if (node && next && isReaderTranscribing() && !isPersistentStatusText(next)) {
    return;
  }
  if (!node) {
    return;
  }
  const line = node as StatusLineNode;
  cancelAutoHide(line);
  if (line.textContent !== next) {
    line.textContent = next;
  }
  if (!next) {
    line.hidden = true;
    return;
  }
  line.hidden = false;
  if (isPersistentStatusText(next)) {
    return;
  }
  line.__biliscriptStatusHideTimer = window.setTimeout(() => {
    delete line.__biliscriptStatusHideTimer;
    line.textContent = "";
    line.hidden = true;
  }, STATUS_LINE_AUTO_HIDE_MS);
}
