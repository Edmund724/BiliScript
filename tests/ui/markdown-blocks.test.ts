// ui/markdown 块级语法单测：引用块（>）、任务列表（- [ ]）、分割线（---）、
// 行内删除线（~~ ~~）。四者均为 AI 摘要常见输出而旧 parser 不支持（引用块/
// 分割线/删除线落进普通段落，任务列表渲染成字面 "[ ]" 文本）。样式契约对齐
// github-markdown-css 基线：任务列表产 GitHub 的 contains-task-list /
// task-list-item / task-list-item-checkbox 类名，由基线与 reader-chat.css 覆盖
// 层共同负责外观（本测试只钉 parser 产出）。

import { describe, expect, it } from "vitest";
import { renderMarkdown, splitMarkdownTail } from "../../extension/ui/markdown.js";

describe("renderMarkdown 引用块", () => {
  it("连续 > 行收集成一块，行内格式正常解析", () => {
    const html = renderMarkdown("> 第一层 **要点**\n> 补充说明\n\n下文段落");
    expect(html).toContain("<blockquote><p>第一层 <strong>要点</strong> 补充说明</p></blockquote>");
    expect(html).toContain("<p>下文段落</p>");
  });

  it("裸 >（空内容行）保持引用不断开，并按空内容行分组为多段", () => {
    const html = renderMarkdown("> 第一段\n>\n> 第二段");
    expect(html).toContain(
      "<blockquote><p>第一段</p><p>第二段</p></blockquote>"
    );
  });

  it("嵌套 > 不展开，内层 > 作为字面文本保留", () => {
    expect(renderMarkdown(">> 嵌套")).toContain("<blockquote><p>&gt; 嵌套</p></blockquote>");
  });

  it("引用块截断列表（flush/close 语义与普通块一致）", () => {
    const html = renderMarkdown("- 甲\n> 引用");
    expect(html).toContain("<ul><li>甲</li></ul>");
    expect(html).toContain("<blockquote>");
  });
});

describe("renderMarkdown 任务列表", () => {
  it("- [ ] / - [x] 产 contains-task-list 契约与 disabled 复选框", () => {
    const html = renderMarkdown("- [ ] 未完成\n- [x] 已完成");
    expect(html).toContain('<ul class="contains-task-list">');
    expect(html).toContain(
      '<li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox" disabled> 未完成</li>'
    );
    expect(html).toContain(
      '<li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox" disabled checked> 已完成</li>'
    );
  });

  it("空任务项（- [ ] 无文本）只产勾框", () => {
    const html = renderMarkdown("- [ ]");
    expect(html).toContain('type="checkbox" disabled></li>');
    expect(html).not.toContain("disabled >");
  });

  it("任务列表后的普通列表重开新 ul（flavor 不同不共用容器）", () => {
    const html = renderMarkdown("- [x] 任务\n- 普通项");
    expect(html).toContain("</ul><ul><li>普通项</li>");
  });

  it("* [ ] 与 + [ ] 同样识别", () => {
    const html = renderMarkdown("* [ ] 甲\n+ [x] 乙");
    expect(html.match(/<li class="task-list-item">/g)!.length).toBe(2);
  });
});

describe("renderMarkdown 有序列表（CommonMark 续进口径）", () => {
  it("连续编号共享一个 <ol>，不再每条重开", () => {
    const html = renderMarkdown("1. 甲\n2. 乙\n3. 丙");
    expect(html).toBe("<ol><li>甲</li><li>乙</li><li>丙</li></ol>");
  });

  it("首项编号非 1 时 start 传递，后续乱序编号归一为连续递增", () => {
    const html = renderMarkdown("3. 甲\n7. 乙");
    expect(html).toBe('<ol start="3"><li>甲</li><li>乙</li></ol>');
    expect(renderMarkdown("1. 甲\n1. 乙")).toBe("<ol><li>甲</li><li>乙</li></ol>");
  });

  it("空行相隔的 ol 项续进同一列表", () => {
    const html = renderMarkdown("1. 甲\n\n2. 乙");
    expect(html).toBe("<ol><li>甲</li><li>乙</li></ol>");
  });

  it("ol 与 ul 互相切换时各自重开", () => {
    const html = renderMarkdown("1. 甲\n- 乙\n2. 丙");
    expect(html).toBe("<ol><li>甲</li></ol><ul><li>乙</li></ul><ol start=\"2\"><li>丙</li></ol>");
  });
});

describe("renderMarkdown 分割线", () => {
  it("--- / *** / ___ 独占行产 <hr>，正文紧邻时先行 flush", () => {
    for (const marker of ["---", "***", "___", "----"]) {
      expect(renderMarkdown(`上文\n${marker}\n下文`)).toContain(`<p>上文</p><hr><p>下文</p>`);
    }
  });

  it("列表内截断列表；行内两个 - 不误判（非独占行）", () => {
    expect(renderMarkdown("- 甲\n---")).toContain("</ul><hr>");
    expect(renderMarkdown("a -- b")).toContain("<p>a -- b</p>");
  });
});

describe("renderMarkdown 删除线", () => {
  it("~~文本~~ 产 <del>，行内与其他格式共存", () => {
    expect(renderMarkdown("~~旧结论~~ 与 **新结论**")).toBe(
      "<p><del>旧结论</del> 与 <strong>新结论</strong></p>"
    );
  });

  it("一行多处删除线各自成对", () => {
    expect(renderMarkdown("~~甲~~ 与 ~~乙~~")).toBe("<p><del>甲</del> 与 <del>乙</del></p>");
  });
});

describe("splitMarkdownTail 与新增块型兼容", () => {
  it("引用块/分割线/任务列表参与流式切分：空行边界切点不变，堆叠渲染与全文一致", () => {
    const text = "> 引用首段\n> 引用续行\n\n---\n\n- [x] 任务甲\n- [ ] 任务乙\n\n正文尾段";
    const { stableText, tailText } = splitMarkdownTail(text);
    // 最后一个空行边界在「任务乙」与「正文尾段」之间
    expect(stableText).toContain("任务乙");
    expect(tailText.trim()).toBe("正文尾段");
    expect(renderMarkdown(stableText) + renderMarkdown(tailText)).toBe(renderMarkdown(text));
  });
});
