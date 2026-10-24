// 字幕 tab 句内搜索：大小写不敏感字面量匹配 + 命中高亮（mark）+ 上/下一条循环
// 导航 + 匹配计数。
//
// 双语：匹配**可见的两轨文本**——逐条目先主行、后副行，因此条目内 ordinal 与
// DOM 顺序（主文 mark 在副行 span 之前）一致；副轨 loading / fail 的占位文案
// 不参与匹配。双语关时命中集合与单轨态逐字相同（副轨索引不建）。
//
// 与分批渲染（./batched-render.ts）的组合是本模块的核心约束：
//   - 匹配在数据层（state.clip.subtitleBody，经 getReadingSubtitleItems 与
//     渲染同源同口径）计算，天然覆盖尚未上屏的条目——计数与导航不依赖渲染进度；
//   - 「下一条/上一条」目标未渲染时经 deps.flushReadingSubtitleToIndex
//     同步补渲染（与跟随/跳转的补渲染同一条路径，不许跳不过去）；
//   - 搜索激活期间后续批次上屏的条目也要带高亮：组装根（lifecycle.ts）把实例的
//     handleRangeAppended 注册进 batched-render 的批次回执 hook，每次分批/补渲染
//     上屏 [from, to) 即对新条目打高亮；
//   - 搜索清除/清空时把 mark 还原为纯文本（restore 后 normalize）。
//   - 主行与副行的命中范围在数据层只计算一次，高亮构建直接复用该结果；当前命中
//     标记清理仅定向处理上一条目与上一 mark 节点，不扫描全表。
//
// 形态：createSubtitleSearch(deps) 工厂——搜索态（query/matches/matchesByItem/
// itemRanges/currentIndex/currentActiveNode）与全部 DOM 触达收进实例闭包，外部触达经 deps 注入（list/input
// 元素访问、补渲染 flush 端口、手动交互通知）；数据层（state/clipState、
// getReadingSubtitleItems、secondaryAlignmentFor）保持静态边，与 sync.ts 同款。
// 生产实例由组装根 lifecycle.ts 以生产依赖装配并持有：批次回执 hook 注册、渲染
// 尾部重放、close 清理都在那里；subtitle-tab-ui 的输入/键盘回调经 reader 域
// 入口的具名转发触达同一实例，调用方不感知实例存在。
//
// 状态维持：字幕 tab 隐藏（切到概览/AI 对话）时 DOM 保留（display:none 不销毁），
// 切回后高亮与导航位置原样还在；阅读视图重渲重建列表后由组装根在渲染尾部调
// refresh({ scroll: false }) 重放高亮。
//
// 依赖方向（无环）：state 叶子 + deps 注入的端口回调（生产实例绑
// readerPorts.flushReadingSubtitleToIndex 与 SYNC 的 noteManualReaderInteraction，
// LIFECYCLE → SYNC 合法边）+ subtitle/core 与 subtitle/alignment（静态边）。
// 本模块不 import lifecycle/batched-render——补渲染走显式 deps，批次回执走注册 hook。

import { clipState, state } from "../core/state.js";
import { getReadingSubtitleItems } from "../subtitle/core.js";
import { secondaryAlignmentFor } from "../subtitle/alignment.js";
import type { SecondaryAlignment } from "../subtitle/alignment.js";
import { ids } from "./state.js";
import {
  findSubtitleItem,
  getSubtextNode,
  isSubtextReady,
  replaceMainLineContent
} from "./subtitle-item-dom.js";

// 高亮与当前命中的 class 契约（reader.css 消费；search-current 为任务约定名）
const SEARCH_HIT_MARK_CLASS = "biliscript-reading-search-hit";
const SEARCH_CURRENT_CLASS = "search-current";

interface SearchRange {
  start: number;
  end: number;
}

interface SearchMatch {
  // data-index（getReadingSubtitleItems 的 item.index，与渲染条目一致）
  itemIndex: number;
  // 该条目内第几个命中（0 起）——当前命中落点 = 条目内第 ordinal 个 mark
  ordinal: number;
}

interface ItemHighlightRanges {
  mainText: string;
  mainRanges: SearchRange[];
  secondaryText: string | null;
  secondaryRanges: SearchRange[];
}

