import { describe, expect, it } from "vitest";
import { renderMarkdown, splitMarkdownTail, stripThinkBlocks } from "../../extension/ui/markdown.js";

const EQUIVALENCE_CORPUS = [
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
  "行内 <think>think</think> 混合\n\n第二段",
  "单独行 think\n<think>\n单独行内容\n</think>\n结尾段",
  "全文没有空行的单段流式文本**加粗**`code`",
  "```js\n\n只有围栏和空行\n\n",
  "尾随空行\n\n第二段\n\n\n\n",
  "\n\n开头空行\n\n正文段",
  "   \n\n全空白行段\n\n内容",
  "段落一\n\n```\n未闭合围栏\n\n空行在围栏内\n\n",
  "```\n围栏先开\n\n```\n\n围栏后段落",
  "a<think\n\n部分标签在段尾",
  "emoji 🎉 段落\n\n第二段 **bold** [link](https://example.com)",
  "嵌套 ``` 围栏 ``` 行内\n\n第二段",
  "说明\n\n段中开启 ```js\n代码\n```\n\n后续段落",
  "```js\nx\n```\n\n中间段落 ```code``` 之后继续",
  "``````\n\n``````e",
  "ol 列表\n\n3. 丙\n7. 丁\n\nol 后续段"
];

describe("不变量 2/3：stable + tail 堆叠渲染与全文渲染逐字节等价（语料库）", () => {
  for (const text of EQUIVALENCE_CORPUS) {
    it(`堆叠 ≡ 全文：${JSON.stringify(text.slice(0, 32))}`, () => {
      const cleaned = stripThinkBlocks(text);
      const { stableText, tailText } = splitMarkdownTail(cleaned);
      const fullHtml = renderMarkdown(cleaned);
      expect(renderMarkdown(stableText) + renderMarkdown(tailText)).toBe(fullHtml);
      expect(fullHtml).not.toContain("\u0001BILISCRIPT_CODE");
    });
  }
});

describe("不变量 2：切点判定规则锁定", () => {
  it("切点只落在「空行段起点」，且该空行段之后还有非空行", () => {
    for (const text of EQUIVALENCE_CORPUS) {
      const cleaned = stripThinkBlocks(text);
      const { stableText, tailText } = splitMarkdownTail(cleaned);
      if (!stableText) {
        continue;
      }
      expect(cleaned.startsWith(stableText)).toBe(true);
      expect(cleaned).toBe(stableText + "\n" + tailText);
      expect(tailText.split("\n")[0].trim()).toBe("");
      expect(stableText.split("\n").pop()!.trim()).not.toBe("");
    }
  });

  it("切点前围栏必须闭合：未闭合 ``` 整段留在 tail", () => {
    const text = "第一段\n\n```js\n\n围栏内空行\n\n围栏内第二空行\n\n结尾";
    const { stableText, tailText } = splitMarkdownTail(text);
    expect(stableText).toBe("第一段");
    expect(tailText).toContain("```js");
    expect(tailText).toContain("结尾");
  });
});

describe("不变量 2：stable 只增不减（逐帧前缀序列）", () => {
  const SEQUENCES = [
    ["第一段\n\n", "第二段", "，仍在增长", "\n\n第三段", "\n\n", "第四段"],
    ["# 标题\n", "\n- 项目一\n", "- 项目二\n\n", "```js\nconst a = 1;\n", "```\n\n结尾"],
    ["<think>思考", "过程</think>", "\n\n正文", "\n\n```js\n", "代码\n```\n\n尾"],
    ["只有一", "个段落", "没有空行"],
    ["```js\n", "围栏内容", "\n\n围栏内空行\n", "```\n\n围栏后"],
    ["尾随空行\n\n第二段\n", "\n", "\n", "第三段前", "\n\n第三段"],
    ["<think>未闭合", "思考继续", "</think>\n\n正文段", "\n\n再一段"],
    ["a<think", ">\n\n段二"],
    ["", "  ", "\n\n", "前导空白后", "\n\n第二段"],
    ["mermaid\n\n```mermaid\n", "graph TD;\n", "A-->B;\n```\n\n", "图后"]
  ];

  function charSplits(text: string) {
    const cuts = new Set([0, text.length]);
    for (let i = 1; i < text.length; i += 7) cuts.add(i);
    return [...cuts].sort((a, b) => a - b).map((c, i, arr) => text.slice(arr[i - 1] ?? 0, c));
  }

  function assertMonotone(tokens: string[]) {
    let cumulative = "";
    let prevStable = "";
    let prevCutLineCount = -1;
    for (const token of tokens) {
      cumulative += token;
      const cleaned = stripThinkBlocks(cumulative);
      const { stableText, tailText } = splitMarkdownTail(cleaned);
      expect(stableText.startsWith(prevStable)).toBe(true);
      expect(stableText.length).toBeGreaterThanOrEqual(prevStable.length);
      prevStable = stableText;
      const cutLines = stableText ? stableText.split("\n").length : -1;
      expect(cutLines).toBeGreaterThanOrEqual(prevCutLineCount);
      prevCutLineCount = cutLines;
      expect(renderMarkdown(stableText) + renderMarkdown(tailText)).toBe(renderMarkdown(cleaned));
    }
  }

  function assertEquivalence(tokens: string[]) {
    let cumulative = "";
    for (const token of tokens) {
      cumulative += token;
      const cleaned = stripThinkBlocks(cumulative);
      const { stableText, tailText } = splitMarkdownTail(cleaned);
      expect(renderMarkdown(stableText) + renderMarkdown(tailText)).toBe(renderMarkdown(cleaned));
    }
  }

  for (const seq of SEQUENCES) {
    it(`语义切分：${JSON.stringify(seq.join("")).slice(0, 40)}`, () => assertMonotone(seq));
  }

  for (const text of EQUIVALENCE_CORPUS.filter((t) => t.length > 8)) {
    it(`字符级细切分（仅逐帧等价）：${JSON.stringify(text.slice(0, 24))}`, () =>
      assertEquivalence(charSplits(text)));
  }
});

