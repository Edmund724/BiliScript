// tests/ui/custom-select-value-styles.test.ts
// 组件表缺口（wayfinder/subtitle-track-picker 10 号票）：按**真实 CSS 注入**核验四条
// 组件侧视觉规则的 computed 值，并守「设置页三处调用点外观逐字不变」。
//
// 先列失败方式，再据此写断言：
//   F1 值区裸奔：`.custom-select-value` 在组件表里一条规则都没有 → UA 的
//      `button { text-align: center }` 继承进 trigger，短名居中、长名**两端一起裁**
//      （02 号票原型实测）。故必须断言 overflow/text-overflow/white-space/text-align
//      四项 computed 值。
//   F2 禁用与忙碌不可分：空态 / 转写中 / busy 三态全靠组件表区分，缺禁用视觉看不出
//      「不可用」，缺 aria-busy 消费规则看不出「请求中」。
//   F3 RTL 行不跟随方向：`.custom-select-option` 写死 text-align: left → 挂
//      dir="auto" 的阿拉伯语行也靠左；逻辑值 start 才随行方向解析。
//   F4 改坏设置页：值区新规则若把 span 变成贪婪伸缩（flex-grow），设置页三处
//      调用点的 trigger/wrapper 宽度会变。故逐处核宽度不变。
//
// jsdom 说明：无布局引擎（宽度恒 0），故宽度断言按**flex 尺寸参与项**核，而不是
// 像素几何——像素层由 10 号票在真实 Chrome 里做过 A/B 实测（见该票报告）。
// 规则在场的判定用 computed 值（jsdom 采信注入的 style 元素），不用源码正则。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CUSTOM_SELECT_CSS = "extension/entry/styles/custom-select.css";

// 注入组件表：与 ui/custom-select.ts 模块顶挂载同一条真实来源（而不是夹具自写规则）
function injectComponentStyles(): void {
  document.head.querySelectorAll('link[href$="entry/styles/custom-select.css"]').forEach((link) => link.remove());
  const style = document.createElement("style");
  style.textContent = readFileSync(join(process.cwd(), CUSTOM_SELECT_CSS), "utf8");
  document.head.appendChild(style);
}

// 设置页/Modal 的真实宿主形态：作用域根 #biliscript-reading-view 内的原生 select
function mountSelect(markup: string, selectId: string): HTMLSelectElement {
  document.body.innerHTML = `<div id="biliscript-reading-view">${markup}</div>`;
  return document.getElementById(selectId) as HTMLSelectElement;
}

// jsdom 说明：overflowX / overflowY 两个 longhand 在 jsdom 里恒读作 'visible'（它只
// 实现 overflow 简写），故一律按简写读。white-space 在无表时是空串（jsdom 不实现 UA
// 表），按 'normal' 呈现——不影响「有表后是 nowrap」这条断言。
function readValueCss(value: HTMLElement): Record<string, string> {
  const style = window.getComputedStyle(value);
  const raw = (name: string, fallback: string): string => style.getPropertyValue(name) || fallback;
  return {
    minWidth: raw("min-width", "auto"),
    overflow: raw("overflow", "visible"),
    textOverflow: raw("text-overflow", "clip"),
    whiteSpace: raw("white-space", "normal"),
    textAlign: raw("text-align", "start")
  };
}

