import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-firefox",
  "build",
  "coverage",
  ".git",
  ".scratch",
  ".comment-audit-tmp",
  ".pages-dist",
  ".pnpm-store"
]);

export const EXCLUDED_PREFIXES = [
  "extension/entry/chunks/"
];

export const EXCLUDED_FILES = new Set([
  "extension/entry/content-resident.iife.js",
  "eval/run.mjs",
  "eval/sweep.mjs"
]);

export const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

export const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

export const CSS_EXTENSIONS = new Set([".css"]);

export const HTML_EXTENSIONS = new Set([".html"]);

export const SVG_EXTENSIONS = new Set([".svg"]);

export const PYTHON_EXTENSIONS = new Set([".py"]);

export const RATCHET_EXEMPT_FILES = new Set([]);

export const RATCHET_EXEMPT_PREFIXES = [];

const REGEX_ALLOWED_BEFORE = new Set([
  "", "(", "[", "{", ",", ";", ":", "=", "!", "?", "&", "|", "^", "~",
  "+", "-", "*", "%", "<", ">", "return", "case", "throw", "in", "of",
  "typeof", "void", "delete", "new", "yield", "await", "=>", "else", "do"
]);

export function scanComments(src) {
  const comments = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let prevToken = "";
  const tplStack = [];

  const isIdStart = (c) => /[a-zA-Z_$]/.test(c);
  const isIdPart = (c) => /[a-zA-Z0-9_$]/.test(c);

  function scanTemplateChunk(activeHtmlComment) {
    let htmlComment = activeHtmlComment;
    let closed = false;
    while (i < n) {
      if (src[i] === "\\") {
        if (src[i + 1] === "\r" && src[i + 2] === "\n") { line++; i += 3; continue; }
        if (src[i + 1] === "\n") { line++; i += 2; continue; }
        i += 2;
        continue;
      }
      if (src[i] === "`") { i++; closed = true; break; }
      if (src[i] === "$" && src[i + 1] === "{") {
        tplStack.push({ braces: 0, htmlComment });
        i += 2;
        prevToken = "{";
        break;
      }
      if (htmlComment !== null) {
        if (
          i >= htmlComment.start + 4 &&
          src[i] === "-" &&
          src[i + 1] === "-" &&
          src[i + 2] === ">"
        ) {
          const end = i + 3;
          const inner = src.slice(htmlComment.start + 4, i);
          if (inner.trim().length > 0) {
            const lineStart = src.lastIndexOf("\n", htmlComment.start - 1) + 1;
            const beforeEmpty = src.slice(lineStart, htmlComment.start).trim() === "";
            let lineEnd = src.indexOf("\n", end);
            if (lineEnd === -1) lineEnd = n;
            const afterEmpty = src.slice(end, lineEnd).trim() === "";
            comments.push({
              type: "html",
              start: htmlComment.start,
              end,
              startLine: htmlComment.startLine,
              endLine: line,
              text: src.slice(htmlComment.start, end),
              standalone: beforeEmpty && afterEmpty
            });
          }
          htmlComment = null;
          i = end;
          continue;
        }
      } else if (
        src[i] === "<" &&
        src[i + 1] === "!" &&
        src[i + 2] === "-" &&
        src[i + 3] === "-"
      ) {
        htmlComment = { start: i, startLine: line };
        i += 4;
        continue;
      }
      if (src[i] === "\n") line++;
      i++;
    }
    if (closed) prevToken = "str";
  }

  if (src.startsWith("#!")) {
    let end = src.indexOf("\n");
    if (end === -1) end = n;
    comments.push({
      type: "shebang",
      start: 0,
      end,
      startLine: 1,
      endLine: 1,
      text: src.slice(0, end),
      standalone: true
    });
    i = end < n ? end + 1 : n;
    line = 2;
  }

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === "\n") { line++; i++; continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { i++; continue; }

    if (ch === "/" && next === "/") {
      const start = i;
      const startLine = line;
      const lineStart = src.lastIndexOf("\n", start - 1) + 1;
      const standalone = src.slice(lineStart, start).trim() === "";
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      comments.push({
        type: "line",
        start,
        end: i,
        startLine,
        endLine: line,
        text: src.slice(start, i),
        standalone
      });
      continue;
    }

    if (ch === "/" && next === "*") {
      const start = i;
      const startLine = line;
      const lineStart = src.lastIndexOf("\n", start - 1) + 1;
      const beforeEmpty = src.slice(lineStart, start).trim() === "";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      if (i < n) i += 2;
      let lineEnd = src.indexOf("\n", i);
      if (lineEnd === -1) lineEnd = n;
      const afterEmpty = src.slice(i, lineEnd).trim() === "";
      comments.push({
        type: "block",
        start,
        end: i,
        startLine,
        endLine: line,
        text: src.slice(start, i),
        standalone: beforeEmpty && afterEmpty
      });
      continue;
    }

    if (ch === "'" || ch === "\"") {
      const q = ch;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") {
          if (src[i + 1] === "\r" && src[i + 2] === "\n") { line++; i += 3; continue; }
          if (src[i + 1] === "\n") { line++; i += 2; continue; }
          i += 2;
          continue;
        }
        if (src[i] === "\n") line++;
        i++;
      }
      if (i < n) i++;
      prevToken = "str";
      continue;
    }

    if (ch === "`") {
      i++;
      scanTemplateChunk(null);
      continue;
    }

    if (ch === "{" && tplStack.length > 0) {
      tplStack[tplStack.length - 1].braces++;
      i++;
      prevToken = "{";
      continue;
    }

    if (ch === "}" && tplStack.length > 0) {
      if (tplStack[tplStack.length - 1].braces === 0) {
        const entry = tplStack.pop();
        i++;
        scanTemplateChunk(entry.htmlComment);
        continue;
      } else {
        tplStack[tplStack.length - 1].braces--;
        i++;
        prevToken = "}";
        continue;
      }
    }

    if (ch === "/" && REGEX_ALLOWED_BEFORE.has(prevToken)) {
      const scanStart = i;
      i++;
      let inClass = false;
      let validRegex = false;
      while (i < n && src[i] !== "\n" && src[i] !== "\r") {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) { i++; validRegex = true; break; }
        i++;
      }
      if (validRegex) {
        while (i < n && /[a-z]/i.test(src[i])) i++;
        prevToken = "regex";
        continue;
      }
      i = scanStart + 1;
      prevToken = "/";
      continue;
    }

    if (isIdStart(ch)) {
      const s = i;
      while (i < n && isIdPart(src[i])) i++;
      prevToken = src.slice(s, i);
      continue;
    }

    if (/[0-9]/.test(ch)) {
      while (i < n && /[0-9a-zA-Z._]/.test(src[i])) i++;
      prevToken = "num";
      continue;
    }

    if (ch === "=" && next === ">") { i += 2; prevToken = "=>"; continue; }
    if ((ch === "+" && next === "+") || (ch === "-" && next === "-")) {
      i += 2;
      prevToken = ch + next;
      continue;
    }

    prevToken = ch;
    i++;
  }
  return comments;
}

