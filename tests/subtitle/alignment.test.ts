// 双语配对算法（票 bilingual-subtitles/04 的裁定，06 号票落地）。
//
// 口径（04 号票，不复述理由，只落断言）：
//   - 一条规则两个方向共用：「副行 = 与主轨段**重叠时长 > 0** 的全部副轨段，按
//     `from` 升序、**空格**拼接」；
//   - 半开区间 + 重叠时长**严格 > 0**：相邻段共享端点不互相污染；**不留容差窗口**；
//   - 无重叠 ⇒ 折叠（`null`，该行不出副行节点）；
//   - 配对**只读**两轨已排序的 body（接受事务已保证 `from` 升序），**不做任何再排序**；
//   - 双语关 / 副轨未就绪 ⇒ `null`（算法完全不参与，零行为差）。
//
// 系统可能怎么坏（先列失败方式，再据此写用例）：
//   1. 把「2 主段 ↔ 1 副段」的合并段只挂给其中一行（另一行该段时间里屏幕上没有译文）；
//   2. 把「1 主段 ↔ 2 副段」只取重叠最长的一条（丢掉另一句译文）；
//   3. 端点相接被判成重叠（相邻两行的副行互相串台）；
//   4. 反向：主轨段两端与相邻副轨段只有零测度交集时被粘上；
//   5. 空/纯空白副轨段参与拼接（副行出现多余空格或整行空白）；
//   6. 双语关 / 副轨 loading / error 时仍给出正文（列表在没译文时显示译文）；
//   7. 拼接顺序与输入顺序不一致（副行把后一句排到前一句前面）；
//   8. 结果不确定（同一输入两次调用给出不同字符串）。

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { clipState, state } from "../../extension/core/state.js";
import { buildSecondaryAlignment, secondaryContentFor } from "../../extension/subtitle/alignment.js";
import type { SubtitleBodyItem } from "../../extension/core/state.js";

function seg(from: number, to: number, content: string): SubtitleBodyItem {
  return { from, to, content };
}

// 纯函数入口：**建一次索引、查询多行**（渲染/导出走同款；测试逐例重建是因为每例
// 的副轨语料不同）。每行重建索引在生产里是 1500×1500 的平方级开销，不要模仿。
function pair(main: { from: number; to: number }, secondary: SubtitleBodyItem[]) {
  return buildSecondaryAlignment(secondary).query(main);
}

// 03 号票探针样本的合并形状（缩比）：zh 两段共享一条 en 译文。
const ZH_PAIR = [seg(0, 5, "第一句"), seg(5, 9, "第二句")];
const EN_MERGED = [seg(0, 9, "First and second")];

afterEach(() => {
  clipState.clearSecondarySubtitle();
  state.setSettings({ ...DEFAULT_SETTINGS });
});

