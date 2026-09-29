// tab body 可见性 CSS 源守卫（候选 06）。
//
// 字幕 tab body 的隐藏通道只允许三条：reader.css 的 :not(.is-active) 与
// [hidden]（reader/state.ts 的 readingActiveScriptTab 投影）、
// reader-settings-shell.css 的设置抽屉兄弟选择器（readingSettingsExpanded 投影）。
// 判定侧（sync 的 250ms tick）已改为只读状态位；CSS 读不到状态，两侧靠「投影
// 单点写出」对齐——本守卫钉住 CSS 这一半：任何新增的隐藏规则都必须在此显式
// 登记，否则「改 CSS 悄悄让 tick 往不可见字幕列表继续写」的旧病会回来。
//
// 祖先门（#biliscript-reading-view 去 .open / ready=0 时 display:none 与
// visibility:hidden）不在本守卫范围：它由 readingViewOpen（阅读壳状态机单写）
// 覆盖，锁在 shell-state-machine 测试里。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const STYLE_DIR = join(process.cwd(), "extension/entry/styles");
const TAB_BODY = ".biliscript-reading-tab-body";

// 允许的隐藏通道（归一化后的单条选择器，逐条登记）
const EXPECTED = [
  ".biliscript-reading-tab-body:not(.is-active)",
  ".biliscript-reading-tab-body[hidden]",
  "#biliscript-reading-view .biliscript-reading-settings-panel:not([hidden]) ~ .biliscript-reading-tab-body"
];

// 从 CSS 源里挖出「主体就是 tab body 自身且声明块含 display:none」的规则。
// 只取选择器文本到其规则开括号之间的一段（够用且不受 @media 嵌套影响：
// 嵌套里的隐藏规则会被挖出来并因不在登记表内而失败——这正是守卫想要的）。
// 主体判定 = 选择器末段（按组合符/空白切开取最后一段）以 .biliscript-reading-tab-body
// 开头：子元素上的 display:none（如转写期压掉 follow 按钮）不属本守卫范围。
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
