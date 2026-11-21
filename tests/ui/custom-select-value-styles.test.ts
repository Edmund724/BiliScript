import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CUSTOM_SELECT_CSS = "extension/entry/styles/custom-select.css";

function injectComponentStyles(): void {
  document.head.querySelectorAll('link[href$="entry/styles/custom-select.css"]').forEach((link) => link.remove());
  const style = document.createElement("style");
  style.textContent = readFileSync(join(process.cwd(), CUSTOM_SELECT_CSS), "utf8");
  document.head.appendChild(style);
}

function mountSelect(markup: string, selectId: string): HTMLSelectElement {
  document.body.innerHTML = `<div id="biliscript-reading-view">${markup}</div>`;
  return document.getElementById(selectId) as HTMLSelectElement;
}

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
    expect(window.getComputedStyle(trigger).textAlign).toBe("center");
  });

  it("值区不吃 flex 增长、不改宿主尺寸参与项（设置页两处调用点外观不变）", async () => {
    injectComponentStyles();
    const sources = [
      markup,
      '<div class="provider-editor-field"><label class="provider-editor-label">协议</label><select id="protocolSelect"><option value="openai">OpenAI Chat Completions</option><option value="anthropic">Anthropic Messages</option></select></div>'
    ];
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    const seen: string[] = [];
    for (const [index, source] of sources.entries()) {
      const id = ["downloadFormat", "protocolSelect"][index];
      const select = mountSelect(source, id);
      initCustomSelect(select);
      const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
      const trigger = wrapper.querySelector<HTMLElement>(".custom-select-trigger")!;
      const value = trigger.querySelector<HTMLElement>(".custom-select-value")!;
      const valueStyle = window.getComputedStyle(value);
      expect(valueStyle.flexGrow, `${id} 的值区吃了 flex 增长`).toBe("0");
      expect(window.getComputedStyle(trigger.querySelector<HTMLElement>(".custom-select-arrow")!).flex).toBe("0 0 auto");
      expect(trigger.firstElementChild).toBe(value);
      seen.push(valueStyle.flexShrink);
    }
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
    expect(window.getComputedStyle(trigger).opacity).toBe("1");
  });

  it("裁定 3 源码守卫：禁用淡化只落在值区/箭头，trigger:disabled 规则块里没有 opacity", () => {
    const css = readFileSync(join(process.cwd(), CUSTOM_SELECT_CSS), "utf8");
    const disabledBlock = css.match(/#biliscript-reading-view \.custom-select-trigger:disabled\s*\{[^}]*\}/);
    expect(disabledBlock, "trigger:disabled 规则块未找到").not.toBeNull();
    expect(disabledBlock![0]).toMatch(/cursor:\s*default/);
    expect(disabledBlock![0], "trigger:disabled 里仍有 opacity —— 忙碌圆点会被一起淡化").not.toMatch(/opacity/);
    expect(css).toMatch(
      /\.custom-select-trigger:disabled \.custom-select-value,[\s\S]{0,160}\.custom-select-trigger:disabled \.custom-select-arrow\s*\{[^}]*opacity:\s*0\.45/
    );
  });

  it("aria-busy 消费规则在场：忙碌指示是组件表里的 ::after 规则（含呼吸动画与减弱动态降级）", () => {
    const css = readFileSync(join(process.cwd(), CUSTOM_SELECT_CSS), "utf8");
    expect(css).toMatch(
      /\.custom-select-trigger\[aria-busy="true"\]::after\s*\{[^}]*content:\s*""/
    );
    expect(css).toMatch(/\.custom-select-trigger\[aria-busy="true"\]::after\s*\{[^}]*width:\s*6px/);
    expect(css).toMatch(/\.custom-select-trigger\[aria-busy="true"\]::after\s*\{[^}]*animation:\s*biliscript-custom-select-busy/);
    expect(css).toMatch(/@keyframes biliscript-custom-select-busy/);
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
    option.setAttribute("dir", "auto");
    expect(window.getComputedStyle(option).textAlign).toBe("start");
  });
});

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
    expect(valueCss(value)).toBe("auto|visible|clip|normal");

    injectComponentStyles();
    expect(valueCss(value)).toBe("0px|hidden|ellipsis|nowrap");
  });
});

