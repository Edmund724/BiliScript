#!/usr/bin/env node
/**
 * 零外部运行时依赖的轻量静态文档站构建与自检脚本。
 *
 * 公开范围白名单（严守 AGENTS / .scratch / docs/agents 隔离边界）：
 *   - README.md            -> index.html
 *   - docs/guide.md        -> docs/guide.html
 *   - docs/agent-bridge.md -> docs/agent-bridge.html
 *   - docs/development.md  -> docs/development.html
 *   - PRIVACY.md           -> privacy.html
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, ".pages-dist");
const REPO_BLOB_BASE = "https://github.com/Edmund724/BiliScript/blob/main/";
const REPO_URL = "https://github.com/Edmund724/BiliScript";
const EDGE_STORE_URL =
  "https://microsoftedge.microsoft.com/addons/detail/nhjeecahklhcjknimgapihnjbeiolpmn";
const RELEASES_URL = "https://github.com/Edmund724/BiliScript/releases";

const PAGES = [
  {
    src: "README.md",
    out: "index.html",
    navTitle: "概览与快速开始",
    group: "使用指南",
    description: "BiliScript 浏览器扩展功能概览、安装方式与快速上手指南。"
  },
  {
    src: "docs/guide.md",
    out: "docs/guide.html",
    navTitle: "配置与排障指南",
    group: "使用指南",
    description: "支持平台清单、ASR 语音识别模型对比、联网搜索、实时伴看与常见问题排障。"
  },
  {
    src: "docs/agent-bridge.md",
    out: "docs/agent-bridge.html",
    navTitle: "本地 Agent 桥接指南",
    group: "使用指南",
    description: "通过本机 WebSocket 桥接供编程 Agent 读取 B 站视频字幕、热评与关键帧。"
  },
  {
    src: "docs/development.md",
    out: "docs/development.html",
    navTitle: "开发与架构指南",
    group: "开发与隐私",
    description: "BiliScript 扩展构建命令、目录结构、评测基准与架构文档索引。"
  },
  {
    src: "PRIVACY.md",
    out: "privacy.html",
    navTitle: "隐私政策",
    group: "开发与隐私",
    description: "BiliScript 扩展权限逐项说明、数据去向与本地存储隔离策略。"
  }
];

const ROUTE_BY_SRC = new Map(PAGES.map((p) => [p.src, p.out]));

const FORBIDDEN_PATHS = [
  "docs/agents/",
  "AGENTS.md",
  ".scratch/",
  "docs/adr/",
  "docs/UX_AUDIT_",
  "docs/state-contract.md"
];

function parseBasePath() {
  const arg = process.argv.find((item) => item.startsWith("--base="));
  const raw = arg ? arg.slice("--base=".length) : process.env.DOCS_BASE_PATH || "/BiliScript/";
  let normalized = raw.trim() || "/";
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  if (!normalized.endsWith("/")) normalized = `${normalized}/`;
  return normalized;
}

const BASE_PATH = parseBasePath();

function siteUrl(outRelPath) {
  return outRelPath === "index.html" ? BASE_PATH : `${BASE_PATH}${outRelPath}`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(text) {
  return escapeHtml(text);
}

function slugify(rawText, usedSlugs) {
  const plain = rawText
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim()
    .toLowerCase();
  let base = plain
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!base) base = "section";
  const count = usedSlugs.get(base) || 0;
  usedSlugs.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function stripInlineFormattingForText(raw) {
  return raw
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*([^\n*]+?)\*\*/g, "$1")
    .replace(/~~([^\n~]+?)~~/g, "$1")
    .trim();
}

/**
 * 将相对资源/文档链接解析为目标站点路由或 GitHub 源文件路径。
 * 严禁把未公开的内部路径静默打包进站点。
 */
function resolveRepoLink(rawUrl, fromSrcRel, referencedAssets, kind) {
  const trimmed = rawUrl.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("data:")
  ) {
    return trimmed;
  }

  const hashIdx = trimmed.indexOf("#");
  const queryIdx = trimmed.indexOf("?");
  let splitIdx = -1;
  if (hashIdx >= 0 && queryIdx >= 0) splitIdx = Math.min(hashIdx, queryIdx);
  else splitIdx = Math.max(hashIdx, queryIdx);

  const rawPath = splitIdx >= 0 ? trimmed.slice(0, splitIdx) : trimmed;
  const suffix = splitIdx >= 0 ? trimmed.slice(splitIdx) : "";

  if (!rawPath) return trimmed;

  const fromDir = path.posix.dirname(fromSrcRel);
  const resolved = path.posix.normalize(
    fromDir === "." ? rawPath : path.posix.join(fromDir, rawPath)
  );

  // 已发布的公开文档 -> 映射为 /BiliScript/<route>
  if (ROUTE_BY_SRC.has(resolved)) {
    return `${siteUrl(ROUTE_BY_SRC.get(resolved))}${suffix}`;
  }

  // 静态图片资源（仅允许 docs/images/**）
  if (kind === "img" || resolved.startsWith("docs/images/")) {
    const absAsset = path.join(ROOT, resolved);
    if (!fs.existsSync(absAsset) || fs.statSync(absAsset).isDirectory()) {
      throw new Error(`Missing static image referenced in ${fromSrcRel}: ${rawUrl} -> ${resolved}`);
    }
    referencedAssets.add(resolved);
    return `${BASE_PATH}${resolved}${suffix}`;
  }

  // 未列入公开站点白名单的仓库文件（如 AGENTS.md、GLOSSARY.md、LICENSE、docs/adr/README.md）
  // 统一重写为 GitHub 仓库 blob 链接，既不断链也不泄露内部文档进站点产物。
  const absTarget = path.join(ROOT, resolved);
  if (fs.existsSync(absTarget)) {
    return `${REPO_BLOB_BASE}${resolved}${suffix}`;
  }

  throw new Error(`Broken relative link in ${fromSrcRel}: ${rawUrl} -> ${resolved}`);
}

function rewriteRawHtmlAttributes(html, fromSrcRel, referencedAssets) {
  return html.replace(/\b(href|src)=("([^"]*)"|'([^']*)')/gi, (full, attr, quoted, dq, sq) => {
    const val = dq !== undefined ? dq : sq;
    const kind = attr.toLowerCase() === "src" ? "img" : "link";
    const rewritten = resolveRepoLink(val, fromSrcRel, referencedAssets, kind);
    return `${attr}="${escapeAttr(rewritten)}"`;
  });
}

