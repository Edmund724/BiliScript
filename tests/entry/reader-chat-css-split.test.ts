import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const READER_CSS = "extension/entry/styles/reader.css";
const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const INJECTOR = "extension/shared/style-injector.ts";
const UI_RENDERER = "extension/ui/ui-renderer.ts";
const CHAT_TAB = "extension/reader/chat-tab.ts";

const CHAT_MARKERS = [
  "chat-hero",
  "chat-model-panel",
  "chat-thinking",
  "chat-suggestions",
  "chat-history-",
  "chat-center-error",
  "chat-timestamp-link",
  "chat-send-btn"
];

describe("对话分区 CSS 拆分（arch-slim-4/07）", () => {
  it("reader.css 不含对话分区 .chat-* 规则（守卫回流）", () => {
    const text = read(READER_CSS);
    for (const marker of CHAT_MARKERS) {
      expect(text.includes(marker), `${READER_CSS} 仍含对话分区标记 ${marker}`).toBe(false);
    }
  });

  it("reader-chat.css 持有全部对话分区标记", () => {
    const text = read(CHAT_CSS);
    for (const marker of CHAT_MARKERS) {
      expect(text.includes(marker), `${CHAT_CSS} 缺少标记 ${marker}`).toBe(true);
    }
  });

  it("壳常驻分区留守 reader.css（intent 卡 + 三 tab 共享滚动条）", () => {
    const text = read(READER_CSS);
    expect(text.includes("biliscript-reading-chat-intent")).toBe(true);
    expect(text).toMatch(/\.biliscript-reading-chat \.chat-messages::-webkit-scrollbar/);
  });

  it("style-injector 暴露对话表挂载原语与三份路径（无 onload 门控）", () => {
    const injector = read(INJECTOR);
    expect(injector).toMatch(/export function ensureReaderChatStyles/);
    expect(injector).toMatch(/entry\/styles\/reader-chat\.css/);
    const CHAT_STYLE_PATHS = [
      "entry/styles/github-markdown.css",
      "entry/styles/github-markdown-theme.css",
      "entry/styles/reader-chat.css"
    ];
    let cursor = -1;
    for (const path of CHAT_STYLE_PATHS) {
      const at = injector.indexOf(path);
      expect(at, `${INJECTOR} 缺少对话表路径 ${path}`).toBeGreaterThan(-1);
      expect(at, `${INJECTOR} 对话表路径 ${path} 顺序与 READER_CHAT_STYLE_PATHS 不符`).toBeGreaterThan(
        cursor
      );
      cursor = at;
    }
  });

  it("两个挂载点在场：setReaderScriptTab chat 分支 + chat-tab 模块顶兜底", () => {
    const renderer = read(UI_RENDERER);
    expect(renderer).toMatch(/if \(tab === "chat"\)\s*\{\s*ensureReaderChatStyles\(\);/);
    const chatTab = read(CHAT_TAB);
    expect(chatTab).toMatch(/^ensureReaderChatStyles\(\);/m);
  });
});

describe("长回复屏外段落跳过渲染（M13）", () => {
  const BLOCKS = ["p", "h3", "h4", "h5", "h6", "ul", "ol", "pre", "table", "blockquote", "hr"];

  const findRule = (cssText: string, selector: string) =>
    (cssText.replace(/\/\*[\s\S]*?\*\//g, "").match(/[^{}]+\{[^}]*\}/g) || []).find((rule) => {
      const [head, body] = rule.split("{");
      return (
        head
          .split(",")
          .map((part: string) => part.trim())
          .includes(selector) && body.includes("content-visibility: auto")
      );
    });

  it("reader-chat.css 对话区 markdown 块级容器逐块 c-v:auto + auto 记忆占位（流式消息豁免）", () => {
    const css = read(CHAT_CSS);
    for (const block of BLOCKS) {
      const rule = findRule(css, `.biliscript-reading-chat .chat-msg-assistant:not(.chat-msg-streaming) ${block}`);
      expect(rule, `chat 分区缺块级 c-v 规则: ${block}`).toBeTruthy();
      expect(rule).toMatch(/contain-intrinsic-size: auto none auto \d+px;/);
    }
  });

  it("reader.css 解释卡同步逐块 c-v:auto；概览条目统一为 auto 记忆 + none 宽占位", () => {
    const css = read(READER_CSS);
    for (const block of BLOCKS) {
      const rule = findRule(css, `.biliscript-reading-explain-card-answer ${block}`);
      expect(rule, `解释卡缺块级 c-v 规则: ${block}`).toBeTruthy();
      expect(rule).toMatch(/contain-intrinsic-size: auto none auto \d+px;/);
    }
    expect(css).toMatch(
      /\.biliscript-reading-item \{[^}]*contain-intrinsic-size: auto none auto var\(--biliscript-reader-item-estimate, 44px\);/s
    );
  });
});

describe("对话域分割线样式", () => {
  it("reader-chat.css 对话域 hr 覆盖 height:1px / margin:16px 0", () => {
    const css = read(CHAT_CSS);
    const rule = (css.replace(/\/\*[\s\S]*?\*\//g, "").match(/[^{}]+\{[^}]*\}/g) || []).find((r) => {
      const [head] = r.split("{");
      return head.trim() === ".biliscript-reading-chat .markdown-body hr";
    });
    expect(rule, `${CHAT_CSS} 缺对话域 hr 瘦身规则`).toBeTruthy();
    expect(rule).toMatch(/height: 1px;/);
    expect(rule).toMatch(/margin: 16px 0;/);
  });

  it("解释卡域（reader.css）无 markdown-body hr 高度覆盖", () => {
    const css = read(READER_CSS).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/\.markdown-body hr\s*\{/);
  });
});

describe("历史内容模式投影", () => {
  it("同一 hidden 隐藏标签行和对话内容，直接切换而无透明叠字", () => {
    const css = read(CHAT_CSS);
    const start = css.indexOf(
      "#biliscript-reading-view .biliscript-reading-script-panel:has(#biliscript-reading-tab-body-chat.is-active):has(.chat-history-popover:not([hidden])) > .biliscript-reading-tabs-row"
    );
    const end = css.indexOf(".biliscript-reading-chat .chat-history-popover-head", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = css.slice(start, end);
    expect(block).toContain(":has(.chat-history-popover:not([hidden])) > .biliscript-reading-tabs-row");
    expect(block).toContain(
      ".biliscript-reading-chat:has(> .chat-history-popover:not([hidden])) > :not(.chat-history-popover)"
    );
    expect(block).not.toContain("~");
    expect(block).not.toMatch(/opacity|transition|@starting-style/);
  });
});
