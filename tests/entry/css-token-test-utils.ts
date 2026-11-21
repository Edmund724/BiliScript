import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

const ROOT = process.cwd();

export function readStyleFile(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

export function stripCssCommentsKeepLines(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    return match.replace(/[^\r\n]/g, " ");
  });
}

export function normalizeCss(css: string): string {
  return stripCssComments(css)
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
}

export function extractBlock(css: string, tailSelector: string, headStartsWith?: string): string {
  const text = stripCssComments(css);
  const rules = text.match(/[^{}]+\{[^}]*\}/g) || [];
  const hit = rules.find((rule) => {
    const head = rule.split("{")[0].trim();
    return head.endsWith(tailSelector) && (!headStartsWith || head.startsWith(headStartsWith));
  });
  expect(hit, `应存在以 ${tailSelector} 结尾的规则块`).not.toBeUndefined();
  return hit!.split("{")[1];
}

export function extractDeclarations(css: string, property: string): { selector: string; value: string }[] {
  const text = stripCssComments(css);
  const rules = text.match(/[^{}]+\{[^}]*\}/g) || [];
  const results: { selector: string; value: string }[] = [];
  const regex = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;{}]+)`, "g");

  for (const rule of rules) {
    const [head, body] = rule.split("{");
    const selector = head.trim();
    let m: RegExpExecArray | null;
    while ((m = regex.exec(body)) !== null) {
      results.push({ selector, value: m[1].trim() });
    }
  }
  return results;
}