function splitMarkdownLinkTarget(text, startIdx) {
  // startIdx 指向 '[' 之后，先找匹配的 ']'，再找 '(...)'（支持括号内一层嵌套或尖括号）
  let depth = 1;
  let i = startIdx;
  let inCode = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      i += 1;
      continue;
    }
    if (!inCode) {
      if (ch === "[") depth += 1;
      else if (ch === "]") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    i += 1;
  }
  if (depth !== 0 || text[i + 1] !== "(") return null;

  const label = text.slice(startIdx, i);
  let j = i + 2;
  let parenDepth = 1;
  while (j < text.length && parenDepth > 0) {
    if (text[j] === "\\" && j + 1 < text.length) {
      j += 2;
      continue;
    }
    if (text[j] === "(") parenDepth += 1;
    else if (text[j] === ")") parenDepth -= 1;
    if (parenDepth === 0) break;
    j += 1;
  }
  if (parenDepth !== 0) return null;

  let rawTarget = text.slice(i + 2, j).trim();
  let title = "";
  const titleMatch = rawTarget.match(/^(\S+)\s+["']([^"']*)["']$/);
  if (titleMatch) {
    rawTarget = titleMatch[1];
    title = titleMatch[2];
  }
  if (rawTarget.startsWith("<") && rawTarget.endsWith(">")) {
    rawTarget = rawTarget.slice(1, -1);
  }
  return { label, href: rawTarget, title, endIdx: j + 1 };
}

