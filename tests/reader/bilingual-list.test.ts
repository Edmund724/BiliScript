// 双语字幕列表渲染与搜索（票 bilingual-subtitles/06）。
//
// 口径来源（本文件不重述理由，只落断言）：
//   - 形状：01 号票的次级样式——副行是主文 span **内嵌**的块级 span，两行同属
//     `.biliscript-reading-text`（CSS grid `76px minmax(0,1fr)` 与时间戳落位不动）；
//   - 配对：04 号票（重叠时长 > 0 的副轨段按 from 升序空格拼接；无重叠 = 折叠，
//     不发副行节点）；副轨 loading / error 的占位由渲染层出，算法不出占位；
//   - 占位：02 号票 Q6——重试入口**唯一**在弹层副列，列表这行不可点、不带 affordance；
//   - 搜索：06 号票 Q6 映射——匹配可见的两轨文本，逐条目「主行先、副行后」，
//     占位文案不参与匹配。
//
// 系统可能怎么坏（先列失败方式，再据此写用例）：
//   1. 双语关：条目 HTML 多出副行节点或空 span（零行为差被破坏）；搜索命中集合 /
//      计数 / 当前命中落点被改动；
//   2. 副行节点挂在 `.biliscript-reading-text` 之外（破坏 grid 的两列与时间戳落位），
//      或主 / 副行顺序被调换；
//   3. 折叠口径丢失：无重叠的行仍出空副行节点，或副轨槽 idle 也出占位；
//   4. 合并段（2 主段 ↔ 1 副段）只给其中一行挂译文——另一行该段时间里屏幕上没有译文；
//   5. loading / error 不出占位（用户以为本来就没译文），或占位被做成可点
//      （重试入口在列表与弹层各出现一次）；
//   6. 占位文案参与匹配：搜「译文 / 加载」把每一行都命中（占位不是译文内容）；
//   7. 副行命中不可导航：ordinal 与 DOM 顺序不一致（`querySelectorAll(...)[ordinal]`
//      落错 mark），或高亮重建时用 `textSpan.textContent` 把副行压平进主行
//      （两行结构丢失，清除后还原不回来）；
//   8. 逐行重建配对索引（1500 行渲染变成平方级卡死）；
//   9. 关掉双语后命中集合没有回到单轨结果（残留副行命中 / 副行 mark）。
//
// 端到端形态：列表 DOM 全部由生产的 `buildReadingSubtitleItemHtml` 拼出（与
// renderReadingView 的首屏批同一份代码），搜索走生产的 subtitle-search 模块缝。
// 不挂完整 reader shell：那会连带装载选轨弹层 / 概览 / 生命周期（本改动不碰的域），
// 而这里要锁的渲染与匹配路径在模块层已完整可达。
// 唯一 mock：alignment 的 `buildSecondaryAlignment` 包一层调用计数（仍委托真实实现），
// 用来钉住「一批 / 一次搜索只建一次索引」。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { escapeHtml } from "../../extension/shared/string-utils.js";
import { formatClock } from "../../extension/shared/clock-text.js";
import type { SubtitleBodyItem } from "../../extension/core/state.js";
import type { ReadingSubtitleItem } from "../../extension/subtitle/core.js";
import type { TestState } from "./reader-test-env.js";

vi.mock("../../extension/subtitle/alignment.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/subtitle/alignment.js")>();
  return { ...actual, buildSecondaryAlignment: vi.fn(actual.buildSecondaryAlignment) };
});

const SUBTEXT_SELECTOR = ".biliscript-reading-subtext";
const MARK_SELECTOR = "mark.biliscript-reading-search-hit";

// 双语能力上线前的单轨模板（改动前 buildReadingSubtitleItemHtml 的逐字副本）。
// 写死在这里是**故意的**：双语关的输出必须与它逐字节相同——多一个换行、多一个
// 空 span 都算零行为差被破坏。
function singleTrackItemHtml(item: ReadingSubtitleItem, withHours: boolean): string {
  return `
    <button
      type="button"
      class="biliscript-reading-item"
      data-index="${item.index}"
      data-seconds="${item.from}"
    >
      <span class="biliscript-reading-time">${escapeHtml(
        formatClock(item.from, { hours: withHours })
      )}</span>
      <span class="biliscript-reading-text">${escapeHtml(item.content)}</span>
    </button>
  `;
}

let state: TestState;
let clipState: typeof import("../../extension/core/state.js").clipState;
let ids: typeof import("../../extension/reader/state.js").ids;
let core: typeof import("../../extension/subtitle/core.js");
let alignment: typeof import("../../extension/subtitle/alignment.js");
let render: typeof import("../../extension/reader/batched-render.js");
let search: typeof import("../../extension/reader/subtitle-search.js");

