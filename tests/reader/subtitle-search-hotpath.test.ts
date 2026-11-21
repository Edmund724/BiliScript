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
let indexSubtitleItems: typeof import("../../extension/reader/subtitle-item-dom.js").indexSubtitleItems;

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
  indexSubtitleItems = (await import("../../extension/reader/subtitle-item-dom.js")).indexSubtitleItems;
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

    const from = 500;
    const to = 510;
    for (let i = from; i < to; i += 1) {
      itemText(i).replaceChildren(`第${i}条含${KEYWORD}的句子`);
    }
    expect(itemText(from).querySelector("mark")).toBe(null);

    const querySpy = vi.spyOn(list, "querySelector");
    try {
      search.handleRangeAppended(from, to);
    } finally {
      vi.restoreAllMocks();
    }

    for (let i = from; i < to; i += 1) {
      expect(itemText(i).querySelectorAll("mark").length).toBe(1);
    }
    expect(itemText(from).querySelector("mark")!.textContent).toBe(KEYWORD);
    expect(markCount()).toBe(TOTAL_ITEMS);
    expect(querySpy).toHaveBeenCalledTimes(to - from);
  });

  it("修3：当前命中清理只处理必要节点，不触发全列表 .search-current 扫描", { timeout: 30_000 }, () => {
    const { input, list } = buildFixture();
    input.value = KEYWORD;
    search.refresh({ scroll: false });

    const querySpy = vi.spyOn(list, "querySelectorAll");
    search.move(1);

    const searchCurrentCalls = querySpy.mock.calls.filter(([selector]) =>
      typeof selector === "string" && selector.includes("search-current")
    );
    expect(searchCurrentCalls.length).toBe(0);
  });

  it("修4：已建立条目索引时，查找与批次回执直接命中索引，零 querySelector 调用", { timeout: 30_000 }, () => {
    const { input, list } = buildFixture();
    indexSubtitleItems(list);
    input.value = KEYWORD;
    search.refresh({ scroll: false });

    const from = 600;
    const to = 610;
    for (let i = from; i < to; i += 1) {
      itemText(i).replaceChildren(`第${i}条含${KEYWORD}的句子`);
    }

    const querySpy = vi.spyOn(list, "querySelector");
    search.handleRangeAppended(from, to);

    expect(querySpy).not.toHaveBeenCalled();
    for (let i = from; i < to; i += 1) {
      expect(itemText(i).querySelectorAll("mark").length).toBe(1);
    }
  });
});