function renderInline(text, ctx) {
  if (!text) return "";

  // 1. 提取行内代码段与行内 HTML 标签（<br>, <code>, <a>, <img> 等）避免被后续强调规则破坏
  const tokens = [];
  const stash = (html) => {
    const id = `\u0000TOK_${tokens.length}\u0000`;
    tokens.push(html);
    return id;
  };

  let out = "";
  for (let i = 0; i < text.length; ) {
    const ch = text[i];

    // 反斜杠转义
    if (ch === "\\" && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|>~]/.test(text[i + 1])) {
      out += stash(escapeHtml(text[i + 1]));
      i += 2;
      continue;
    }

    // 行内代码 `...` 或 ``...``
    if (ch === "`") {
      let tickLen = 1;
      while (text[i + tickLen] === "`") tickLen += 1;
      const fence = "`".repeat(tickLen);
      const closeIdx = text.indexOf(fence, i + tickLen);
      if (closeIdx !== -1) {
        let code = text.slice(i + tickLen, closeIdx);
        if (code.length >= 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) {
          code = code.slice(1, -1);
        }
        out += stash(`<code>${escapeHtml(code)}</code>`);
        i = closeIdx + tickLen;
        continue;
      }
    }

    // 图片 ![alt](src)
    if (ch === "!" && text[i + 1] === "[") {
      const parsed = splitMarkdownLinkTarget(text, i + 2);
      if (parsed) {
        const src = resolveRepoLink(parsed.href, ctx.srcRel, ctx.referencedAssets, "img");
        const titleAttr = parsed.title ? ` title="${escapeAttr(parsed.title)}"` : "";
        out += stash(
          `<img src="${escapeAttr(src)}" alt="${escapeAttr(parsed.label)}" loading="lazy"${titleAttr} />`
        );
        i = parsed.endIdx;
        continue;
      }
    }

    // 链接 [label](href)
    if (ch === "[") {
      const parsed = splitMarkdownLinkTarget(text, i + 1);
      if (parsed) {
        const href = resolveRepoLink(parsed.href, ctx.srcRel, ctx.referencedAssets, "link");
        const titleAttr = parsed.title ? ` title="${escapeAttr(parsed.title)}"` : "";
        const isExternal = /^https?:\/\//i.test(href);
        const relAttr = isExternal ? ` target="_blank" rel="noopener noreferrer"` : "";
        const innerHtml = renderInline(parsed.label, ctx);
        out += stash(`<a href="${escapeAttr(href)}"${titleAttr}${relAttr}>${innerHtml}</a>`);
        i = parsed.endIdx;
        continue;
      }
    }

    // 尖括号自动链接 <https://...>
    if (ch === "<") {
      const autoMatch = text.slice(i).match(/^<(https?:\/\/[^>\s]+)>/i);
      if (autoMatch) {
        const href = autoMatch[1];
        out += stash(
          `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a>`
        );
        i += autoMatch[0].length;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  // 2. 转义剩余纯文本中的 HTML 特殊字符
  out = escapeHtml(out);

  // 3. 裸 URL 自动链接（排除占位符附近和已被转义的末尾标点）
  out = out.replace(/(^|[\s(（：:])(https?:\/\/[^\s<>"')）\]]+)/g, (full, prefix, url) => {
    let cleanUrl = url;
    let trailing = "";
    while (/[.,;:!?。，；：！？]$/.test(cleanUrl)) {
      trailing = cleanUrl.slice(-1) + trailing;
      cleanUrl = cleanUrl.slice(0, -1);
    }
    return `${prefix}<a href="${escapeAttr(cleanUrl)}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a>${trailing}`;
  });

  // 4. 删除线 / 粗斜体 / 粗体 / 斜体（仅匹配不跨空白边界的常见用法，避免误伤 snake_case）
  out = out.replace(/~~([^\n~]+?)~~/g, "<del>$1</del>");
  out = out.replace(/\*\*\*([^\n*]+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  out = out.replace(/\*\*([^\n*]+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^\w*])\*([^\s*][^\n*]*?[^\s*]|[^\s*])\*(?!\*)/g, "$1<em>$2</em>");

  // 5. 还原占位符
  out = out.replace(/\u0000TOK_(\d+)\u0000/g, (_, idx) => tokens[Number(idx)]);
  return out;
}

function parseTableSeparator(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  let cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const c = cell.trim();
    if (!/^:?-{3,}:?$/.test(c)) return null;
    if (c.startsWith(":") && c.endsWith(":")) aligns.push("center");
    else if (c.endsWith(":")) aligns.push("right");
    else aligns.push("left");
  }
  return aligns;
}

function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "\\" && i + 1 < trimmed.length && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function renderCodeBlock(lang, codeText) {
  const normalizedLang = lang.trim().toLowerCase();
  const displayLang = normalizedLang || "text";
  const escapedCode = escapeHtml(codeText.replace(/\n$/, ""));
  return [
    `<div class="code-block" data-lang="${escapeAttr(displayLang)}">`,
    `  <div class="code-toolbar">`,
    `    <span class="code-lang">${escapeHtml(displayLang)}</span>`,
    `    <button type="button" class="copy-btn" aria-label="复制代码">复制</button>`,
    `  </div>`,
    `  <pre><code class="language-${escapeAttr(displayLang)}">${escapedCode}</code></pre>`,
    `</div>`
  ].join("\n");
}

const ALERT_META = {
  NOTE: { label: "提示", cls: "note" },
  TIP: { label: "建议", cls: "tip" },
  IMPORTANT: { label: "重要", cls: "important" },
  WARNING: { label: "注意", cls: "warning" },
  CAUTION: { label: "警告", cls: "caution" }
};

function renderMarkdownBlocks(markdown, ctx) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const htmlParts = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // <details> 块（保留标签与 <summary>，内部 Markdown 递归渲染）
    if (/^\s*<details\b[^>]*>\s*$/i.test(line)) {
      const openTag = line.trim();
      i += 1;
      let summaryHtml = "";
      if (i < lines.length && /^\s*<summary\b[^>]*>.*<\/summary>\s*$/i.test(lines[i])) {
        summaryHtml = lines[i].trim();
        i += 1;
      }
      const innerLines = [];
      while (i < lines.length && !/^\s*<\/details>\s*$/i.test(lines[i])) {
        innerLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && /^\s*<\/details>\s*$/i.test(lines[i])) {
        i += 1;
      }
      const innerHtml = renderMarkdownBlocks(innerLines.join("\n"), ctx);
      htmlParts.push(`${openTag}\n${summaryHtml}\n<div class="details-body">\n${innerHtml}\n</div>\n</details>`);
      continue;
    }

    // 原始 HTML 块（如 README.md 的居中 Hero <div>）
    const htmlBlockMatch = line.match(/^\s*<(div|p|section|header|footer|figure|table|blockquote)\b[^>]*>/i);
    if (htmlBlockMatch) {
      const tag = htmlBlockMatch[1].toLowerCase();
      const rawLines = [line];
      const selfClosingOrInline = new RegExp(`</${tag}>\\s*$`, "i");
      if (!selfClosingOrInline.test(line)) {
        let depth = 1;
        const openRe = new RegExp(`<${tag}\\b`, "gi");
        const closeRe = new RegExp(`</${tag}>`, "gi");
        i += 1;
        while (i < lines.length && depth > 0) {
          const cur = lines[i];
          rawLines.push(cur);
          const opens = (cur.match(openRe) || []).length;
          const closes = (cur.match(closeRe) || []).length;
          depth += opens - closes;
          i += 1;
        }
      } else {
        i += 1;
      }
      const rawHtml = rewriteRawHtmlAttributes(rawLines.join("\n"), ctx.srcRel, ctx.referencedAssets);
      // 若原始 HTML 块内含 <h1>，同步记录页面标题
      if (!ctx.pageTitle) {
        const h1Match = rawHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        if (h1Match) ctx.pageTitle = h1Match[1].replace(/<[^>]+>/g, "").trim();
      }
      htmlParts.push(`<div class="md-html-block">\n${rawHtml}\n</div>`);
      continue;
    }

    // 围栏代码块 ```lang
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const fenceChar = fenceMatch[1][0];
      const fenceLen = fenceMatch[1].length;
      const lang = fenceMatch[2].trim();
      const codeLines = [];
      i += 1;
      const closeRe = new RegExp(`^ {0,3}${fenceChar}{${fenceLen},}\\s*$`);
      while (i < lines.length && !closeRe.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      htmlParts.push(renderCodeBlock(lang, codeLines.join("\n")));
      continue;
    }

    // 标题 # ... ######
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const rawHeading = headingMatch[2].trim();
      const plainText = stripInlineFormattingForText(rawHeading);
      const id = slugify(rawHeading, ctx.usedSlugs);
      if (level === 1 && !ctx.pageTitle) {
        ctx.pageTitle = plainText;
      }
      if (level === 2 || level === 3) {
        ctx.headings.push({ level, id, text: plainText });
      }
      const inner = renderInline(rawHeading, ctx);
      const anchor = level >= 2 ? `<a class="heading-anchor" href="#${escapeAttr(id)}" aria-label="本节链接">#</a>` : "";
      htmlParts.push(`<h${level} id="${escapeAttr(id)}">${inner}${anchor}</h${level}>`);
      i += 1;
      continue;
    }

    // 分隔线 ---
    if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$/.test(line)) {
      htmlParts.push("<hr />");
      i += 1;
      continue;
    }

    // GFM 表格（当前行含 | 且下一行是分隔行）
    if (line.includes("|") && i + 1 < lines.length) {
      const aligns = parseTableSeparator(lines[i + 1]);
      if (aligns) {
        const headers = splitTableRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
          rows.push(splitTableRow(lines[i]));
          i += 1;
        }
        const thead = headers
          .map((cell, idx) => {
            const align = aligns[idx] ? ` style="text-align:${aligns[idx]}"` : "";
            return `<th scope="col"${align}>${renderInline(cell, ctx)}</th>`;
          })
          .join("");
        const tbody = rows
          .map((row) => {
            const tds = aligns
              .map((align, idx) => {
                const cell = row[idx] ?? "";
                const style = align ? ` style="text-align:${align}"` : "";
                return `<td${style}>${renderInline(cell, ctx)}</td>`;
              })
              .join("");
            return `<tr>${tds}</tr>`;
          })
          .join("\n");
        htmlParts.push(
          `<div class="table-wrapper" tabindex="0" role="region" aria-label="数据表格">\n<table>\n<thead><tr>${thead}</tr></thead>\n<tbody>\n${tbody}\n</tbody>\n</table>\n</div>`
        );
        continue;
      }
    }

    // 引用块 / GitHub Alert (> [!NOTE])
    if (/^\s*>/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      const alertMatch = quoteLines[0]?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i);
      if (alertMatch) {
        const kind = alertMatch[1].toUpperCase();
        const meta = ALERT_META[kind] || ALERT_META.NOTE;
        const bodyHtml = renderMarkdownBlocks(quoteLines.slice(1).join("\n"), ctx);
        htmlParts.push(
          `<div class="callout callout-${meta.cls}" role="note">\n<div class="callout-title">${meta.label}</div>\n<div class="callout-body">${bodyHtml}</div>\n</div>`
        );
      } else {
        const bodyHtml = renderMarkdownBlocks(quoteLines.join("\n"), ctx);
        htmlParts.push(`<blockquote>\n${bodyHtml}\n</blockquote>`);
      }
      continue;
    }

    // 列表（无序 - / * 与有序 1.）— 支持含空行与缩进代码块的列表项
    const ulMatch = line.match(/^(\s*)([-*])\s+(.*)$/);
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (ulMatch || olMatch) {
      const isOrdered = Boolean(olMatch);
      const baseIndent = (ulMatch || olMatch)[1].length;
      const listTag = isOrdered ? "ol" : "ul";
      const items = [];

      const itemStartRe = isOrdered
        ? new RegExp(`^ {0,${baseIndent + 1}}\\d+\\.\\s+(.*)$`)
        : new RegExp(`^ {0,${baseIndent + 1}}[-*]\\s+(.*)$`);
      const otherListRe = isOrdered ? /^(\s*)([-*])\s+/ : /^(\s*)(\d+)\.\s+/;

      while (i < lines.length) {
        const cur = lines[i];
        const startMatch = cur.match(itemStartRe);
        if (!startMatch) break;

        const itemLines = [startMatch[1]];
        i += 1;
        while (i < lines.length) {
          const next = lines[i];
          if (!next.trim()) {
            // 仅当下一非空行是缩进续行（如列表内缩进代码块）或同级列表项时继续
            let lookahead = i + 1;
            while (lookahead < lines.length && !lines[lookahead].trim()) lookahead += 1;
            if (
              lookahead < lines.length &&
              (/^\s{2,}/.test(lines[lookahead]) || itemStartRe.test(lines[lookahead]))
            ) {
              if (itemStartRe.test(lines[lookahead])) {
                i = lookahead;
                break;
              }
              itemLines.push("");
              i += 1;
              continue;
            }
            break;
          }
          if (itemStartRe.test(next)) break;
          if (otherListRe.test(next) && next.match(/^(\s*)/)[1].length <= baseIndent) break;
          if (/^(#{1,6}\s+|```|~~~|>|<div\b|<details\b)/i.test(next.trim()) && !/^\s{2,}/.test(next)) {
            break;
          }
          // 剥离列表项公共缩进（通常 2~4 空格）
          const stripped = next.replace(/^ {1,4}/, "");
          itemLines.push(stripped);
          i += 1;
        }
        items.push(itemLines);
      }

      const renderedItems = items
        .map((itemLines) => {
          const text = itemLines.join("\n");
          const hasBlockChildren = /(^|\n)\s*(```|~~~|[-*]\s+|\d+\.\s+|>\s+)|\n\s*\n/.test(text);
          if (hasBlockChildren) {
            return `<li>\n${renderMarkdownBlocks(text, ctx)}\n</li>`;
          }
          return `<li>${renderInline(itemLines.join(" ").trim(), ctx)}</li>`;
        })
        .join("\n");
      htmlParts.push(`<${listTag}>\n${renderedItems}\n</${listTag}>`);
      continue;
    }

    // 普通段落
    const paraLines = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (
        !cur.trim() ||
        /^(#{1,6}\s+|```|~~~|\s*>|\s*[-*]\s+|\s*\d+\.\s+|\s*(?:-\s*){3,}$|\s*<(?:div|details|p|section|table)\b)/i.test(
          cur
        )
      ) {
        break;
      }
      if (cur.includes("|") && i + 1 < lines.length && parseTableSeparator(lines[i + 1])) {
        break;
      }
      paraLines.push(cur.trim());
      i += 1;
    }
    if (paraLines.length > 0) {
      htmlParts.push(`<p>${renderInline(paraLines.join(" "), ctx)}</p>`);
    } else {
      // 防呆推进
      htmlParts.push(`<p>${renderInline(line, ctx)}</p>`);
      i += 1;
    }
  }

  return htmlParts.join("\n");
}

