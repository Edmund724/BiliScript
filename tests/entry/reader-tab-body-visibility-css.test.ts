import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const STYLE_DIR = join(process.cwd(), "extension/entry/styles");
const TAB_BODY = ".biliscript-reading-tab-body";

const EXPECTED = [
  ".biliscript-reading-tab-body:not(.is-active)",
  ".biliscript-reading-tab-body[hidden]",
  "#biliscript-reading-view .biliscript-reading-settings-panel:not([hidden]) ~ .biliscript-reading-tab-body"
];

function collectHidingSelectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: string[] = [];
  let idx = text.indexOf(TAB_BODY);
  while (idx !== -1) {
    const open = text.indexOf("{", idx);
    if (open !== -1) {
      const prevClose = text.lastIndexOf("}", open);
      const selectorText = text.slice(prevClose + 1, open);
      const close = text.indexOf("}", open);
      const declarations = close === -1 ? "" : text.slice(open + 1, close);
      if (selectorText.includes(TAB_BODY) && /display\s*:\s*none/.test(declarations)) {
        for (const part of selectorText.split(",")) {
          const selector = part.replace(/\s+/g, " ").trim();
          const subject = selector.split(/[\s>+~]+/).filter(Boolean).pop() ?? "";
          if (subject.startsWith(TAB_BODY)) {
            found.push(selector);
          }
        }
      }
    }
    idx = text.indexOf(TAB_BODY, idx + TAB_BODY.length);
  }
  return found;
}

describe("tab body 可见性 CSS 源守卫（候选 06）", () => {
  it("能压掉 .biliscript-reading-tab-body 的规则只有登记的三条", () => {
    const found = new Set<string>();
    for (const file of readdirSync(STYLE_DIR).filter((name) => name.endsWith(".css"))) {
      for (const selector of collectHidingSelectors(readFileSync(join(STYLE_DIR, file), "utf8"))) {
        found.add(selector);
      }
    }
    expect([...found].sort()).toEqual([...EXPECTED].sort());
  });
});
