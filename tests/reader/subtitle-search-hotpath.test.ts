// arch-review-2026-09/01：字幕搜索热路径三修的回归网（1500 条全量命中夹具）。
//
// - 修1：clearSearchHighlights 的 normalize 出循环——清除时对列表整体 normalize
//   一次，不再每个 mark 各扫一次全子树（全量命中下 O(n²)）；
// - 修2：批次回执 handleReadingSubtitleRangeAppended 对有序 matches 数组二分
//   取批次 index 区间子集，不遍历 matchesByItem 全表。
//
// 测试直驱 reader/subtitle-search.js 模块缝（不经完整 reader shell）：手工搭
// 列表 DOM + state.clip.subtitleBody，行为断言与计数断言共享同一夹具。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import type { SubtitleBodyItem } from "../../extension/core/state.js";

const TOTAL_ITEMS = 1500;
const KEYWORD = "目标词";

let state: typeof import("../../extension/core/state.js").state;
let ids: typeof import("../../extension/reader/state.js").ids;
let search: ReturnType<
  typeof import("../../extension/reader/subtitle-search.js").createSubtitleSearch
>;

function buildFixture() {
  document.body.innerHTML = "";
  const input = document.createElement("input");
  input.id = ids.readingSearchInput;
  document.body.appendChild(input);
  const list = document.createElement("div");
  list.id = ids.readingSubtitleList;
  document.body.appendChild(list);
  const body: SubtitleBodyItem[] = [];
  for (let i = 0; i < TOTAL_ITEMS; i += 1) {
    const content = `第${i}条含${KEYWORD}的句子`;
    body.push({ from: i * 2, to: i * 2 + 1.9, content });
    const item = document.createElement("div");
    item.className = "biliscript-reading-item";
    item.dataset.index = String(i);
    const text = document.createElement("span");
    text.className = "biliscript-reading-text";
    text.textContent = content;
    item.appendChild(text);
    list.appendChild(item);
  }
  state.clip.setSubtitleBody(body);
  return { input, list };
}

function markCount() {
  return document.querySelectorAll(`mark.biliscript-reading-search-hit`).length;
}

function itemText(index: number) {
  return document.querySelector(`[data-index="${index}"] .biliscript-reading-text`)!;
}

beforeEach(async () => {
  resetModuleState();
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state;
  ids = (await import("../../extension/reader/state.js")).ids;
  // 生产实例由组装根（lifecycle）持有；本套件直驱工厂模块缝：手工注入
  // 夹具 DOM 访问与空交互回调，不经完整 reader shell。
  const searchMod = await import("../../extension/reader/subtitle-search.js");
  search = searchMod.createSubtitleSearch({
    getSearchInput: () =>
      document.getElementById(ids.readingSearchInput) as HTMLInputElement | null,
    getSubtitleList: () => document.getElementById(ids.readingSubtitleList),
    flushReadingSubtitleToIndex: () => {},
    noteManualReaderInteraction: () => {}
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("字幕搜索热路径（1500 条全量命中夹具）", () => {
  // 两用例各自重建 1500 条 DOM 夹具（jsdom 下 O(n) 的 replaceChildren/normalize
  // 实测量级 5-13s），在并发跑测试（多 worker 抢核）时贴近默认 10s 上限而随机
  // 超时——与本改动无关的既有抖动。给显式余量，让 tests/reader 全量跑稳定。
  it("修1：清除高亮只 normalize 列表一次，且文本逐字还原", { timeout: 30_000 }, () => {
    const { input } = buildFixture();
    input.value = KEYWORD;
    search.refresh({ scroll: false });
    expect(markCount()).toBe(TOTAL_ITEMS);

    const normalizeSpy = vi.spyOn(Node.prototype, "normalize");
    input.value = "";
    search.refresh({ scroll: false });

    expect(markCount()).toBe(0);
    expect(normalizeSpy).toHaveBeenCalledTimes(1);
    expect((normalizeSpy.mock.instances[0] as Element).id).toBe(ids.readingSubtitleList);
    expect(itemText(0).textContent).toBe(`第0条含${KEYWORD}的句子`);
    expect(itemText(TOTAL_ITEMS - 1).textContent).toBe(`第${TOTAL_ITEMS - 1}条含${KEYWORD}的句子`);

    // 再次在空态下 refresh：命中快速路径，不应产生额外的 normalize 与节点扫描
    const querySpy = vi.spyOn(document.getElementById(ids.readingSubtitleList)!, "querySelectorAll");
    search.refresh({ scroll: false });
    expect(normalizeSpy).toHaveBeenCalledTimes(1);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("稳态空搜索快速路径：初始空态多次 refresh 不触发节点扫描与 normalize", { timeout: 30_000 }, () => {
    const { input, list } = buildFixture();
    input.value = "";
    const normalizeSpy = vi.spyOn(Node.prototype, "normalize");
    const querySpy = vi.spyOn(list, "querySelectorAll");

    search.refresh({ scroll: false });
    search.refresh({ scroll: false });

    expect(normalizeSpy).not.toHaveBeenCalled();
    expect(querySpy).not.toHaveBeenCalled();
    expect(markCount()).toBe(0);
  });

  it("修2：批次回执按区间二分取子集，DOM 访问以区间宽为量级", { timeout: 30_000 }, () => {
    const { input, list } = buildFixture();
    input.value = KEYWORD;
    search.refresh({ scroll: false });
    expect(markCount()).toBe(TOTAL_ITEMS);

    // 模拟批次回执场景：区间内条目按「新上屏」形态还原为无 mark 纯文本
    const from = 500;
    const to = 510;
    for (let i = from; i < to; i += 1) {
      itemText(i).replaceChildren(`第${i}条含${KEYWORD}的句子`);
    }
    expect(itemText(from).querySelector("mark")).toBe(null);

    // 统计回执期间对列表的 querySelector 调用：getItemNode 每处理一个区间
    // 内条目定位一次；全表扫描形态的实现会是 TOTAL_ITEMS 次起步
    const querySpy = vi.spyOn(list, "querySelector");
    try {
      search.handleRangeAppended(from, to);
    } finally {
      vi.restoreAllMocks();
    }

    // 区间内 10 个条目逐一补高亮，区间外不动
    for (let i = from; i < to; i += 1) {
      expect(itemText(i).querySelectorAll("mark").length).toBe(1);
    }
    expect(itemText(from).querySelector("mark")!.textContent).toBe(KEYWORD);
    expect(markCount()).toBe(TOTAL_ITEMS);
    // 区间取子集：恰为区间宽次定位，与全表规模无关
    expect(querySpy).toHaveBeenCalledTimes(to - from);
  });
});
