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
  "extension/entry/content-bootstrap.iife.js",
  "extension/entry/content-main.mjs",
  "eval/run.mjs",
  "eval/sweep.mjs"
]);

export const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

export const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

export const CSS_EXTENSIONS = new Set([".css"]);

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
      let closed = false;
      while (i < n) {
        if (src[i] === "\\") {
          if (src[i + 1] === "\r" && src[i + 2] === "\n") { line++; i += 3; continue; }
          if (src[i + 1] === "\n") { line++; i += 2; continue; }
          i += 2;
          continue;
        }
        if (src[i] === "`") { i++; closed = true; break; }
        if (src[i] === "$" && src[i + 1] === "{") { tplStack.push(0); i += 2; prevToken = "{"; break; }
        if (src[i] === "\n") line++;
        i++;
      }
      if (closed) prevToken = "str";
      continue;
    }

    if (ch === "{" && tplStack.length > 0) {
      tplStack[tplStack.length - 1]++;
      i++;
      prevToken = "{";
      continue;
    }

    if (ch === "}" && tplStack.length > 0) {
      if (tplStack[tplStack.length - 1] === 0) {
        tplStack.pop();
        i++;
        let closed = false;
        while (i < n) {
          if (src[i] === "\\") {
            if (src[i + 1] === "\r" && src[i + 2] === "\n") { line++; i += 3; continue; }
            if (src[i + 1] === "\n") { line++; i += 2; continue; }
            i += 2;
            continue;
          }
          if (src[i] === "`") { i++; closed = true; break; }
          if (src[i] === "$" && src[i + 1] === "{") { tplStack.push(0); i += 2; prevToken = "{"; break; }
          if (src[i] === "\n") line++;
          i++;
        }
        if (closed) prevToken = "str";
        continue;
      } else {
        tplStack[tplStack.length - 1]--;
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

export function isAllowedDirective(comment) {
  if (comment.type === "shebang") return true;
  const text = comment.text;
  if (/@ts-ignore\b|@ts-nocheck\b/.test(text)) return false;
  if (/^\/\/\/\s*<reference\b/.test(text)) return true;
  if (/^\/\/\s*BILISCRIPT_DUAL_INSTANCE_STATEFUL\s*$/.test(text)) return true;
  if (
    /^\/\/\s*@vitest-environment\s+(?:node|jsdom|happy-dom|edge-runtime)\s*$/.test(text) ||
    /^\/\*\s*@vitest-environment\s+(?:node|jsdom|happy-dom|edge-runtime)\s*\*\/$/.test(text)
  ) {
    return true;
  }
  if (/@jsx\b|@jsxImportSource\b|@vite-ignore\b|v8 ignore|c8 ignore|istanbul ignore|prettier-ignore|@license\b|DO NOT EDIT/i.test(text)) {
    return true;
  }
  const tsExpect = text.match(/@ts-expect-error\b(.*)$/s);
  if (tsExpect) {
    const reason = tsExpect[1].replace(/\*\/$/, "").trim();
    if (reason.length > 0) return true;
  }
  if (/eslint-disable(?:-next-line|-line)?\b/.test(text)) return true;
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
      if (!CODE_EXTENSIONS.has(ext) && !CSS_EXTENSIONS.has(ext)) continue;
      if (entry.name.endsWith(".generated.ts")) continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (isGeneratedOutput(rel)) continue;
      out.push(rel);
    }
  }
  walk(rootDir, "");
  return out.sort();
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
    const comments = CSS_EXTENSIONS.has(ext) ? scanCssComments(src) : scanComments(src);
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