// ===== 夹具：03 号票探针的合并形状（缩比） =====
// 2 主段共享 1 副段（相邻两行显示同一句译文）；第 3 段与副轨零重叠（折叠）。
const MAIN_BODY: SubtitleBodyItem[] = [
  { from: 0, to: 5, content: "第一句" },
  { from: 5, to: 9, content: "第二句" },
  { from: 20, to: 24, content: "独行" }
];
const SECONDARY_MERGED: SubtitleBodyItem[] = [{ from: 0, to: 9, content: "First and second" }];

function setBilingual(on: boolean): void {
  state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: on, secondarySubtitleLang: "en-US" });
}

function seedSecondaryReady(body: SubtitleBodyItem[]): void {
  clipState.applySecondarySubtitle({ id: "en", url: "https://sub/ai-en.json", body });
}

function ensureList(): HTMLElement {
  const existing = document.getElementById(ids.readingSubtitleList);
  if (existing) {
    return existing;
  }
  const list = document.createElement("div");
  list.id = ids.readingSubtitleList;
  document.body.appendChild(list);
  return list;
}

// 与 renderReadingView 的列表构建同源：同一份 buildReadingSubtitleItemHtml。
function renderList(items: ReadingSubtitleItem[]): void {
  ensureList().innerHTML = items.map((item) => render.buildReadingSubtitleItemHtml(item, false)).join("");
}

function renderBody(body: SubtitleBodyItem[]): ReadingSubtitleItem[] {
  clipState.setSubtitleBody(body);
  const items = core.getReadingSubtitleItems(body);
  renderList(items);
  return items;
}

function mountSearchShell(): void {
  const input = document.createElement("input");
  input.id = ids.readingSearchInput;
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
}

function listEl(): HTMLElement {
  return document.getElementById(ids.readingSubtitleList) as HTMLElement;
}

function row(index: number): HTMLElement {
  return listEl().querySelector(`[data-index="${index}"]`) as HTMLElement;
}

function textSpan(index: number): HTMLElement {
  return row(index).querySelector(".biliscript-reading-text") as HTMLElement;
}

function subtextOf(index: number): HTMLElement | null {
  return row(index).querySelector<HTMLElement>(SUBTEXT_SELECTOR);
}

function subtextNodes(): HTMLElement[] {
  return [...listEl().querySelectorAll<HTMLElement>(SUBTEXT_SELECTOR)];
}

function marks(): HTMLElement[] {
  return [...listEl().querySelectorAll<HTMLElement>(MARK_SELECTOR)];
}

function currentMark(): HTMLElement | null {
  return listEl().querySelector<HTMLElement>(`${MARK_SELECTOR}.search-current`);
}

function searchInput(): HTMLInputElement {
  return document.getElementById(ids.readingSearchInput) as HTMLInputElement;
}

function searchCount(): string {
  return (document.getElementById(ids.readingSearchCount) as HTMLElement).textContent || "";
}

function runSearch(needle: string): void {
  searchInput().value = needle;
  search.refreshReadingSubtitleSearch({ scroll: false });
}

function alignmentBuildCalls(): number {
  return vi.mocked(alignment.buildSecondaryAlignment).mock.calls.length;
}

// 占位行不可点：不是按钮 / 链接，不带 role / tabindex / 任何交互子节点，文案也不写
// 「重试」（重试入口唯一在弹层副列；行本身的 button 是既有的点击 seek 行为，与主文
// 共享同一个命中盒）。
function expectNoRetryAffordance(node: HTMLElement): void {
  expect(node.tagName).toBe("SPAN");
  expect(node.getAttribute("role")).toBeNull();
  expect(node.hasAttribute("tabindex")).toBe(false);
  expect(node.querySelector("button, a, [role='button']")).toBeNull();
  expect(node.textContent).not.toContain("重试");
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  setLocationUrl(READER_MODE_URL);
  Element.prototype.scrollIntoView = () => {};

  const coreState = await import("../../extension/core/state.js");
  state = coreState.state as TestState;
  clipState = coreState.clipState;
  ids = (await import("../../extension/reader/state.js")).ids;
  core = await import("../../extension/subtitle/core.js");
  alignment = await import("../../extension/subtitle/alignment.js");
  vi.mocked(alignment.buildSecondaryAlignment).mockClear();
  // 先 core/alignment，再 batched-render / subtitle-search：后两者取到本用例注册表里
  // 的同一个 mock 实例（计数才覆盖到它们内部的调用）。
  render = await import("../../extension/reader/batched-render.js");
  search = await import("../../extension/reader/subtitle-search.js");
  mountSearchShell();
});

