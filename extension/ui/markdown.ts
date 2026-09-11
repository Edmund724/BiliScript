// markdown.ts — pure deep module for the custom markdown rendering logic
// extracted out of extension/pages/sidepanel.js (ticket 03 of sidepanel-split).
//
// Domain: ui (same dir as ui-renderer.js). Pure: no DOM, no chrome, no window,
// no sidepanel module-level state. The ONLY external dependency is escapeHtml
// (sourced from shared/string-utils.js).
//
// Shared constants:
//   - TIMESTAMP_PATTERN: the single copy of the timestamp regex
//     (/\b\d{1,3}:\d{2}(?::\d{2})?\b/g); timestamp-nav.js imports it from here.
//   - TIMESTAMP_INLINE_CODE_REST_PATTERN: used only by isTimestampOnlyInlineCode.
import { escapeHtml } from "../shared/string-utils.js";

export const TIMESTAMP_PATTERN = /\b\d{1,3}:\d{2}(?::\d{2})?\b/g;
const TIMESTAMP_INLINE_CODE_REST_PATTERN = /^[\s,，、;；:：\-–—~～至到]+$/;

// mermaid 围栏（```mermaid）的占位标记与选择器单源：renderMarkdown（产出占位）
// 与 ui/lazy-mermaid、ui/mermaid-render（异步水合成图表）共用，避免 data 属性
// 名/类名在三处各写一份。markdown 是纯模块——只产出占位 DOM，不做异步渲染。
export const MERMAID_BLOCK_ATTR = "data-boc-mermaid";
export const MERMAID_BLOCK_SELECTOR = `[${MERMAID_BLOCK_ATTR}]`;
// 源码 <pre>：渲染成功后由 CSS 按 done 状态隐藏，渲染前/失败时就是一块普通代码块
const MERMAID_SOURCE_CLASS = "boc-md-mermaid-src";
export const MERMAID_SOURCE_SELECTOR = `.${MERMAID_SOURCE_CLASS}`;
const MERMAID_FENCE_LANG = "mermaid";

// 代码围栏的解析结果：info string（语言）与正文分列。旧实现把 info string 一并
// 当正文，```mermaid 的语言名会被当代码首行显示出来。
interface CodeFence {
  lang: string;
  code: string;
}

export function isTimestampOnlyInlineCode(value: unknown): boolean {
  const text = String(value || "").trim();
  if (!text) {
    return false;
  }
  TIMESTAMP_PATTERN.lastIndex = 0;
  const hasTimestamp = TIMESTAMP_PATTERN.test(text);
  TIMESTAMP_PATTERN.lastIndex = 0;
  if (!hasTimestamp) {
    return false;
  }
  const rest = text.replace(TIMESTAMP_PATTERN, "").trim();
  TIMESTAMP_PATTERN.lastIndex = 0;
  return !rest || TIMESTAMP_INLINE_CODE_REST_PATTERN.test(rest);
}