function valueCss(value: HTMLElement): string {
  const css = readValueCss(value);
  return [css.minWidth, css.overflow, css.textOverflow, css.whiteSpace].join("|");
}

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("值区省略号（10 号票第 1 条：.custom-select-value 此前零规则）", () => {
  const markup =
    '<div class="biliscript-set-row"><label for="downloadFormat">下载格式</label>' +
    '<select id="downloadFormat"><option value="srt">SRT</option><option value="txt">TXT</option></select></div>';

  it("computed：overflow hidden + text-overflow ellipsis + white-space nowrap（长值只裁尾端）", async () => {
    injectComponentStyles();
    const select = mountSelect(markup, "downloadFormat");
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    initCustomSelect(select);

    const value = select.closest(".custom-select-wrapper")!.querySelector<HTMLElement>(".custom-select-value")!;
    const css = readValueCss(value);
    expect(css.overflow).toBe("hidden");
    expect(css.textOverflow).toBe("ellipsis");
    expect(css.whiteSpace).toBe("nowrap");
    expect(css.minWidth).toBe("0px");
  });

  it("computed：text-align 为逻辑值 start（压过 UA 的 button text-align: center）", async () => {
    injectComponentStyles();
    const select = mountSelect(markup, "downloadFormat");
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    initCustomSelect(select);

    const trigger = select.closest(".custom-select-wrapper")!.querySelector<HTMLElement>(".custom-select-trigger")!;
    const value = trigger.querySelector<HTMLElement>(".custom-select-value")!;
    expect(window.getComputedStyle(value).textAlign).toBe("start");
    // 反证：宿主 trigger 自身仍是 UA 的居中（否则上面那条断言可能在「继承」而非「规则」上通过）
    expect(window.getComputedStyle(trigger).textAlign).toBe("center");
  });

  it("值区不吃 flex 增长、不改宿主尺寸参与项（设置页三处调用点外观不变）", async () => {
    injectComponentStyles();
    const sources = [
      '<div class="biliscript-set-row"><label for="readerThemeFamily">主题</label><select id="readerThemeFamily"><option value="bilibili">Bilibili</option><option value="flyme">Flyme</option></select></div>',
      markup,
      '<div class="provider-editor-field"><label class="provider-editor-label">协议</label><select id="protocolSelect"><option value="openai">OpenAI Chat Completions</option><option value="anthropic">Anthropic Messages</option></select></div>'
    ];
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    const seen: string[] = [];
    for (const [index, source] of sources.entries()) {
      const id = ["readerThemeFamily", "downloadFormat", "protocolSelect"][index];
      const select = mountSelect(source, id);
      initCustomSelect(select);
      const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
      const trigger = wrapper.querySelector<HTMLElement>(".custom-select-trigger")!;
      const value = trigger.querySelector<HTMLElement>(".custom-select-value")!;
      const valueStyle = window.getComputedStyle(value);
      // 值区只能在既有空间里省略，不能参与扩张（flex-grow 会把 trigger/wrapper 撑开）
      expect(valueStyle.flexGrow, `${id} 的值区吃了 flex 增长`).toBe("0");
      // 箭头仍是不可压缩的固定项，值区是唯一让位方
      expect(window.getComputedStyle(trigger.querySelector<HTMLElement>(".custom-select-arrow")!).flex).toBe("0 0 auto");
      // 值区是 trigger 的首个子节点（值在左、箭头在右的既有顺序不变）
      expect(trigger.firstElementChild).toBe(value);
      seen.push(valueStyle.flexShrink);
    }
    // 三处调用点同规格（分叉即在此暴露）
    expect(new Set(seen).size).toBe(1);
  });
});

