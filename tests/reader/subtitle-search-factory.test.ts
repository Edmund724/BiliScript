// 字幕搜索工厂（createSubtitleSearch(deps)）注入直测（arch-review-20261018/03）。
//
// 不经完整 reader shell、不注册 reader 端口：DOM 元素访问与补渲染端口/手动交互
// 通知全部经 deps 注入（vi.fn 断言触达），数据层喂 state.clip.subtitleBody
// （与生产同源 getReadingSubtitleItems 口径）。
//
// 覆盖工单列的三条行为：
//   1. 补渲染闸：导航目标未上屏时先经 deps.flushReadingSubtitleToIndex 同步补
//      渲染，再落到新上屏条目的 mark 上（不许跳不过去）；
//   2. 上/下一条循环导航：越过末尾/开头环绕，像浏览器 Find；
//   3. 批次回执只对新区间打高亮：[from, to) 之外的条目不被触碰。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import type { SubtitleBodyItem } from "../../extension/core/state.js";
import type { SubtitleSearchDeps } from "../../extension/reader/subtitle-search.js";

const KEYWORD = "目标词";
const TOTAL = 4;
const MARK_SELECTOR = "mark.biliscript-reading-search-hit";

let state: typeof import("../../extension/core/state.js").state;
let ids: typeof import("../../extension/reader/state.js").ids;
let createSubtitleSearch: typeof import("../../extension/reader/subtitle-search.js").createSubtitleSearch;

const BODY: SubtitleBodyItem[] = Array.from({ length: TOTAL }, (_, i) => ({
  from: i * 2,
  to: i * 2 + 1.9,
  content: `第${i}条含${KEYWORD}的句子`
}));

function buildItemNode(index: number): HTMLElement {
  const item = document.createElement("div");
  item.className = "biliscript-reading-item";
  item.dataset.index = String(index);
  const text = document.createElement("span");
  text.className = "biliscript-reading-text";
  text.textContent = BODY[index].content;
  item.appendChild(text);
  return item;
}

let input: HTMLInputElement;
let list: HTMLElement;

type TestDeps = SubtitleSearchDeps & {
  flushReadingSubtitleToIndex: Mock;
  noteManualReaderInteraction: Mock;
};

// 注入夹具：list/input 用测试局部元素（不挂生产 id），flush 语义由用例传入
// （默认只追加节点），手动交互通知收 vi.fn。
function mountSearchShell(renderedCount: number): void {
  document.body.innerHTML = "";
  input = document.createElement("input");
  document.body.appendChild(input);
  const count = document.createElement("span");
  count.id = ids.readingSearchCount;
  document.body.appendChild(count);
  const prev = document.createElement("button");
  prev.id = ids.readingSearchPrevBtn;
  document.body.appendChild(prev);
  const next = document.createElement("button");
  next.id = ids.readingSearchNextBtn;
  document.body.appendChild(next);
  list = document.createElement("div");
  document.body.appendChild(list);
  for (let i = 0; i < renderedCount; i += 1) {
    list.appendChild(buildItemNode(i));
  }
}

function makeDeps(flushImpl: (itemIndex: number) => void = () => {}): TestDeps {
  return {
    getSearchInput: () => input,
    getSubtitleList: () => list,
    flushReadingSubtitleToIndex: vi.fn(flushImpl),
    noteManualReaderInteraction: vi.fn()
  };
}

function searchCount(): string {
  return (document.getElementById(ids.readingSearchCount) as HTMLElement).textContent || "";
}

function currentMark(): HTMLElement | null {
  return list.querySelector<HTMLElement>(`${MARK_SELECTOR}.search-current`);
}

function itemNode(index: number): HTMLElement | null {
  return list.querySelector<HTMLElement>(`[data-index="${index}"]`);
}