export function renderMarkdown(text: string): string {
  let escaped = escapeHtml(stripThinkBlocks(text));
  const codeBlocks: CodeFence[] = [];
  // info string 单列捕获（不含换行与反引号，因而不会跨行吃掉围栏正文）+ 其后
  // 可选的换行。没有换行说明 ``` 与正文同行（`` ```js alert(1)``` ``），此时
  // 整段按正文处理、语言为空——与旧实现一致，不然语言判定会把正文吃掉。
  escaped = escaped.replace(
    /```([^\n`]*)(\r?\n)?([\s\S]*?)```/g,
    (_, info: string, newline: string | undefined, code: string) => {
      const sameLine = newline === undefined;
      codeBlocks.push({
        lang: sameLine ? "" : info.trim().toLowerCase(),
        code: sameLine ? info + code : code
      });
      return `\u0001BOC_CODE_${codeBlocks.length - 1}\u0001`;
    }
  );

  const lines = escaped.split("\n");
  const out: string[] = [];
  let listType = "";
  let listStartNumber = 1;
  // 任务列表（- [ ]） flavor：当前 ul 是否 contains-task-list 档。同类型列表
  // flavor 不同也重开（两种缩进契约不同：基线 checkbox 负边距配 2em 缩进）。
  let listTaskFlavor = false;
  let paraBuf: string[] = [];

  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${renderInline(paraBuf.join(" "))}</p>`);
      paraBuf = [];
    }
  };
  const closeList = () => {
    if (!listType) {
      return;
    }
    out.push(listType === "ul" ? "</ul>" : "</ol>");
    listType = "";
    listTaskFlavor = false;
    listStartNumber = 1;
  };
  const openList = (nextType: string, startNumber = 1, taskFlavor = false) => {
    if (
      listType === nextType &&
      listTaskFlavor === taskFlavor &&
      (nextType !== "ol" || listStartNumber === startNumber)
    ) {
      return;
    }
    closeList();
    listType = nextType;
    listTaskFlavor = taskFlavor;
    listStartNumber = nextType === "ol" ? startNumber : 1;
    if (nextType === "ul") {
      out.push(taskFlavor ? `<ul class="contains-task-list">` : "<ul>");
      return;
    }
    out.push(startNumber > 1 ? `<ol start="${startNumber}">` : "<ol>");
  };
  const getNextListType = (startIndex: number) => {
    for (let index = startIndex; index < lines.length; index += 1) {
      const nextLine = lines[index].trim();
      if (!nextLine) {
        continue;
      }
      if (/^[-*+]\s+(.+)$/.test(nextLine)) {
        return "ul";
      }
      if (/^\d+\.\s+(.+)$/.test(nextLine)) {
        return "ol";
      }
      break;
    }
    return "";
  };
  const isTableSeparatorLine = (value: string) => /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(value);
  const isTableRowLine = (value: string) => /^\|.+\|$/.test(value);
  const splitTableCells = (value: string) =>
    value
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => renderInline(cell.trim()));

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    const codeMatch = line.match(/^\u0001BOC_CODE_(\d+)\u0001$/);
    if (codeMatch) {
      flushPara();
      closeList();
      const fence = codeBlocks[Number(codeMatch[1])];
      if (fence.lang === MERMAID_FENCE_LANG) {
        // 图表占位：源码留在 <pre><code> 里（渲染前/渲染失败时就是一块普通代码
        // 块，不需要额外的加载态样式），真正的 SVG 由 ui/lazy-mermaid 在节点插入
        // DOM 后异步换入（见 MERMAID_BLOCK_ATTR 的状态机 pending/done/error）。
        out.push(
          `<div class="boc-md-mermaid" ${MERMAID_BLOCK_ATTR}="pending">` +
            `<pre class="${MERMAID_SOURCE_CLASS}"><code>${fence.code}</code></pre></div>`
        );
        continue;
      }
      out.push(`<pre><code>${fence.code}</code></pre>`);
      continue;
    }

    // ATX 标题 1–6 级：面板自身占用 h1/h2，正文标题整体下移两档；4 级及以上
    //（#### 起）已无更深档可让，一律夹到最深档 h6。
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    // 分割线：- / * / _ 三种独占行（3 个及以上）。本 parser 无 setext 标题
    // 概念，段落紧接的 --- 按分割线处理（段落先行 flush）。
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushPara();
      closeList();
      out.push("<hr>");
      continue;
    }

    // 引用块：连续 > 行收集成一块，裸 >（空内容）保持引用不断开；块内按空
    // 内容行分组，每组一个 <p>。嵌套 >（>> ）不展开，内层 > 作为字面文本
    // 留在行内——AI 摘要场景的引用一层即够用。注意匹配 &gt;：解析全程在
    // escapeHtml 之后的文本上进行，> 已被转义。
    const bq = line.match(/^&gt;\s?(.*)$/);
    if (bq) {
      flushPara();
      closeList();
      const inner: string[] = [bq[1]];
      while (index + 1 < lines.length) {
        const nextBq = lines[index + 1].trim().match(/^&gt;\s?(.*)$/);
        if (!nextBq) {
          break;
        }
        index += 1;
        inner.push(nextBq[1]);
      }
      const quoteParas: string[][] = [[]];
      for (const text of inner) {
        if (!text.trim()) {
          quoteParas.push([]);
          continue;
        }
        quoteParas[quoteParas.length - 1].push(text);
      }
      out.push(
        `<blockquote>${quoteParas
          .filter((para) => para.length)
          .map((para) => `<p>${renderInline(para.join(" "))}</p>`)
          .join("")}</blockquote>`
      );
      continue;
    }

    // 任务列表项：- [ ] / - [x]（*、+ 同样）。契约对齐 github-markdown-css
    // 基线（.contains-task-list / .task-list-item / .task-list-item-checkbox），
    // disabled 复选框只表达状态不可交互。
    const task = line.match(/^[-*+]\s+\[([ xX])\]\s*(.*)$/);
    if (task) {
      flushPara();
      openList("ul", 1, true);
      const checkbox =
        `<input class="task-list-item-checkbox" type="checkbox" disabled` +
        `${task[1] === " " ? "" : " checked"}>`;
      out.push(
        `<li class="task-list-item">${checkbox}${task[2] ? ` ${renderInline(task[2])}` : ""}</li>`
      );
      continue;
    }

    if (
      isTableRowLine(line) &&
      index + 1 < lines.length &&
      isTableSeparatorLine(lines[index + 1].trim())
    ) {
      flushPara();
      closeList();
      const headers = splitTableCells(line);
      const bodyRows: string[][] = [];
      index += 2;
      while (index < lines.length) {
        const tableLine = lines[index].trim();
        if (!isTableRowLine(tableLine)) {
          index -= 1;
          break;
        }
        bodyRows.push(splitTableCells(tableLine));
        index += 1;
      }
      out.push(
        `<table><thead><tr>${headers.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${
          bodyRows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")
        }</tbody></table>`
      );
      continue;
    }

    const ul = line.match(/^[-*+]\s+(.+)$/);
    if (ul) {
      flushPara();
      openList("ul");
      out.push(`<li>${renderInline(ul[1])}</li>`);
      continue;
    }

    const ol = line.match(/^(\d+)\.\s+(.+)$/);
    if (ol) {
      flushPara();
      const orderNumber = Number(ol[1]) || 1;
      // 已处于 <ol> 中即续进（CommonMark 口径：后续项的源编号不影响渲染，
      // marker 由 start 起自动递增，1. 1. / 3. 7. 都归一成连续编号）；只有
      // 不在 ol 中时才以该项编号开新列表。流式切分跨切点的 tail 重开列表时，
      // start 取该项源编号，堆叠渲染编号仍连续。
      if (listType !== "ol") {
        openList("ol", orderNumber);
      }
      out.push(`<li>${renderInline(ol[2])}</li>`);
      continue;
    }

    if (!line) {
      flushPara();
      if (listType && getNextListType(index + 1) === listType) {
        continue;
      }
      closeList();
      continue;
    }

    paraBuf.push(line);
  }

  flushPara();
  closeList();
  return out.join("");
}

