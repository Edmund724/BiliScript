// 阅读视图一次渲染的投影知识（reader 动态域）。
//
// 本模块是「一次 renderReadingView 要投影什么、按什么次序」的唯一真源：
// base 投影（meta 行 / 字幕列表 / 设置面板 / 排版应用）在此声明，渲染驱动
// render() 按声明次序逐格投影、尾部归零选中标记。会话态投影（句内搜索重放 /
// 转写横幅 / 概览收敛 / 字幕工具条）由组装根 lifecycle.ts 在装配期传入，追加在
// base 之后——渲染次序的知识只在本文件与 lifecycle 的装配点两处，改次序先动这里。
//
// 取数归属：各投影仍各自读 state 袋与各自模块内的相位，本表是「渲染次序与投影
// 身份的单源」，不是「渲染输入的单源」。
//
// 依赖：core/state、subtitle/core、./batched-render、./presentation、
// notes/section-lines、./subtitle-item-dom 与 shared 叶子；不 import lifecycle（会话态投影经注入反转）。
import { state } from "../core/state.js";
import { getReaderElement } from "../shared/dom-utils.js";
import {
  getReadingSubtitleItems,
  getReadingSubtitlePlaceholderText
} from "../subtitle/core.js";
import { escapeHtml } from "../shared/string-utils.js";
import { shouldShowHoursInNote } from "../notes/section-lines.js";
import {
  SUBTITLE_FIRST_BATCH,
  buildReadingSubtitleItemHtml,
  calibrateReadingSubtitleItemEstimate,
  cancelReadingSubtitleAppend,
  startReadingSubtitleAppendTask
} from "./batched-render.js";
import {
  clearSubtitleItemIndex,
  indexSubtitleItems
} from "./subtitle-item-dom.js";
import { applyReadingViewPresentation } from "./presentation.js";
import { ids } from "./state.js";

export interface ReaderViewProjection {
  readonly id: string;
  project(): void;
}

// meta 行投影（一次渲染的步骤之一）：只读 clip 的作者/分P 事实。
function projectReadingMetaLine(): void {
  const metaNode = getReaderElement(ids.readingMeta);
  if (!metaNode) {
    return;
  }
  const metaLine = buildReadingMetaLine();
  metaNode.textContent = metaLine;
  // 字段全空（无作者/单P）时整块隐藏：header 不留空行。
  // 只隐藏 meta 本体——.biliscript-reading-header-copy 的「手动浏览中」::after
  // 挂在其父节点上（reader-gate.css），隐藏父节点会连带吃掉该标注。
  metaNode.hidden = !metaLine;
}

// 作者加「UP主：」前缀（「标签：值」口径）；分P 不跟在 UP主 后面——`UP主：…` 与
// `P{n}：…` 各占一行（本函数返回带 \n 的文本，视觉换行由 .biliscript-reading-meta
// 的 white-space:pre-line 落地），长分P标题不从中间折断；无分P标题时只留 P{n}，
// 不落一个悬空的全角冒号。字幕来源/语言不在 meta 行投影。
function buildReadingMetaLine() {
  const head = [];
  if (state.clip.author) {
    head.push(`UP主：${state.clip.author}`);
  }
  if (Number(state.clip.pageCount) > 1) {
    const page = `P${Number(state.clip.pageIndex) > 0 ? Number(state.clip.pageIndex) : 1}`;
    const pageTitle = String(state.clip.pageTitle || "").trim();
    head.push(pageTitle ? `${page}：${pageTitle}` : page);
  }
  return head.join("\n");
}

// 字幕列表投影（一次渲染的步骤之一）：整表重建 + 首屏分批；先取消上一轮未完成的
// 追加任务，避免旧任务把过期条目追加进新列表。首屏只渲染前 SUBTITLE_FIRST_BATCH
// 条，其余走 rAF 分批追加（./batched-render.ts 的 rAF 状态机），首屏 HTML 形态与
// 整段重建逐字一致；content-visibility 占位高度校准消除估计偏差导致的滚动条
// 拖动不跟手。首屏渲染同步维护条目索引，重建前清空上一代索引映射。
function projectReadingSubtitleList(): void {
  cancelReadingSubtitleAppend();
  const body = Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
  const subtitleItems = getReadingSubtitleItems();
  const withHours = shouldShowHoursInNote(state, body);

  const subtitleList = getReaderElement(ids.readingSubtitleList);
  clearSubtitleItemIndex(subtitleList);
  if (subtitleItems.length === 0) {
    subtitleList.innerHTML = `<div class="biliscript-reading-empty">${escapeHtml(
      getReadingSubtitlePlaceholderText()
    )}</div>`;
  } else {
    const firstEnd = Math.min(subtitleItems.length, SUBTITLE_FIRST_BATCH);
    let firstHtml = "";
    for (let i = 0; i < firstEnd; i += 1) {
      firstHtml += buildReadingSubtitleItemHtml(subtitleItems[i], withHours);
    }
    subtitleList.innerHTML = firstHtml;
    indexSubtitleItems(subtitleList, subtitleList.children);
    calibrateReadingSubtitleItemEstimate(subtitleList);
    if (firstEnd < subtitleItems.length) {
      startReadingSubtitleAppendTask({
        listEl: subtitleList,
        items: subtitleItems,
        cursor: firstEnd,
        withHours
      });
    }
  }
}

// 设置面板投影（一次渲染的步骤之一）：抽屉显隐 + 按钮 active 态；展开时装载
// 原 options 页的全部设置项（宿主容器在 ui-renderer 模板内；模板与数据装载在
// settings-panel 内，展开即刷新）。装载失败静默，渲染异常照旧上浮未处理拒绝。
export function renderReaderPanels() {
  const settingsPanel = getReaderElement(ids.readingSettingsPanel);
  const settingsBtn = getReaderElement(ids.readingSettingsBtn);
  settingsPanel.hidden = !state.reader.readingSettingsExpanded;
  settingsBtn.classList.toggle("is-active", state.reader.readingSettingsExpanded);
  if (!settingsPanel.hidden) {
    void (async () => {
      const mod = await import("../ui/settings-panel.js").catch(() => null);
      mod?.renderReaderSettingsPanel();
    })();
  }
}

// base 投影：meta 行 → 字幕列表 → 设置面板 → 排版应用（含 header 主题按钮与
// mermaid 重着色）。会话态投影由组装根追加在 base 之后，渲染尾部收敛会话态的
// 次序约定（搜索重放 → 转写横幅 → 概览 → 工具条）在 lifecycle 的装配点声明。
const BASE_PROJECTIONS: readonly ReaderViewProjection[] = [
  { id: "meta-line", project: projectReadingMetaLine },
  { id: "subtitle-list", project: projectReadingSubtitleList },
  { id: "reader-panels", project: renderReaderPanels },
  { id: "presentation", project: applyReadingViewPresentation }
];

// 渲染一次阅读视图：按投影表顺序逐格投影，随后把选中标记归零（列表整体重建后
// 旧高亮已不存在）。投影表 = base + 组装根传入的会话态投影， identity 与次序
// 在装配期固定。
export function createViewRender(options: {
  sessionProjections: readonly ReaderViewProjection[];
}): { projections: readonly ReaderViewProjection[]; render(): void } {
  const projections: ReaderViewProjection[] = [...BASE_PROJECTIONS, ...options.sessionProjections];
  function render(): void {
    for (const { project } of projections) {
      project();
    }
    state.reader.setActiveSubtitleIndex(-1);
    state.reader.setActiveChapterIndex(-1);
  }
  return { projections, render };
}
