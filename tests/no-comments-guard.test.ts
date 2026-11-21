import { describe, expect, it } from "vitest";
import {
  checkNoComments,
  isAllowedDirective,
  RATCHET_EXEMPT_FILES,
  RATCHET_EXEMPT_PREFIXES,
  scanComments,
  scanCssComments
} from "../scripts/check-no-comments.mjs";

describe("no-comments guard", () => {
  it("reports zero disallowed comments across all repository code, .d.ts, and CSS files", () => {
    expect(RATCHET_EXEMPT_FILES.size).toBe(0);
    expect(RATCHET_EXEMPT_PREFIXES).toEqual([]);
    const result = checkNoComments(process.cwd());
    expect(result.filesChecked).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  it("blocks regular line/block comments, bare @ts-expect-error, @ts-ignore, @ts-nocheck, and prose dual-instance comments", () => {
    const samples = [
      "// plain comment\nconst x = 1;",
      "/* block comment */\nconst x = 1;",
      "// @ts-expect-error\nconst x: number = 'a';",
      "// @ts-ignore legacy\nconst x = 1;",
      "// @ts-nocheck\nconst x = 1;",
      "// BILISCRIPT_DUAL_INSTANCE_STATEFUL extra prose not allowed\nconst x = 1;",
      `// ${"@vitest-environment"} invalid\nconst x = 1;`
    ];
    for (const sample of samples) {
      const comments = scanComments(sample);
      expect(comments.length).toBe(1);
      expect(isAllowedDirective(comments[0]), sample).toBe(false);
    }
  });

  it("allows whitelisted machine directives, @vitest-environment, and explained @ts-expect-error", () => {
    const samples = [
      "#!/usr/bin/env node\nconst x = 1;",
      "/// <reference types=\"chrome\" />\nconst x = 1;",
      "// BILISCRIPT_DUAL_INSTANCE_STATEFUL\nconst x = 1;",
      `// ${"@vitest-environment"} node\nconst x = 1;`,
      `// ${"@vitest-environment"} jsdom\r\nconst x = 1;`,
      `/* ${"@vitest-environment"} jsdom */\nconst x = 1;`,
      "/* @jsxImportSource react */\nconst x = 1;",
      "/* @vite-ignore */\nconst x = 1;",
      "/* v8 ignore next */\nconst x = 1;",
      "/* c8 ignore start */\nconst x = 1;",
      "/* istanbul ignore next */\nconst x = 1;",
      "// prettier-ignore\nconst x = 1;",
      "/* @license MIT */\nconst x = 1;",
      "// DO NOT EDIT\nconst x = 1;",
      "// @ts-expect-error intentional negative type test\nconst x = 1;",
      "// eslint-disable-next-line no-console\nconst x = 1;"
    ];
    for (const sample of samples) {
      const comments = scanComments(sample);
      expect(comments.length).toBe(1);
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
});