// splitMarkdownTail — 流式增量渲染的切分纯函数：把文本切成"已稳定的前缀块"
// 与"仍在增长的末块"，调用方对 stable 只在其增长时渲染一次，tail 每帧重渲染。
//
// 切分规则：
//   1. 只在"空行连续段"的起点切（连续空行按一个边界处理），且该空行段之后
//      必须还有非空行——排除文末换行产生的尾随空行，保证 stable 随流式追加
//      只增不减、不会因尾随空行出现又消失而来回抖动；取满足条件的最后一个
//      切点（最后一个空行边界）。
//   2. 切点之前围栏必须闭合。围栏开合判定与 renderMarkdown 的 ``` 成对摘出
//      （``` 按出现顺序两两配对）一致：``` 每出现一次开/闭一次，前缀内累计
//      出现奇数次即处于未闭合围栏中（escapeHtml 不改写反引号，转义前后计数
//      一致）。
//   3. 找不到满足条件的切点（全文无空行，或所有空行边界都落在未闭合围栏内）
//      时安全退化：stableText 为空串、tailText 为全文，等价于全量渲染。
// 切点落在空行上，而 markdown 的块级结构（标题/表格/列表/段落/引用块/分割线/
// 任务列表）都以空行或单换行为界且不跨空行延续成块，因此
// renderMarkdown(stable) 与 renderMarkdown(tail) 堆叠渲染与 renderMarkdown(全文)
// 等价。
export function splitMarkdownTail(text: unknown): { stableText: string; tailText: string } {
  const source = String(text || "");
  const lines = source.split("\n");
  let lastNonBlank = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== "") {
      lastNonBlank = index;
      break;
    }
  }
  if (lastNonBlank < 0) {
    return { stableText: "", tailText: source };
  }
  let fenceOpen = false;
  let cut = -1;
  for (let index = 0; index < lastNonBlank; index += 1) {
    const line = lines[index];
    const blank = line.trim() === "";
    if (blank && !fenceOpen && (index === 0 || lines[index - 1].trim() !== "")) {
      cut = index; // 循环上界 lastNonBlank 保证该空行段之后仍有非空行
    }
    const fences = line.match(/```/g);
    if (fences && fences.length % 2 === 1) {
      fenceOpen = !fenceOpen;
    }
  }
  if (cut < 0) {
    return { stableText: "", tailText: source };
  }
  return {
    stableText: lines.slice(0, cut).join("\n"),
    tailText: lines.slice(cut).join("\n")
  };
}

function renderInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_, c: string) => (isTimestampOnlyInlineCode(c) ? c : `<code>${c}</code>`))
    .replace(/\*\*([^*\n]+)\*\*/g, (_, c: string) => `<strong>${c}</strong>`)
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, pre: string, c: string) => `${pre}<em>${c}</em>`)
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t: string, u: string) => {
      const safeUrl = /^(https?:|mailto:|#)/i.test(u) ? u : "#";
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${t}</a>`;
    });
}

export function stripThinkBlocks(text: unknown): string {
  return String(text || "")
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<\/think>/gi, "")
    .replace(/^\s*<\/?think\b[^>]*>\s*$/gim, "")
    .trim();
}
