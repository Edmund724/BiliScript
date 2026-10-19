// tests/reader/liquid-glass-gemini.test.ts
// flyme-liquid-gemini-upgrade 票：flyme 色板液态玻璃材质升级 + 克制 Gemini 流光
// 触点的 CSS 契约。本文件锁四点：
//
// 1. token 契约（reader-gate.css 主题块）：--biliscript-reader-card 升级为 165deg
//    曲面透镜渐变；新增 --biliscript-reader-card-highlight（左上高光 + 右下冷色
//    反弹光的双对角线折射内高光 + 多层悬浮柔影）；--biliscript-reader-shadow
//    升级为三层悬浮柔影（明暗两档同结构、各取各档）；Gemini 四色虹彩流光 token
//    （gradient / gradient-soft / border-gradient / glow）明暗两档各一份。
// 2. 六处风格收敛：次级小按钮、悬浮跟随/解释胶囊与滚底圆钮、横幅/状态条、
//    面板内对话框在 flyme 下无 1px 灰框，统一液态玻璃卡片体系；带框图标开关
//    （联网搜索 pill）关态保留 1px 描边。
// 3. 六处 Gemini 触点：hero 徽标 / 概览徽标 / 输入卡聚焦环 / 思考滑块最高档 /
//    进度条与三点脉冲 / 播放器快捷按钮，全部以 :not([data-palette="editorial"])
//    门控，editorial 色板零侵入。
// 4. 无障碍降级：prefers-reduced-motion 停流光位移、prefers-reduced-transparency
//    与滚动期关停新增 backdrop-filter。
//
// 局限同 flyme-panel-layering.test.ts：jsdom 无布局，本文件只锁 CSS 源文本，
// 真实观感回归由真机 harness（scripts/browser-harness）兜。
// 防倒退：token 回平色、实线灰框复辟、Gemini 规则脱门控污染 editorial、降级
// 列表漏新组件，本文件红。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const GATE_CSS = "extension/entry/styles/reader-gate.css";
const READER_CSS = "extension/entry/styles/reader.css";
const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const PLAYER_AI_CSS = "extension/entry/styles/player-ai.css";

function readCss(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// 多行值归一为单行，断言不绑定书写换行与括号内侧空格。
function normalize(css: string): string {
  return stripComments(css)
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
}

// 主题块定位（与 flyme-panel-layering.test.ts 同口径）：gate 段每个色板块的
// 最后一个选择器是 #biliscript-reading-view 形态，按结尾特征区分块；浅色基础块
// 的裸结尾会与定位段（body[...] #biliscript-reading-view）撞尾，加头部前缀区分。
function themeBlock(tailSelector: string, headStartsWith?: string): string {
  const text = stripComments(readCss(GATE_CSS));
  const rules = text.match(/[^{}]+\{[^}]*\}/g) || [];
  const hit = rules.find((rule) => {
    const head = rule.split("{")[0].trim();
    return head.endsWith(tailSelector) && (!headStartsWith || head.startsWith(headStartsWith));
  });
  expect(hit, `应存在以 ${tailSelector} 结尾的主题块`).not.toBe(undefined);
  return normalize(hit!.split("{")[1]);
}

// 取「选择器恰好等于 selector」的那条规则块（head 逗号拆分精确匹配）。
function ruleBody(css: string, selector: string): string {
  const text = stripComments(css);
  const rules = text.match(/[^{}]+\{[^}]*\}/g) || [];
  const bodies = rules
    .map((rule) => {
      const [head, body] = rule.split("{");
      return { head: head.trim(), body };
    })
    .filter((rule) => rule.head.split(",").map((part) => part.trim()).includes(selector))
    .map((rule) => rule.body);
  expect(bodies.length, `应存在 ${selector} 规则`).toBeGreaterThan(0);
  return normalize(bodies.join("\n"));
}

const FLYME_LIGHT = () => themeBlock("#biliscript-reading-view", "html[data-biliscript-reader-mode=\"1\"]");
const FLYME_DARK = () => themeBlock("#biliscript-reading-view[data-theme=\"dark\"]");

describe("收敛 1/6：字幕工具栏与面板内次级按钮", () => {
  it("flyme：mini-btn 去 1px 灰框，液态玻璃卡面 + 折射高光", () => {
    const body = ruleBody(
      readCss(GATE_CSS),
      "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-mini-btn"
    );
    expect(body).toContain("border-color: transparent");
    expect(body).toContain("background: var(--biliscript-reader-card)");
    expect(body).toContain("box-shadow: var(--biliscript-reader-card-highlight)");
  });

  it("flyme：mini-btn 悬停 accent-soft 底 + accent 字", () => {
    const body = ruleBody(
      readCss(GATE_CSS),
      "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-mini-btn:hover"
    );
    expect(body).toContain("background: var(--biliscript-reader-accent-soft)");
    expect(body).toContain("color: var(--biliscript-reader-accent)");
  });

  it("editorial：mini-btn 走基表，保留 1px 实线描边", () => {
    const base = ruleBody(readCss(READER_CSS), ".biliscript-reading-mini-btn");
    expect(base).toContain("border: 1px solid var(--biliscript-reader-border)");
  });

  it("字幕工具栏选轨触发器（custom-select trigger）已在无边框玻璃控件族内", () => {
    const body = ruleBody(
      readCss(GATE_CSS),
      "body[data-biliscript-reader-mode=\"1\"] #biliscript-reading-view .custom-select-trigger"
    );
    expect(body).toContain("border: none");
  });
});

