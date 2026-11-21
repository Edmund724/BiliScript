#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOME_REFERENCED_ASSETS,
  REPO_BLOB_BASE,
  escapeAttr,
  escapeHtml,
  renderCalloutIcon,
  renderCopyControl,
  renderPageHtml
} from "./docs-site/template.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, ".pages-dist");
const TOKENS_CSS_PATH = path.join(ROOT, "extension/entry/styles/tokens-primitive.css");
const SITE_CSS_PATH = path.join(__dirname, "docs-site/docs.css");
const SITE_JS_PATH = path.join(__dirname, "docs-site/docs.js");

const PAGES = [
  {
    src: "README.md",
    out: "index.html",
    topLabel: "首页",
    navTitle: "概览与快速开始",
    description: "BiliScript 浏览器扩展功能概览、安装方式与快速上手指南。"
  },
  {
    src: "docs/guide.md",
    out: "docs/guide.html",
    topLabel: "配置与排障",
    navTitle: "配置与排障指南",
    description: "支持平台清单、ASR 语音识别模型对比、联网搜索、实时伴看与常见问题排障。"
  },
  {
    src: "docs/agent-bridge.md",
    out: "docs/agent-bridge.html",
    topLabel: "Agent 桥接",
    navTitle: "本地 Agent 桥接指南",
    description: "通过本机 WebSocket 桥接供编程 Agent 读取 B 站视频字幕、热评与关键帧。"
  },
  {
    src: "docs/development.md",
    out: "docs/development.html",
    topLabel: "开发与架构",
    navTitle: "开发与架构指南",
    description: "BiliScript 扩展构建命令、目录结构、评测基准与架构文档索引。"
  },
  {
    src: "PRIVACY.md",
    out: "privacy.html",
    topLabel: "隐私政策",
    navTitle: "隐私政策",
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

  if (ROUTE_BY_SRC.has(resolved)) {
    return `${siteUrl(ROUTE_BY_SRC.get(resolved))}${suffix}`;
  }

  if (kind === "img" || resolved.startsWith("docs/images/")) {
    const absAsset = path.join(ROOT, resolved);
    if (!fs.existsSync(absAsset) || fs.statSync(absAsset).isDirectory()) {
      throw new Error(`Missing static image referenced in ${fromSrcRel}: ${rawUrl} -> ${resolved}`);
    }
    referencedAssets.add(resolved);
    return `${BASE_PATH}${resolved}${suffix}`;
  }

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

  const tokens = [];
  const stash = (html) => {
    const id = `\u0000TOK_${tokens.length}\u0000`;
    tokens.push(html);
    return id;
  };

  let out = "";
  for (let i = 0; i < text.length; ) {
    const ch = text[i];

    if (ch === "\\" && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|>~]/.test(text[i + 1])) {
      out += stash(escapeHtml(text[i + 1]));
      i += 2;
      continue;
    }

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

  out = escapeHtml(out);

  out = out.replace(/(^|[\s(（：:])(https?:\/\/[^\s<>"')）\]]+)/g, (full, prefix, url) => {
    let cleanUrl = url;
    let trailing = "";
    while (/[.,;:!?。，；：！？]$/.test(cleanUrl)) {
      trailing = cleanUrl.slice(-1) + trailing;
      cleanUrl = cleanUrl.slice(0, -1);
    }
    return `${prefix}<a href="${escapeAttr(cleanUrl)}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a>${trailing}`;
  });

  out = out.replace(/~~([^\n~]+?)~~/g, "<del>$1</del>");
  out = out.replace(/\*\*\*([^\n*]+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  out = out.replace(/\*\*([^\n*]+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^\w*])\*([^\s*][^\n*]*?[^\s*]|[^\s*])\*(?!\*)/g, "$1<em>$2</em>");

  out = out.replace(/\u0000TOK_(\d+)\u0000/g, (_, idx) => tokens[Number(idx)]);
  return out;
}

function parseTableSeparator(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
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

function renderCodeBlock(lang, codeText, ctx) {
  ctx.codeIndex += 1;
  const codeId = `code-block-${ctx.codeIndex}`;
  const normalizedLang = lang.trim().toLowerCase();
  const displayLang = normalizedLang || "text";
  const escapedCode = escapeHtml(codeText.replace(/\n$/, ""));
  const copyHtml = renderCopyControl(codeId, `复制 ${displayLang} 代码`);
  if (!normalizedLang) {
    return [
      `<div class="code-block" data-lang="text">`,
      `  <pre tabindex="0"><code id="${escapeAttr(codeId)}" class="language-text">${escapedCode}</code></pre>`,
      `  ${copyHtml}`,
      `</div>`
    ].join("\n");
  }
  return [
    `<div class="code-block" data-lang="${escapeAttr(displayLang)}">`,
    `  <div class="code-head"><span class="code-lang-pill">${escapeHtml(displayLang)}</span>${copyHtml}</div>`,
    `  <pre tabindex="0"><code id="${escapeAttr(codeId)}" class="language-${escapeAttr(displayLang)}">${escapedCode}</code></pre>`,
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

    if (!line.trim()) {
      i += 1;
      continue;
    }

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
      if (!ctx.pageTitle) {
        const h1Match = rawHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        if (h1Match) ctx.pageTitle = h1Match[1].replace(/<[^>]+>/g, "").trim();
      }
      htmlParts.push(`<div class="md-html-block">\n${rawHtml}\n</div>`);
      continue;
    }

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
      htmlParts.push(renderCodeBlock(lang, codeLines.join("\n"), ctx));
      continue;
    }

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
      htmlParts.push(`<h${level} id="${escapeAttr(id)}" tabindex="-1">${inner}${anchor}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$/.test(line)) {
      htmlParts.push("<hr />");
      i += 1;
      continue;
    }

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
          `<div class="callout callout-${meta.cls}" role="note">\n<div class="callout-title">${renderCalloutIcon()}<span>${meta.label}</span></div>\n<div class="callout-body">${bodyHtml}</div>\n</div>`
        );
      } else {
        const bodyHtml = renderMarkdownBlocks(quoteLines.join("\n"), ctx);
        htmlParts.push(`<blockquote>\n${bodyHtml}\n</blockquote>`);
      }
      continue;
    }

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
      htmlParts.push(`<p>${renderInline(line, ctx)}</p>`);
      i += 1;
    }
  }

  return htmlParts.join("\n");
}

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

  for (const page of PAGES) {
    if (!files.includes(page.out)) {
      errors.push(`Missing generated page: ${page.out}`);
    }
  }
  for (const reqFile of [".nojekyll", "assets/docs.css", "assets/docs.js"]) {
    if (!files.includes(reqFile)) {
      errors.push(`Missing required output file: ${reqFile}`);
    }
  }

  for (const rel of files) {
    if (FORBIDDEN_PATHS.some((bad) => rel.includes(bad) || rel === bad)) {
      errors.push(`Forbidden internal file leaked into site output: ${rel}`);
    }
  }

  const htmlFiles = files.filter((f) => f.endsWith(".html"));
  for (const htmlRel of htmlFiles) {
    const htmlPath = path.join(outDir, htmlRel);
    const content = fs.readFileSync(htmlPath, "utf8");

    if (/docs\/agents\/|\.scratch\//i.test(content)) {
      errors.push(`Forbidden internal reference found in ${htmlRel}`);
    }

    if (/☀️|🌙|🎬/.test(content)) {
      errors.push(`Unexpected template emoji found in ${htmlRel}`);
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

  const referencedAssets = new Set(HOME_REFERENCED_ASSETS);

  for (let idx = 0; idx < PAGES.length; idx += 1) {
    const page = PAGES[idx];
    const isHome = page.out === "index.html";
    let bodyHtml = "";
    let title = page.navTitle;
    let headings = [];

    if (!isHome) {
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
        pageTitle: "",
        codeIndex: 0
      };
      bodyHtml = renderMarkdownBlocks(markdown, ctx);
      title = ctx.pageTitle || page.navTitle;
      headings = ctx.headings;
    }

    const html = renderPageHtml({
      pages: PAGES,
      page,
      pageIndex: idx,
      version,
      title,
      bodyHtml,
      headings,
      siteUrl,
      basePath: BASE_PATH
    });

    const outPath = path.join(OUT_DIR, page.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html, "utf8");
  }

  for (const relAsset of referencedAssets) {
    const srcAsset = path.join(ROOT, relAsset);
    const destAsset = path.join(OUT_DIR, relAsset);
    fs.mkdirSync(path.dirname(destAsset), { recursive: true });
    fs.copyFileSync(srcAsset, destAsset);
  }

  const tokensCss = fs.readFileSync(TOKENS_CSS_PATH, "utf8");
  const siteCss = fs.readFileSync(SITE_CSS_PATH, "utf8");
  const bundledCss = `${tokensCss}\n\n${siteCss}`;
  const siteJs = fs.readFileSync(SITE_JS_PATH, "utf8");

  fs.writeFileSync(path.join(OUT_DIR, "assets/docs.css"), bundledCss, "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "assets/docs.js"), siteJs, "utf8");
  fs.writeFileSync(path.join(OUT_DIR, ".nojekyll"), "", "utf8");

  const outputFiles = verifyBuiltSite(OUT_DIR);
  console.log(`Built & verified docs site at ${OUT_DIR} (base: ${BASE_PATH})`);
  console.log(`Published pages (${PAGES.length}):`);
  for (const page of PAGES) {
    console.log(`  - ${siteUrl(page.out)}  <-  ${page.out === "index.html" ? "custom landing" : page.src}`);
  }
  console.log(`Copied static assets (${referencedAssets.size}):`);
  for (const asset of [...referencedAssets].sort()) {
    console.log(`  - ${BASE_PATH}${asset}`);
  }
  console.log(`Total output files: ${outputFiles.length}`);
}

buildDocs();
