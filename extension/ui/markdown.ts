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
export const MERMAID_BLOCK_ATTR = "data-biliscript-mermaid";
export const MERMAID_BLOCK_SELECTOR = `[${MERMAID_BLOCK_ATTR}]`;
// 源码 <pre>：渲染成功后由 CSS 按 done 状态隐藏，渲染前/失败时就是一块普通代码块
const MERMAID_SOURCE_CLASS = "biliscript-md-mermaid-src";
export const MERMAID_SOURCE_SELECTOR = `.${MERMAID_SOURCE_CLASS}`;
const MERMAID_FENCE_LANG = "mermaid";

// 代码围栏的解析结果：info string（语言）与正文分列。旧实现把 info string 一并
// 当正文，```mermaid 的语言名会被当代码首行显示出来。
interface CodeFence {
  lang: string;
  code: string;
}

interface FenceDelimiter {
  markerLength: number;
  info: string;
}

function parseFenceOpeningLine(line: string): FenceDelimiter | null {
  const match = line.match(/^ {0,3}(`{3,})([^\n`]*)\r?$/);
  return match ? { markerLength: match[1].length, info: match[2] } : null;
}

function isMatchingFenceClosingLine(line: string, markerLength: number): boolean {
  const delimiter = parseFenceOpeningLine(line);
  return delimiter !== null && delimiter.markerLength >= markerLength && delimiter.info.trim() === "";
}

function updateFenceState(line: string, markerLength: number): number {
  if (markerLength === 0) {
    return parseFenceOpeningLine(line)?.markerLength ?? 0;
  }
  return isMatchingFenceClosingLine(line, markerLength) ? 0 : markerLength;
}

function extractCodeFences(escaped: string): { text: string; codeBlocks: CodeFence[] } {
  const lines = escaped.split("\n");
  const output: string[] = [];
  const codeBlocks: CodeFence[] = [];

  for (let index = 0; index < lines.length; ) {
    const opening = parseFenceOpeningLine(lines[index]);
    if (!opening) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    let closing = -1;
    for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
      if (isMatchingFenceClosingLine(lines[candidate], opening.markerLength)) {
        closing = candidate;
        break;
      }
    }
    if (closing < 0) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    const body = lines.slice(index + 1, closing).join("\n");
    codeBlocks.push({
      lang: opening.info.trim().toLowerCase(),
      code: closing === index + 1 ? "" : `${body}${body.endsWith("\n") ? "" : "\n"}`
    });
    output.push(`\u0001BILISCRIPT_CODE_${codeBlocks.length - 1}\u0001`);
    index = closing + 1;
  }

  return { text: output.join("\n"), codeBlocks };
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
  return renderMarkdownStripped(stripThinkBlocks(text));
}

