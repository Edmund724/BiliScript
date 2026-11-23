import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkNoComments,
  isAllowedDirective,
  RATCHET_EXEMPT_FILES,
  RATCHET_EXEMPT_PREFIXES,
  scanComments,
  scanCssComments,
  scanHtmlComments,
  scanPythonComments,
  scanSvgComments
} from "../scripts/check-no-comments.mjs";

describe("no-comments guard", () => {
  it("reports zero disallowed comments across all repository code, .d.ts, CSS, HTML, SVG, and Python files", () => {
    expect(RATCHET_EXEMPT_FILES.size).toBe(0);
    expect(RATCHET_EXEMPT_PREFIXES).toEqual([]);
    const result = checkNoComments(process.cwd());
    expect(result.filesChecked).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  it("blocks regular line/block comments, bare @ts-expect-error, @ts-ignore, @ts-nocheck, and prose smuggling directives", () => {
    const samples = [
      "// plain comment\nconst x = 1;",
      "/* block comment */\nconst x = 1;",
      "// @ts-expect-error\nconst x: number = 'a';",
      "/* @ts-expect-error */\nconst x: number = 'a';",
      "// @ts-ignore legacy\nconst x = 1;",
      "// @ts-nocheck\nconst x = 1;",
      "// BILISCRIPT_DUAL_INSTANCE_STATEFUL extra prose not allowed\nconst x = 1;",
      `// ${"@vitest-environment"} invalid\nconst x = 1;`,
      "// prose mentioning @ts-expect-error with reason\nconst x = 1;",
      "/* prose mentioning @ts-expect-error with reason */\nconst x = 1;",
      "// prose mentioning eslint-disable-next-line no-console\nconst x = 1;",
      "/* prose mentioning eslint-disable */\nconst x = 1;",
      "// eslint-disable-custom\nconst x = 1;",
      "// prose mentioning @jsx h\nconst x = 1;",
      "/* prose mentioning @jsxImportSource react */\nconst x = 1;",
      "/* prose mentioning @vite-ignore */\nconst x = 1;",
      "// prose mentioning v8 ignore next\nconst x = 1;",
      "// prose mentioning c8 ignore start\nconst x = 1;",
      "// prose mentioning istanbul ignore next\nconst x = 1;",
      "// prose mentioning prettier-ignore\nconst x = 1;",
      "/* note: @license MIT */\nconst x = 1;",
      "// warning: DO NOT EDIT manually\nconst x = 1;",
      "/** @license MIT */\nconst x = 1;"
    ];
    for (const sample of samples) {
      const comments = scanComments(sample);
      expect(comments.length, sample).toBe(1);
      expect(isAllowedDirective(comments[0]), sample).toBe(false);
    }
  });

  it("allows whitelisted machine directives anchored at comment start, @vitest-environment, and explained @ts-expect-error", () => {
    const samples = [
      "#!/usr/bin/env node\nconst x = 1;",
      "/// <reference types=\"chrome\" />\nconst x = 1;",
      "// BILISCRIPT_DUAL_INSTANCE_STATEFUL\nconst x = 1;",
      `// ${"@vitest-environment"} node\nconst x = 1;`,
      `// ${"@vitest-environment"} jsdom\r\nconst x = 1;`,
      `/* ${"@vitest-environment"} jsdom */\nconst x = 1;`,
      "/* @jsx h */\nconst x = 1;",
      "// @jsx h\nconst x = 1;",
      "/* @jsxImportSource react */\nconst x = 1;",
      "/* @vite-ignore */\nconst x = 1;",
      "/* v8 ignore next */\nconst x = 1;",
      "/* c8 ignore start */\nconst x = 1;",
      "/* istanbul ignore next */\nconst x = 1;",
      "// prettier-ignore\nconst x = 1;",
      "/* prettier-ignore */\nconst x = 1;",
      "/* @license MIT */\nconst x = 1;",
      "// DO NOT EDIT\nconst x = 1;",
      "/* DO NOT EDIT: generated */\nconst x = 1;",
      "// @ts-expect-error intentional negative type test\nconst x = 1;",
      "/* @ts-expect-error intentional negative type test */\nconst x = 1;",
      "// eslint-disable-next-line no-console\nconst x = 1;",
      "// eslint-disable-line no-console\nconst x = 1;",
      "/* eslint-disable no-console */\nconst x = 1;"
    ];
    for (const sample of samples) {
      const comments = scanComments(sample);
      expect(comments.length, sample).toBe(1);
      expect(isAllowedDirective(comments[0]), sample).toBe(true);
    }
  });

  it("does not misclassify // or /* inside strings, template literals, or regex literals", () => {
    const code = [
      "const url = 'https://example.com/*not-a-comment*/';",
      "const tpl = `http://${host}/path /* keep */`;",
      "const rx = /https?:\\/\\/[a-z]+/i;",
      "const div = 10 / 2;"
    ].join("\n");
    expect(scanComments(code)).toEqual([]);
  });

  it("scans non-empty HTML comments inside TS/JS template literals while skipping <!----> and regular strings", () => {
    const allowedCode = [
      "const vueEmpty = `<div><!----></div>`;",
      "const quoted = \"<div><!-- not a template literal --></div>\";",
      "const unclosed = `<!--`;"
    ].join("\n");
    expect(scanComments(allowedCode)).toEqual([]);

    const dirtyCode = [
      "const a = `<div><!-- single line --></div>`;",
      "const b = `",
      "  <!-- multi",
      "       line -->",
      "`;",
      "const c = `<!-- interpolated ${id} -->`;",
      "const d = `<div>${`<span><!-- nested --></span>`}<!-- outer --></div>`;"
    ].join("\n");
    const found = scanComments(dirtyCode);
    expect(found.map((c) => ({ type: c.type, startLine: c.startLine, endLine: c.endLine, text: c.text }))).toEqual([
      { type: "html", startLine: 1, endLine: 1, text: "<!-- single line -->" },
      { type: "html", startLine: 3, endLine: 4, text: "<!-- multi\n       line -->" },
      { type: "html", startLine: 6, endLine: 6, text: "<!-- interpolated ${id} -->" },
      { type: "html", startLine: 7, endLine: 7, text: "<!-- nested -->" },
      { type: "html", startLine: 7, endLine: 7, text: "<!-- outer -->" }
    ]);
    for (const c of found) {
      expect(isAllowedDirective(c)).toBe(false);
    }
  });

  it("scans CSS comments while skipping quoted strings, allowing @license and blocking regular CSS comments", () => {
    const cleanCss = [
      "/* @license MIT - github-markdown-css v5.9.0 */",
      ".a::before { content: \"/* not a comment */ \\\" /* still string */\"; }",
      ".b { background: url('https://example.com/a/*b*/.png'); }"
    ].join("\n");
    const allowed = scanCssComments(cleanCss);
    expect(allowed.length).toBe(1);
    expect(isAllowedDirective(allowed[0])).toBe(true);

    const dirtyCss = ".a { color: red; }\n/* disallowed css comment */\n.b { color: blue; }";
    const blocked = scanCssComments(dirtyCss);
    expect(blocked.length).toBe(1);
    expect(blocked[0].standalone).toBe(true);
    expect(isAllowedDirective(blocked[0])).toBe(false);
  });

  it("scans HTML comments and embedded <script>/<style> blocks while skipping <!----> and attributes", () => {
    const cleanHtml = [
      "<!DOCTYPE html>",
      "<html>",
      "<head>",
      "<style>",
      "/* @license MIT */",
      ".a::before { content: \"/* keep */\"; }",
      "</style>",
      "</head>",
      "<body>",
      "<div title=\"<!-- attr value -->\"><!----></div>",
      "<script type=\"application/json\">{\"url\":\"https://example.com/*ok*/\"}</script>",
      "<script type=\"module\">",
      "const u = \"https://example.com\";",
      "/* @vite-ignore */",
      "import(u);",
      "</script>",
      "</body>",
      "</html>"
    ].join("\n");
    const cleanComments = scanHtmlComments(cleanHtml);
    expect(cleanComments.length).toBe(2);
    expect(cleanComments.every((c) => isAllowedDirective(c))).toBe(true);

    const dirtyHtml = [
      "<!DOCTYPE html>",
      "<!-- top html comment -->",
      "<html>",
      "<head>",
      "<style>",
      "/* bad css comment */",
      "body { color: red; }",
      "</style>",
      "</head>",
      "<body>",
      "<script type=\"module\">",
      "// bad js comment",
      "const tpl = `<span><!-- bad tpl html --></span>`;",
      "</script>",
      "</body>",
      "</html>"
    ].join("\n");
    const dirtyComments = scanHtmlComments(dirtyHtml);
    expect(dirtyComments.map((c) => ({ type: c.type, startLine: c.startLine, text: c.text }))).toEqual([
      { type: "html", startLine: 2, text: "<!-- top html comment -->" },
      { type: "block", startLine: 6, text: "/* bad css comment */" },
      { type: "line", startLine: 12, text: "// bad js comment" },
      { type: "html", startLine: 13, text: "<!-- bad tpl html -->" }
    ]);
    expect(dirtyComments.every((c) => !isAllowedDirective(c))).toBe(true);
  });

  it("scans SVG comments while skipping <!----> and attribute values", () => {
    const cleanSvg = [
      "<svg xmlns=\"http://www.w3.org/2000/svg\">",
      "  <g data-note=\"<!-- attr -->\"><!----></g>",
      "</svg>"
    ].join("\n");
    expect(scanSvgComments(cleanSvg)).toEqual([]);

    const dirtySvg = [
      "<svg xmlns=\"http://www.w3.org/2000/svg\">",
      "  <!-- svg shape note -->",
      "  <rect width=\"10\" height=\"10\" />",
      "</svg>"
    ].join("\n");
    const found = scanSvgComments(dirtySvg);
    expect(found.length).toBe(1);
    expect(found[0].startLine).toBe(2);
    expect(found[0].type).toBe("html");
    expect(isAllowedDirective(found[0])).toBe(false);
  });

  it("scans Python # comments and module/class/function docstrings while allowing shebang, whitelisted directives, and normal strings", () => {
    const cleanPy = [
      "#!/usr/bin/env python3",
      "# -*- coding: utf-8 -*-",
      "x: int = \"a\"  # type: ignore[assignment]",
      "y = 1  # type: ignore",
      "import os  # noqa: F401, E501",
      "z = 2  # noqa\r",
      "s1 = \"# not a comment\"",
      "s2 = r'# also not a comment'",
      "s3 = f\"{y:#x} {dict(a='#')['a']}\"",
      "SQL = \"\"\"SELECT '# not a comment' FROM t\"\"\"",
      "def fn(default: str = '''not a docstring''') -> str:",
      "    items = [\"\"\"a\"\"\", '''b''']",
      "    if default:",
      "        \"\"\"not a docstring inside if\"\"\"",
      "    raw = \"\"\"hello\"\"\".strip()",
      "    return \"\"\"value\"\"\" + raw + items[0]"
    ].join("\n");
    const cleanFound = scanPythonComments(cleanPy);
    expect(cleanFound.length).toBe(6);
    for (const c of cleanFound) {
      expect(isAllowedDirective(c), c.text).toBe(true);
    }

    const dirtyPy = [
      "#!/usr/bin/env python3",
      "\"\"\"module docstring\"\"\"",
      "# plain python comment",
      "# prose mentioning noqa",
      "# prose mentioning type: ignore",
      "# -*- coding: utf-8 -*-",
      "x = 1  # inline comment",
      "@decorator",
      "class Demo:",
      "    '''class docstring'''",
      "    async def run(self, cfg: dict[str, int] = {\"a\": 1}) -> None:",
      "        r\"\"\"async method docstring\"\"\"",
      "        pass",
      "def oneline(): \"\"\"inline docstring\"\"\"; return 1"
    ].join("\n");
    const dirtyFound = scanPythonComments(dirtyPy);
    const disallowed = dirtyFound.filter((c) => !isAllowedDirective(c));
    expect(disallowed.map((c) => ({ type: c.type, startLine: c.startLine, text: c.text }))).toEqual([
      { type: "python-docstring", startLine: 2, text: "\"\"\"module docstring\"\"\"" },
      { type: "python-line", startLine: 3, text: "# plain python comment" },
      { type: "python-line", startLine: 4, text: "# prose mentioning noqa" },
      { type: "python-line", startLine: 5, text: "# prose mentioning type: ignore" },
      { type: "python-line", startLine: 6, text: "# -*- coding: utf-8 -*-" },
      { type: "python-line", startLine: 7, text: "# inline comment" },
      { type: "python-docstring", startLine: 10, text: "'''class docstring'''" },
      { type: "python-docstring", startLine: 12, text: "r\"\"\"async method docstring\"\"\"" },
      { type: "python-docstring", startLine: 14, text: "\"\"\"inline docstring\"\"\"" }
    ]);
  });

  it("collects .html, .svg, .py, and code files while respecting exclusion rules in checkNoComments", () => {
    const tmpDir = fs.mkdtempSync(path.resolve(os.tmpdir(), "no-comments-guard-"));
    try {
      fs.writeFileSync(path.resolve(tmpDir, "page.html"), "<div><!-- html bad --></div>\n");
      fs.writeFileSync(path.resolve(tmpDir, "icon.svg"), "<svg><!-- svg bad --></svg>\n");
      fs.writeFileSync(path.resolve(tmpDir, "tool.py"), "#!/usr/bin/env python3\n# py bad\nx = 1\n");
      fs.writeFileSync(path.resolve(tmpDir, "tpl.ts"), "export const s = `<div><!-- tpl bad --></div>`;\n");
      fs.writeFileSync(path.resolve(tmpDir, "skip.generated.ts"), "// ignored generated\n");
      fs.mkdirSync(path.resolve(tmpDir, "dist"));
      fs.writeFileSync(path.resolve(tmpDir, "dist", "ignored.html"), "<!-- ignored -->\n");
      fs.mkdirSync(path.resolve(tmpDir, "extension", "entry", "chunks"), { recursive: true });
      fs.writeFileSync(path.resolve(tmpDir, "extension", "entry", "chunks", "c.js"), "// ignored\n");
      fs.mkdirSync(path.resolve(tmpDir, "eval"), { recursive: true });
      fs.writeFileSync(path.resolve(tmpDir, "eval", "run.mjs"), "// ignored\n");

      const result = checkNoComments(tmpDir);
      expect(result.filesChecked).toBe(4);
      expect(result.violations.map((v) => `${v.file}:${v.line}`).sort()).toEqual([
        "icon.svg:1",
        "page.html:1",
        "tool.py:2",
        "tpl.ts:1"
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