export function scanCssComments(src) {
  const comments = [];
  const n = src.length;
  let i = 0;
  let line = 1;

  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === "\n") { line++; i++; continue; }

    if (ch === "'" || ch === "\"") {
      const q = ch;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") {
          if (src[i + 1] === "\r" && src[i + 2] === "\n") { line++; i += 3; continue; }
          if (src[i + 1] === "\n") { line++; i += 2; continue; }
          i += 2;
          continue;
        }
        if (src[i] === "\n") line++;
        i++;
      }
      if (i < n) i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      const start = i;
      const startLine = line;
      const lineStart = src.lastIndexOf("\n", start - 1) + 1;
      const beforeEmpty = src.slice(lineStart, start).trim() === "";
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      if (i < n) i += 2;
      let lineEnd = src.indexOf("\n", i);
      if (lineEnd === -1) lineEnd = n;
      const afterEmpty = src.slice(i, lineEnd).trim() === "";
      comments.push({
        type: "block",
        start,
        end: i,
        startLine,
        endLine: line,
        text: src.slice(start, i),
        standalone: beforeEmpty && afterEmpty
      });
      continue;
    }

    i++;
  }

  return comments;
}

const JS_SCRIPT_TYPES = new Set([
  "",
  "module",
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript"
]);

function countNewlines(text) {
  let count = 0;
  for (let k = 0; k < text.length; k++) {
    if (text[k] === "\n") count++;
  }
  return count;
}

