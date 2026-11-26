import {
  resolveNodeDocument,
  resolveNodeWindow,
  writeActiveClipboardText,
} from "../shared/cross-doc.js";
import { decodeHtmlEntities, escapeHtml } from "../shared/string-utils.js";
import { flashCopySuccess } from "./copy-feedback.js";
import { READING_COPY_ICON } from "./reading-icons.js";
import { enhanceMarkdownTables, TABLE_SHELL_CLASS } from "./markdown-table.js";
import { hydrateMermaid } from "./lazy-mermaid.js";
import { hydrateMath } from "./lazy-math.js";
import {
  MATH_BLOCK_ATTR,
  MATH_BLOCK_SELECTOR,
  MERMAID_BLOCK_ATTR,
  MERMAID_BLOCK_SELECTOR,
  MERMAID_SOURCE_CLASS,
  MERMAID_SOURCE_SELECTOR,
} from "./markdown-block-constants.js";

export {
  MATH_BLOCK_ATTR,
  MATH_BLOCK_SELECTOR,
  MERMAID_BLOCK_ATTR,
  MERMAID_BLOCK_SELECTOR,
  MERMAID_SOURCE_SELECTOR,
};

export const TIMESTAMP_PATTERN = /\b\d{1,3}:\d{2}(?::\d{2})?\b/g;
const TIMESTAMP_INLINE_CODE_REST_PATTERN = /^[\s,，、;；:：\-–—~～至到]+$/;

const MATH_FENCE_LANGS = new Set(["math", "latex", "katex"]);
const MERMAID_FENCE_LANG = "mermaid";