beforeEach(async () => {
  resetModuleState();
  setLocationUrl(READER_MODE_URL);
  const coreState = await import("../../extension/core/state.js");
  state = coreState.state;
  ids = (await import("../../extension/reader/state.js")).ids;
  createSubtitleSearch = (await import("../../extension/reader/subtitle-search.js")).createSubtitleSearch;
  state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: false });
  state.clip.setSubtitleBody(BODY);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("createSubtitleSearch：补渲染闸", () => {
  it("导航目标未上屏：先经 flush 端口补渲染，search-current 落到新上屏条目的 mark", () => {
    // 首屏只有第 0 条，其余 3 条匹配但尚未上屏
    mountSearchShell(1);
    let search!: ReturnType<typeof createSubtitleSearch>;
    // flush 模拟生产补渲染闭环：追加节点（batched-render 的活），再经批次回执
    // 给新上屏条目补高亮（lifecycle 注册的 hook 的活）——两者都在端口返回前完成
    const deps = makeDeps((itemIndex: number) => {
      list.appendChild(buildItemNode(itemIndex));
      search.handleRangeAppended(itemIndex, itemIndex + 1);
    });
    search = createSubtitleSearch(deps);
    input.value = KEYWORD;
    search.refresh({ scroll: false });

    expect(searchCount()).toBe("1 / 4");
    expect(currentMark()?.closest("[data-index]")).toBe(itemNode(0));
    expect(deps.flushReadingSubtitleToIndex).not.toHaveBeenCalled();

    search.move(1);

    // 补渲染端口以目标条目序号被调一次，且补渲染后命中落点立即跟上
    expect(deps.flushReadingSubtitleToIndex).toHaveBeenCalledTimes(1);
    expect(deps.flushReadingSubtitleToIndex).toHaveBeenCalledWith(1);
    expect(itemNode(1)).not.toBeNull();
    expect(currentMark()?.closest("[data-index]")).toBe(itemNode(1));
    // move 的滚动路径即「用户在看这里」：手动交互通知经 deps 触达
    expect(deps.noteManualReaderInteraction).toHaveBeenCalled();
    expect(searchCount()).toBe("2 / 4");
  });
});

describe("createSubtitleSearch：循环导航", () => {
  it("上/下一条越过末尾与开头时环绕（浏览器 Find 语义）", () => {
    mountSearchShell(TOTAL);
    const deps = makeDeps();
    const search = createSubtitleSearch(deps);
    input.value = KEYWORD;
    search.refresh({ scroll: false });
    expect(searchCount()).toBe("1 / 4");

    search.move(1);
    expect(searchCount()).toBe("2 / 4");
    expect(currentMark()?.closest("[data-index]")).toBe(itemNode(1));

    search.move(1);
    expect(searchCount()).toBe("3 / 4");
    expect(currentMark()?.closest("[data-index]")).toBe(itemNode(2));

    search.move(1);
    expect(searchCount()).toBe("4 / 4");
    expect(currentMark()?.closest("[data-index]")).toBe(itemNode(3));

    // 越过末尾 → 回到第一条
    search.move(1);
    expect(searchCount()).toBe("1 / 4");
    expect(currentMark()?.closest("[data-index]")).toBe(itemNode(0));

    // 越过开头 → 绕到最后一条
    search.move(-1);
    expect(searchCount()).toBe("4 / 4");
    expect(currentMark()?.closest("[data-index]")).toBe(itemNode(3));

    // 全部命中已上屏：补渲染端口全程不被触碰
    expect(deps.flushReadingSubtitleToIndex).not.toHaveBeenCalled();
  });
});

describe("createSubtitleSearch：批次回执只对新区间打高亮", () => {
  it("重新铺一批无 mark 的纯文本条目后，回执只高亮 [from, to) 内条目", () => {
    mountSearchShell(TOTAL);
    const search = createSubtitleSearch(makeDeps());
    input.value = KEYWORD;
    search.refresh({ scroll: false });
    expect(list.querySelectorAll(MARK_SELECTOR).length).toBe(TOTAL);

    // 模拟「新一批上屏」：整表重建为无 mark 的原始条目（与分批渲染的新批次同形）
    list.replaceChildren(...BODY.map((_, i) => buildItemNode(i)));
    expect(list.querySelectorAll(MARK_SELECTOR).length).toBe(0);

    search.handleRangeAppended(1, 3);

    // 区间内的两条补回高亮，区间外不动
    expect(itemNode(0)!.querySelectorAll(MARK_SELECTOR).length).toBe(0);
    expect(itemNode(1)!.querySelectorAll(MARK_SELECTOR).length).toBe(1);
    expect(itemNode(2)!.querySelectorAll(MARK_SELECTOR).length).toBe(1);
    expect(itemNode(3)!.querySelectorAll(MARK_SELECTOR).length).toBe(0);
    expect(itemNode(1)!.querySelector(MARK_SELECTOR)!.textContent).toBe(KEYWORD);
  });

  it("搜索未激活时回执空转：不打高亮也不访问 flush 端口", () => {
    mountSearchShell(TOTAL);
    const deps = makeDeps();
    const search = createSubtitleSearch(deps);
    input.value = "";
    search.refresh({ scroll: false });

    search.handleRangeAppended(0, TOTAL);

    expect(list.querySelectorAll(MARK_SELECTOR).length).toBe(0);
    expect(deps.flushReadingSubtitleToIndex).not.toHaveBeenCalled();
  });
});