describe("不变量 3/5：剥 think 的跨帧边界行为锁定", () => {
  it("未闭合 think 随流闭合：剥除结果从「吞到流尾」变为「成对剥除」", () => {
    expect(stripThinkBlocks("pre<think>secret")).toBe("pre");
    expect(stripThinkBlocks("pre<think>secret</think>tail")).toBe("pretail");
    expect(stripThinkBlocks("pre<think>sec")).toBe("pre");
    expect(stripThinkBlocks("pre<think>sec</think>tail")).toBe("pretail");
  });

  it("think 块内空行不成为切点（剥除先于切分，整块消失）", () => {
    const cleaned = stripThinkBlocks("A\n\n<think>\n块内空行\n\n块内第二段\n</think>\n\nB");
    expect(cleaned).toBe("A\n\n\n\nB");
    const { stableText, tailText } = splitMarkdownTail(cleaned);
    expect(renderMarkdown(stableText) + renderMarkdown(tailText)).toBe(renderMarkdown(cleaned));
  });

  it("行首行尾 think 标签行的剥除（^\\s*<\\/?think\\b[^>]*>\\s*$）", () => {
    expect(stripThinkBlocks("ab\n  <think>\nx")).toBe("ab");
    expect(stripThinkBlocks("ab\n  <think>")).toBe("ab");
    expect(stripThinkBlocks("cd  <think>")).toBe("cd");
    expect(stripThinkBlocks("a\n<think>\nb")).toBe("a");
    expect(stripThinkBlocks("lone<think>tagonlyline\nbody")).toBe("lone");
  });

  it("杂散 </think> 与大小写变体", () => {
    expect(stripThinkBlocks("a </think> b")).toBe("a  b");
    expect(stripThinkBlocks("</think>lead")).toBe("lead");
    expect(stripThinkBlocks("a<THINK>b</THINK>c")).toBe("ac");
    expect(stripThinkBlocks("x\n<think>\ny\n</think>\nz")).toBe("x\n\nz");
  });

  it("部分标签（无 >）保留为字面文本", () => {
    expect(stripThinkBlocks("a<think")).toBe("a<think");
    expect(stripThinkBlocks("keep</thin")).toBe("keep</thin");
  });

  it("幂等：剥除输出再剥除不变（增量跳过已剥前缀的依据）", () => {
    const corpus = EQUIVALENCE_CORPUS.concat([
      "a<think>b</think>c",
      "x<think>a",
      "a </think> b",
      "p<think>q</think>r<think>s",
      "  <think>\n  ",
      "<think>\nmulti\n\npara\n</think>\nend"
    ]);
    for (const text of corpus) {
      const once = stripThinkBlocks(text);
      expect(stripThinkBlocks(once)).toBe(once);
    }
  });

  it("剥除输出的跨帧变化（非前缀稳定角落）：部分标签补全 / 未闭合块闭合", () => {
    const seqs = [
      { pieces: ["pre<think>sec", "ret</think>tail"], expected: ["pre", "pretail"] },
      { pieces: ["a<think", ">\n\n段二"], expected: ["a<think", "a"] },
      { pieces: ["a </thin", "k> b"], expected: ["a </thin", "a  b"] },
      { pieces: ["  <think>\n", "  \nbody"], expected: ["", ""] },
      { pieces: ["x<think>a<think>b", "</think>c"], expected: ["x", "xc"] },
      { pieces: ["lead\n<think a=1>", "body</think>\ntrail"], expected: ["lead", "lead\n\ntrail"] },
      { pieces: ["A\n\n </thin", "k>   "], expected: ["A\n\n </thin", "A"] }
    ];
    for (const { pieces, expected } of seqs) {
      let acc = "";
      pieces.forEach((piece, i) => {
        acc += piece;
        expect(stripThinkBlocks(acc)).toBe(expected[i]);
      });
    }
  });
});