function renderSidebarNav(currentOut) {
  const groups = new Map();
  for (const page of PAGES) {
    if (!groups.has(page.group)) groups.set(page.group, []);
    groups.get(page.group).push(page);
  }

  const sections = [];
  for (const [groupTitle, groupPages] of groups.entries()) {
    const links = groupPages
      .map((page) => {
        const isCurrent = page.out === currentOut;
        const currentAttr = isCurrent ? ' aria-current="page"' : "";
        return `<li><a href="${escapeAttr(siteUrl(page.out))}"${currentAttr}>${escapeHtml(page.navTitle)}</a></li>`;
      })
      .join("\n");
    sections.push(
      `<div class="nav-group">\n  <div class="nav-group-title">${escapeHtml(groupTitle)}</div>\n  <ul>\n${links}\n  </ul>\n</div>`
    );
  }
  return sections.join("\n");
}

function renderToc(headings) {
  if (!headings || headings.length === 0) return "";
  const items = headings
    .map(
      (h) =>
        `<li class="toc-level-${h.level}"><a href="#${escapeAttr(h.id)}">${escapeHtml(h.text)}</a></li>`
    )
    .join("\n");
  return [
    `<aside class="toc-rail" aria-label="本页目录">`,
    `  <div class="toc-sticky">`,
    `    <div class="toc-title">本页目录</div>`,
    `    <nav class="toc-nav">`,
    `      <ul>`,
    items,
    `      </ul>`,
    `    </nav>`,
    `  </div>`,
    `</aside>`
  ].join("\n");
}

function renderPager(currentIndex) {
  const prev = currentIndex > 0 ? PAGES[currentIndex - 1] : null;
  const next = currentIndex < PAGES.length - 1 ? PAGES[currentIndex + 1] : null;
  if (!prev && !next) return "";
  const prevHtml = prev
    ? `<a class="pager-link pager-prev" href="${escapeAttr(siteUrl(prev.out))}"><span class="pager-dir">上一篇</span><span class="pager-title">${escapeHtml(prev.navTitle)}</span></a>`
    : `<span></span>`;
  const nextHtml = next
    ? `<a class="pager-link pager-next" href="${escapeAttr(siteUrl(next.out))}"><span class="pager-dir">下一篇</span><span class="pager-title">${escapeHtml(next.navTitle)}</span></a>`
    : `<span></span>`;
  return `<nav class="doc-pager" aria-label="上下篇导航">\n${prevHtml}\n${nextHtml}\n</nav>`;
}

