// 流式增量游标（ThinkStripCursor / MarkdownTailCursor）与全量纯函数
// （stripThinkBlocks / splitMarkdownTail）的逐字节对拍测试。
//
// 对拍断言（每个 delta 切分的每一帧）：
//   - 游标行视图 join("\n") + trimEnd === stripThinkBlocks(累计原文)（逐字节）
//   - 游标 cut/stableText/tailText === splitMarkdownTail(剥除后全文)（逐字节）
// 覆盖不变量 2/3 的增量侧：切点判定规则一个比特不变；剥除先于切分；
// 部分标签/未闭合块/核尾空白等「未定居尾」角落的跨帧行为与全量一致。

import { describe, expect, it } from "vitest";
import {
  createMarkdownTailCursor,
  createThinkStripCursor,
  renderMarkdown,
  splitMarkdownTail,
  stripThinkBlocks
} from "../../extension/ui/markdown.js";

const CORPUS = [
  "第一段\n\n第二段开头，仍在增长\n\n第三段",
  "# 标题\n\n- 项目一\n- 项目二\n\n```js\nconst a = 1;\n```\n\n结尾段落",
  "说明\n\n```js\n\n围栏内空行\n\n```\n\n后续段落",
  "前言\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n表后段落",
  "> 引用\n>\n> 第二组\n\n引用后段落\n\n---\n\n分割线后",
  "- [x] 任务一\n- [ ] 任务二\n\n任务列表后段落",
  "```mermaid\ngraph TD; A-->B;\n```\n\n图表后段落",
  "```js\nconst a = 1;\n```\n\n```js\nconst b = 2;\n```\n\n双围栏后",
  "think 前\n\n<think>内部思考</think>\n\nthink 后",
  "<think>开头思考</think>直接正文\n\n第二段",
  "单独行 think\n<think>\n单独行内容\n</think>\n结尾段",
  "全文没有空行的单段流式文本**加粗**`code`",
  "```js\n\n只有围栏和空行\n\n",
  "尾随空行\n\n第二段\n\n\n\n",
  "\n\n开头空行\n\n正文段",
  "   \n\n全空白行段\n\n内容",
  "段落一\n\n```\n未闭合围栏\n\n空行在围栏内\n\n",
  "```\n围栏先开\n\n```\n\n围栏后段落",
  "a<think\n\n部分标签在段尾",
  "嵌套 ``` 围栏 ``` 行内\n\n第二段",
  "ol 列表\n\n3. 丙\n7. 丁\n\nol 后续段",
  "x<think>a<think>b</think>c",
  "a </think> b\n\n第二段",
  "<THINK>大写</THINK>正文\n\n段二",
  "a<think",
  "keep</thin\n\n下一段"
];

// 跨帧「未定居尾」角落序列：部分标签补全、未闭合块闭合、核尾空白被正则 4
// 吃掉、剥除后仍全空白、块内容丢弃后闭合等——增量实现最易与全量分叉的地方。
const SEQUENCES = [
  ["pre<think>sec", "ret</think>tail"],
  ["a<think", ">\n\n段二"],
  ["a </thin", "k> \n\n", "下一段"],
  ["a </thin", "k>   "],
  ["A\n\n </thin", "k>   "],
  ["  <think>\n", "  \nbody"],
  ["x<think>a<think>b", "</think>c"],
  ["lead\n<think a=1>", "body</think>\ntrail"],
  ["ab\n  ", "<think>\nx"],
  ["ab\n  <think>", "\nx\n</think>\ntail"],
  ["cd  <thin", "k>\n\n后段"],
  ["<think>", "块内大量内容\n\n更多", "仍不闭合", "直到这里</think>后文", "\n\n新段"],
  ["<think>块一</think>", "<think>块二", "块二继续</think>尾", "\n\n段"],
  ["前段\n\n```js\n", "代码<think>标签在围栏里", "\n```\n\n后段"],
  ["", "  ", "\n\n", "前导空白后", "\n\n第二段"],
  ["<think>a</think>", "\n\n", "正文"],
  ["杂散</think>在流中\n\n", "第二段</think>\n\n", "第三段"],
  ["尾行部分<th", "ink>开块", "块内容</think>", "\n\n结尾"],
  ["p1\n\np2  ", "  \n\n", "p3"],
  ["\n", "\n", "段一\n\n", "段二"]
];

function splitsOf(text: string) {
  const result = [];
  // 整段一次推入
  result.push([text]);
  // 逐字符
  result.push([...text]);
  // 每 3 字符
  const by3 = [];
  for (let i = 0; i < text.length; i += 3) by3.push(text.slice(i, i + 3));
  result.push(by3);
  return result;
}

function assertCursorEqualsFull(deltas: string[]) {
  const strip = createThinkStripCursor();
  const tail = createMarkdownTailCursor();
  let full = "";
  for (const delta of deltas) {
    full += delta;
    strip.push(delta);
    const lines = strip.lines;
    tail.update(lines);
    const cleaned = stripThinkBlocks(full);
    // 行视图：与全量剥除逐字节一致（仅尾部空白由 trimEnd 还原）
    expect(lines.join("\n").trimEnd()).toBe(cleaned);
    // 切分：cut / stable / tail 与全量版逐字节一致
    const expected = splitMarkdownTail(cleaned);
    const cut = tail.cut;
    const stableText = cut < 0 ? "" : lines.slice(0, cut).join("\n");
    const tailText = (cut < 0 ? lines.join("\n") : lines.slice(cut).join("\n")).trimEnd();
    expect(stableText).toBe(expected.stableText);
    expect(tailText).toBe(expected.tailText);
    // 堆叠渲染等价（双保险）
    expect(renderMarkdown(stableText) + renderMarkdown(tailText)).toBe(renderMarkdown(cleaned));
  }
}

describe("ThinkStripCursor + MarkdownTailCursor 对拍全量纯函数", () => {
  for (const text of CORPUS) {
    for (const [i, deltas] of splitsOf(text).entries()) {
      it(`语料 ${JSON.stringify(text.slice(0, 24))} 切分#${i}`, () => {
        assertCursorEqualsFull(deltas);
      });
    }
  }

  for (const [i, seq] of SEQUENCES.entries()) {
    it(`未定居尾序列 #${i}：${JSON.stringify(seq.join("")).slice(0, 48)}`, () => {
      assertCursorEqualsFull(seq);
      // 同一序列换字符级细切分再对拍一遍
      assertCursorEqualsFull([...seq.join("")]);
    });
  }
});

describe("增量游标的长流压力对拍", () => {
  it("600 帧小增量构建长文：每帧与全量一致", () => {
    const rand = (seed: number) => () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const next = rand(42);
    const deltas = [];
    for (let para = 0; para < 120; para += 1) {
      deltas.push(`第${para}段 内容${Math.floor(next() * 1000)} 继续`);
      // 段落间要么空行、要么单换行（单换行并段，两种边界都要覆盖）；
      // 围栏/think 只在行首开启——行中开启和占位符泄漏已修复，语料覆盖该路径。
      deltas.push(next() < 0.3 ? "\n\n" : "\n");
      if (next() < 0.15) {
        deltas.push("<think>思");
        deltas.push("考</think>");
        deltas.push("\n\n");
      }
      if (next() < 0.1) {
        deltas.push("```js\n");
        deltas.push(`const v = ${para};\n`);
        deltas.push("```\n\n");
      }
    }
    assertCursorEqualsFull(deltas);
  });
});