// renderMarkdownStripped — 与 renderMarkdown 相同，但输入须已由调用方剥除 think
// 块（chat-runtime 的流式 flush 与终态渲染都先经 stripThinkBlocks，内部再剥一
// 遍只是幂等冗余）。独立调用方（如 explain-card）用 renderMarkdown，勿直接用本函数。
export function renderMarkdownStripped(text: string): string {
  const escaped = escapeHtml(text);
  // 仅行首（允许 ≤3 空格）围栏是块级标记；段中出现的 ``` 保留为普通文本。
  const extracted = extractCodeFences(escaped);
  const renderedText = extracted.text;
  const codeBlocks = extracted.codeBlocks;

  const lines = renderedText.split("\n");
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

    const codeMatch = line.match(/^\u0001BILISCRIPT_CODE_(\d+)\u0001$/);
    if (codeMatch) {
      flushPara();
      closeList();
      const fence = codeBlocks[Number(codeMatch[1])];
      if (fence.lang === MERMAID_FENCE_LANG) {
        // 图表占位：源码留在 <pre><code> 里（渲染前/渲染失败时就是一块普通代码
        // 块，不需要额外的加载态样式），真正的 SVG 由 ui/lazy-mermaid 在节点插入
        // DOM 后异步换入（见 MERMAID_BLOCK_ATTR 的状态机 pending/done/error）。
        out.push(
          `<div class="biliscript-md-mermaid" ${MERMAID_BLOCK_ATTR}="pending">` +
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
//   2. 切点之前围栏必须闭合。围栏开合判定与 renderMarkdown 的行级成对摘出
//      （围栏只在行首开启，允许 0–3 个空格；段中 ``` 不生效）一致：
//      每行最多一个围栏分隔符，开启行记录标记长度，闭合行还必须匹配该长度。
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
  let fenceMarkerLength = 0;
  let cut = -1;
  for (let index = 0; index < lastNonBlank; index += 1) {
    const line = lines[index];
    const blank = line.trim() === "";
    if (blank && fenceMarkerLength === 0 && (index === 0 || lines[index - 1].trim() !== "")) {
      cut = index; // 循环上界 lastNonBlank 保证该空行段之后仍有非空行
    }
    fenceMarkerLength = updateFenceState(line, fenceMarkerLength);
  }
  if (cut < 0) {
    return { stableText: "", tailText: source };
  }
  return {
    stableText: lines.slice(0, cut).join("\n"),
    tailText: lines.slice(cut).join("\n")
  };
}

// =========================================================================
// 流式增量剥除 / 切分游标
// =========================================================================
// chat-runtime 的流式 flush 每帧对「全文」跑 stripThinkBlocks + splitMarkdownTail
// 是 O(全文) 的纯函数开销。两个游标把这两条纯函数改成增量维护，输出与全量版本
// 逐字节一致（尾部差一个 trimEnd，见 ThinkStripCursor.lines 的文档）：
//
//   const strip = createThinkStripCursor();
//   const tail = createMarkdownTailCursor();
//   for (const delta of 每帧 pending) {
//     strip.push(delta);
//     tail.update(strip.lines);
//     const stableText = tail.cut < 0 ? "" : strip.lines.slice(0, tail.cut).join("\n");
//     const tailText = (tail.cut < 0 ? strip.lines.join("\n") : strip.lines.slice(tail.cut).join("\n")).trimEnd();
//   }
//
// ThinkStripCursor 的逐字节论证（为何已定居前缀可以跳过重复剥除）：
//   剥除的 4 条正则里，任何匹配只会「从某个 < 起始、向右延伸」，因此一帧内只有
//   靠近文本末尾的「未定居尾」可能受未来文本影响，分三种形态：
//     1. 部分标签（如 "<thin"、"</think"）：当前不构成匹配、原样保留在输出里，
//        未来文本可将其补全为真标签（杂散闭合被剥除 / 开标签开块）；
//     2. 未闭合 <think> 开标签：正则 2 把它吃到串尾，未来闭标签到达时转为
//        正则 1 成对剥除——块起点之前输出不变，块内容丢弃即可（顺序配对：
//        第 k 个闭标签配第 k 个开标签），故只需记住标签本身；
//     3. 核尾空白：正则 4（^\s*<标签>\s*$）的 \s* 可向前跨行吃到切点前的空白，
//        故行尾空白行与行尾空白也留在未定居区，每帧随剥除结果重新落定。
//   三类之外的前缀（「核」）不含任何活标签，未来的匹配不可能触达，跳过重复剥除
//   是安全的。每帧实际跑正则的字符串 = 未定居尾 + 本帧新增，与帧间隔成正比。
export interface ThinkStripCursor {
  // 追加一帧新增原文（对应 flush 的 pending.join("")）。
  push(delta: string): void;
  // 剥除后文本的逐行视图：join("\n") 与 stripThinkBlocks(累计原文) 逐字节一致，
  // 仅尾部可能多出来被 strip 的 trim 去掉的空白（调用方对 tail 侧做 trimEnd 即
  // 完全等价；这些尾部空白不改变 splitMarkdownTail 的切点判定与 renderMarkdown
  // 输出——空行是 parser 无操作，行尾空白被 parser 逐行 trim）。
  readonly lines: readonly string[];
}

// 部分标签后缀：可跨帧补全为 think 标签的串尾（< / </ / <t…<think…(无 >) /
// </t…</think）。保守起见任何 "<" 开头的串尾都算（如 "<b"），只会多留少量
// 字符在未定居区，不影响正确性。
const PARTIAL_THINK_TAG = /<(\/?)(t(h(i(n(k\b[^>]*)?)?)?)?)?$/i;
// think 标签词法单元：完整开标签或闭标签（顺序配对的扫描单位）。
const THINK_TAG_TOKEN = /<think\b[^>]*>|<\/think>/gi;
const TRAILING_WS_RUN = /\s*$/;

export function createThinkStripCursor(): ThinkStripCursor {
  const lines: string[] = [""];
  // 未闭合 think 块的起始标签（非空即处于「块内」）；块内容已丢弃。
  let openTag = "";
  // 块内未检后缀：闭标签可能跨帧补全（字符先被当块内容到达），块内每帧只在
  // blockTail + 新增里找第一个完整 </think>，未找到时把可补全的标签后缀留下。
  let blockTail = "";

  return {
    push(delta: string): void {
      if (!delta) {
        return;
      }
      let remaining = delta;
      while (remaining) {
        if (openTag) {
          // 块内：顺序配对该块的是其后第一个完整 </think>。找到则出块，闭标签
          // 之后的文本回清态继续处理；未找到只留可补全后缀（O(新增)）。
          const combined = blockTail + remaining;
          const close = combined.match(/<\/think>/i);
          if (!close) {
            const partial = combined.match(PARTIAL_THINK_TAG);
            blockTail = partial ? partial[0] : "";
            remaining = "";
            continue;
          }
          blockTail = "";
          openTag = "";
          remaining = combined.slice(close.index! + close[0].length);
          continue;
        }
        // 清态。1. 抽出未定居尾，按原文顺序（末行尾的部分标签 → 行尾空白 →
        // 末尾空白行）拼回应检串 q：view = 核 + (pre + pt + ws) + 空白行。
        // 顺序依据：空白行是数组末尾行，在串上位于末行之后；行尾空白抽自末行
        // 尾部，位于部分标签之后。
        let tailBuf = "";
        while (lines.length > 1 && lines[lines.length - 1].trim() === "") {
          tailBuf = "\n" + lines.pop()! + tailBuf;
        }
        let last = lines[lines.length - 1];
        const ws = last.match(TRAILING_WS_RUN)![0];
        if (ws) {
          last = last.slice(0, last.length - ws.length);
        }
        const partial = last.match(PARTIAL_THINK_TAG);
        let pt = "";
        if (partial) {
          pt = partial[0];
          last = last.slice(0, last.length - pt.length);
        }
        lines[lines.length - 1] = last;
        const q = pt + ws + tailBuf + remaining;
        remaining = "";

        // 2. 对未定居区跑与全量完全相同的剥除正则。
        let resolved = stripThinkBlocksBody(q);

        // 3. 顺序配对扫描：balance 记录未配对开标签数，openIdx 为最早未配对
        // 开标签。存在未闭合块时块内容丢弃（见文件级注释的论证），块起点
        // 之前的结果与全量一致；块后可补全的标签后缀转入 blockTail。
        let openIdx = -1;
        let balance = 0;
        THINK_TAG_TOKEN.lastIndex = 0;
        let token: RegExpExecArray | null;
        while ((token = THINK_TAG_TOKEN.exec(q))) {
          if (token[0][1] === "/") {
            if (balance > 0) {
              balance -= 1;
              if (balance === 0) {
                openIdx = -1;
              }
            }
          } else {
            if (balance === 0) {
              openIdx = token.index;
            }
            balance += 1;
          }
        }
        if (openIdx >= 0) {
          openTag = q.slice(openIdx).match(/^<think\b[^>]*>/i)![0];
          const afterTag = q.slice(openIdx + openTag.length);
          const bp = afterTag.match(PARTIAL_THINK_TAG);
          blockTail = bp ? bp[0] : "";
        }

        // 4. 剥除结果并回行视图（仅改动末行及其后——切分游标已扫前缀不受影响）。
        const pieces = resolved.split("\n");
        lines[lines.length - 1] += pieces[0];
        for (let i = 1; i < pieces.length; i += 1) {
          lines.push(pieces[i]);
        }

        // 5. 前导 trim：与 stripThinkBlocks 的 trim 头部逐帧保持一致（think 块
        // 整体剥除后视图可重回空白，前缘并非一次落定，而是每帧幂等修剪）。实质
        // 修剪只发生在视图全空白、切分游标尚未扫描任何行的阶段；修剪后首行首
        // 字符从此不变（合并只追加末行），后续调用为 O(1) 空操作。
        let head = 0;
        while (head < lines.length && lines[head].trim() === "") {
          head += 1;
        }
        if (head === lines.length) {
          lines.length = 1;
          lines[0] = "";
        } else {
          if (head > 0) {
            lines.splice(0, head);
          }
          lines[0] = lines[0].replace(/^\s+/, "");
        }
      }
    },
    get lines(): readonly string[] {
      return lines;
    }
  };
}

// MarkdownTailCursor — splitMarkdownTail 的增量版：逐帧喂入行数组（按前缀增长，
// 只有末行及其后可能变化），cut 判定规则与全量版一个比特都不变。维护已扫描行数
// 与围栏开合状态，每帧只扫新增部分。唯一例外：末行突变可使「最后非空行」回退
// （部分标签补全 + 纯空白负载的极端角落），此时重置重扫——该角落全量版本身就会
// 缩短 stable，正确性优先于增量。
export interface MarkdownTailCursor {
  // 用最新行数组推进切分状态（行数组与上次调用按前缀一致）。
  update(lines: readonly string[]): void;
  // 当前切点（空行段起点行号；-1 = 无切点，全 tail）。
  readonly cut: number;
}

export function createMarkdownTailCursor(): MarkdownTailCursor {
  let cut = -1;
  let fenceMarkerLength = 0;
  // 已计入围栏/切点扫描的行数：下标 [0, scanned) 的行内容永不再变。
  let scanned = 0;
  let lastNonBlank = -1;

  return {
    update(lines: readonly string[]): void {
      let nb = lines.length - 1;
      while (nb >= 0 && lines[nb].trim() === "") {
        nb -= 1;
      }
      if (nb < lastNonBlank) {
        cut = -1;
        fenceMarkerLength = 0;
        scanned = 0;
      }
      if (nb > scanned) {
        for (let i = scanned; i < nb; i += 1) {
          const blank = lines[i].trim() === "";
          if (blank && fenceMarkerLength === 0 && (i === 0 || lines[i - 1].trim() !== "")) {
            cut = i;
          }
          fenceMarkerLength = updateFenceState(lines[i], fenceMarkerLength);
        }
        scanned = nb;
      }
      lastNonBlank = nb;
    },
    get cut(): number {
      return cut;
    }
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

// stripThinkBlocksBody — 4 条剥除正则（不含首尾 trim），stripThinkBlocks 与
// ThinkStripCursor（流式增量剥除）共用同一份正则序列，保证增量与全量逐字节一致。
function stripThinkBlocksBody(text: string): string {
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<\/think>/gi, "")
    .replace(/^\s*<\/?think\b[^>]*>\s*$/gim, "");
}

export function stripThinkBlocks(text: unknown): string {
  return stripThinkBlocksBody(String(text || "")).trim();
}