function renderHtmlShell({ page, pageIndex, version, title, bodyHtml, headings }) {
  const fullTitle = page.out === "index.html" ? title : `${title} · BiliScript 文档`;
  const logoUrl = `${BASE_PATH}docs/images/biliscript-logo.svg`;
  const cssUrl = `${BASE_PATH}assets/docs.css`;
  const jsUrl = `${BASE_PATH}assets/docs.js`;
  const homeUrl = siteUrl("index.html");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <script>
    try {
      var saved = localStorage.getItem("biliscript-docs-theme");
      if (saved === "light" || saved === "dark") {
        document.querySelector('meta[name="color-scheme"]').setAttribute("content", saved);
      }
    } catch (_) {}
  </script>
  <title>${escapeHtml(fullTitle)}</title>
  <meta name="description" content="${escapeAttr(page.description)}" />
  <link rel="icon" type="image/svg+xml" href="${escapeAttr(logoUrl)}" />
  <link rel="stylesheet" href="${escapeAttr(cssUrl)}" />
</head>
<body>
  <a class="skip-link" href="#main-content">跳至正文</a>

  <header class="mobile-header">
    <button type="button" class="nav-toggle" aria-expanded="false" aria-controls="site-sidebar" aria-label="打开导航菜单">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <line x1="3" y1="6" x2="21" y2="6"></line>
        <line x1="3" y1="12" x2="21" y2="12"></line>
        <line x1="3" y1="18" x2="21" y2="18"></line>
      </svg>
    </button>
    <a class="mobile-brand" href="${escapeAttr(homeUrl)}">
      <img src="${escapeAttr(logoUrl)}" width="22" height="22" alt="" />
      <span>BiliScript 文档</span>
    </a>
    <button type="button" class="theme-toggle" data-theme-toggle aria-label="切换深浅色主题" title="切换深浅色主题">
      <span class="theme-icon-sun" aria-hidden="true">☀️</span>
      <span class="theme-icon-moon" aria-hidden="true">🌙</span>
    </button>
  </header>

  <div class="sidebar-backdrop" hidden></div>

  <div class="docs-shell">
    <aside id="site-sidebar" class="sidebar" aria-label="文档导航">
      <div class="sidebar-header">
        <a class="brand" href="${escapeAttr(homeUrl)}">
          <img src="${escapeAttr(logoUrl)}" width="28" height="28" alt="BiliScript" />
          <div class="brand-text">
            <span class="brand-name">BiliScript</span>
            <span class="brand-version">v${escapeHtml(version)}</span>
          </div>
        </a>
        <button type="button" class="theme-toggle desktop-theme-toggle" data-theme-toggle aria-label="切换深浅色主题" title="切换深浅色主题">
          <span class="theme-icon-sun" aria-hidden="true">☀️</span>
          <span class="theme-icon-moon" aria-hidden="true">🌙</span>
        </button>
      </div>

      <nav class="sidebar-nav" aria-label="文档目录">
        ${renderSidebarNav(page.out)}
      </nav>

      <div class="sidebar-footer">
        <a href="${escapeAttr(EDGE_STORE_URL)}" target="_blank" rel="noopener noreferrer">Edge 应用市场</a>
        <a href="${escapeAttr(RELEASES_URL)}" target="_blank" rel="noopener noreferrer">GitHub Releases</a>
        <a href="${escapeAttr(REPO_URL)}" target="_blank" rel="noopener noreferrer">GitHub 源码</a>
      </div>
    </aside>

    <main id="main-content" class="doc-main">
      <article class="markdown-body">
        ${bodyHtml}
      </article>
      ${renderPager(pageIndex)}
      <footer class="doc-footer">
        <span>BiliScript 开源浏览器扩展 · MIT License</span>
        <a href="${escapeAttr(`${REPO_BLOB_BASE}${page.src}`)}" target="_blank" rel="noopener noreferrer">在 GitHub 上查看本页源码</a>
      </footer>
    </main>

    ${renderToc(headings)}
  </div>

  <script src="${escapeAttr(jsUrl)}" defer></script>
</body>
</html>
`;
}

const DOCS_CSS = `:root {
  color-scheme: light dark;

  --bg-page-light: #ffffff;
  --bg-page-dark: #0f1117;
  --bg-sidebar-light: #f8f9fb;
  --bg-sidebar-dark: #141720;
  --bg-surface-light: #f3f5f8;
  --bg-surface-dark: #1b1f2b;
  --bg-code-light: #f6f8fa;
  --bg-code-dark: #161b26;
  --text-primary-light: #181c25;
  --text-primary-dark: #e8ecf4;
  --text-muted-light: #5a6475;
  --text-muted-dark: #97a3b6;
  --border-light: #e3e8ef;
  --border-dark: #272d3d;
  --accent-light: #e14776;
  --accent-dark: #ff7ba3;
  --accent-soft-light: rgba(225, 71, 118, 0.1);
  --accent-soft-dark: rgba(255, 123, 163, 0.14);

  --bg-page: var(--bg-page-light);
  --bg-sidebar: var(--bg-sidebar-light);
  --bg-surface: var(--bg-surface-light);
  --bg-code: var(--bg-code-light);
  --text-primary: var(--text-primary-light);
  --text-muted: var(--text-muted-light);
  --border: var(--border-light);
  --accent: var(--accent-light);
  --accent-soft: var(--accent-soft-light);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg-page: var(--bg-page-dark);
    --bg-sidebar: var(--bg-sidebar-dark);
    --bg-surface: var(--bg-surface-dark);
    --bg-code: var(--bg-code-dark);
    --text-primary: var(--text-primary-dark);
    --text-muted: var(--text-muted-dark);
    --border: var(--border-dark);
    --accent: var(--accent-dark);
    --accent-soft: var(--accent-soft-dark);
  }
}