describe("禁用态与忙碌指示（10 号票第 2 条）", () => {
  const markup =
    '<div class="biliscript-set-row"><label for="downloadFormat">下载格式</label>' +
    '<select id="downloadFormat"><option value="srt">SRT</option><option value="txt">TXT</option></select></div>';

  async function mountInitialized() {
    injectComponentStyles();
    const select = mountSelect(markup, "downloadFormat");
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    initCustomSelect(select);
    return select.closest<HTMLElement>(".custom-select-wrapper")!.querySelector<HTMLButtonElement>(".custom-select-trigger")!;
  }

  it("禁用态 computed 与 reader.css 既有先例同规格：内容淡出（值区/箭头 0.45）+ cursor default", async () => {
    const trigger = await mountInitialized();
    const value = trigger.querySelector<HTMLElement>(".custom-select-value")!;
    const arrow = trigger.querySelector<HTMLElement>(".custom-select-arrow")!;
    expect(window.getComputedStyle(value).opacity).toBe("1");

    trigger.disabled = true;

    expect(window.getComputedStyle(trigger).cursor).toBe("default");
    expect(window.getComputedStyle(value).opacity).toBe("0.45");
    expect(window.getComputedStyle(arrow).opacity).toBe("0.45");
    // 反证（裁定 3）：trigger 自身不置 opacity——父元素上的 opacity 会连忙碌圆点一起
    // 按组透明度合成，深色档下 0.45 × 0.55（呼吸下限）≈ 0.25 会糊到看不清
    expect(window.getComputedStyle(trigger).opacity).toBe("1");
  });

  it("裁定 3 源码守卫：禁用淡化只落在值区/箭头，trigger:disabled 规则块里没有 opacity", () => {
    const css = readFileSync(join(process.cwd(), CUSTOM_SELECT_CSS), "utf8");
    const disabledBlock = css.match(/#biliscript-reading-view \.custom-select-trigger:disabled\s*\{[^}]*\}/);
    expect(disabledBlock, "trigger:disabled 规则块未找到").not.toBeNull();
    expect(disabledBlock![0]).toMatch(/cursor:\s*default/);
    expect(disabledBlock![0], "trigger:disabled 里仍有 opacity —— 忙碌圆点会被一起淡化").not.toMatch(/opacity/);
    // 淡化落在内容上：值区与箭头各 0.45
    expect(css).toMatch(
      /\.custom-select-trigger:disabled \.custom-select-value,[\s\S]{0,160}\.custom-select-trigger:disabled \.custom-select-arrow\s*\{[^}]*opacity:\s*0\.45/
    );
  });

  it("aria-busy 消费规则在场：忙碌指示是组件表里的 ::after 规则（含呼吸动画与减弱动态降级）", () => {
    const css = readFileSync(join(process.cwd(), CUSTOM_SELECT_CSS), "utf8");
    // jsdom 不做伪元素计算样式，故按规则源核验（既有 custom-select-hidden.test.ts 同款口径）
    expect(css).toMatch(
      /\.custom-select-trigger\[aria-busy="true"\]::after\s*\{[^}]*content:\s*""/
    );
    expect(css).toMatch(/\.custom-select-trigger\[aria-busy="true"\]::after\s*\{[^}]*width:\s*6px/);
    expect(css).toMatch(/\.custom-select-trigger\[aria-busy="true"\]::after\s*\{[^}]*animation:\s*biliscript-custom-select-busy/);
    expect(css).toMatch(/@keyframes biliscript-custom-select-busy/);
    // 减弱动态：动画关停、圆点留场
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.custom-select-trigger\[aria-busy="true"\]::after\s*\{[^}]*animation:\s*none/
    );
  });

  it("busy 与 disabled 同时置位：圆点不受内容淡化影响（trigger 恒全不透明）", async () => {
    const trigger = await mountInitialized();
    const value = trigger.querySelector<HTMLElement>(".custom-select-value")!;
    const arrow = trigger.querySelector<HTMLElement>(".custom-select-arrow")!;
    trigger.disabled = true;
    trigger.setAttribute("aria-busy", "true");

    // 内容退到背景、圆点所在的 trigger 自身保持 1（圆点 opacity 由 keyframes 定 0.55–1）
    expect(window.getComputedStyle(value).opacity).toBe("0.45");
    expect(window.getComputedStyle(arrow).opacity).toBe("0.45");
    expect(window.getComputedStyle(trigger).opacity).toBe("1");
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("true");
  });
});

describe("选项行方向（10 号票第 4 条：text-align: left → start）", () => {
  it("computed：选项行 text-align 为 start，且不再写死 left", () => {
    const css = readFileSync(join(process.cwd(), CUSTOM_SELECT_CSS), "utf8");
    const optionBlock = css.match(/#biliscript-reading-view \.custom-select-option\s*\{[^}]*\}/);
    expect(optionBlock, ".custom-select-option 规则块未找到").not.toBeNull();
    expect(optionBlock![0]).toMatch(/text-align:\s*start/);
    expect(optionBlock![0]).not.toMatch(/text-align:\s*left/);
  });

  it("computed：注入真实表后选项行的 text-align 为 start（dir=auto 的 RTL 行随之靠右）", async () => {
    injectComponentStyles();
    const select = mountSelect('<select id="trackSelect" aria-label="字幕语言"><option value="ai-ar">العربية</option></select>', "trackSelect");
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    initCustomSelect(select);

    const option = select.closest(".custom-select-wrapper")!.querySelector<HTMLElement>(".custom-select-option")!;
    option.setAttribute("dir", "auto"); // 消费侧给阿拉伯语行挂的方向属性（08 号票）
    expect(window.getComputedStyle(option).textAlign).toBe("start");
  });
});

// 值区四项的联合诊断串：失败时一眼看出缺哪一项（避免测试只报裸 false）
describe("值区诊断串（无表 → 有表 的缺口形态）", () => {
  it("未注入组件表时值区是 UA 默认（即可见溢出、不省略），注入后四项齐备", async () => {
    const select = mountSelect(
      '<select id="downloadFormat"><option value="srt">SRT</option></select>',
      "downloadFormat"
    );
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    initCustomSelect(select);
    const value = select
      .closest(".custom-select-wrapper")!
      .querySelector<HTMLElement>(".custom-select-value")!;
    // jsdom 无 UA 表：无规则时 white-space / text-overflow 读作空串（按 UA 默认呈现）
    expect(valueCss(value)).toBe("auto|visible|clip|normal");

    injectComponentStyles();
    expect(valueCss(value)).toBe("0px|hidden|ellipsis|nowrap");
  });
});