afterEach(() => {
  document.body.innerHTML = "";
  clipState.clearSecondarySubtitle();
  state.setSettings({ ...DEFAULT_SETTINGS });
});

describe("06 双语列表：双语关零行为差", () => {
  it("副轨就绪但双语关：条目 HTML 与单轨模板逐字节相同（两档 withHours + 转义）", () => {
    setBilingual(false);
    seedSecondaryReady(SECONDARY_MERGED);

    const items: ReadingSubtitleItem[] = [
      { index: 0, from: 0, to: 5, content: "普通句" },
      { index: 3, from: 65, to: 70, content: "中途句" },
      { index: 7, from: 3661, to: 3670, content: 'a<b>&"c"' }
    ];
    for (const item of items) {
      expect(render.buildReadingSubtitleItemHtml(item, false)).toBe(singleTrackItemHtml(item, false));
      expect(render.buildReadingSubtitleItemHtml(item, true)).toBe(singleTrackItemHtml(item, true));
    }
    // 单轨形态里根本没有副行节点，也没有空 span
    expect(render.buildReadingSubtitleItemHtml(items[0], false)).not.toContain(SUBTEXT_SELECTOR);
  });

  it("双语关：渲染行只有「时间戳 + 主文」两个子节点，主文 span 恰一个文本节点", () => {
    setBilingual(false);
    seedSecondaryReady(SECONDARY_MERGED);
    renderBody(MAIN_BODY);

    expect(subtextNodes().length).toBe(0);
    expect(row(0).children.length).toBe(2);
    expect(row(0).querySelector(".biliscript-reading-time")?.nextElementSibling).toBe(textSpan(0));
    expect(textSpan(0).childNodes.length).toBe(1);
    expect(textSpan(0).textContent).toBe("第一句");
  });

  it("双语关：搜索命中集合与单轨态逐项相同（副轨正文不参与）", () => {
    setBilingual(false);
    seedSecondaryReady([{ from: 0, to: 5, content: "target in secondary" }]);
    renderBody([{ from: 0, to: 5, content: "target in main" }]);

    runSearch("target");
    expect(searchCount()).toBe("1 / 1");
    expect(marks().length).toBe(1);
    expect(currentMark()?.closest(SUBTEXT_SELECTOR)).toBeNull();
    expect(subtextNodes().length).toBe(0);
  });
});

describe("06 双语列表：副行渲染（ready / 折叠 / 占位）", () => {
  it("副行内嵌在主文 span 内、主文之后（grid 两列与时间戳落位不动）", () => {
    setBilingual(true);
    seedSecondaryReady(SECONDARY_MERGED);
    renderBody(MAIN_BODY);

    expect(textSpan(0).parentElement).toBe(row(0));
    expect(row(0).querySelector(".biliscript-reading-time")?.nextElementSibling).toBe(textSpan(0));
    expect(
      render.buildReadingSubtitleItemHtml(core.getReadingSubtitleItems(MAIN_BODY)[0], false)
    ).toContain(
      '<span class="biliscript-reading-text">第一句<span class="biliscript-reading-subtext" data-state="ready">First and second</span></span>'
    );
  });

  it("合并段（2 主段 ↔ 1 副段）：两行显示同一句；无重叠的行没有副行节点", () => {
    setBilingual(true);
    seedSecondaryReady(SECONDARY_MERGED);
    renderBody(MAIN_BODY);

    expect(subtextOf(0)?.textContent).toBe("First and second");
    expect(subtextOf(1)?.textContent).toBe("First and second");
    expect(subtextOf(0)?.getAttribute("data-state")).toBe("ready");
    expect(subtextOf(1)?.getAttribute("data-state")).toBe("ready");
    expect(subtextOf(2)).toBeNull();
    expect(subtextNodes().length).toBe(2);
  });

  it("副轨槽 idle：双语开着也不出副行节点（不发光秃 span 占位）", () => {
    setBilingual(true);
    clipState.clearSecondarySubtitle();
    renderBody(MAIN_BODY);

    expect(subtextNodes().length).toBe(0);
    expect(render.buildReadingSubtitleItemHtml(core.getReadingSubtitleItems(MAIN_BODY)[0], false)).not.toContain(
      SUBTEXT_SELECTOR
    );
  });

  it("副轨 loading：每行出占位、data-state=loading，占位不可点", () => {
    setBilingual(true);
    clipState.markSecondarySubtitleLoading({ id: "en", url: "https://sub/ai-en.json" });
    renderBody(MAIN_BODY);

    for (const index of [0, 1, 2]) {
      const node = subtextOf(index);
      expect(node?.textContent).toBe("译文加载中…");
      expect(node?.getAttribute("data-state")).toBe("loading");
      expectNoRetryAffordance(node!);
    }
    // 主行照常，副轨占位不阻塞（主文仍是 text span 的第一个文本节点）
    expect(textSpan(2).firstChild?.textContent).toBe("独行");
  });

  it("副轨 error：每行出失败占位、data-state=fail，占位不可点", () => {
    setBilingual(true);
    clipState.markSecondarySubtitleLoading({ id: "en", url: "https://sub/ai-en.json" });
    clipState.markSecondarySubtitleError();
    renderBody(MAIN_BODY);

    for (const index of [0, 1, 2]) {
      const node = subtextOf(index);
      expect(node?.textContent).toBe("译文加载失败");
      expect(node?.getAttribute("data-state")).toBe("fail");
      expectNoRetryAffordance(node!);
    }
  });

  it("配对索引一批只建一次（300 行渲染 + 300 行匹配都不是平方级）", () => {
    setBilingual(true);
    const body: SubtitleBodyItem[] = [];
    for (let i = 0; i < 300; i += 1) {
      body.push({ from: i * 2, to: i * 2 + 1, content: `主文${i}` });
    }
    seedSecondaryReady([{ from: 0, to: 600, content: "整段译文" }]);
    renderBody(body);
    expect(alignmentBuildCalls()).toBe(1);

    runSearch("整段译文");
    expect(searchCount()).toBe("1 / 300");
    expect(alignmentBuildCalls()).toBe(2); // 搜索重算再建一次，不是每条一次
  });
});