@supports (color: light-dark(white, black)) {
  :root {
    --bg-page: light-dark(var(--bg-page-light), var(--bg-page-dark));
    --bg-sidebar: light-dark(var(--bg-sidebar-light), var(--bg-sidebar-dark));
    --bg-surface: light-dark(var(--bg-surface-light), var(--bg-surface-dark));
    --bg-code: light-dark(var(--bg-code-light), var(--bg-code-dark));
    --text-primary: light-dark(var(--text-primary-light), var(--text-primary-dark));
    --text-muted: light-dark(var(--text-muted-light), var(--text-muted-dark));
    --border: light-dark(var(--border-light), var(--border-dark));
    --accent: light-dark(var(--accent-light), var(--accent-dark));
    --accent-soft: light-dark(var(--accent-soft-light), var(--accent-soft-dark));
  }
}

:root:has(> head > meta[name="color-scheme"][content="dark"]) {
  color-scheme: dark;
  --bg-page: var(--bg-page-dark);
  --bg-sidebar: var(--bg-sidebar-dark);
  --bg-surface: var(--bg-surface-dark);
  --bg-code: var(--bg-code-dark);
  --text-primary: var(--text-primary-dark);
  --text-muted: var(--text-muted-dark);
  --border: var(--border-dark);
  --accent: var(--accent-dark);
  --accent-soft: var(--accent-soft-dark);
}

:root:has(> head > meta[name="color-scheme"][content="light"]) {
  color-scheme: light;
  --bg-page: var(--bg-page-light);
  --bg-sidebar: var(--bg-sidebar-light);
  --bg-surface: var(--bg-surface-light);
  --bg-code: var(--bg-code-light);
  --text-primary: var(--text-primary-light);
  --text-muted: var(--text-muted-light);
  --border: var(--border-light);
  --accent: var(--accent-light);
  --accent-soft: var(--accent-soft-light);
}

*, *::before, *::after {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
  scroll-padding-top: 4.5rem;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 16px;
  line-height: 1.72;
  color: var(--text-primary);
  background: var(--bg-page);
  -webkit-font-smoothing: antialiased;
}

.skip-link {
  position: fixed;
  left: -9999px;
  top: 0.75rem;
  z-index: 100;
  padding: 0.5rem 0.875rem;
  border-radius: 0.5rem;
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  text-decoration: none;
}

.skip-link:focus {
  left: 0.75rem;
}

.mobile-header {
  display: none;
  position: sticky;
  top: 0;
  z-index: 30;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  height: 3.5rem;
  padding: 0 1rem;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border);
}

.mobile-brand {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--text-primary);
  font-weight: 700;
  text-decoration: none;
}

.nav-toggle,
.theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-page);
  color: var(--text-primary);
  cursor: pointer;
}

.nav-toggle:hover,
.theme-toggle:hover {
  border-color: var(--accent);
}

.theme-icon-sun { display: none; }
.theme-icon-moon { display: inline; }

@media (prefers-color-scheme: dark) {
  .theme-icon-sun { display: inline; }
  .theme-icon-moon { display: none; }
}

:root:has(> head > meta[name="color-scheme"][content="dark"]) .theme-icon-sun { display: inline; }
:root:has(> head > meta[name="color-scheme"][content="dark"]) .theme-icon-moon { display: none; }
:root:has(> head > meta[name="color-scheme"][content="light"]) .theme-icon-sun { display: none; }
:root:has(> head > meta[name="color-scheme"][content="light"]) .theme-icon-moon { display: inline; }

.docs-shell {
  display: grid;
  grid-template-columns: 268px minmax(0, 1fr) 220px;
  max-width: 1400px;
  margin: 0 auto;
  min-height: 100dvh;
}

.sidebar {
  position: sticky;
  top: 0;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  padding: 1.25rem 1rem;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border);
  overflow-y: auto;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding-bottom: 1rem;
  margin-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}

.brand {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  text-decoration: none;
  color: var(--text-primary);
}

.brand-text {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
}