describe("收敛 2/6：悬浮胶囊与滚底圆钮（跟随播放 / 选区解释 / 滚底）", () => {
  const PILL_LIGHT = [
    "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-follow-btn",
    "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-explain-btn",
    "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-chat .chat-scroll-bottom"
  ];
  const PILL_DARK = [
    "#biliscript-reading-view[data-theme=\"dark\"]:not([data-palette=\"editorial\"]) .biliscript-reading-follow-btn",
    "#biliscript-reading-view[data-theme=\"dark\"]:not([data-palette=\"editorial\"]) .biliscript-reading-explain-btn",
    "#biliscript-reading-view[data-theme=\"dark\"]:not([data-palette=\"editorial\"]) .biliscript-reading-chat .chat-scroll-bottom"
  ];

  it("flyme 浅色：去框 + 液态玻璃卡面 + blur(20px) saturate(180%) 磨砂 + 顶沿折射高光与漫射浮层阴影", () => {
    const gate = readCss(GATE_CSS);
    for (const sel of PILL_LIGHT) {
      const body = ruleBody(gate, sel);
      expect(body, sel).toContain("border-color: transparent");
      expect(body, sel).toContain("background: var(--biliscript-reader-card)");
      expect(body, sel).toContain("-webkit-backdrop-filter: blur(20px) saturate(180%)");
      expect(body, sel).toContain("backdrop-filter: blur(20px) saturate(180%)");
      expect(body, sel).toContain("inset 0 1px 0 rgba(255, 255, 255, 0.92)");
      expect(body, sel).toContain("0 10px 28px -4px rgba(15, 23, 42, 0.16)");
      expect(body, sel).toContain("0 2px 6px rgba(15, 23, 42, 0.06)");
    }
  });

  it("flyme 深色：暗面内高光与漫射浮层阴影换档", () => {
    const gate = readCss(GATE_CSS);
    for (const sel of PILL_DARK) {
      const body = ruleBody(gate, sel);
      expect(body, sel).toContain("inset 0 1px 0 rgba(255, 255, 255, 0.18)");
      expect(body, sel).toContain("0 10px 28px -4px rgba(0, 0, 0, 0.5)");
      expect(body, sel).toContain("0 2px 6px rgba(0, 0, 0, 0.3)");
    }
  });

  it("follow-btn 基态 translateX(-50%) 与按压缩放链不变（玻璃化不碰 transform）", () => {
    const base = ruleBody(readCss(READER_CSS), ".biliscript-reading-follow-btn");
    expect(base).toContain("transform: translateX(-50%)");
    const active = ruleBody(readCss(READER_CSS), ".biliscript-reading-follow-btn:active");
    expect(active).toContain("translateX(-50%) scale(var(--biliscript-reader-press-scale, 1))");
    const gate = readCss(GATE_CSS);
    for (const sel of [...PILL_LIGHT, ...PILL_DARK]) {
      if (sel.includes("follow-btn")) {
        expect(ruleBody(gate, sel), "follow-btn 覆写不含 transform").not.toContain("transform");
      }
    }
  });

  it("降级：减弱透明度与滚动期关停三件套的 backdrop-filter", () => {
    const gate = readCss(GATE_CSS);
    const reduced = gate.match(/@media\s*\(prefers-reduced-transparency:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(reduced, "gate 必须含 prefers-reduced-transparency 块").not.toBeNull();
    for (const cls of [".biliscript-reading-follow-btn", ".biliscript-reading-explain-btn", ".chat-scroll-bottom"]) {
      expect(reduced![1], `减弱透明度块缺 ${cls}`).toContain(cls);
    }

    const scrollRules = gate.match(/#biliscript-reading-view\[data-biliscript-script-scrolling="1"\][^{]*\{[^}]*\}/g) || [];
    const merged = scrollRules.join("\n");
    for (const cls of [".biliscript-reading-follow-btn", ".biliscript-reading-explain-btn", ".chat-scroll-bottom"]) {
      expect(merged, `滚动降级缺 ${cls}`).toContain(cls);
    }
  });

  it("editorial：三件套走基表，保留 1px 实线描边且无 backdrop-filter", () => {
    expect(ruleBody(readCss(READER_CSS), ".biliscript-reading-follow-btn")).toContain(
      "border: 1px solid var(--biliscript-reader-border)"
    );
    expect(ruleBody(readCss(READER_CSS), ".biliscript-reading-explain-btn")).toContain(
      "border: 1px solid var(--biliscript-reader-border)"
    );
    const scrollBottom = ruleBody(readCss(CHAT_CSS), ".biliscript-reading-chat .chat-scroll-bottom");
    expect(scrollBottom).toContain("border: 1px solid var(--biliscript-reader-border)");
    expect(scrollBottom).not.toContain("backdrop-filter");
  });

  it("flyme hover：门控基态特异度高于基表 :hover，须同门控重申悬停母题（胶囊 accent-soft/accent，滚底钮 surface-2/text）", () => {
    const gate = readCss(GATE_CSS);
    for (const sel of [
      "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-follow-btn:hover",
      "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-explain-btn:hover"
    ]) {
      const body = ruleBody(gate, sel);
      expect(body, sel).toContain("background: var(--biliscript-reader-accent-soft)");
      expect(body, sel).toContain("color: var(--biliscript-reader-accent)");
    }
    const scroll = ruleBody(
      gate,
      "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-chat .chat-scroll-bottom:hover"
    );
    expect(scroll).toContain("background: var(--biliscript-reader-surface-2)");
    expect(scroll).toContain("color: var(--biliscript-reader-text)");
  });
});

describe("收敛 3/6：横幅与状态通知条", () => {
  const BANNER_LIGHT = [
    "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-asr-banner",
    "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-ov-strip",
    "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-chat-intent",
    "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-chat .chat-context-notice",
    "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-chat .chat-asr-notice",
    "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-chat .chat-msg-error"
  ];

  it("flyme 浅色：六条通知条去外圈灰框 + 顶沿内高光 + 极轻外影", () => {
    const gate = readCss(GATE_CSS);
    for (const sel of BANNER_LIGHT) {
      const body = ruleBody(gate, sel);
      expect(body, sel).toContain("border-color: transparent");
      expect(body, sel).toContain("inset 0 1px 0 rgba(255, 255, 255, 0.75)");
      expect(body, sel).toContain("0 2px 8px rgba(15, 23, 42, 0.03)");
    }
  });

  it("chat-intent 保留左缘 3px accent 强调竖条，仅其余三边去框", () => {
    const body = ruleBody(
      readCss(GATE_CSS),
      "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-chat-intent"
    );
    expect(body).toContain("border-left-color: var(--biliscript-reader-accent)");
  });

  it("flyme 深色：暗面内高光与投影换档", () => {
    const gate = readCss(GATE_CSS);
    for (const sel of BANNER_LIGHT.map((s) => s.replace("#biliscript-reading-view:not", "#biliscript-reading-view[data-theme=\"dark\"]:not"))) {
      const body = ruleBody(gate, sel);
      expect(body, sel).toContain("inset 0 1px 0 rgba(255, 255, 255, 0.12)");
      expect(body, sel).toContain("0 2px 8px rgba(0, 0, 0, 0.2)");
    }
  });

  it("editorial：六条通知条走基表，保留 1px 实线描边", () => {
    expect(ruleBody(readCss(READER_CSS), ".biliscript-reading-asr-banner")).toContain(
      "border: 1px solid var(--biliscript-reader-border)"
    );
    expect(ruleBody(readCss(READER_CSS), ".biliscript-reading-ov-strip")).toContain(
      "border: 1px solid var(--biliscript-reader-border)"
    );
    expect(ruleBody(readCss(READER_CSS), ".biliscript-reading-chat-intent")).toContain(
      "border: 1px solid var(--biliscript-reader-border)"
    );
    expect(ruleBody(readCss(CHAT_CSS), ".biliscript-reading-chat .chat-context-notice")).toContain(
      "border: 1px solid var(--biliscript-reader-border)"
    );
    expect(ruleBody(readCss(CHAT_CSS), ".biliscript-reading-chat .chat-asr-notice")).toContain(
      "border: 1px solid var(--biliscript-reader-border)"
    );
    expect(ruleBody(readCss(CHAT_CSS), ".biliscript-reading-chat .chat-msg-error")).toContain(
      "border: 1px solid var(--biliscript-reader-border)"
    );
  });
});

describe("收敛 4/6：面板内弹层对话框（解释卡 / 二次确认）", () => {
  it("flyme：去框 + 液态玻璃卡面 + blur(24px) saturate(180%) 磨砂 + 悬浮柔影 token", () => {
    const gate = readCss(GATE_CSS);
    for (const sel of [
      "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-explain-card-dialog",
      "#biliscript-reading-view:not([data-palette=\"editorial\"]) .confirm-dialog"
    ]) {
      const body = ruleBody(gate, sel);
      expect(body, sel).toContain("border-color: transparent");
      expect(body, sel).toContain("background: var(--biliscript-reader-card)");
      expect(body, sel).toContain("-webkit-backdrop-filter: blur(24px) saturate(180%)");
      expect(body, sel).toContain("backdrop-filter: blur(24px) saturate(180%)");
      expect(body, sel).toContain("box-shadow: var(--biliscript-reader-shadow)");
    }
  });

  it("flyme：确认弹层取消键去框改 surface-2 底", () => {
    const body = ruleBody(
      readCss(GATE_CSS),
      "#biliscript-reading-view:not([data-palette=\"editorial\"]) .confirm-dialog-cancel"
    );
    expect(body).toContain("border-color: transparent");
    expect(body).toContain("background: var(--biliscript-reader-surface-2)");
  });

  it("解释卡不再有无门控的玻璃/卡面规则（降级规则除外）", () => {
    const gate = stripComments(readCss(GATE_CSS));
    const rules = gate.match(/[^{}]+\{[^}]*\}/g) || [];
    const hits = rules.filter((r) => r.split("{")[0].includes(".biliscript-reading-explain-card-dialog"));
    expect(hits.length).toBeGreaterThan(0);
    for (const r of hits) {
      const head = r.split("{")[0];
      const body = r.split("{")[1];
      const isGated = head.includes(":not([data-palette=\"editorial\"])") || head.includes("[data-palette=\"editorial\"]");
      const isDegradation = body.includes("backdrop-filter: none");
      expect(isGated || isDegradation, `解释卡规则须带色板门控或为降级规则：${head.trim()}`).toBe(true);
    }
  });

  it("降级：解释卡与确认弹层纳入减弱透明度与滚动期的毛玻璃关停", () => {
    const gate = readCss(GATE_CSS);
    const reduced = gate.match(/@media\s*\(prefers-reduced-transparency:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(reduced, "gate 必须含 prefers-reduced-transparency 块").not.toBeNull();
    expect(reduced![1]).toContain(".biliscript-reading-explain-card-dialog");
    expect(reduced![1]).toContain(".confirm-dialog");

    const scrollRules = (gate.match(/#biliscript-reading-view\[data-biliscript-script-scrolling="1"\][^{]*\{[^}]*\}/g) || []).join("\n");
    expect(scrollRules).toContain(".biliscript-reading-explain-card-dialog");
    expect(scrollRules).toContain(".confirm-dialog");
  });

  it("editorial：解释卡维持 1px 实线与零投影（恢复块），确认弹层走基表实线", () => {
    const restore = ruleBody(
      readCss(GATE_CSS),
      "#biliscript-reading-view[data-palette=\"editorial\"] .biliscript-reading-explain-card-dialog"
    );
    expect(restore).toContain("border: 1px solid var(--biliscript-reader-border)");
    expect(restore).toContain("box-shadow: none");
    expect(restore).toContain("backdrop-filter: none");
    const confirmBase = ruleBody(readCss(READER_CSS), "#biliscript-reading-view .confirm-dialog");
    expect(confirmBase).toContain("border: 1px solid var(--biliscript-reader-border)");
  });
});

describe("卡面材质统一走 card-highlight token（flyme 凸起卡族）", () => {
  it("卡族（章节/金句、用户气泡、chips、平台行）统一消费 card-highlight，深色靠主题块 token 自动换档", () => {
    const gate = readCss(GATE_CSS);
    for (const sel of [
      "#biliscript-reading-view .biliscript-reading-ov-chapter",
      "#biliscript-reading-view .biliscript-reading-chat .chat-msg-user",
      "#biliscript-reading-view .biliscript-reading-chat .chat-chip",
      "body[data-biliscript-reader-mode=\"1\"] #biliscript-reading-view .biliscript-reading-settings-host .ai-provider-row"
    ]) {
      expect(ruleBody(gate, sel), `${sel} 应消费 card-highlight`).toContain(
        "box-shadow: var(--biliscript-reader-card-highlight)"
      );
    }
    // 深色章节/金句悬停覆写浅色 :hover 字面阴影，重申 card-highlight
    for (const sel of [
      "#biliscript-reading-view[data-theme=\"dark\"] .biliscript-reading-ov-chapter:hover",
      "#biliscript-reading-view[data-theme=\"dark\"] .biliscript-reading-ov-quote:hover"
    ]) {
      expect(ruleBody(gate, sel), `${sel} 应消费 card-highlight`).toContain(
        "box-shadow: var(--biliscript-reader-card-highlight)"
      );
    }
  });
});

describe("液态玻璃 token 契约（flyme 两档）", () => {
  it("浅色档：card 升级为 165deg 曲面透镜渐变（顶光折射到底部微透）", () => {
    expect(FLYME_LIGHT()).toContain(
      "--biliscript-reader-card: linear-gradient(165deg, rgba(255, 255, 255, 0.88) 0%, rgba(255, 255, 255, 0.72) 55%, rgba(246, 250, 255, 0.78) 100%)"
    );
  });

  it("浅色档：新增 card-highlight 双对角线折射内高光 + 双层柔影", () => {
    const block = FLYME_LIGHT();
    expect(block).toContain(
      "--biliscript-reader-card-highlight: inset 0 1px 0 0 rgba(255, 255, 255, 0.95), inset 1px 0 0 0 rgba(255, 255, 255, 0.65), inset 0 -1px 0 0 rgba(16, 136, 247, 0.08), 0 6px 24px -4px rgba(15, 23, 42, 0.06), 0 2px 6px -1px rgba(15, 23, 42, 0.03)"
    );
    expect(block).toContain(
      "--biliscript-reader-shadow: 0 20px 48px -8px rgba(15, 23, 42, 0.14), 0 4px 14px -2px rgba(15, 23, 42, 0.06), inset 0 1px 0 0 rgba(255, 255, 255, 0.85)"
    );
  });

  it("浅色档：Gemini 虹彩流光四 token（蓝→紫→珊瑚粉→暖金）", () => {
    const block = FLYME_LIGHT();
    expect(block).toContain(
      "--biliscript-gemini-gradient: linear-gradient(135deg, #4285f4 0%, #9b72cb 36%, #d96570 72%, #f49c46 100%)"
    );
    expect(block).toContain(
      "--biliscript-gemini-gradient-soft: linear-gradient(135deg, rgba(66, 133, 244, 0.14) 0%, rgba(155, 114, 203, 0.14) 40%, rgba(217, 101, 112, 0.14) 75%, rgba(244, 156, 70, 0.14) 100%)"
    );
    expect(block).toContain(
      "--biliscript-gemini-border-gradient: linear-gradient(135deg, rgba(66, 133, 244, 0.72) 0%, rgba(155, 114, 203, 0.72) 38%, rgba(217, 101, 112, 0.72) 74%, rgba(244, 156, 70, 0.65) 100%)"
    );
    expect(block).toContain(
      "--biliscript-gemini-glow: 0 6px 22px -4px rgba(155, 114, 203, 0.24), 0 2px 8px -2px rgba(66, 133, 244, 0.18)"
    );
  });

  it("深色档：card 165deg 透镜渐变 + card-highlight 冷蓝反弹光 + 悬浮柔影", () => {
    const block = FLYME_DARK();
    expect(block).toContain(
      "--biliscript-reader-card: linear-gradient(165deg, rgba(255, 255, 255, 0.10) 0%, rgba(255, 255, 255, 0.055) 55%, rgba(92, 179, 255, 0.06) 100%)"
    );
    expect(block).toContain(
      "--biliscript-reader-card-highlight: inset 0 1px 0 0 rgba(255, 255, 255, 0.16), inset 1px 0 0 0 rgba(255, 255, 255, 0.08), inset 0 -1px 0 0 rgba(92, 179, 255, 0.10), 0 8px 26px -4px rgba(0, 0, 0, 0.36), 0 2px 8px -1px rgba(0, 0, 0, 0.24)"
    );
    expect(block).toContain(
      "--biliscript-reader-shadow: 0 22px 52px -8px rgba(0, 0, 0, 0.58), 0 6px 18px -2px rgba(0, 0, 0, 0.36), inset 0 1px 0 0 rgba(255, 255, 255, 0.14)"
    );
  });

  it("深色档：Gemini 虹彩流光四 token 换暗面亮档", () => {
    const block = FLYME_DARK();
    expect(block).toContain(
      "--biliscript-gemini-gradient: linear-gradient(135deg, #669df6 0%, #b388ff 36%, #f28b82 72%, #fdd663 100%)"
    );
    expect(block).toContain(
      "--biliscript-gemini-gradient-soft: linear-gradient(135deg, rgba(102, 157, 246, 0.18) 0%, rgba(179, 136, 255, 0.18) 40%, rgba(242, 139, 130, 0.18) 75%, rgba(253, 214, 99, 0.16) 100%)"
    );
    expect(block).toContain(
      "--biliscript-gemini-border-gradient: linear-gradient(135deg, rgba(102, 157, 246, 0.82) 0%, rgba(179, 136, 255, 0.82) 38%, rgba(242, 139, 130, 0.82) 74%, rgba(253, 214, 99, 0.72) 100%)"
    );
    expect(block).toContain(
      "--biliscript-gemini-glow: 0 8px 26px -4px rgba(179, 136, 255, 0.28), 0 2px 10px -2px rgba(102, 157, 246, 0.24)"
    );
  });

  it("editorial 两档不定义 Gemini token 以外的覆写：card/shadow 原值不动", () => {
    const editorialLight = themeBlock("#biliscript-reading-view[data-palette=\"editorial\"]");
    const editorialDark = themeBlock("#biliscript-reading-view[data-theme=\"dark\"][data-palette=\"editorial\"]");
    expect(editorialLight).toContain("--biliscript-reader-card: #f3ede2");
    expect(editorialLight).toContain("--biliscript-reader-shadow: 0 10px 26px rgba(60, 45, 30, 0.08)");
    expect(editorialDark).toContain("--biliscript-reader-card: #211e1b");
    expect(editorialDark).toContain("--biliscript-reader-shadow: none");
  });
});

describe("chat 空态建议卡悬停折射增强（spec §3.5，.chat-action-card → .chat-chip）", () => {
  const CHIP_HOVER =
    "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-chat .chat-chip:hover";
  const CHIP_ACTIVE =
    "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-chat .chat-chip:active";

  it("flyme hover：translateY(-1px) + 微蓝折射内高光（card-highlight），editorial 门控隔离", () => {
    const body = ruleBody(readCss(GATE_CSS), CHIP_HOVER);
    expect(body).toContain("transform: translateY(-1px)");
    expect(body).toContain("box-shadow: var(--biliscript-reader-card-highlight)");
  });

  it("flyme active：按压缩放不被 hover 的 translateY 吃掉（门控 :active 写在 :hover 之后）", () => {
    expect(ruleBody(readCss(GATE_CSS), CHIP_ACTIVE)).toContain(
      "transform: scale(var(--biliscript-reader-press-scale, 1))"
    );
    const gate = stripComments(readCss(GATE_CSS));
    expect(gate.indexOf(CHIP_ACTIVE)).toBeGreaterThan(gate.indexOf(CHIP_HOVER));
  });

  it("基表 :hover/:active 原样保留（editorial 的悬停换底与按压缩放走基表）", () => {
    expect(ruleBody(readCss(CHAT_CSS), ".biliscript-reading-chat .chat-chip:hover")).toContain(
      "background: var(--biliscript-reader-accent-soft)"
    );
    expect(ruleBody(readCss(CHAT_CSS), ".biliscript-reading-chat .chat-chip:active")).toContain(
      "transform: scale(var(--biliscript-reader-press-scale, 1))"
    );
  });
});

describe("带框图标开关保框（联网搜索 pill，spec §3 例外项）", () => {
  it("基表 pill 关态保留 1px 实线描边", () => {
    expect(ruleBody(readCss(CHAT_CSS), ".biliscript-reading-chat .chat-web-search-pill")).toContain(
      "border: 1px solid var(--biliscript-reader-border)"
    );
  });

  it("gate 液态玻璃收敛不碰 pill：全文零引用", () => {
    expect(readCss(GATE_CSS)).not.toContain("chat-web-search-pill");
  });
});

describe("收敛 1/6 补：字幕工具栏选轨触发器按次级按钮收敛（spec §3.1 的 .biliscript-reading-sub-picker-trigger）", () => {
  const PICKERS = [
    "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-track-picker .custom-select-trigger",
    "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-bilingual-secondary-picker .custom-select-trigger",
    "body[data-biliscript-reader-mode=\"1\"] #biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-track-picker .custom-select-trigger",
    "body[data-biliscript-reader-mode=\"1\"] #biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-bilingual-secondary-picker .custom-select-trigger"
  ];

  it("flyme：凸起卡面 + card-highlight 折射高光（含 body 前缀压过暗面设置输入凹陷井规则）", () => {
    const gate = readCss(GATE_CSS);
    for (const sel of PICKERS) {
      const body = ruleBody(gate, sel);
      expect(body, sel).toContain("background: var(--biliscript-reader-card)");
      expect(body, sel).toContain("box-shadow: var(--biliscript-reader-card-highlight)");
    }
  });

  it("flyme hover：accent-soft 底 + accent 字（同 mini-btn 母题）", () => {
    const gate = readCss(GATE_CSS);
    for (const sel of PICKERS) {
      const body = ruleBody(gate, `${sel}:hover`);
      expect(body, `${sel}:hover`).toContain("background: var(--biliscript-reader-accent-soft)");
      expect(body, `${sel}:hover`).toContain("color: var(--biliscript-reader-accent)");
    }
  });

  it("设置表单里的 custom-select 仍走输入控件凹陷井（不误伤同族类）", () => {
    const family = ruleBody(
      readCss(GATE_CSS),
      "body[data-biliscript-reader-mode=\"1\"] #biliscript-reading-view .custom-select-trigger"
    );
    expect(family).toContain("border: none");
    expect(family).not.toContain("card-highlight");
  });
});

describe("Gemini 触点 1 · chat 空态 hero 徽标", () => {
  it("flyme：虹彩渐变底 + 白图标 + 顶沿内高光与 gemini-glow 外发光", () => {
    const body = ruleBody(
      readCss(GATE_CSS),
      "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-chat .chat-hero-icon"
    );
    expect(body).toContain("background: var(--biliscript-gemini-gradient)");
    expect(body).toContain("color: #ffffff");
    expect(body).toContain("inset 0 1px 1px rgba(255, 255, 255, 0.65)");
    expect(body).toContain("var(--biliscript-gemini-glow)");
  });

  it("editorial 走基表：accent-soft 圆底 + accent 图标原样保留", () => {
    const base = ruleBody(readCss(CHAT_CSS), ".biliscript-reading-chat .chat-hero-icon");
    expect(base).toContain("background: var(--biliscript-reader-accent-soft)");
    expect(base).toContain("color: var(--biliscript-reader-accent)");
  });
});

describe("Gemini 触点 2 · 概览 AI 徽标（ov-badge）", () => {
  it("flyme 浅色：虹彩 soft 渐变底 + accent 字 + 顶沿内高光", () => {
    const body = ruleBody(
      readCss(GATE_CSS),
      "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-ov-badge"
    );
    expect(body).toContain("background: var(--biliscript-gemini-gradient-soft)");
    expect(body).toContain("color: var(--biliscript-reader-accent)");
    expect(body).toContain("box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75)");
  });

  it("flyme 深色：内高光换暗面档 0.14", () => {
    const body = ruleBody(
      readCss(GATE_CSS),
      "#biliscript-reading-view[data-theme=\"dark\"]:not([data-palette=\"editorial\"]) .biliscript-reading-ov-badge"
    );
    expect(body).toContain("box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14)");
  });

  it("editorial 走基表：accent-soft 底 + accent 字原样保留", () => {
    const base = ruleBody(readCss(READER_CSS), ".biliscript-reading-ov-badge");
    expect(base).toContain("background: var(--biliscript-reader-accent-soft)");
    expect(base).toContain("color: var(--biliscript-reader-accent)");
  });
});

describe("Gemini 触点 3 · chat 输入卡液态玻璃基态与流光聚焦环", () => {
  const CARD =
    "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-chat .chat-input-card";

  it("flyme 基态：1.5px 透明边 + card 透镜底 + blur(20px) saturate(185%) 磨砂 + card-highlight + 过渡", () => {
    const body = ruleBody(readCss(GATE_CSS), CARD);
    expect(body).toContain("border: 1.5px solid transparent");
    expect(body).toContain("background: var(--biliscript-reader-card)");
    expect(body).toContain("backdrop-filter: blur(20px) saturate(185%)");
    expect(body).toContain("box-shadow: var(--biliscript-reader-card-highlight)");
    expect(body).toContain("transition: box-shadow 0.22s ease, background 0.22s ease");
  });

  it("flyme 聚焦：padding-box/border-box 双层背景打出虹彩描边 + 顶沿内高光 + gemini-glow", () => {
    const body = ruleBody(readCss(GATE_CSS), `${CARD}:focus-within`);
    expect(body).toContain("border-color: transparent");
    expect(body).toContain("var(--biliscript-reader-card) padding-box");
    expect(body).toContain("var(--biliscript-gemini-border-gradient) border-box");
    expect(body).toContain("inset 0 1px 0 0 rgba(255, 255, 255, 0.92)");
    expect(body).toContain("var(--biliscript-gemini-glow)");
  });

  it("flyme 深色聚焦：内高光换暗面档 0.16", () => {
    const body = ruleBody(
      readCss(GATE_CSS),
      "#biliscript-reading-view[data-theme=\"dark\"]:not([data-palette=\"editorial\"]) .biliscript-reading-chat .chat-input-card:focus-within"
    );
    expect(body).toContain("inset 0 1px 0 0 rgba(255, 255, 255, 0.16)");
    expect(body).toContain("var(--biliscript-gemini-glow)");
  });

  it("editorial：输入卡保持书摘卡底（--card），聚焦环维持 accent 实线 + soft 光环", () => {
    const restore = ruleBody(
      readCss(GATE_CSS),
      "#biliscript-reading-view[data-palette=\"editorial\"] .biliscript-reading-chat .chat-input-card"
    );
    expect(restore).toContain("background: var(--biliscript-reader-card)");
    expect(restore).toContain("border: 1px solid var(--biliscript-reader-border)");
    const focus = ruleBody(
      readCss(GATE_CSS),
      "#biliscript-reading-view[data-palette=\"editorial\"] .biliscript-reading-chat .chat-input-card:focus-within"
    );
    expect(focus).toContain("border: 1px solid var(--biliscript-reader-accent)");
    expect(focus).toContain("box-shadow: 0 0 0 2px var(--biliscript-reader-accent-soft)");
  });

  it("降级：减弱透明度与滚动期关停输入卡的 backdrop-filter", () => {
    const gate = readCss(GATE_CSS);
    const reduced = gate.match(/@media\s*\(prefers-reduced-transparency:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(reduced, "gate 必须含 prefers-reduced-transparency 块").not.toBeNull();
    expect(reduced![1]).toContain(".chat-input-card");

    const scrollRules = (gate.match(/#biliscript-reading-view\[data-biliscript-script-scrolling="1"\][^{]*\{[^}]*\}/g) || []).join("\n");
    expect(scrollRules).toContain(".chat-input-card");
  });
});

describe("Gemini 触点 4 · 思考强度滑块最高档渐变（ultra-gradient）", () => {
  it("flyme 浅色：Gemini 流光渐变（蓝 #4285f4 → 紫 #9b72cb → 珊瑚 #d96570）", () => {
    const body = ruleBody(
      readCss(GATE_CSS),
      "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-chat .chat-thinking-ultra-gradient"
    );
    expect(body).toContain("linear-gradient(90deg, #4285f4 0%, #9b72cb 36%, #d96570 100%)");
  });

  it("flyme 深色：换暗面亮档（#669df6 → #b388ff → #f28b82）", () => {
    const body = ruleBody(
      readCss(GATE_CSS),
      "#biliscript-reading-view[data-theme=\"dark\"]:not([data-palette=\"editorial\"]) .biliscript-reading-chat .chat-thinking-ultra-gradient"
    );
    expect(body).toContain("linear-gradient(90deg, #669df6 0%, #b388ff 36%, #f28b82 100%)");
  });

  it("editorial 走基表：紫色渐变层原样保留（起点 #88a3fe 终点 #6752c9）", () => {
    const base = ruleBody(readCss(CHAT_CSS), ".biliscript-reading-chat .chat-thinking-ultra-gradient");
    expect(base).toContain("#88a3fe 0%");
    expect(base).toContain("#6752c9 100%");
  });
});

describe("Gemini 触点 5 · 生成进度条流光与三点脉冲光标", () => {
  it("flyme 进度条：虹彩 90deg 四色渐变 + 200% 幅宽 + pulse/shimmer 双动画", () => {
    for (const cls of [".biliscript-reading-ov-fill", ".biliscript-reading-asr-fill"]) {
      const body = ruleBody(
        readCss(GATE_CSS),
        `#biliscript-reading-view:not([data-palette="editorial"]) ${cls}`
      );
      expect(body, `${cls} 渐变`).toContain(
        "background: linear-gradient(90deg, #4285f4 0%, #9b72cb 35%, #d96570 70%, #f49c46 100%)"
      );
      expect(body, `${cls} 幅宽`).toContain("background-size: 200% 100%");
      expect(body, `${cls} 双动画`).toContain(
        "biliscript-asr-pulse 1.6s ease-in-out infinite alternate"
      );
      expect(body, `${cls} 双动画`).toContain("biliscript-gemini-shimmer 2.6s linear infinite");
    }
  });

  it("shimmer keyframes 定义在 gate（100% 0 → -100% 0 扫光位移）", () => {
    const gate = normalize(readCss(GATE_CSS));
    expect(gate).toContain("@keyframes biliscript-gemini-shimmer");
    expect(gate).toContain("background-position: 100% 0");
    expect(gate).toContain("background-position: -100% 0");
  });

  it("降级：prefers-reduced-motion 下门控关停进度条动画（基表规则特异性压不过门控）", () => {
    const gate = readCss(GATE_CSS);
    const reduced = gate.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(reduced, "gate 必须含 prefers-reduced-motion 块").not.toBeNull();
    expect(reduced![1]).toContain(
      "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-ov-fill"
    );
    expect(reduced![1]).toContain(
      "#biliscript-reading-view:not([data-palette=\"editorial\"]) .biliscript-reading-asr-fill"
    );
    expect(reduced![1]).toContain("animation: none");
  });

  it("flyme 三点脉冲：浅档蓝/紫/珊瑚，深档换暗面亮档", () => {
    const light: [string, string][] = [
      ["1", "#4285f4"],
      ["2", "#9b72cb"],
      ["3", "#d96570"]
    ];
    for (const [nth, color] of light) {
      const body = ruleBody(
        readCss(GATE_CSS),
        `#biliscript-reading-view:not([data-palette="editorial"]) .biliscript-reading-chat .chat-msg-cursor i:nth-child(${nth})`
      );
      expect(body, `浅档第 ${nth} 点`).toContain(`background: ${color}`);
    }
    const dark: [string, string][] = [
      ["1", "#669df6"],
      ["2", "#b388ff"],
      ["3", "#f28b82"]
    ];
    for (const [nth, color] of dark) {
      const body = ruleBody(
        readCss(GATE_CSS),
        `#biliscript-reading-view[data-theme="dark"]:not([data-palette="editorial"]) .biliscript-reading-chat .chat-msg-cursor i:nth-child(${nth})`
      );
      expect(body, `深档第 ${nth} 点`).toContain(`background: ${color}`);
    }
  });

  it("editorial 走基表：进度条与三点维持 accent 单色", () => {
    for (const cls of [".biliscript-reading-ov-fill", ".biliscript-reading-asr-fill"]) {
      expect(ruleBody(readCss(READER_CSS), cls)).toContain("background: var(--biliscript-reader-accent)");
    }
    expect(ruleBody(readCss(CHAT_CSS), ".biliscript-reading-chat .chat-msg-cursor i")).toContain(
      "background: var(--biliscript-reader-accent)"
    );
  });
});

describe("Gemini 触点 6 · 播放器快捷按钮（player-ai.css）", () => {
  it("按钮升级为深色液态玻璃胶囊 + 虹彩细环（padding-box/border-box 双层背景）", () => {
    const body = ruleBody(readCss(PLAYER_AI_CSS), "#biliscript-player-ai-quick-action");
    expect(body).toContain("border: 1.5px solid transparent");
    expect(body).toContain("border-radius: 999px");
    expect(body).toContain(
      "linear-gradient(165deg, rgba(24, 28, 38, 0.86), rgba(15, 18, 26, 0.92)) padding-box"
    );
    expect(body).toContain(
      "linear-gradient(135deg, rgba(102, 157, 246, 0.85), rgba(179, 136, 255, 0.85), rgba(242, 139, 130, 0.85), rgba(253, 214, 99, 0.75)) border-box"
    );
    expect(body).toContain("backdrop-filter: blur(18px) saturate(190%)");
    expect(body).toContain("inset 0 1px 0 rgba(255, 255, 255, 0.22)");
    expect(body).toContain("0 6px 20px -2px rgba(0, 0, 0, 0.36)");
    expect(body).toContain("0 0 16px -2px rgba(155, 114, 203, 0.32)");
  });

  it("wrap 悬停：虹彩环换亮档四色 + 外发光加强", () => {
    const body = ruleBody(
      readCss(PLAYER_AI_CSS),
      ".biliscript-player-ai-wrap:hover #biliscript-player-ai-quick-action"
    );
    expect(body).toContain(
      "linear-gradient(165deg, rgba(32, 38, 52, 0.92), rgba(20, 24, 34, 0.96)) padding-box"
    );
    expect(body).toContain("linear-gradient(135deg, #669df6, #b388ff, #f28b82, #fdd663) border-box");
    expect(body).toContain("inset 0 1px 0 rgba(255, 255, 255, 0.32)");
    expect(body).toContain("0 8px 24px -2px rgba(0, 0, 0, 0.44)");
    expect(body).toContain("0 0 20px 0 rgba(179, 136, 255, 0.45)");
  });

  it("胶囊壳剥离实心黑底旧视觉（底/框/影/overflow 移除），几何与滑入动效保留", () => {
    const wrap = ruleBody(readCss(PLAYER_AI_CSS), ".biliscript-player-ai-wrap");
    expect(wrap).not.toContain("background:");
    expect(wrap).not.toContain("border:");
    expect(wrap).not.toContain("box-shadow:");
    expect(wrap).not.toContain("overflow: hidden");
    expect(wrap).toContain("transform: translate(8px, -50%)");
    expect(wrap).toContain("opacity: 0");

    const shown = ruleBody(readCss(PLAYER_AI_CSS), ".biliscript-player-ai-wrap.is-active");
    expect(shown).not.toContain("background:");
    expect(shown).toContain("opacity: 1");
    expect(shown).toContain("transform: translate(0, -50%)");
  });
});

describe("editorial 隔离总扫", () => {
  it("gate 内消费 Gemini 流光（gemini-* token 或四色字面量）的规则一律带 editorial 门控", () => {
    const text = stripComments(readCss(GATE_CSS));
    const rules = text.match(/[^{}]+\{[^}]*\}/g) || [];
    const geminiUse =
      /var\(--biliscript-gemini-|#4285f4|#9b72cb|#d96570|#f49c46|#669df6|#b388ff|#f28b82|#fdd663/i;
    const tokenDef = /--biliscript-gemini-[a-z-]+\s*:/;
    const offenders: string[] = [];
    for (const rule of rules) {
      const [head, body] = rule.split("{");
      if (tokenDef.test(body)) continue; // flyme 主题块的 token 定义（editorial 不消费）
      if (!geminiUse.test(body)) continue;
      if (!head.includes(':not([data-palette="editorial"])')) offenders.push(head.trim());
    }
    expect(offenders, "脱门控的 Gemini 消费规则会污染 editorial").toEqual([]);
  });
});