export function scanHtmlComments(src, options = {}) {
  const scanEmbedded = options.scanEmbedded !== false;
  const comments = [];
  const n = src.length;
  let i = 0;
  let line = 1;

  while (i < n) {
    if (src.startsWith("<!--", i)) {
      const start = i;
      const startLine = line;
      const closeIdx = src.indexOf("-->", i + 4);
      const end = closeIdx === -1 ? n : closeIdx + 3;
      const inner = closeIdx === -1 ? src.slice(i + 4, end) : src.slice(i + 4, closeIdx);
      line += countNewlines(src.slice(start, end));
      if (inner.trim().length > 0) {
        const lineStart = src.lastIndexOf("\n", start - 1) + 1;
        const beforeEmpty = src.slice(lineStart, start).trim() === "";
        let lineEnd = src.indexOf("\n", end);
        if (lineEnd === -1) lineEnd = n;
        const afterEmpty = src.slice(end, lineEnd).trim() === "";
        comments.push({
          type: "html",
          start,
          end,
          startLine,
          endLine: line,
          text: src.slice(start, end),
          standalone: beforeEmpty && afterEmpty
        });
      }
      i = end;
      continue;
    }

    if (src.startsWith("<![CDATA[", i)) {
      const closeIdx = src.indexOf("]]>", i + 9);
      const end = closeIdx === -1 ? n : closeIdx + 3;
      line += countNewlines(src.slice(i, end));
      i = end;
      continue;
    }

    if (src[i] === "<" && /[a-zA-Z]/.test(src[i + 1] ?? "")) {
      let nameEnd = i + 1;
      while (nameEnd < n && /[a-zA-Z0-9:-]/.test(src[nameEnd])) nameEnd++;
      const tagName = src.slice(i + 1, nameEnd).toLowerCase();
      let j = nameEnd;
      while (j < n && src[j] !== ">") {
        const ch = src[j];
        if (ch === "\"" || ch === "'") {
          const q = ch;
          j++;
          while (j < n && src[j] !== q) {
            if (src[j] === "\n") line++;
            j++;
          }
          if (j < n) j++;
          continue;
        }
        if (ch === "\n") line++;
        j++;
      }
      const attrText = src.slice(nameEnd, j);
      const selfClosing = /\/\s*$/.test(attrText);
      i = j < n ? j + 1 : n;

      if (scanEmbedded && !selfClosing && (tagName === "script" || tagName === "style")) {
        const closeRe = new RegExp(`<\\/${tagName}\\s*>`, "gi");
        closeRe.lastIndex = i;
        const closeMatch = closeRe.exec(src);
        const bodyStart = i;
        const bodyStartLine = line;
        const bodyEnd = closeMatch ? closeMatch.index : n;
        const afterClose = closeMatch ? closeRe.lastIndex : n;

        let shouldScan = tagName === "style";
        if (tagName === "script") {
          const typeMatch = attrText.match(/(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
          const scriptType = typeMatch
            ? (typeMatch[1] ?? typeMatch[2] ?? typeMatch[3] ?? "").trim().toLowerCase().split(";")[0].trim()
            : "";
          shouldScan = JS_SCRIPT_TYPES.has(scriptType);
        }

        if (shouldScan) {
          const body = src.slice(bodyStart, bodyEnd);
          const embedded = tagName === "script" ? scanComments(body) : scanCssComments(body);
          for (const c of embedded) {
            comments.push({
              ...c,
              start: c.start + bodyStart,
              end: c.end + bodyStart,
              startLine: c.startLine + bodyStartLine - 1,
              endLine: c.endLine + bodyStartLine - 1
            });
          }
        }

        line += countNewlines(src.slice(bodyStart, afterClose));
        i = afterClose;
      }
      continue;
    }

    if (src[i] === "\n") line++;
    i++;
  }

  return comments;
}

export function scanSvgComments(src) {
  return scanHtmlComments(src, { scanEmbedded: false });
}

function matchPyStringPrefix(src, idx) {
  const c0 = src[idx];
  if (c0 === "'" || c0 === "\"") return 0;
  const c1 = src[idx + 1];
  if (
    (c0 === "r" || c0 === "R" || c0 === "u" || c0 === "U" || c0 === "b" || c0 === "B" || c0 === "f" || c0 === "F") &&
    (c1 === "'" || c1 === "\"")
  ) {
    return 1;
  }
  const c2 = src[idx + 2];
  if (c2 === "'" || c2 === "\"") {
    const pair = (c0 + (c1 ?? "")).toLowerCase();
    if (pair === "rb" || pair === "br" || pair === "rf" || pair === "fr") return 2;
  }
  return -1;
}

export function scanPythonComments(src) {
  const comments = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let parenDepth = 0;
  let atStmtStart = true;
  let expectDocstring = true;
  let inDefOrClassHeader = false;
  let afterAsync = false;

  const isIdStart = (c) => /[a-zA-Z_]/.test(c);
  const isIdPart = (c) => /[a-zA-Z0-9_]/.test(c);

  function skipQuotedString(startIdx, prefixLen) {
    const qStart = startIdx + prefixLen;
    const q = src[qStart];
    const triple = src[qStart + 1] === q && src[qStart + 2] === q;
    const prefixLower = src.slice(startIdx, qStart).toLowerCase();
    const isFString = prefixLower.includes("f");
    let idx = qStart + (triple ? 3 : 1);

    while (idx < n) {
      const ch = src[idx];
      if (ch === "\\") {
        if (src[idx + 1] === "\r" && src[idx + 2] === "\n") { line++; idx += 3; continue; }
        if (src[idx + 1] === "\n") { line++; idx += 2; continue; }
        idx += 2;
        continue;
      }
      if (isFString && ch === "{") {
        if (src[idx + 1] === "{") { idx += 2; continue; }
        idx++;
        let braceDepth = 1;
        while (idx < n && braceDepth > 0) {
          const ec = src[idx];
          if (ec === "\n") { line++; idx++; continue; }
          if (ec === "{") { braceDepth++; idx++; continue; }
          if (ec === "}") { braceDepth--; idx++; continue; }
          const nestedPrefix = matchPyStringPrefix(src, idx);
          if (nestedPrefix !== -1) {
            idx = skipQuotedString(idx, nestedPrefix).end;
            continue;
          }
          idx++;
        }
        continue;
      }
      if (isFString && ch === "}" && src[idx + 1] === "}") {
        idx += 2;
        continue;
      }
      if (triple) {
        if (ch === q && src[idx + 1] === q && src[idx + 2] === q) {
          idx += 3;
          break;
        }
      } else if (ch === q) {
        idx++;
        break;
      }
      if (ch === "\n") line++;
      idx++;
    }

    return { end: idx, triple, prefixLower };
  }

  if (src.startsWith("#!")) {
    let end = src.indexOf("\n");
    if (end === -1) end = n;
    comments.push({
      type: "shebang",
      start: 0,
      end,
      startLine: 1,
      endLine: 1,
      text: src.slice(0, end),
      standalone: true
    });
    i = end < n ? end + 1 : n;
    line = 2;
  }

  while (i < n) {
    const ch = src[i];

    if (ch === "\\") {
      if (src[i + 1] === "\r" && src[i + 2] === "\n") { line++; i += 3; continue; }
      if (src[i + 1] === "\n") { line++; i += 2; continue; }
      expectDocstring = false;
      atStmtStart = false;
      afterAsync = false;
      i++;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\f") { i++; continue; }

    if (ch === "\n") {
      line++;
      i++;
      if (parenDepth === 0) {
        atStmtStart = true;
        afterAsync = false;
      }
      continue;
    }

    if (ch === "#") {
      const start = i;
      const startLine = line;
      const lineStart = src.lastIndexOf("\n", start - 1) + 1;
      const standalone = src.slice(lineStart, start).trim() === "";
      i++;
      while (i < n && src[i] !== "\n") i++;
      comments.push({
        type: "python-line",
        start,
        end: i,
        startLine,
        endLine: line,
        text: src.slice(start, i),
        standalone
      });
      continue;
    }

    const strPrefixLen = matchPyStringPrefix(src, i);
    if (strPrefixLen !== -1) {
      const start = i;
      const startLine = line;
      const { end, triple, prefixLower } = skipQuotedString(i, strPrefixLen);
      const isDocstringPrefix = !prefixLower.includes("b") && !prefixLower.includes("f");
      let isDocstring = false;
      if (triple && isDocstringPrefix && expectDocstring && parenDepth === 0) {
        let j = end;
        while (j < n && (src[j] === " " || src[j] === "\t")) j++;
        if (j >= n || src[j] === "\n" || src[j] === "\r" || src[j] === ";" || src[j] === "#") {
          isDocstring = true;
        }
      }
      if (isDocstring) {
        const lineStart = src.lastIndexOf("\n", start - 1) + 1;
        const beforeEmpty = src.slice(lineStart, start).trim() === "";
        let lineEnd = src.indexOf("\n", end);
        if (lineEnd === -1) lineEnd = n;
        const afterEmpty = src.slice(end, lineEnd).trim() === "";
        comments.push({
          type: "python-docstring",
          start,
          end,
          startLine,
          endLine: line,
          text: src.slice(start, end),
          standalone: beforeEmpty && afterEmpty
        });
      }
      i = end;
      expectDocstring = false;
      atStmtStart = false;
      afterAsync = false;
      continue;
    }

    if (ch === "(" || ch === "[" || ch === "{") {
      parenDepth++;
      expectDocstring = false;
      atStmtStart = false;
      afterAsync = false;
      i++;
      continue;
    }

    if (ch === ")" || ch === "]" || ch === "}") {
      if (parenDepth > 0) parenDepth--;
      expectDocstring = false;
      atStmtStart = false;
      afterAsync = false;
      i++;
      continue;
    }

    if (ch === ";") {
      if (parenDepth === 0) {
        atStmtStart = true;
        afterAsync = false;
      }
      expectDocstring = false;
      i++;
      continue;
    }

    if (ch === ":") {
      if (parenDepth === 0) {
        if (inDefOrClassHeader) {
          inDefOrClassHeader = false;
          expectDocstring = true;
        } else {
          expectDocstring = false;
        }
        atStmtStart = true;
        afterAsync = false;
      }
      i++;
      continue;
    }

    if (isIdStart(ch)) {
      const s = i;
      while (i < n && isIdPart(src[i])) i++;
      const word = src.slice(s, i);
      expectDocstring = false;
      if (parenDepth === 0) {
        if (atStmtStart && word === "async") {
          afterAsync = true;
          atStmtStart = false;
        } else if ((atStmtStart || afterAsync) && (word === "def" || word === "class")) {
          inDefOrClassHeader = true;
          atStmtStart = false;
          afterAsync = false;
        } else {
          atStmtStart = false;
          afterAsync = false;
        }
      }
      continue;
    }

    expectDocstring = false;
    atStmtStart = false;
    afterAsync = false;
    i++;
  }

  return comments;
}

export function isAllowedDirective(comment) {
  if (comment.type === "shebang") return true;
  const text = comment.text;

  if (comment.type === "python-line") {
    if (
      (comment.startLine == null || comment.startLine <= 2) &&
      /^#\s*(?:-\*-\s*)?coding[:=]\s*[-\w.]+(?:\s*-\*-)?\s*$/.test(text)
    ) {
      return true;
    }
    if (/^#\s*type:\s*ignore(?:\[[^\]]+\])?(?:\s|$)/.test(text)) return true;
    if (/^#\s*(?:ruff:\s*)?noqa(?::\s*[A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)?\s*$/.test(text)) {
      return true;
    }
    if (/^#\s*pyright:\s*ignore(?:\[[^\]]+\])?\s*$/.test(text)) return true;
    if (/^#\s*pragma:\s*no\s+cover\s*$/.test(text)) return true;
    if (/^#\s*fmt:\s*(?:off|on|skip)\s*$/.test(text)) return true;
    if (/^#\s*pylint:\s*disable=[a-zA-Z0-9_,-]+\s*$/.test(text)) return true;
    return false;
  }

  if (comment.type === "python-docstring" || comment.type === "html") {
    return false;
  }

  if (/@ts-ignore\b|@ts-nocheck\b/.test(text)) return false;
  if (/^\/\/\/\s*<reference\b/.test(text)) return true;
  if (/^\/\/\s*BILISCRIPT_DUAL_INSTANCE_STATEFUL\s*$/.test(text)) return true;
  if (
    /^\/\/\s*@vitest-environment\s+(?:node|jsdom|happy-dom|edge-runtime)\s*$/.test(text) ||
    /^\/\*\s*@vitest-environment\s+(?:node|jsdom|happy-dom|edge-runtime)\s*\*\/$/.test(text)
  ) {
    return true;
  }
  if (
    /^(?:\/\/|\/\*)\s*(?:@jsx\b|@jsxImportSource\b|@vite-ignore\b|v8 ignore\b|c8 ignore\b|istanbul ignore\b|prettier-ignore\b|@license\b|DO NOT EDIT\b)/i.test(
      text
    )
  ) {
    return true;
  }
  const tsExpect = text.match(/^(?:\/\/|\/\*)\s*@ts-expect-error\b(.*)$/s);
  if (tsExpect) {
    const reason = text.startsWith("/*") ? tsExpect[1].replace(/\*\/$/, "").trim() : tsExpect[1].trim();
    if (reason.length > 0) return true;
    return false;
  }
  if (/^(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?(?:\s|\*\/|$)/.test(text)) return true;
  return false;
}

export function isRatchetExempt(relPath, exemptFiles = RATCHET_EXEMPT_FILES, exemptPrefixes = RATCHET_EXEMPT_PREFIXES) {
  if (exemptFiles.has(relPath)) return true;
  return exemptPrefixes.some((prefix) => relPath.startsWith(prefix));
}

function isGeneratedOutput(relPath) {
  if (EXCLUDED_FILES.has(relPath)) return true;
  return EXCLUDED_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function collectTargetFiles(rootDir) {
  const out = [];
  function walk(absDir, relPrefix) {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        const nextRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (EXCLUDED_PREFIXES.some((prefix) => `${nextRel}/`.startsWith(prefix))) continue;
        walk(path.join(absDir, entry.name), nextRel);
        continue;
      }
      const ext = path.extname(entry.name);
      if (
        !CODE_EXTENSIONS.has(ext) &&
        !CSS_EXTENSIONS.has(ext) &&
        !HTML_EXTENSIONS.has(ext) &&
        !SVG_EXTENSIONS.has(ext) &&
        !PYTHON_EXTENSIONS.has(ext)
      ) {
        continue;
      }
      if (entry.name.endsWith(".generated.ts")) continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (isGeneratedOutput(rel)) continue;
      out.push(rel);
    }
  }
  walk(rootDir, "");
  return out.sort();
}

function scanFileComments(src, ext) {
  if (CSS_EXTENSIONS.has(ext)) return scanCssComments(src);
  if (HTML_EXTENSIONS.has(ext)) return scanHtmlComments(src);
  if (SVG_EXTENSIONS.has(ext)) return scanSvgComments(src);
  if (PYTHON_EXTENSIONS.has(ext)) return scanPythonComments(src);
  return scanComments(src);
}

export function checkNoComments(rootDir = process.cwd(), options = {}) {
  const exemptFiles = options.exemptFiles ?? RATCHET_EXEMPT_FILES;
  const exemptPrefixes = options.exemptPrefixes ?? RATCHET_EXEMPT_PREFIXES;
  const files = collectTargetFiles(rootDir);
  const violations = [];

  for (const rel of files) {
    if (isRatchetExempt(rel, exemptFiles, exemptPrefixes)) continue;
    const src = fs.readFileSync(path.join(rootDir, rel), "utf8");
    const ext = path.extname(rel);
    const comments = scanFileComments(src, ext);
    for (const c of comments) {
      if (!isAllowedDirective(c)) {
        const preview = c.text.replace(/\s+/g, " ").slice(0, 100);
        violations.push({ file: rel, line: c.startLine, text: c.text, preview });
      }
    }
  }

  return { filesChecked: files.length, violations };
}

const isCli =
  typeof process !== "undefined" &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const { filesChecked, violations } = checkNoComments(process.cwd());
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.file}:${v.line}: ${v.preview}`);
    }
    console.error(`Found ${violations.length} disallowed comment(s) across ${filesChecked} files.`);
    process.exit(1);
  }
  console.log(`Zero disallowed comments across ${filesChecked} files.`);
}
