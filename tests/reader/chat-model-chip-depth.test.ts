// tests/reader/chat-model-chip-depth.test.ts
// chip 的「模型名 / 思考档位」两级深浅（2026-10-05 用户裁定）：两级同色时 chip 读起来
// 是一串平铺文字，看不出「模型 + 当前档位」的两段结构；参考截图里档位恒比模型名浅。
//
// 本文件挡住的退化：
// 1. 档位 span 丢掉自己的 color，回落 chip 的 color → 两级同色，深浅差消失；
// 2. 档位 span 直接写 --biliscript-reader-text（就是模型名的那一级）→ 同上；
// 3. chevron 回到 currentColor → 它比紧邻的档位更重，主次反了；面板一级行的
//    「当前值 + chevron」是 muted + faint 一组，chip 必须同配色。
// 4. chip 高度偏离 28px（与联网搜索开关 28px 高度对齐契约）；
// 5. chip 丢失 999px 胶囊圆角与 background 过渡；
// 6. hover / focus-visible / is-open 状态丢失 --biliscript-reader-fill-hover 胶囊底色反馈。
// 色值本身（muted/faint 在各主题的具体 hex）由 reader-gate.css 的主题块持有，
// 本文件只锁 chip 引用的是哪两个 token（同 chat-input-autosize.test.ts 的局限：
// jsdom 不算样式）。视觉差由真模板真样式的
// .scratch/tickets/chat-thinking-submenu/prototypes/real-panel-check.html 截图兜。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const CHIP = ".biliscript-reading-chat .chat-model-chip";
const CHIP_LEVEL = ".biliscript-reading-chat .chat-model-chip-level";

function readChatCss(): string {
  return readFileSync(join(ROOT, CHAT_CSS), "utf8");
}

// 规则块抽取：剥除注释并支持多选择器逗号切分匹配，按选择器定位 `{ ... }`。
function ruleBody(css: string, selector: string): string {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = text.match(/[^{}]+\{[^}]*\}/g) || [];
  const matched = rules.find((rule) => {
    const [head] = rule.split("{");
    return head
      .split(",")
      .map((part) => part.trim())
      .includes(selector);
  });
  if (matched) {
    return matched.split("{")[1].replace(/\}[^}]*$/, "");
  }
  const escaped = selector.replace(/[.#*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `reader-chat.css 中应有 ${selector} 规则块`).not.toBe(null);
  return match![1];
}

function declarationBody(block: string, prop: string): string {
  const match = block.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`));
  expect(match, `规则块里应有 ${prop} 声明`).not.toBe(null);
  return match![1].trim();
}

describe("chip 主次：模型名持正文字色，档位退 muted", () => {
  it("chip 自身定正文字色（模型名 span 不另写色，继承即最深的一级）", () => {
    expect(declarationBody(ruleBody(readChatCss(), CHIP), "color")).toBe(
      "var(--biliscript-reader-text)"
    );
  });

  it("档位 span 单独写 muted：不与模型名同色", () => {
    expect(declarationBody(ruleBody(readChatCss(), CHIP_LEVEL), "color")).toBe(
      "var(--biliscript-reader-muted)"
    );
  });
});

describe("chip chevron 与档位同组（faint，不再吃 currentColor）", () => {
  it("chevron 用 faint，与面板一级行的「当前值 + chevron」同配色", () => {
    expect(declarationBody(ruleBody(readChatCss(), `${CHIP} svg`), "stroke")).toBe(
      "var(--biliscript-reader-faint)"
    );
  });
});

describe("chip 几何与交互反馈（底栏对齐与胶囊交互态契约）", () => {
  it("chip 高度为 28px，与联网搜索开关 28px 对齐", () => {
    expect(declarationBody(ruleBody(readChatCss(), CHIP), "height")).toBe("28px");
  });

  it("具备 999px 胶囊圆角与 background 0.15s ease-out 过渡", () => {
    const chipBlock = ruleBody(readChatCss(), CHIP);
    expect(declarationBody(chipBlock, "border-radius")).toMatch(/^(?:var\(--(?:chip-radius|biliscript-radius-pill).*\)|999px)$/);
    expect(declarationBody(chipBlock, "transition")).toContain("background 0.15s ease-out");
  });

  it("在 :hover、:focus-visible 及展开态 .is-open 下均呈现 --biliscript-reader-fill-hover 底色反馈", () => {
    const css = readChatCss();
    expect(declarationBody(ruleBody(css, `${CHIP}:hover`), "background")).toBe(
      "var(--biliscript-reader-fill-hover)"
    );
    expect(declarationBody(ruleBody(css, `${CHIP}:focus-visible`), "background")).toBe(
      "var(--biliscript-reader-fill-hover)"
    );
    expect(declarationBody(ruleBody(css, `${CHIP}.is-open`), "background")).toBe(
      "var(--biliscript-reader-fill-hover)"
    );
  });
});
