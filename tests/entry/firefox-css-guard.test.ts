// Firefox CSS 适配守卫：
// 1. 严禁在 @supports (-moz-appearance: none) 块外裸写 scrollbar-width / scrollbar-color
//    （Chrome 121+ 会因标准滚动条属性跳过 ::-webkit-scrollbar，回退 Windows 原生粗灰条）。
// 2. 6 份定制滚动条的样式表均需在 @supports (-moz-appearance: none) 内提供细滚动条声明。
// 3. 设置抽屉、对话更多菜单与伴看浮窗的 range 滑块均需补齐 ::-moz-range-track 与 ::-moz-range-thumb。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripCssComments } from "./css-token-test-utils.js";

const STYLES_DIR = join(process.cwd(), "extension/entry/styles");
const MOZ_SUPPORTS_HEADER = "@supports (-moz-appearance: none)";

function listStyleFiles(): string[] {
  return readdirSync(STYLES_DIR)
    .filter((name) => name.endsWith(".css"))
    .sort();
}

function readStyle(fileName: string): string {
  return stripCssComments(readFileSync(join(STYLES_DIR, fileName), "utf8"));
}

function findUnscopedScrollbarProps(fileName: string): string[] {
  const css = readStyle(fileName);
  const violations: string[] = [];
  const scopeStack: boolean[] = [];
  let pendingHeader = "";
  let i = 0;

  while (i < css.length) {
    const ch = css[i];
    if (ch === "{") {
      const parentInMoz = scopeStack.length > 0 && scopeStack[scopeStack.length - 1];
      const isMozBlock = pendingHeader.trim() === MOZ_SUPPORTS_HEADER;
      scopeStack.push(parentInMoz || isMozBlock);
      pendingHeader = "";
      i += 1;
      continue;
    }
    if (ch === "}") {
      const inMoz = scopeStack[scopeStack.length - 1] ?? false;
      if (!inMoz && /\bscrollbar-(?:width|color)\s*:/.test(pendingHeader)) {
        violations.push(`${fileName}: ${pendingHeader.trim()}`);
      }
      scopeStack.pop();
      pendingHeader = "";
      i += 1;
      continue;
    }
    if (ch === ";") {
      const inMoz = scopeStack[scopeStack.length - 1] ?? false;
      if (!inMoz && /\bscrollbar-(?:width|color)\s*:/.test(pendingHeader)) {
        violations.push(`${fileName}: ${pendingHeader.trim()}`);
      }
      pendingHeader = "";
      i += 1;
      continue;
    }
    pendingHeader += ch;
    i += 1;
  }

  return violations;
}

function collectAllUnscopedScrollbarProps(): string[] {
  return listStyleFiles().flatMap(findUnscopedScrollbarProps);
}

describe("Firefox CSS 渐进适配守卫", () => {
  it("所有样式表中 scrollbar-width 与 scrollbar-color 仅允许出现在 @supports (-moz-appearance: none) 块内", () => {
    expect(collectAllUnscopedScrollbarProps()).toEqual([]);
  });

  it("6 份定制滚动条的样式表均在 @supports (-moz-appearance: none) 内提供细滚动条声明", () => {
    const expectedFiles = [
      "reader.css",
      "reader-settings-shell.css",
      "reader-settings-rows.css",
      "reader-chat.css",
      "bilingual-subtitles.css",
      "player-ai.css"
    ];

    const missing = expectedFiles.filter((file) => {
      const css = readStyle(file);
      return !css.includes(MOZ_SUPPORTS_HEADER) || !/\bscrollbar-width\s*:/.test(css);
    });

    expect(missing).toEqual([]);
  });

  it("range 滑块样式表均补齐 ::-moz-range-track 与 ::-moz-range-thumb", () => {
    const sliderFiles = [
      "reader-settings-rows.css",
      "reader-chat.css",
      "player-ai.css"
    ];

    const missing = sliderFiles.filter((file) => {
      const css = readStyle(file);
      return !css.includes("::-moz-range-track") || !css.includes("::-moz-range-thumb");
    });

    expect(missing).toEqual([]);
  });
});