describe("06 双语列表：双轨搜索", () => {
  it("只存在于副行的命中：被找到、被计数、可导航，副行结构在高亮重建后仍在", () => {
    setBilingual(true);
    seedSecondaryReady([
      { from: 0, to: 5, content: "hello target" },
      { from: 5, to: 10, content: "second target" }
    ]);
    renderBody([
      { from: 0, to: 5, content: "第一句" },
      { from: 5, to: 10, content: "第二句" }
    ]);
    const subtextBefore = subtextOf(0);

    runSearch("target");
    expect(searchCount()).toBe("1 / 2");
    expect(marks().length).toBe(2);
    // 命中落在副行 span 内，当前命中 = 第 1 行的副行 mark（ordinal 0）
    expect(marks()[0].closest(SUBTEXT_SELECTOR)).toBe(subtextBefore);
    expect(currentMark()).toBe(marks()[0]);
    // 高亮重建后副行节点身份 / class / data-state 原样保留
    expect(subtextOf(0)).toBe(subtextBefore);
    expect(subtextBefore?.getAttribute("data-state")).toBe("ready");
    expect(subtextBefore?.textContent).toBe("hello target");

    search.moveReadingSubtitleSearch(1);
    expect(searchCount()).toBe("2 / 2");
    expect(currentMark()?.closest(SUBTEXT_SELECTOR)).toBe(subtextOf(1));
    expect(currentMark()?.textContent).toBe("target");
  });

  it("同一行主行 + 副行都命中：DOM 顺序 = match 顺序（主行 ordinal 更低）", () => {
    setBilingual(true);
    seedSecondaryReady([{ from: 0, to: 5, content: "target in sub" }]);
    renderBody([
      { from: 0, to: 5, content: "target in main" },
      { from: 5, to: 10, content: "不含该词" }
    ]);

    runSearch("target");
    expect(searchCount()).toBe("1 / 2");
    const rowMarks = [...row(0).querySelectorAll<HTMLElement>(MARK_SELECTOR)];
    expect(rowMarks.length).toBe(2);
    expect(rowMarks[0].parentElement).toBe(textSpan(0));
    expect(rowMarks[1].closest(SUBTEXT_SELECTOR)).not.toBeNull();
    // 第 1 个命中（ordinal 0）在主行，第 2 个（ordinal 1）在副行
    expect(currentMark()).toBe(rowMarks[0]);
    expect(currentMark()?.closest(SUBTEXT_SELECTOR)).toBeNull();

    search.moveReadingSubtitleSearch(1);
    expect(searchCount()).toBe("2 / 2");
    expect(currentMark()).toBe(rowMarks[1]);
    expect(currentMark()?.closest(SUBTEXT_SELECTOR)).not.toBeNull();
  });

  it("占位文案不产生命中：loading / fail 文案搜不到，主行命中照常", () => {
    setBilingual(true);
    clipState.markSecondarySubtitleLoading({ id: "en", url: "https://sub/ai-en.json" });
    renderBody([{ from: 0, to: 5, content: "主行正文" }]);
    expect(subtextOf(0)?.getAttribute("data-state")).toBe("loading");

    runSearch("译文");
    expect(searchCount()).toBe("无匹配");
    expect(marks().length).toBe(0);
    runSearch("加载");
    expect(searchCount()).toBe("无匹配");
    expect(marks().length).toBe(0);

    runSearch("主行");
    expect(searchCount()).toBe("1 / 1");
    expect(marks()[0].closest(SUBTEXT_SELECTOR)).toBeNull();
    expect(subtextOf(0)?.querySelectorAll("mark").length).toBe(0);

    // fail 占位同理：占位文案搜不到（占位不是译文内容）
    clipState.markSecondarySubtitleError();
    renderBody([{ from: 0, to: 5, content: "主行正文" }]);
    runSearch("失败");
    expect(searchCount()).toBe("无匹配");
    expect(marks().length).toBe(0);
    runSearch("主行");
    expect(searchCount()).toBe("1 / 1");
    expect(subtextOf(0)?.querySelectorAll("mark").length).toBe(0);
  });

  it("批次回执：后上屏的条目由 hook 补高亮，副行 span 保持", () => {
    setBilingual(true);
    seedSecondaryReady([
      { from: 0, to: 5, content: "hello target" },
      { from: 5, to: 10, content: "second target" }
    ]);
    const items = renderBody([
      { from: 0, to: 5, content: "第一句" },
      { from: 5, to: 10, content: "第二句" }
    ]);
    // 首屏只有第 1 行
    renderList([items[0]]);
    runSearch("target");
    expect(marks().length).toBe(1);

    // 第二批上屏（原始无 mark 的条目）→ hook 补高亮
    listEl().insertAdjacentHTML("beforeend", render.buildReadingSubtitleItemHtml(items[1], false));
    expect(marks().length).toBe(1);
    search.handleReadingSubtitleRangeAppended(1, 2);
    expect(marks().length).toBe(2);
    expect(row(1).querySelector<HTMLElement>(MARK_SELECTOR)?.closest(SUBTEXT_SELECTOR)).not.toBeNull();
    expect(subtextOf(1)?.getAttribute("data-state")).toBe("ready");
    expect(subtextOf(1)?.textContent).toBe("second target");
  });

  it("清除搜索：两行文本逐字还原，副行节点仍在", () => {
    setBilingual(true);
    seedSecondaryReady([{ from: 0, to: 5, content: "target in sub" }]);
    renderBody([{ from: 0, to: 5, content: "target in main" }]);

    runSearch("target");
    expect(marks().length).toBe(2);
    search.clearReadingSubtitleSearch();
    expect(marks().length).toBe(0);
    expect(searchCount()).toBe("");
    expect(textSpan(0).textContent).toBe("target in maintarget in sub");
    const subtext = subtextOf(0);
    expect(subtext?.textContent).toBe("target in sub");
    expect(subtext?.getAttribute("data-state")).toBe("ready");
    expect(subtext?.querySelectorAll("mark").length).toBe(0);
  });

  it("双语开后又关：命中集合 / 高亮回到单轨结果，重渲后没有副行节点", () => {
    setBilingual(true);
    seedSecondaryReady([{ from: 0, to: 5, content: "target in sub" }]);
    const body: SubtitleBodyItem[] = [{ from: 0, to: 5, content: "target in main" }];
    const items = renderBody(body);
    runSearch("target");
    expect(searchCount()).toBe("1 / 2");

    setBilingual(false);
    // 未重渲的老 DOM（副行仍在屏上）：匹配按单轨算，且不给残留副行落 mark
    const staleSubtext = subtextOf(0);
    search.refreshReadingSubtitleSearch({ scroll: false });
    expect(searchCount()).toBe("1 / 1");
    expect(marks().length).toBe(1);
    expect(marks()[0].closest(SUBTEXT_SELECTOR)).toBeNull();
    expect(staleSubtext?.querySelectorAll("mark").length).toBe(0);
    expect(staleSubtext?.textContent).toBe("target in sub");

    // 开关收尾的重渲（同一份 builder）后：列表退回单轨，命中与单轨态一致
    renderList(items);
    expect(subtextNodes().length).toBe(0);
    search.refreshReadingSubtitleSearch({ scroll: false });
    expect(searchCount()).toBe("1 / 1");
    expect(marks().length).toBe(1);
    // 重渲后的行只有主行（textContent 不含任何副行文本）
    expect(textSpan(0).textContent).toBe("target in main");
  });
});