// 注入的外部触达：DOM 元素访问（list/input）+ 补渲染端口 + 手动交互通知。
// 生产实例由组装根把 readerPorts.flushReadingSubtitleToIndex 与 SYNC 的
// noteManualReaderInteraction 绑进来；测试可换注入直测三条行为
// （补渲染闸 / 循环导航 / 批次回执高亮），不经完整 reader shell。
export interface SubtitleSearchDeps {
  getSearchInput(): HTMLInputElement | null;
  getSubtitleList(): HTMLElement | null;
  flushReadingSubtitleToIndex(itemIndex: number): void;
  noteManualReaderInteraction(): void;
}

// 实例接口（facade 导出的形状与此一致）
export interface SubtitleSearch {
  refresh(options?: { preserveIndex?: boolean; scroll?: boolean }): void;
  move(direction: 1 | -1): void;
  clear(): void;
  handleRangeAppended(fromIndex: number, toIndex: number): void;
}

// 大小写不敏感字面量匹配（语义照搬 youtube-digest findLiteralTranscriptMatches：
// 正则元字符转义为字面量——标点是字幕文本不是表达式命令）
function findLiteralMatches(text: string, needle: string): SearchRange[] {
  const source = String(text || "");
  const target = String(needle || "").trim();
  if (!target) {
    return [];
  }
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(escaped, "gi");
  const ranges: SearchRange[] = [];
  for (const match of source.matchAll(matcher)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

// 搜索的第二条轨（bilingual-subtitles/06 号票的 Q6 映射）：只吃**真实译文**
//（04 号票的配对结果）——loading / fail 占位文案**不产生命中**，双语关 / 副轨
// 未就绪一律不参与（双语关零行为差）。索引经 alignment 的 secondaryAlignmentFor
// 取（引用记忆单槽收在该模块内，与 batched-render 的投影同一份索引）。
function resolveSecondarySearchAlignment(): SecondaryAlignment | null {
  if (!state.settings.bilingualSubtitles) {
    return null;
  }
  const slot = clipState.secondarySubtitle;
  if (!slot || slot.state !== "ready" || !Array.isArray(slot.body) || slot.body.length === 0) {
    return null;
  }
  return secondaryAlignmentFor(slot.body);
}

// 把一段原文 + 命中区间拼成「文本 ↔ mark 交替」的片段（主行/副行共用）。
function buildHighlightFragment(source: string, ranges: SearchRange[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      fragment.appendChild(document.createTextNode(source.slice(cursor, range.start)));
    }
    const mark = document.createElement("mark");
    mark.className = SEARCH_HIT_MARK_CLASS;
    mark.textContent = source.slice(range.start, range.end);
    fragment.appendChild(mark);
    cursor = range.end;
  }
  if (cursor < source.length) {
    fragment.appendChild(document.createTextNode(source.slice(cursor)));
  }
  return fragment;
}

export function createSubtitleSearch(deps: SubtitleSearchDeps): SubtitleSearch {
  let query = "";
  let matches: SearchMatch[] = [];
  // itemIndex → 该条目的命中列表（批次回执与条目高亮按条目取用，免全量扫描）
  let matchesByItem = new Map<number, SearchMatch[]>();
  // itemIndex → 主行与副行的预计算命中范围（计算一次后供高亮重建直接复用）
  let itemRanges = new Map<number, ItemHighlightRanges>();
  let currentIndex = -1;

  // 当前命中高亮节点引用：定向移除 class，避免扫描全表
  let currentActiveItemNode: HTMLElement | null = null;
  let currentActiveMarkNode: HTMLElement | null = null;

  function getItemNode(itemIndex: number): HTMLElement | null {
    return findSubtitleItem(deps.getSubtitleList(), itemIndex);
  }

  function clearCurrentMatchHighlight(): void {
    if (currentActiveItemNode) {
      currentActiveItemNode.classList.remove(SEARCH_CURRENT_CLASS);
      currentActiveItemNode = null;
    }
    if (currentActiveMarkNode) {
      currentActiveMarkNode.classList.remove(SEARCH_CURRENT_CLASS);
      currentActiveMarkNode = null;
    }
  }

  function computeMatches(needle: string): void {
    matches = [];
    matchesByItem = new Map();
    itemRanges = new Map();
    const secondary = resolveSecondarySearchAlignment();
    for (const item of getReadingSubtitleItems(state.clip.subtitleBody)) {
      // 主行先、副行后：DOM 顺序（主文在副行 span 之前）= ordinal 顺序，
      // revealCurrentMatch 的 `querySelectorAll("mark.…")[match.ordinal]` 才落得对。
      const mainRanges = findLiteralMatches(item.content, needle);
      const secondaryText = secondary ? secondary.query(item) : null;
      const secondaryRanges = secondaryText ? findLiteralMatches(secondaryText, needle) : [];
      const total = mainRanges.length + secondaryRanges.length;
      if (total === 0) {
        continue;
      }
      itemRanges.set(item.index, {
        mainText: item.content,
        mainRanges,
        secondaryText,
        secondaryRanges
      });
      const itemList: SearchMatch[] = [];
      for (let ordinal = 0; ordinal < total; ordinal += 1) {
        const match: SearchMatch = { itemIndex: item.index, ordinal };
        matches.push(match);
        itemList.push(match);
      }
      matchesByItem.set(item.index, itemList);
    }
  }

  // 把一条已上屏条目的文本替换为 mark 高亮（主行 mark 在前、副行 span 在后——
  // 与 computeMatches 的 ordinal 顺序一致）。直接复用数据层计算好的主行与副行命中
  // 范围，避免二次匹配正则。副行节点身份、class 与 data-state 原样保留。
  function highlightItemNode(node: HTMLElement, itemIndex: number): boolean {
    const ranges = itemRanges.get(itemIndex);
    if (!ranges) {
      return false;
    }
    const { mainText, mainRanges, secondaryText, secondaryRanges } = ranges;
    const subtextSpan = getSubtextNode(node);
    if (subtextSpan && isSubtextReady(node) && secondaryRanges.length > 0) {
      const subtextRaw = secondaryText ?? subtextSpan.textContent ?? "";
      subtextSpan.replaceChildren(buildHighlightFragment(subtextRaw, secondaryRanges));
    }
    return replaceMainLineContent(node, buildHighlightFragment(mainText, mainRanges));
  }

  // 还原高亮：mark 换回文本节点，循环结束后对列表整体 normalize 一次（递归合并
  // 所有后代相邻文本节点，与逐 mark normalize 行为等价）。定向清理当前命中标记。
  function clearSearchHighlights(): void {
    clearCurrentMatchHighlight();
    const list = deps.getSubtitleList();
    if (!list) {
      return;
    }
    list.querySelectorAll(`mark.${SEARCH_HIT_MARK_CLASS}`).forEach((mark) => {
      mark.replaceWith(document.createTextNode(mark.textContent || ""));
    });
    list.normalize();
  }

  // 对「已上屏且命中」的条目打高亮（全量；批次回执路径见 handleRangeAppended）
  function applyHighlightsToRendered(needle: string): void {
    if (!needle || matches.length === 0) {
      return;
    }
    for (const itemIndex of matchesByItem.keys()) {
      const node = getItemNode(itemIndex);
      if (node) {
        highlightItemNode(node, itemIndex);
      }
    }
  }

  // 当前命中落点：补渲染/翻页后把 search-current 标到对应 mark 与条目上。
  // 定向移除旧标记，避免 querySelectorAll 扫描全表。
  function revealCurrentMatch({ scroll = true }: { scroll?: boolean } = {}): void {
    clearCurrentMatchHighlight();
    const list = deps.getSubtitleList();
    if (!list) {
      return;
    }
    const match = matches[currentIndex];
    if (!match) {
      return;
    }
    // 目标条目未上屏（分批渲染落后于匹配）：先同步补渲染再取节点——与跟随/跳转
    // 的「跳不过去」防线同一条端口路径。
    let node = getItemNode(match.itemIndex);
    if (!node) {
      deps.flushReadingSubtitleToIndex(match.itemIndex);
      node = getItemNode(match.itemIndex);
    }
    if (!node) {
      return;
    }
    const mark = node.querySelectorAll(`mark.${SEARCH_HIT_MARK_CLASS}`)[match.ordinal] as HTMLElement | undefined;
    if (mark) {
      mark.classList.add(SEARCH_CURRENT_CLASS);
      currentActiveMarkNode = mark;
    }
    node.classList.add(SEARCH_CURRENT_CLASS);
    currentActiveItemNode = node;
    if (scroll) {
      // 搜索定位即「用户在看这里」：暂停自动跟随（与手动滚动同语义，保持手动
      // 浏览态，Follow 悬浮按钮同步出现），再把命中条目滚到视口中部。
      deps.noteManualReaderInteraction();
      node.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function updateSearchControls(): void {
    const countNode = document.getElementById(ids.readingSearchCount);
    const prev = document.getElementById(ids.readingSearchPrevBtn) as HTMLButtonElement | null;
    const next = document.getElementById(ids.readingSearchNextBtn) as HTMLButtonElement | null;
    if (countNode) {
      countNode.textContent = !query
        ? ""
        : matches.length > 0
          ? `${currentIndex + 1} / ${matches.length}`
          : "无匹配";
    }
    if (prev) {
      prev.disabled = matches.length === 0;
    }
    if (next) {
      next.disabled = matches.length === 0;
    }
  }

  // 重算并重放搜索（输入变化 / renderReadingView 重渲后由 lifecycle 调用）。
  // preserveIndex：重放时尽量保住当前命中序号（重渲不打断阅读位置）；输入变化
  // 场景传 false 回到第一个命中。
  // 空搜索快速路径：新查询词与内部查询状态均为空时跳过 DOM 高亮扫描与列表
  // 规范化，仅收敛控制区状态。
  function refresh(
    { preserveIndex = false, scroll = true }: { preserveIndex?: boolean; scroll?: boolean } = {}
  ): void {
    const input = deps.getSearchInput();
    const nextQuery = String(input?.value || "").trim();
    if (!nextQuery && !query) {
      clearCurrentMatchHighlight();
      matches = [];
      matchesByItem = new Map();
      itemRanges = new Map();
      currentIndex = -1;
      updateSearchControls();
      return;
    }
    const previousIndex = currentIndex;
    clearSearchHighlights();
    matches = [];
    matchesByItem = new Map();
    itemRanges = new Map();
    currentIndex = -1;
    query = nextQuery;
    if (!query) {
      updateSearchControls();
      return;
    }
    computeMatches(query);
    applyHighlightsToRendered(query);
    if (matches.length > 0) {
      currentIndex = preserveIndex ? Math.min(Math.max(previousIndex, 0), matches.length - 1) : 0;
      revealCurrentMatch({ scroll });
    }
    updateSearchControls();
  }

  // 上/下一条循环导航（Enter=+1、Shift+Enter=-1、按钮同款），环绕像浏览器 Find。
  function move(direction: 1 | -1): void {
    if (matches.length === 0) {
      return;
    }
    currentIndex = (currentIndex + direction + matches.length) % matches.length;
    revealCurrentMatch();
    updateSearchControls();
  }

  // 清空搜索状态（清输入 + 还原文本 + 计数归零）。closeReadingView 的会话收尾
  // 与「换视频」场景调用；输入框 DOM 常驻（tab 显隐不销毁），必须显式清值。
  function clear(): void {
    const input = deps.getSearchInput();
    if (input) {
      input.value = "";
    }
    if (query) {
      clearSearchHighlights();
    } else {
      clearCurrentMatchHighlight();
    }
    matches = [];
    matchesByItem = new Map();
    itemRanges = new Map();
    currentIndex = -1;
    query = "";
    updateSearchControls();
  }

  // 批次回执（lifecycle 组装根把它注册进 batched-render 的 hook 槽）：搜索激活
  // 期间，新上屏的 [fromIndex, toIndex) 条目自动带高亮——已渲染集合与匹配集合
  // 的差集随每批收敛，最终与整段渲染等价。
  // matches 由全量 matchAll 顺序构建、天然按 itemIndex 升序——回执按批次区间
  // 二分取子集，不遍历 matchesByItem 全表（全量命中时全表 = 条目数量级）。
  function handleRangeAppended(fromIndex: number, toIndex: number): void {
    if (!query || matches.length === 0) {
      return;
    }
    // 二分定位首个 itemIndex >= fromIndex 的命中
    let lo = 0;
    let hi = matches.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (matches[mid].itemIndex < fromIndex) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    // 顺序走过区间：同一条目的多个命中相邻，按条目去重各打一次高亮
    let lastItemIndex = -1;
    for (let i = lo; i < matches.length && matches[i].itemIndex < toIndex; i += 1) {
      const itemIndex = matches[i].itemIndex;
      if (itemIndex === lastItemIndex) {
        continue;
      }
      lastItemIndex = itemIndex;
      const node = getItemNode(itemIndex);
      if (node) {
        highlightItemNode(node, itemIndex);
      }
    }
  }

  return { refresh, move, clear, handleRangeAppended };
}