describe("buildSecondaryAlignment（纯函数）", () => {
  it("逐段一致时一一对应", () => {
    const secondary = [seg(0, 5, "A"), seg(5, 9, "B")];
    expect(pair(ZH_PAIR[0], secondary)).toBe("A");
    expect(pair(ZH_PAIR[1], secondary)).toBe("B");
  });

  it("2 主段 ↔ 1 副段：两行显示同一句（重复但诚实）", () => {
    expect(pair(ZH_PAIR[0], EN_MERGED)).toBe("First and second");
    expect(pair(ZH_PAIR[1], EN_MERGED)).toBe("First and second");
  });

  it("1 主段 ↔ 2 副段：一行两句、空格连接、按 from 升序", () => {
    const secondary = [seg(0, 5, "A"), seg(5, 9, "B")];
    expect(pair(seg(0, 9, "整段"), secondary)).toBe("A B");
  });

  it("完全无重叠 ⇒ 折叠（null）", () => {
    expect(pair(seg(10, 20, "主"), [seg(0, 5, "副")])).toBeNull();
    expect(pair(seg(10, 20, "主"), [])).toBeNull();
  });

  it("端点相接不算重叠（相邻两段不互相串台）", () => {
    const secondary = [seg(0, 5, "A"), seg(5, 9, "B")];
    expect(pair(seg(5, 9, "主"), secondary)).toBe("B");
    expect(pair(seg(0, 5, "主"), secondary)).toBe("A");
  });

  it("零测度交集不算重叠（相邻但不重叠）", () => {
    expect(pair(seg(9, 12, "主"), [seg(0, 9, "A")])).toBeNull();
    expect(pair(seg(0, 5, "主"), [seg(5, 9, "B")])).toBeNull();
  });

  it("主轨段比副轨段粗时按时间顺序拼全（含多段跨接）", () => {
    const secondary = [seg(0, 10, "A"), seg(10, 20, "B"), seg(20, 31, "C")];
    expect(pair(seg(0, 30, "整段"), secondary)).toBe("A B C");
  });

  it("空 / 纯空白副轨段不参与拼接；全空 ⇒ null", () => {
    const secondary = [seg(0, 5, "  A  "), seg(5, 9, "   ")];
    expect(pair(seg(0, 9, "主"), secondary)).toBe("A");
    expect(pair(seg(0, 9, "主"), [seg(0, 9, "   ")])).toBeNull();
  });

  it("同一输入两次调用结果相同（确定性）", () => {
    const secondary = [seg(0, 4, "A"), seg(4, 8, "B")];
    const first = pair(seg(0, 8, "主"), secondary);
    const second = pair(seg(0, 8, "主"), secondary);
    expect(first).toBe(second);
    expect(first).toBe("A B");
  });

  it("主轨段 to <= from（脏数据）不产生重叠", () => {
    expect(pair(seg(5, 5, "主"), [seg(0, 9, "A")])).toBeNull();
    expect(pair(seg(9, 5, "主"), [seg(0, 9, "A")])).toBeNull();
  });
});

describe("secondaryContentFor（读 state 的投影入口）", () => {
  const main = { from: 0, to: 9 };

  it("双语关 ⇒ null（算法完全不参与）", () => {
    clipState.applySecondarySubtitle({ id: "en", url: "u", lang: "ai-en", body: EN_MERGED });
    state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: false });
    expect(secondaryContentFor(main)).toBeNull();
  });

  it("双语开且副轨就绪 ⇒ 给出拼接结果", () => {
    clipState.applySecondarySubtitle({ id: "en", url: "u", lang: "ai-en", body: EN_MERGED });
    state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: true });
    expect(secondaryContentFor(main)).toBe("First and second");
  });

  it("副轨 loading / error / 空槽 ⇒ null（占位文案由渲染层出，算法不出正文）", () => {
    state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: true });
    expect(secondaryContentFor(main)).toBeNull();

    clipState.markSecondarySubtitleLoading({ id: "en", url: "u", lang: "ai-en" });
    expect(secondaryContentFor(main)).toBeNull();

    clipState.applySecondarySubtitle({ id: "en", url: "u", lang: "ai-en", body: EN_MERGED });
    clipState.markSecondarySubtitleError();
    expect(secondaryContentFor(main)).toBeNull();
  });

  it("清场后回到 null（换视频不继承上一个视频的译文）", () => {
    state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: true });
    clipState.applySecondarySubtitle({ id: "en", url: "u", lang: "ai-en", body: EN_MERGED });
    expect(secondaryContentFor(main)).toBe("First and second");
    clipState.clearSecondarySubtitle();
    expect(secondaryContentFor(main)).toBeNull();
  });

  it("同一 body 引用重复查询给出同一结果（索引缓存不改变语义）", () => {
    state.setSettings({ ...DEFAULT_SETTINGS, bilingualSubtitles: true });
    const body = [seg(0, 5, "A"), seg(5, 9, "B")];
    clipState.applySecondarySubtitle({ id: "en", url: "u", lang: "ai-en", body });
    expect(secondaryContentFor(ZH_PAIR[0])).toBe("A");
    expect(secondaryContentFor(ZH_PAIR[1])).toBe("B");
    expect(secondaryContentFor(ZH_PAIR[0])).toBe("A");
  });
});
