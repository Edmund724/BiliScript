// tests/entry/css-token-test-utils.ts
// 样式表与 Token 测试公共解析与提取辅助工具。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

const ROOT = process.cwd();

/**
 * 读取相对于工程根目录的样式或源文件
 */
export function readStyleFile(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

/**
 * 剥除 CSS 中的全部注释块
 */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 移除全部跨行与单行注释，同时用空格和换行填充被移除区域，保证原始行号 1:1 维持
 */
export function stripCssCommentsKeepLines(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    return match.replace(/[^\r\n]/g, " ");
  });
}

/**
 * 规范化 CSS 字符串（去除注释、折叠多余空白）
 */
export function normalizeCss(css: string): string {
  return stripCssComments(css)
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
}

/**
 * 从 CSS 文本中提取指定选择器的规则块内部声明文本
 */
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

/**
 * 提取 CSS 中所有的特定属性声明键值对（忽略注释）
 */
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
