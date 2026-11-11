// 面板 header 状态行（#biliscript-reading-status，阅读视图内 header 下方的
// 唯一状态宿主）的显示策略：
//   - 播放进度不再写入（原每 250ms tick 覆盖该行；字幕列表自动高亮本身就是
//     位置反馈）；
//   - 字幕抓取与无字幕/语音转写相关的报错与状态提示不落 header 行（下方字幕列表/空态已有对应展示，避免上下重复）；
//   - 其余非字幕链路的错误/失败类文案常驻：直到下一条文案覆盖；
//   - 转写中的进度文案不落 header 行（字幕 tab 的转写横幅有独立进度行），
//     只经 state.ui.statusText 供横幅消费；错误文案不受此抑制；
//   - 其余操作反馈类文案写入即显示，5s 后清空并 hidden；
//   - 空文案：立即清空并 hidden（空闲态整行收起，面板网格第 2 行 auto 塌为 0）。
//   - 读屏镜像：可见行在 aria-hidden 的阅读视图内，对辅助技术不可达；有效文案
//     同步到 document.body 下的 #biliscript-reading-status-live（视觉隐藏的
//     role="status" live region），口径与可见行一致（抑制文案不同步）。
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
import { ids } from "../shared/dom-ids.js";

// 自动收起时长：错误类文案以外的状态文案在有下一件事发生前的最长停留时间。
export const STATUS_LINE_AUTO_HIDE_MS = 5000;

// 常驻（不自动收起）的错误/失败类词表。状态行文案是展示层字符串，写入方分散在
// subtitle/asr/reader/ai 各域，分类集中在此裁决；语料锁在
// tests/reader/reading-status-line.test.ts（常驻语料表）。
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

// 用户主动操作（复制/导出）的即时反馈，不属于自动弹出的抓取/报错，不抑制。
const ACTION_FEEDBACK_PATTERNS: readonly RegExp[] = [
  /已复制/,
  /已下载/,
  /没有可复制/,
  /没有可下载/,
  /复制失败/
];

// 字幕抓取与无字幕/语音转写提示词表（下方字幕列表已有即时渲染与空态展示，不落 header 行以避免上下重复）。
const SUBTITLE_SUPPRESSED_PATTERNS: readonly RegExp[] = [
  /抓取/,
  /无字幕/,
  /语音识别/,
  /音频转写/,
  /获取.*字幕/,
  /刷新.*字幕/,
  /同步.*字幕/,
  /加载字幕/,
  /字幕加载/
];

export function isSuppressedReadingStatusText(text: unknown): boolean {
  const value = String(text ?? "");
  if (ACTION_FEEDBACK_PATTERNS.some((pattern) => pattern.test(value))) {
    return false;
  }
  return SUBTITLE_SUPPRESSED_PATTERNS.some((pattern) => pattern.test(value));
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

// ===== 读屏镜像 live region =====
//
// 可见状态行在 #biliscript-reading-view 内，而该根节点常驻 aria-hidden="true"
//（整个阅读面板不进无障碍树），行内的 role="status" 语义对读屏不可达。因此把
// 一份同文案镜像写到 document.body 下的本节点（视觉隐藏、始终在无障碍树内），
// aria-live="polite" 在文本变化时礼貌播报。同步口径与可见行完全一致：同一份
// 抑制/转写判定后的有效文案，可见行不写它就不写（转写进度早退分支不触碰）。
// 双实例（常驻包 + 懒加载区）共享同一 document：节点按 id 取或建，两侧写的是
// 同一个 DOM 节点，与本模块无模块级可变状态的纪律一致。
function syncStatusLiveRegion(text: string): void {
  let node = document.getElementById(ids.readingStatusLive) as HTMLElement | null;
  if (!node) {
    node = document.createElement("p");
    node.id = ids.readingStatusLive;
    node.className = "biliscript-reading-status-live";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    node.setAttribute("aria-atomic", "true");
    document.body.appendChild(node);
  }
  if (node.textContent !== text) {
    node.textContent = text;
  }
}

// 节点由调用方解析（core/ui-status 走 getElementById 允许缺失，reader/presentation
// 走 getReaderElement 缺失即抛错——两侧原行为都保留）。节点缺失时无可写对象，
// 直接返回（状态本体仍由调用方写进 state）。
export function writeReadingStatusLine(node: HTMLElement | null, text: unknown): void {
  const next = String(text ?? "");
  if (!node) {
    return;
  }
  const line = node as StatusLineNode;
  cancelAutoHide(line);

  // 报错文案与抓取字幕提示不落 header 行（下方字幕列表/空态已有对应展示，避免上下重复；
  // 命中抑制时隐藏并清空状态行，不占位）；镜像区同步清空，不播报被抑制文案
  if (isSuppressedReadingStatusText(next)) {
    line.textContent = "";
    line.hidden = true;
    syncStatusLiveRegion("");
    return;
  }

  // 转写进度不落 header 行（横幅已显示同一进度）；错误文案不受此抑制。
  // 早退＝可见行保持原状，镜像区同样不动（没有新的可见文案就无新播报）。
  if (next && isReaderTranscribing() && !isPersistentStatusText(next)) {
    return;
  }

  if (line.textContent !== next) {
    line.textContent = next;
  }
  syncStatusLiveRegion(next);
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
    // 镜像与可见行同生命周期：可见文案收起即同步清空，不残留已消失内容
    syncStatusLiveRegion("");
  }, STATUS_LINE_AUTO_HIDE_MS);
}