interface CodeFence {
  lang: string;
  code: string;
  unclosed?: boolean;
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

function updateBlockMathState(line: string, inBlockMath: boolean): boolean {
  const trimmed = line.trim();
  if (!inBlockMath) {
    if (trimmed.startsWith("$$") && !(trimmed.length >= 4 && trimmed.endsWith("$$"))) {
      return true;
    }
    return false;
  }
  return trimmed.endsWith("$$") ? false : true;
}

function extractCodeFences(
  escaped: string,
  allowUnclosed = false
): { text: string; codeBlocks: CodeFence[] } {
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
      if (!allowUnclosed) {
        output.push(lines[index]);
        index += 1;
        continue;
      }
      const body = lines.slice(index + 1).join("\n");
      codeBlocks.push({
        lang: opening.info.trim().toLowerCase(),
        code: body ? `${body}${body.endsWith("\n") ? "" : "\n"}` : "",
        unclosed: true
      });
      output.push(`\u0001BILISCRIPT_CODE_${codeBlocks.length - 1}\u0001`);
      break;
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

function nearestNonBlankLine(lines: string[], from: number, step: -1 | 1): string | null {
  for (let index = from; index >= 0 && index < lines.length; index += step) {
    const trimmed = lines[index].trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function firstNonBlankLine(text: string): string | null {
  if (!text) {
    return null;
  }
  return nearestNonBlankLine(text.split("\n"), 0, 1);
}

function lastNonBlankLine(text: string): string | null {
  if (!text) {
    return null;
  }
  const lines = text.split("\n");
  return nearestNonBlankLine(lines, lines.length - 1, -1);
}

function isHeadingBlockLine(line: string): boolean {
  return /^(?:#{1,6})\s+(.+)$/.test(line);
}

function isHeadingAdjacentHr(lines: string[], index: number, options: MarkdownRenderOptions): boolean {
  const before =
    nearestNonBlankLine(lines, index - 1, -1) ?? lastNonBlankLine(options.hrAdjacentBefore ?? "");
  if (before && isHeadingBlockLine(before)) {
    return true;
  }
  const after =
    nearestNonBlankLine(lines, index + 1, 1) ?? firstNonBlankLine(options.hrAdjacentAfter ?? "");
  return after !== null && isHeadingBlockLine(after);
}

export interface MarkdownRenderOptions {
  dropHeadingAdjacentHr?: boolean;
  hrAdjacentBefore?: string;
  hrAdjacentAfter?: string;
  streaming?: boolean;
}

export function renderMarkdown(text: string, options: MarkdownRenderOptions = {}): string {
  return renderMarkdownStripped(stripThinkBlocks(text), options);
}

export function renderMarkdownStripped(text: string, options: MarkdownRenderOptions = {}): string {
  const streaming = Boolean(options.streaming);
  const inline = (value: string) => renderInline(value, streaming);
  const escaped = escapeHtml(text);
  const extracted = extractCodeFences(escaped, streaming);
  const renderedText = extracted.text;
  const codeBlocks = extracted.codeBlocks;

  const lines = renderedText.split("\n");
  const out: string[] = [];
  let listType = "";
  let listStartNumber = 1;
  let listTaskFlavor = false;
  let paraBuf: string[] = [];

  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${inline(paraBuf.join(" "))}</p>`);
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
      .map((cell) => inline(cell.trim()));

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    const codeMatch = line.match(/^\u0001BILISCRIPT_CODE_(\d+)\u0001$/);
    if (codeMatch) {
      flushPara();
      closeList();
      const fence = codeBlocks[Number(codeMatch[1])];
      if (fence.lang === MERMAID_FENCE_LANG) {
        const mermaidState = fence.unclosed ? "streaming" : "pending";
        const streamingAttr = fence.unclosed ? ' data-streaming-open="true"' : "";
        out.push(
          `<div class="biliscript-md-mermaid" ${MERMAID_BLOCK_ATTR}="${mermaidState}"${streamingAttr}>` +
            `<pre class="${MERMAID_SOURCE_CLASS}"><code>${fence.code}</code></pre></div>`
        );
        continue;
      }
      if (MATH_FENCE_LANGS.has(fence.lang)) {
        const inner = fence.code.trim();
        const rawTex = decodeHtmlEntities(inner);
        if (fence.unclosed) {
          out.push(
            `<div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-streaming-open="true" data-tex="${escapeHtml(rawTex)}">` +
              `<code class="biliscript-md-math-streaming">${inner || "…"}</code></div>`
          );
          continue;
        }
        out.push(
          `<div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${escapeHtml(rawTex)}">` +
            `$$${inner}$$</div>`
        );
        continue;
      }
      const fenceLang = fence.lang.trim().split(/\s+/)[0] || "";
      const langAttr = fenceLang ? ` data-lang="${escapeHtml(fenceLang)}"` : "";
      const streamingAttr = fence.unclosed ? ' data-streaming-open="true"' : "";
      out.push(`<pre${langAttr}${streamingAttr}><code>${fence.code}</code></pre>`);
      continue;
    }

    if (line.startsWith("$$")) {
      if (line.endsWith("$$") && line.length >= 4) {
        flushPara();
        closeList();
        const inner = line.slice(2, -2).trim();
        const rawTex = decodeHtmlEntities(inner);
        out.push(
          `<div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${escapeHtml(rawTex)}">` +
            `$$${inner}$$</div>`
        );
        continue;
      }
      let closing = -1;
      for (let c = index + 1; c < lines.length; c += 1) {
        if (lines[c].trim().endsWith("$$")) {
          closing = c;
          break;
        }
      }
      if (closing > index) {
        flushPara();
        closeList();
        const collected = [line.slice(2)];
        for (let c = index + 1; c < closing; c += 1) {
          collected.push(lines[c]);
        }
        const last = lines[closing].trim();
        collected.push(last.slice(0, -2));
        index = closing;
        const inner = collected.join("\n").trim();
        const rawTex = decodeHtmlEntities(inner);
        out.push(
          `<div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${escapeHtml(rawTex)}">` +
            `$$${inner}$$</div>`
        );
        continue;
      }
      if (streaming) {
        flushPara();
        closeList();
        const collected = [line.slice(2)];
        for (let c = index + 1; c < lines.length; c += 1) {
          collected.push(lines[c]);
        }
        index = lines.length - 1;
        const inner = collected.join("\n").trim();
        const rawTex = decodeHtmlEntities(inner);
        out.push(
          `<div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-streaming-open="true" data-tex="${escapeHtml(rawTex)}">` +
            `<code class="biliscript-md-math-streaming">${inner || "…"}</code></div>`
        );
        continue;
      }
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushPara();
      closeList();
      if (options.dropHeadingAdjacentHr && isHeadingAdjacentHr(lines, index, options)) {
        continue;
      }
      out.push("<hr>");
      continue;
    }

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
          .map((para) => `<p>${inline(para.join(" "))}</p>`)
          .join("")}</blockquote>`
      );
      continue;
    }

    const task = line.match(/^[-*+]\s+\[([ xX])\]\s*(.*)$/);
    if (task) {
      flushPara();
      openList("ul", 1, true);
      const checkbox =
        `<input class="task-list-item-checkbox" type="checkbox" disabled` +
        `${task[1] === " " ? "" : " checked"}>`;
      out.push(
        `<li class="task-list-item">${checkbox}${task[2] ? ` ${inline(task[2])}` : ""}</li>`
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
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    const ol = line.match(/^(\d+)\.\s+(.+)$/);
    if (ol) {
      flushPara();
      const orderNumber = Number(ol[1]) || 1;
      if (listType !== "ol") {
        openList("ol", orderNumber);
      }
      out.push(`<li>${inline(ol[2])}</li>`);
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
  let inBlockMath = false;
  let cut = -1;
  for (let index = 0; index < lastNonBlank; index += 1) {
    const line = lines[index];
    const blank = line.trim() === "";
    if (
      blank &&
      fenceMarkerLength === 0 &&
      !inBlockMath &&
      (index === 0 || lines[index - 1].trim() !== "")
    ) {
      cut = index;
    }
    const nextFence = updateFenceState(line, fenceMarkerLength);
    if (fenceMarkerLength === 0 && nextFence === 0) {
      inBlockMath = updateBlockMathState(line, inBlockMath);
    }
    fenceMarkerLength = nextFence;
  }
  if (cut < 0) {
    return { stableText: "", tailText: source };
  }
  return {
    stableText: lines.slice(0, cut).join("\n"),
    tailText: lines.slice(cut).join("\n")
  };
}

export interface ThinkStripCursor {
  push(delta: string): void;
  readonly lines: readonly string[];
}

const PARTIAL_THINK_TAG = /<(\/?)(t(h(i(n(k\b[^>]*)?)?)?)?)?$/i;
const THINK_TAG_TOKEN = /<think\b[^>]*>|<\/think>/gi;
const TRAILING_WS_RUN = /\s*$/;

export function createThinkStripCursor(): ThinkStripCursor {
  const lines: string[] = [""];
  let openTag = "";
  let blockTail = "";

  return {
    push(delta: string): void {
      if (!delta) {
        return;
      }
      let remaining = delta;
      while (remaining) {
        if (openTag) {
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

        let resolved = stripThinkBlocksBody(q);

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

        const pieces = resolved.split("\n");
        lines[lines.length - 1] += pieces[0];
        for (let i = 1; i < pieces.length; i += 1) {
          lines.push(pieces[i]);
        }

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

export interface MarkdownTailCursor {
  update(lines: readonly string[]): void;
  readonly cut: number;
}

export function createMarkdownTailCursor(): MarkdownTailCursor {
  let cut = -1;
  let fenceMarkerLength = 0;
  let inBlockMath = false;
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
        inBlockMath = false;
        scanned = 0;
      }
      if (nb > scanned) {
        for (let i = scanned; i < nb; i += 1) {
          const blank = lines[i].trim() === "";
          if (
            blank &&
            fenceMarkerLength === 0 &&
            !inBlockMath &&
            (i === 0 || lines[i - 1].trim() !== "")
          ) {
            cut = i;
          }
          const nextFence = updateFenceState(lines[i], fenceMarkerLength);
          if (fenceMarkerLength === 0 && nextFence === 0) {
            inBlockMath = updateBlockMathState(lines[i], inBlockMath);
          }
          fenceMarkerLength = nextFence;
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

function wrapFlowArrows(html: string): string {
  let inMath = false;
  return html
    .split(/(<[^>]+>)/g)
    .map((part) => {
      if (part.startsWith("<")) {
        if (/^<span class="biliscript-md-math\b/.test(part)) {
          inMath = true;
        } else if (inMath && part === "</span>") {
          inMath = false;
        }
        return part;
      }
      return inMath ? part : part.replaceAll("→", '<span class="biliscript-md-arrow">→</span>');
    })
    .join("");
}

function renderInline(text: string, streaming = false): string {
  const inlineCodes: string[] = [];
  let working = text.replace(/`([^`]+)`/g, (_, c: string) => {
    if (isTimestampOnlyInlineCode(c)) {
      return c;
    }
    inlineCodes.push(`<code>${c}</code>`);
    return `\u0002ILC_${inlineCodes.length - 1}\u0002`;
  });

  if (streaming) {
    const danglingTick = working.lastIndexOf("`");
    if (danglingTick >= 0) {
      const rest = working.slice(danglingTick + 1);
      if (rest && !isTimestampOnlyInlineCode(rest)) {
        inlineCodes.push(`<code>${rest}</code>`);
        working = `${working.slice(0, danglingTick)}\u0002ILC_${inlineCodes.length - 1}\u0002`;
      } else if (!rest) {
        working = working.slice(0, danglingTick);
      }
    }
  }

  working = working.replace(/\\(\$)/g, "\u0003ESCDOLLAR\u0003");

  working = working.replace(/\$\$([\s\S]+?)\$\$/g, (_, inner: string) => {
    const trimmed = inner.trim();
    const rawTex = decodeHtmlEntities(trimmed);
    return `<span class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${escapeHtml(rawTex)}">$$${trimmed}$$</span>`;
  });

  if (streaming) {
    const unclosedBlockMath = working.indexOf("$$");
    if (unclosedBlockMath >= 0) {
      const inner = working.slice(unclosedBlockMath + 2).trim();
      const rawTex = decodeHtmlEntities(inner);
      working =
        working.slice(0, unclosedBlockMath) +
        `<span class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-streaming-open="true" data-tex="${escapeHtml(rawTex)}">` +
        `<code class="biliscript-md-math-streaming">${inner || "…"}</code></span>`;
    }
  }

  working = working.replace(/(^|[^\w\$\\])\$([^\s\$](?:[^$\n]*?[^\s\$])?)\$(?!\w)/g, (full, pre: string, inner: string) => {
    if (/^[\d,.]+(?:\s*[a-zA-Z]+)?$/.test(inner.trim())) {
      return full;
    }
    const trimmed = inner.trim();
    const rawTex = decodeHtmlEntities(trimmed);
    return `${pre}<span class="biliscript-md-math biliscript-md-math-inline" ${MATH_BLOCK_ATTR}="inline" data-tex="${escapeHtml(rawTex)}">$${trimmed}$</span>`;
  });

  working = working
    .replace(/\*\*([^*\n]+)\*\*/g, (_, c: string) => `<strong>${c}</strong>`)
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, pre: string, c: string) => `${pre}<em>${c}</em>`)
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t: string, u: string) => {
      const safeUrl = /^(https?:|mailto:|#)/i.test(u) ? u : "#";
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${t}</a>`;
    });

  if (streaming) {
    const danglingBold = working.lastIndexOf("**");
    if (danglingBold >= 0) {
      const rest = working.slice(danglingBold + 2);
      working = rest
        ? `${working.slice(0, danglingBold)}<strong>${rest}</strong>`
        : working.slice(0, danglingBold);
    }
  }

  working = working.replaceAll("\u0003ESCDOLLAR\u0003", "$");
  working = wrapFlowArrows(working);
  working = working.replace(/\u0002ILC_(\d+)\u0002/g, (_, idx: string) => inlineCodes[Number(idx)]);
  return working;
}

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

export interface MarkdownCommitResult {
  newNodes: HTMLElement[];
}

export interface MarkdownCommitCursor {
  commit(deltaHtml: string, container: HTMLElement): MarkdownCommitResult;

  reset(): void;
}

export function createMarkdownCommitCursor(): MarkdownCommitCursor {
  let activeTable: HTMLTableElement | null = null;
  let activeList: HTMLElement | null = null;
  let activeListType = "";
  let activeListTaskFlavor = false;

  return {
    commit(deltaHtml: string, container: HTMLElement): MarkdownCommitResult {
      if (!deltaHtml.trim()) {
        return { newNodes: [] };
      }
      const doc = container.ownerDocument || (typeof document !== "undefined" ? document : null);
      if (!doc) {
        return { newNodes: [] };
      }
      const temp = doc.createElement("div");
      temp.innerHTML = deltaHtml;

      const newNodes: HTMLElement[] = [];
      const children = Array.from(temp.children) as HTMLElement[];

      for (const child of children) {
        const tag = child.tagName.toUpperCase();

        const currentTable = (): HTMLTableElement | null => {
          if (activeTable && container.contains(activeTable)) {
            return activeTable;
          }
          const last = container.lastElementChild;
          if (!last) {
            return null;
          }
          if (last.tagName === "TABLE") {
            return last as HTMLTableElement;
          }
          if (last.classList.contains(TABLE_SHELL_CLASS)) {
            return last.querySelector("table");
          }
          return null;
        };

        if (tag === "TABLE") {
          const existingTable = currentTable();

          if (existingTable) {
            const tbody = existingTable.querySelector("tbody") || existingTable;
            const childTbody = child.querySelector("tbody") || child;
            const rows = Array.from(childTbody.querySelectorAll("tr"));
            for (const row of rows) {
              tbody.appendChild(row);
            }
            activeTable = existingTable;
            activeList = null;
            activeListType = "";
            newNodes.push(existingTable);
            continue;
          }

          container.appendChild(child);
          activeTable = child as HTMLTableElement;
          activeList = null;
          activeListType = "";
          newNodes.push(child);
          continue;
        }

        if (child.tagName === "P") {
          const tableEl = currentTable();
          if (tableEl) {
            const tbody = tableEl.querySelector("tbody") || tableEl;
            const text = child.textContent?.trim() || "";
            const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
            const isAllRows = lines.length > 0 && lines.every((l) => /^\|.+\|$/.test(l));
            if (isAllRows) {
              const addedRows: HTMLElement[] = [];
              for (const line of lines) {
                const tr = doc.createElement("tr");
                const cells = line
                  .replace(/^\|/, "")
                  .replace(/\|$/, "")
                  .split("|")
                  .map((c) => c.trim());
                for (const cell of cells) {
                  const td = doc.createElement("td");
                  td.innerHTML = renderInline(cell);
                  tr.appendChild(td);
                }
                tbody.appendChild(tr);
                addedRows.push(tr);
              }
              activeTable = tableEl;
              activeList = null;
              activeListType = "";
              newNodes.push(...addedRows);
              continue;
            }
          }
        }

        if (tag === "UL" || tag === "OL") {
          const type = tag.toLowerCase();
          const taskFlavor = child.classList.contains("contains-task-list");
          const existingList =
            activeList && activeList.parentElement === container && activeListType === type && activeListTaskFlavor === taskFlavor
              ? activeList
              : (container.lastElementChild &&
                 container.lastElementChild.tagName.toUpperCase() === tag &&
                 (type !== "ul" || container.lastElementChild.classList.contains("contains-task-list") === taskFlavor)
                  ? (container.lastElementChild as HTMLElement)
                  : null);

          if (existingList) {
            const items = Array.from(child.children);
            for (const item of items) {
              existingList.appendChild(item);
            }
            activeList = existingList;
            activeListType = type;
            activeListTaskFlavor = taskFlavor;
            activeTable = null;
            newNodes.push(existingList);
            continue;
          }

          container.appendChild(child);
          activeList = child;
          activeListType = type;
          activeListTaskFlavor = taskFlavor;
          activeTable = null;
          newNodes.push(child);
          continue;
        }

        activeTable = null;
        activeList = null;
        activeListType = "";

        container.appendChild(child);
        newNodes.push(child);
      }

      return { newNodes };
    },

    reset(): void {
      activeTable = null;
      activeList = null;
      activeListType = "";
      activeListTaskFlavor = false;
    }
  };
}

export interface MarkdownStreamFlushOptions {
  cursor?: HTMLElement | null;
  shouldYield?: () => boolean;
  yieldToMain?: () => Promise<void>;
  isStale?: () => boolean;
}

export interface MarkdownStreamSessionOptions extends MarkdownRenderOptions {
  renderMarkdown?: (text: string, options?: MarkdownRenderOptions) => string;
}

export interface MarkdownStreamSession {
  readonly rawText: string;
  readonly strippedText: string;
  readonly stableText: string;
  readonly tailText: string;
  readonly stableCut: number;
  readonly committedCut: number;
  readonly stableEl: HTMLElement;
  readonly tailEl: HTMLElement;
  push(delta: string): void;
  flush(deltaOrOptions?: string | MarkdownStreamFlushOptions, maybeOptions?: MarkdownStreamFlushOptions): void | Promise<void>;
  reset(): void;
}

export function enhanceMarkdownCodeBlocks(root: ParentNode): void {
  const preNodes = Array.from(root.querySelectorAll<HTMLPreElement>("pre"));
  for (const pre of preNodes) {
    if (pre.classList.contains(MERMAID_SOURCE_CLASS) || pre.closest(".biliscript-md-mermaid") || pre.closest(".biliscript-md-code")) {
      continue;
    }
    const doc = resolveNodeDocument(pre);
    const wrapper = doc.createElement("div");
    wrapper.className = "biliscript-md-code";
    const bar = doc.createElement("div");
    bar.className = "biliscript-md-code-bar";
    const lang = pre.getAttribute("data-lang")?.trim() || "";
    if (lang) {
      const langEl = doc.createElement("span");
      langEl.className = "biliscript-md-code-lang";
      langEl.textContent = lang;
      bar.appendChild(langEl);
    }
    const copyBtn = doc.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "biliscript-md-code-copy";
    copyBtn.setAttribute("aria-label", "复制代码");
    copyBtn.setAttribute("title", "复制代码");
    copyBtn.innerHTML = READING_COPY_ICON.trim();
    copyBtn.addEventListener("click", async () => {
      const text = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
      try {
        await writeActiveClipboardText(text, resolveNodeWindow(copyBtn));
        flashCopySuccess(copyBtn, { originalSvg: READING_COPY_ICON, originalLabel: "复制代码" });
      } catch {
      }
    });
    bar.appendChild(copyBtn);
    pre.parentNode?.insertBefore(wrapper, pre);
    wrapper.append(bar, pre);
  }
}

export function hydrateMarkdownContent(root: ParentNode): void {
  enhanceMarkdownCodeBlocks(root);
  enhanceMarkdownTables(root);
  hydrateMermaid(root);
  hydrateMath(root);
}

export function createMarkdownStreamSession(
  stableEl: HTMLElement,
  tailEl: HTMLElement,
  options: MarkdownStreamSessionOptions = {}
): MarkdownStreamSession {
  const render = options.renderMarkdown || renderMarkdownStripped;
  let stripCursor = createThinkStripCursor();
  let tailCursor = createMarkdownTailCursor();
  const commitCursor = createMarkdownCommitCursor();

  let rawText = "";
  let stableText = "";
  let tailText = "";
  let stableCut = -2;
  let committedCut = 0;

  function push(delta: string): void {
    if (!delta) {
      return;
    }
    rawText += delta;
    stripCursor.push(delta);
  }

  function commitStable(toCut: number, fromCut: number, lines: readonly string[], currentTailText: string): void {
    if (toCut > fromCut) {
      const deltaText = lines.slice(fromCut, toCut).join("\n");
      const deltaHtml = render(deltaText, {
        ...options,
        hrAdjacentBefore: stableText,
        hrAdjacentAfter: currentTailText
      });
      const { newNodes } = commitCursor.commit(deltaHtml, stableEl);
      enhanceMarkdownCodeBlocks(stableEl);
      enhanceMarkdownTables(stableEl);
      for (const newNode of newNodes) {
        hydrateMermaid(newNode);
        hydrateMath(newNode);
      }
      committedCut = toCut;
    } else if (toCut < fromCut) {
      stableEl.innerHTML = "";
      commitCursor.reset();
      if (toCut > 0) {
        const rollbackText = lines.slice(0, toCut).join("\n");
        const deltaHtml = render(rollbackText, {
          ...options,
          hrAdjacentBefore: "",
          hrAdjacentAfter: currentTailText
        });
        const { newNodes } = commitCursor.commit(deltaHtml, stableEl);
        enhanceMarkdownCodeBlocks(stableEl);
        enhanceMarkdownTables(stableEl);
        for (const newNode of newNodes) {
          hydrateMermaid(newNode);
          hydrateMath(newNode);
        }
      }
      committedCut = toCut;
    } else if (toCut === 0 && stableEl.innerHTML !== "") {
      stableEl.innerHTML = "";
      commitCursor.reset();
      committedCut = 0;
    }
  }

  function renderTail(currentTailText: string, cursor?: HTMLElement | null): void {
    const html = render(currentTailText, {
      ...options,
      streaming: true,
      hrAdjacentBefore: stableText
    });
    if (cursor && cursor.parentNode === tailEl) {
      while (tailEl.firstChild && tailEl.firstChild !== cursor) {
        tailEl.removeChild(tailEl.firstChild);
      }
      while (cursor.nextSibling) {
        tailEl.removeChild(cursor.nextSibling);
      }
      if (html) {
        const doc = tailEl.ownerDocument || (typeof document !== "undefined" ? document : null);
        if (doc) {
          const temp = doc.createElement("div");
          temp.innerHTML = html;
          while (temp.firstChild) {
            tailEl.insertBefore(temp.firstChild, cursor);
          }
        }
      }
    } else {
      tailEl.innerHTML = html;
      if (cursor) {
        tailEl.appendChild(cursor);
      }
    }
    enhanceMarkdownCodeBlocks(tailEl);
    enhanceMarkdownTables(tailEl);
  }

  function flush(
    deltaOrOptions?: string | MarkdownStreamFlushOptions,
    maybeOptions?: MarkdownStreamFlushOptions
  ): void | Promise<void> {
    let delta = "";
    let opts: MarkdownStreamFlushOptions | undefined;
    if (typeof deltaOrOptions === "string") {
      delta = deltaOrOptions;
      opts = maybeOptions;
    } else if (deltaOrOptions) {
      opts = deltaOrOptions;
    }

    if (delta) {
      push(delta);
    }

    const lines = stripCursor.lines;
    tailCursor.update(lines);
    const cut = tailCursor.cut;
    const stableChanged = !(cut >= 0 && cut === stableCut);
    if (stableChanged) {
      stableText = cut < 0 ? "" : lines.slice(0, cut).join("\n");
    }
    tailText = (cut < 0 ? lines.join("\n") : lines.slice(cut).join("\n")).trimEnd();

    const needStableCommit = stableChanged && (stableText !== "" || stableEl.innerHTML !== "");
    const toCut = cut < 0 ? 0 : cut;
    const fromCut = committedCut < 0 ? 0 : committedCut;

    if (needStableCommit) {
      if (opts?.shouldYield?.()) {
        return (async () => {
          await opts.yieldToMain?.();
          if (opts?.isStale?.()) {
            return;
          }
          commitStable(toCut, fromCut, lines, tailText);
          stableCut = cut;
          if (opts?.shouldYield?.()) {
            await opts.yieldToMain?.();
            if (opts?.isStale?.()) {
              return;
            }
          }
          renderTail(tailText, opts?.cursor);
        })();
      }
      commitStable(toCut, fromCut, lines, tailText);
      stableCut = cut;
    }

    if (opts?.shouldYield?.()) {
      return (async () => {
        await opts.yieldToMain?.();
        if (opts?.isStale?.()) {
          return;
        }
        renderTail(tailText, opts?.cursor);
      })();
    }

    renderTail(tailText, opts?.cursor);
  }

  function reset(): void {
    rawText = "";
    stableText = "";
    tailText = "";
    stableCut = -2;
    committedCut = 0;
    stableEl.innerHTML = "";
    tailEl.innerHTML = "";
    stripCursor = createThinkStripCursor();
    tailCursor = createMarkdownTailCursor();
    commitCursor.reset();
  }

  return {
    get rawText() {
      return rawText;
    },
    get strippedText() {
      return stripCursor.lines.join("\n").trimEnd();
    },
    get stableText() {
      return stableText;
    },
    get tailText() {
      return tailText;
    },
    get stableCut() {
      return stableCut;
    },
    get committedCut() {
      return committedCut;
    },
    get stableEl() {
      return stableEl;
    },
    get tailEl() {
      return tailEl;
    },
    push,
    flush,
    reset
  };
}
