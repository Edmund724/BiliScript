// 字幕条目 DOM 契约（extension/reader/subtitle-item-dom.ts）的聚焦单测。
//
// 覆盖的失败方式：
// - 主行文本把副行一起吃进来（重建后两行压平成一行）；
// - 主行里有搜索 `<mark>` 时读不回原文（幂等重算命中失效）；
// - 主行重写丢失副行节点身份或打乱「主文在前、副行在后」的顺序；
// - 无副行时重写落点错误；
// - 占位副行（data-state 非 ready）被当成可读副行；
// - 条目查找（data-index / 祖先）落到错误节点。

import { describe, expect, it } from "vitest";
import {
  closestSubtitleItem,
  findSubtitleItem,
  getMainLineText,
  getSubtextNode,
  isSubtextReady,
  replaceMainLineContent,
  SUBTITLE_ITEM_CLASS,
  SUBTITLE_SUBTEXT_CLASS,
  SUBTITLE_TEXT_CLASS
} from "../../extension/reader/subtitle-item-dom.js";

function textSpanOf(item: Element): HTMLElement {
  return item.querySelector(`.${SUBTITLE_TEXT_CLASS}`) as HTMLElement;
}

function buildItem(
  index: number,
  main: Node | string,
  subtext?: { text: string; state: string }
): HTMLButtonElement {
  const item = document.createElement("button");
  item.type = "button";
  item.className = SUBTITLE_ITEM_CLASS;
  item.dataset.index = String(index);
  item.dataset.seconds = "1";

  const time = document.createElement("span");
  time.className = "biliscript-reading-time";
  time.textContent = "00:01";

  const text = document.createElement("span");
  text.className = SUBTITLE_TEXT_CLASS;
  if (typeof main === "string") {
    text.textContent = main;
  } else {
    text.appendChild(main);
  }

  if (subtext) {
    const sub = document.createElement("span");
    sub.className = SUBTITLE_SUBTEXT_CLASS;
    sub.dataset.state = subtext.state;
    sub.textContent = subtext.text;
    text.appendChild(sub);
  }

  item.append(time, text);
  return item;
}

function fragmentWithMark(prefix: string, hit: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.appendChild(document.createTextNode(prefix));
  const mark = document.createElement("mark");
  mark.className = "biliscript-reading-search-hit";
  mark.textContent = hit;
  fragment.appendChild(mark);
  return fragment;
}

describe("subtitle-item-dom 主行/副行读写", () => {
  it("主行文本不含副行", () => {
    const item = buildItem(0, "第一句中文", { text: "First line", state: "ready" });

    expect(getMainLineText(item)).toBe("第一句中文");
    expect(getMainLineText(item)).not.toContain("First line");
  });

  it("主行含搜索 mark 时读回的是原文", () => {
    const item = buildItem(0, "前目标后");
    const text = textSpanOf(item);
    text.replaceChildren(fragmentWithMark("前", "目标"));
    text.appendChild(document.createTextNode("后"));

    expect(getMainLineText(item)).toBe("前目标后");
  });

  it("replaceMainLineContent 保留副行节点身份，且副行仍在主文之后", () => {
    const item = buildItem(0, "旧主行", { text: "译文", state: "ready" });
    const subtext = getSubtextNode(item);

    const replaced = replaceMainLineContent(item, fragmentWithMark("新", "主行"));

    expect(replaced).toBe(true);
    expect(getSubtextNode(item)).toBe(subtext);
    const children = Array.from(textSpanOf(item).childNodes);
    expect(children[children.length - 1]).toBe(subtext);
    expect(children[0]?.textContent).toBe("新");
    expect((children[1] as Element | undefined)?.tagName).toBe("MARK");
    expect(getMainLineText(item)).toBe("新主行");
    // 副行自身内容不受主行重写影响
    expect(subtext?.textContent).toBe("译文");
    expect(subtext?.dataset.state).toBe("ready");
  });

  it("无副行时替换后内容正确且不残留旧主文", () => {
    const item = buildItem(0, "旧主行");
    const before = getSubtextNode(item);

    const replaced = replaceMainLineContent(item, fragmentWithMark("新", "内容"));

    expect(before).toBeNull();
    expect(replaced).toBe(true);
    expect(getSubtextNode(item)).toBeNull();
    expect(textSpanOf(item).textContent).toBe("新内容");
    expect(getMainLineText(item)).toBe("新内容");
  });

  it("无条目 / 无 text span 时 replaceMainLineContent 返回 false 且不抛错", () => {
    const bare = document.createElement("button");
    bare.className = SUBTITLE_ITEM_CLASS;

    expect(replaceMainLineContent(null, document.createDocumentFragment())).toBe(false);
    expect(replaceMainLineContent(bare, document.createDocumentFragment())).toBe(false);
  });
});

describe("subtitle-item-dom 副行结构就绪", () => {
  it("只有 data-state=ready 的副行算就绪", () => {
    expect(isSubtextReady(buildItem(0, "主行", { text: "译文", state: "ready" }))).toBe(true);
    expect(isSubtextReady(buildItem(1, "主行", { text: "译文加载中…", state: "loading" }))).toBe(false);
    expect(isSubtextReady(buildItem(2, "主行", { text: "译文加载失败", state: "fail" }))).toBe(false);
    expect(isSubtextReady(buildItem(3, "主行"))).toBe(false);
    expect(isSubtextReady(null)).toBe(false);
  });
});

describe("subtitle-item-dom 条目查找", () => {
  it("按 data-index 查条目，缺失返回 null", () => {
    const list = document.createElement("div");
    const first = buildItem(0, "第一句");
    const second = buildItem(7, "第七句");
    list.append(first, second);

    expect(findSubtitleItem(list, 0)).toBe(first);
    expect(findSubtitleItem(list, 7)).toBe(second);
    expect(findSubtitleItem(list, 8)).toBeNull();
    expect(findSubtitleItem(null, 0)).toBeNull();
  });

  it("从条目内任意后代向上找到条目", () => {
    const item = buildItem(3, "主行", { text: "译文", state: "ready" });
    const subtext = getSubtextNode(item);

    expect(closestSubtitleItem(textSpanOf(item))).toBe(item);
    expect(closestSubtitleItem(subtext)).toBe(item);
    expect(closestSubtitleItem(item)).toBe(item);
    expect(closestSubtitleItem(document.createElement("span"))).toBeNull();
    expect(closestSubtitleItem(null)).toBeNull();
  });
});