.brand-name {
  font-size: 1.08rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.brand-version {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
}

.sidebar-nav {
  flex: 1 1 auto;
}

.nav-group + .nav-group {
  margin-top: 1.25rem;
}

.nav-group-title {
  padding: 0 0.6rem;
  margin-bottom: 0.4rem;
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.sidebar-nav ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.sidebar-nav a {
  display: block;
  padding: 0.45rem 0.7rem;
  border-radius: 0.5rem;
  font-size: 0.92rem;
  color: var(--text-primary);
  text-decoration: none;
  border-left: 2px solid transparent;
}

.sidebar-nav a:hover {
  background: var(--bg-surface);
}

.sidebar-nav a[aria-current="page"] {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
  border-left-color: var(--accent);
}

.sidebar-footer {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding-top: 1rem;
  margin-top: 1rem;
  border-top: 1px solid var(--border);
  font-size: 0.85rem;
}

.sidebar-footer a {
  color: var(--text-muted);
  text-decoration: none;
  padding: 0.25rem 0.5rem;
  border-radius: 0.375rem;
}

.sidebar-footer a:hover {
  color: var(--accent);
  background: var(--bg-surface);
}

.doc-main {
  min-width: 0;
  padding: 2.25rem clamp(1.25rem, 4vw, 3.25rem) 3rem;
}

.markdown-body {
  max-width: 78ch;
  margin: 0 auto;
}

.markdown-body > *:first-child {
  margin-top: 0;
}

.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4 {
  line-height: 1.32;
  font-weight: 700;
  letter-spacing: -0.015em;
  margin-top: 2rem;
  margin-bottom: 0.75rem;
}

.markdown-body h1 {
  font-size: 2rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
}

.markdown-body h2 {
  font-size: 1.45rem;
  padding-bottom: 0.35rem;
  border-bottom: 1px solid var(--border);
}

.markdown-body h3 {
  font-size: 1.15rem;
}

.heading-anchor {
  margin-left: 0.45rem;
  color: var(--text-muted);
  text-decoration: none;
  font-weight: 400;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.markdown-body h2:hover .heading-anchor,
.markdown-body h3:hover .heading-anchor,
.heading-anchor:focus-visible {
  opacity: 1;
}

.markdown-body a {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.markdown-body p,
.markdown-body ul,
.markdown-body ol,
.markdown-body blockquote,
.markdown-body details {
  margin-top: 0;
  margin-bottom: 1rem;
}

.markdown-body ul,
.markdown-body ol {
  padding-left: 1.5rem;
}

.markdown-body li + li {
  margin-top: 0.35rem;
}

.markdown-body img {
  max-width: 100%;
  height: auto;
  border-radius: 0.5rem;
}

.md-html-block {
  margin-bottom: 1.5rem;
}

.md-html-block h1 {
  border-bottom: none;
  margin-top: 0.5rem;
}

.markdown-body code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.875em;
  background: var(--bg-surface);
  padding: 0.15em 0.4em;
  border-radius: 0.35rem;
}

.code-block {
  margin: 1rem 0 1.25rem;
  border: 1px solid var(--border);
  border-radius: 0.65rem;
  background: var(--bg-code);
  overflow: hidden;
}

.code-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.35rem 0.75rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
}

.code-lang {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
}

.copy-btn {
  padding: 0.2rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: var(--bg-page);
  color: var(--text-primary);
  font-size: 0.75rem;
  cursor: pointer;
}

.copy-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.copy-btn.is-copied {
  border-color: #16a34a;
  color: #16a34a;
}

.code-block pre {
  margin: 0;
  padding: 0.9rem 1rem;
  overflow-x: auto;
  font-size: 0.875rem;
  line-height: 1.55;
}

.code-block pre code {
  background: transparent;
  padding: 0;
  font-size: inherit;
}

.markdown-body blockquote {
  padding: 0.5rem 1rem;
  border-left: 3px solid var(--accent);
  background: var(--bg-surface);
  border-radius: 0 0.5rem 0.5rem 0;
  color: var(--text-muted);
}

.markdown-body blockquote > *:last-child {
  margin-bottom: 0;
}

.callout {
  margin: 1rem 0 1.25rem;
  padding: 0.85rem 1rem;
  border-left: 4px solid var(--accent);
  border-radius: 0 0.5rem 0.5rem 0;
  background: var(--bg-surface);
}

.callout-title {
  font-weight: 700;
  font-size: 0.9rem;
  margin-bottom: 0.35rem;
  color: var(--accent);
}

.callout-body > *:last-child {
  margin-bottom: 0;
}

.markdown-body details {
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  padding: 0.75rem 1rem;
  background: var(--bg-sidebar);
}

.markdown-body summary {
  cursor: pointer;
  font-weight: 600;
}

.details-body {
  margin-top: 0.75rem;
}

.details-body > *:last-child {
  margin-bottom: 0;
}

.table-wrapper {
  width: 100%;
  overflow-x: auto;
  margin: 1rem 0 1.5rem;
  border: 1px solid var(--border);
  border-radius: 0.6rem;
}

.table-wrapper table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.92rem;
}

.table-wrapper th,
.table-wrapper td {
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

.table-wrapper th {
  background: var(--bg-surface);
  font-weight: 600;
}

.table-wrapper tbody tr:last-child td {
  border-bottom: none;
}

.table-wrapper td img {
  display: block;
  margin: 0.25rem auto;
  border: 1px solid var(--border);
}

.markdown-body hr {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 2rem 0;
}

.toc-rail {
  padding: 2.25rem 1rem 2rem 0.5rem;
}

.toc-sticky {
  position: sticky;
  top: 1.5rem;
  max-height: calc(100dvh - 3rem);
  overflow-y: auto;
  border-left: 1px solid var(--border);
  padding-left: 0.85rem;
}

.toc-title {
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  margin-bottom: 0.5rem;
}

.toc-nav ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.toc-nav li {
  margin-bottom: 0.35rem;
}

.toc-nav a {
  display: block;
  font-size: 0.84rem;
  line-height: 1.4;
  color: var(--text-muted);
  text-decoration: none;
}

.toc-nav a:hover {
  color: var(--accent);
}

.toc-level-3 {
  padding-left: 0.75rem;
  font-size: 0.8rem;
}

.doc-pager {
  max-width: 78ch;
  margin: 2.5rem auto 0;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border);
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.pager-link {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.8rem 1rem;
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  text-decoration: none;
  color: var(--text-primary);
}

.pager-link:hover {
  border-color: var(--accent);
}

.pager-next {
  text-align: right;
}

.pager-dir {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.pager-title {
  font-weight: 600;
  color: var(--accent);
}

.doc-footer {
  max-width: 78ch;
  margin: 2rem auto 0;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.5rem 1rem;
  font-size: 0.85rem;
  color: var(--text-muted);
}

.doc-footer a {
  color: var(--text-muted);
}

.doc-footer a:hover {
  color: var(--accent);
}

@media (max-width: 1180px) {
  .docs-shell {
    grid-template-columns: 256px minmax(0, 1fr);
  }
  .toc-rail {
    display: none;
  }
}

@media (max-width: 860px) {
  .mobile-header {
    display: flex;
  }
  .docs-shell {
    display: block;
  }
  .desktop-theme-toggle {
    display: none;
  }
  .sidebar {
    position: fixed;
    left: 0;
    top: 3.5rem;
    z-index: 40;
    width: min(82vw, 290px);
    height: calc(100dvh - 3.5rem);
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  .sidebar.is-open {
    transform: translateX(0);
  }
  .sidebar-backdrop:not([hidden]) {
    display: block;
    position: fixed;
    inset: 3.5rem 0 0 0;
    z-index: 35;
    background: rgba(0, 0, 0, 0.45);
  }
  .doc-pager {
    grid-template-columns: 1fr;
  }
}

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
`;

const DOCS_JS = `(() => {
  const THEME_KEY = "biliscript-docs-theme";
  const meta = document.querySelector('meta[name="color-scheme"]');

  function getEffectiveScheme() {
    const content = meta?.getAttribute("content") || "light dark";
    if (content === "light" || content === "dark") return content;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyScheme(value) {
    if (!meta) return;
    meta.setAttribute("content", value);
  }

  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const current = getEffectiveScheme();
      const target = current === "dark" ? "light" : "dark";
      const system = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      try {
        if (target === system) {
          localStorage.removeItem(THEME_KEY);
          applyScheme("light dark");
        } else {
          localStorage.setItem(THEME_KEY, target);
          applyScheme(target);
        }
      } catch (_) {
        applyScheme(target);
      }
    });
  });

  window.addEventListener("storage", (event) => {
    if (event.key !== THEME_KEY) return;
    applyScheme(event.newValue === "light" || event.newValue === "dark" ? event.newValue : "light dark");
  });

  // 移动端侧栏抽屉
  const toggleBtn = document.querySelector(".nav-toggle");
  const sidebar = document.getElementById("site-sidebar");
  const backdrop = document.querySelector(".sidebar-backdrop");

  function setDrawer(open) {
    if (!sidebar || !toggleBtn || !backdrop) return;
    sidebar.classList.toggle("is-open", open);
    toggleBtn.setAttribute("aria-expanded", String(open));
    backdrop.hidden = !open;
  }

  toggleBtn?.addEventListener("click", () => {
    setDrawer(!sidebar?.classList.contains("is-open"));
  });
  backdrop?.addEventListener("click", () => setDrawer(false));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setDrawer(false);
  });

  // 代码块一键复制
  document.querySelectorAll(".code-block").forEach((block) => {
    const btn = block.querySelector(".copy-btn");
    const code = block.querySelector("pre > code");
    if (!btn || !code) return;
    let resetTimer = null;

    btn.addEventListener("click", async () => {
      const text = code.textContent || "";
      let ok = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          ok = true;
        }
      } catch (_) {}

      if (!ok) {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        ta.remove();
      }

      if (ok) {
        btn.textContent = "已复制";
        btn.classList.add("is-copied");
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          btn.textContent = "复制";
          btn.classList.remove("is-copied");
        }, 1800);
      }
    });
  });
})();
`;

function collectFilesRecursive(dir, baseDir = dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectFilesRecursive(full, baseDir));
    else results.push(path.relative(baseDir, full).split(path.sep).join("/"));
  }
  return results;
}

function verifyBuiltSite(outDir) {
  const files = collectFilesRecursive(outDir);
  const errors = [];

  // 1. 必需页面与 .nojekyll 存在性校验
  for (const page of PAGES) {
    if (!files.includes(page.out)) {
      errors.push(`Missing generated page: ${page.out}`);
    }
  }
  if (!files.includes(".nojekyll")) {
    errors.push("Missing .nojekyll in output root");
  }

  // 2. 隔离校验：绝对不能出现 docs/agents/、AGENTS.md、.scratch/ 等内部文件
  for (const rel of files) {
    if (FORBIDDEN_PATHS.some((bad) => rel.includes(bad) || rel === bad)) {
      errors.push(`Forbidden internal file leaked into site output: ${rel}`);
    }
  }

  // 3. 逐页检查死链、图片路径、未转换 .md 链接以及禁止泄露的内部路径引用
  const htmlFiles = files.filter((f) => f.endsWith(".html"));
  for (const htmlRel of htmlFiles) {
    const htmlPath = path.join(outDir, htmlRel);
    const content = fs.readFileSync(htmlPath, "utf8");

    if (/docs\/agents\/|\.scratch\//i.test(content)) {
      errors.push(`Forbidden internal reference found in ${htmlRel}`);
    }

    for (const match of content.matchAll(/\b(?:href|src)="([^"]*)"/gi)) {
      const target = match[1];
      if (!target || target.startsWith("#") || target.startsWith("data:") || target.startsWith("mailto:")) {
        continue;
      }
      if (/^https?:\/\//i.test(target)) {
        continue;
      }

      const cleanTarget = target.split("#")[0].split("?")[0];
      let resolvedRel;
      if (cleanTarget.startsWith(BASE_PATH)) {
        resolvedRel = cleanTarget.slice(BASE_PATH.length) || "index.html";
      } else if (cleanTarget.startsWith("/")) {
        errors.push(`Absolute link missing base path "${BASE_PATH}" in ${htmlRel}: ${target}`);
        continue;
      } else {
        const dir = path.posix.dirname(htmlRel);
        resolvedRel = path.posix.normalize(dir === "." ? cleanTarget : path.posix.join(dir, cleanTarget));
      }

      if (resolvedRel.endsWith("/")) resolvedRel += "index.html";
      if (!files.includes(resolvedRel)) {
        errors.push(`Broken internal link/asset in ${htmlRel}: "${target}" -> missing "${resolvedRel}"`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Docs verification failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
  return files;
}

function buildDocs() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const version = String(pkg.version || "0.0.0");

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT_DIR, "assets"), { recursive: true });

  const referencedAssets = new Set(["docs/images/biliscript-logo.svg"]);

  for (let idx = 0; idx < PAGES.length; idx += 1) {
    const page = PAGES[idx];
    const srcPath = path.join(ROOT, page.src);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`Missing source doc: ${page.src}`);
    }
    const markdown = fs.readFileSync(srcPath, "utf8");
    const ctx = {
      srcRel: page.src,
      referencedAssets,
      usedSlugs: new Map(),
      headings: [],
      pageTitle: ""
    };

    const bodyHtml = renderMarkdownBlocks(markdown, ctx);
    const title = ctx.pageTitle || page.navTitle;
    const html = renderHtmlShell({
      page,
      pageIndex: idx,
      version,
      title,
      bodyHtml,
      headings: ctx.headings
    });

    const outPath = path.join(OUT_DIR, page.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html, "utf8");
  }

  // 复制静态图片资源
  for (const relAsset of referencedAssets) {
    const srcAsset = path.join(ROOT, relAsset);
    const destAsset = path.join(OUT_DIR, relAsset);
    fs.mkdirSync(path.dirname(destAsset), { recursive: true });
    fs.copyFileSync(srcAsset, destAsset);
  }

  // 写入站点样式、脚本与 .nojekyll
  fs.writeFileSync(path.join(OUT_DIR, "assets/docs.css"), DOCS_CSS, "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "assets/docs.js"), DOCS_JS, "utf8");
  fs.writeFileSync(path.join(OUT_DIR, ".nojekyll"), "", "utf8");

  const outputFiles = verifyBuiltSite(OUT_DIR);
  console.log(`Built & verified docs site at ${OUT_DIR} (base: ${BASE_PATH})`);
  console.log(`Published pages (${PAGES.length}):`);
  for (const page of PAGES) {
    console.log(`  - ${siteUrl(page.out)}  <-  ${page.src}`);
  }
  console.log(`Copied static assets (${referencedAssets.size}):`);
  for (const asset of [...referencedAssets].sort()) {
    console.log(`  - ${BASE_PATH}${asset}`);
  }
  console.log(`Total output files: ${outputFiles.length}`);
}

buildDocs();