describe("选项行文字纵向居中（行盒 = 内容盒 30px）", () => {
  const optionBlock = (): string => {
    const css = readFileSync(join(process.cwd(), CUSTOM_SELECT_CSS), "utf8");
    const hit = css.match(/#biliscript-reading-view \.custom-select-option\s*\{[^}]*\}/);
    expect(hit, ".custom-select-option 规则块未找到").not.toBeNull();
    return hit![0];
  };
  const px = (block: string, prop: string): number => {
    const hit = block.match(new RegExp(`(?:^|[;{\\s])${prop}:\\s*(\\d+(?:\\.\\d+)?)px`));
    expect(hit, `规则块里没有 ${prop}: <n>px 声明`).not.toBeNull();
    return Number(hit![1]);
  };

  it("注入真实表后：选项行规则上确实挂着 line-height 30px（宿主继承的 1.5 不再进这个盒子）", () => {
    injectComponentStyles();
    const sheet = document.head.querySelector<HTMLStyleElement>("style")!.sheet!;
    const rule = [...sheet.cssRules].find(
      (item): item is CSSStyleRule =>
        item instanceof CSSStyleRule && item.selectorText === "#biliscript-reading-view .custom-select-option"
    );
    expect(rule, "选项行规则没进注入的表").toBeDefined();
    expect(rule!.style.lineHeight).toBe("30px");
  });

  it("度量自洽：line-height == min-height − 上下 padding（两半必须一起动）", () => {
    const block = optionBlock();
    const pad = block
      .match(/(?:^|[;{\s])padding:\s*([^;]+);/)![1]
      .trim()
      .split(/\s+/)
      .map((value) => Number.parseFloat(value));
    const top = pad[0];
    const bottom = pad.length === 1 ? pad[0] : pad.length === 2 ? pad[0] : pad[2];
    expect(top, "上下 padding 不等，行盒居中就无从谈起").toBe(bottom);
    expect(px(block, "line-height"), "行盒必须恰好填满内容盒（min-height − 上下 padding）").toBe(
      px(block, "min-height") - top - bottom
    );
  });

  it("源码守卫：padding 4px 10px / min-height 38px / line-height 30px 三项同时在场", () => {
    const block = optionBlock();
    expect(block, "选项行左右 padding 是 10 号票定的度量，不得为居中而改").toMatch(/padding:\s*4px 10px/);
    expect(block, "行高 38px 是既有度量，不得为居中而改").toMatch(/min-height:\s*38px/);
    expect(block, "缺 line-height 即回到「文字偏上」的旧形态").toMatch(/line-height:\s*30px/);
  });
});

describe("弹层横向溢出（选项行盒子宽于弹层内容盒）", () => {
  const markup =
    '<select id="trackSelect" aria-label="字幕语言"><option value="ai-zh">中文</option>' +
    '<option value="asr">自配平台转写（中文）</option></select>';

  it("computed：选项行 box-sizing 为 border-box（width: 100% 含 padding，不再溢出）", async () => {
    injectComponentStyles();
    const select = mountSelect(markup, "trackSelect");
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    initCustomSelect(select);

    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    const option = wrapper.querySelector<HTMLElement>(".custom-select-option")!;
    const dropdown = wrapper.querySelector<HTMLElement>(".custom-select-dropdown")!;
    expect(window.getComputedStyle(option).boxSizing).toBe("border-box");
    expect(window.getComputedStyle(dropdown).boxSizing).toBe("content-box");
  });

  it("源码守卫：宽度由 box-sizing 收口、padding 与行高原样保留（不靠删 padding 消溢出）", () => {
    const css = readFileSync(join(process.cwd(), CUSTOM_SELECT_CSS), "utf8");
    const optionBlock = css.match(/#biliscript-reading-view \.custom-select-option\s*\{[^}]*\}/);
    expect(optionBlock, ".custom-select-option 规则块未找到").not.toBeNull();
    expect(optionBlock![0]).toMatch(/box-sizing:\s*border-box/);
    expect(optionBlock![0]).toMatch(/width:\s*100%/);
    expect(optionBlock![0], "选项行左右 padding 是 10 号票定的度量，不得为消溢出而改").toMatch(
      /padding:\s*4px 10px/
    );
    expect(optionBlock![0], "min-height 必须记边框盒数（内容 30 + 上下 padding 8 = 38）").toMatch(
      /min-height:\s*38px/
    );
  });

  it("源码守卫：弹层横轴显式关掉滚动（overflow-x: hidden），纵轴仍可滚", () => {
    const css = readFileSync(join(process.cwd(), CUSTOM_SELECT_CSS), "utf8");
    const dropdownBlock = css.match(/#biliscript-reading-view \.custom-select-dropdown\s*\{[^}]*\}/);
    expect(dropdownBlock, ".custom-select-dropdown 规则块未找到").not.toBeNull();
    expect(dropdownBlock![0]).toMatch(/overflow-x:\s*hidden/);
    expect(dropdownBlock![0], "纵轴滚动不能一起关掉：轨道多的视频要靠它").toMatch(
      /overflow-y:\s*auto/
    );
  });
});

describe("设置抽屉行内下拉菜单（右对齐向左展开防截断与定宽底线）", () => {
  const markup =
    '<div class="biliscript-reading-settings-host">' +
    '<div class="biliscript-set-card"><div class="biliscript-set-row">' +
    '<label for="liveInterpretTargetLang">翻译目标语言</label>' +
    '<select id="liveInterpretTargetLang"><option value="zh">中文</option></select>' +
    '</div></div></div>';

  it("computed：设置行内的 custom-select-wrapper 拥有 min-width 140px，dropdown 为 right: 0 且 left: auto", async () => {
    injectComponentStyles();
    const select = mountSelect(markup, "liveInterpretTargetLang");
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    initCustomSelect(select);

    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    const dropdown = wrapper.querySelector<HTMLElement>(".custom-select-dropdown")!;

    expect(window.getComputedStyle(wrapper).minWidth).toBe("140px");
    expect(window.getComputedStyle(dropdown).right).toBe("0px");
    expect(window.getComputedStyle(dropdown).left).toBe("auto");
    expect(window.getComputedStyle(dropdown).transformOrigin).toMatch(/top right|100% 0%/);
  });
});
