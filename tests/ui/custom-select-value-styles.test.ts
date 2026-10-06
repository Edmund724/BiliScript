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

// 选项行文字纵向基线（2026-10-06 用户报告：字幕 tab 的语言下拉里选项文字偏上）。
//
// 先列失败方式，再据此写断言：
//   H1 行盒只填内容盒上半：min-height 38（border-box）给内容盒 30px，而选项行的行盒
//      取自宿主继承的 unitless line-height（真机 1.5 × 15px = 22.5px）。块布局把余下
//      的 7.5px 落在行盒**下方**，文字整体上移 3.75px。真机 A/B：文字墨迹上距 6.67 /
//      下距 14.44（中心差 3.89px）；行盒改 30px 后 10.22 / 10.89（中心差 0.33px，即
//      字体墨迹固有的上下不对称），行高 38、弹层 133.78×241.78、省略号路径逐值不变。
//   H2 度量两半分头动：38 − 4 − 4 = 30 是同一个度量的两半，min-height 动了而行盒不跟
//      （或反之）就会重新偏上/偏下，故按**算术关系**核，不只核字面 30px。
//   H3 顺手改坏别的：居中不得靠删 padding / 改 min-height 实现（那条已被上面 G 组锁住）。
// jsdom 无布局引擎（量不到墨迹位置），故这里守「声明在场」+「度量自洽」两条；像素层
// 由真机 A/B 实测，脚本与逐值见 .scratch/select-option-centering/measure.md。
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
    // jsdom 不实现 line-height 的 computed 值（恒读作 'normal'，与它的 overflow longhand
    // 同款缺口），故这里读样式表解析后的声明——「规则在场」的核验口径与其它 jsdom
    // 断言一致；注入位置、注入后的墨迹落点由真机 A/B 核验（见本组头注）。
    expect(rule!.style.lineHeight).toBe("30px");
  });

  it("度量自洽：line-height == min-height − 上下 padding（两半必须一起动）", () => {
    const block = optionBlock();
    const pad = block
      .match(/(?:^|[;{\s])padding:\s*([^;]+);/)![1]
      .trim()
      .split(/\s+/)
      .map((value) => Number.parseFloat(value));
    // padding 简写展开：1 值全边、2 值上下/左右、3 值上/左右/下、4 值上右下左
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

// 弹层横向滚动条（2026-10-06 用户报告：选轨浮层底部一条左右滚动条）。
//
// 先列失败方式，再据此写断言：
//   G1 选项行盒子比弹层内容盒宽：组件表从不声明 box-sizing（宿主页的
//      `button { box-sizing }` 只盖到 trigger），content-box 下 `width: 100%`
//      量的是内容盒，再叠左右 padding 就溢出一整个 padding 宽——真机实测选轨
//      弹层 clientWidth 132 / scrollWidth 152，差值恰是 4px 10px 的两倍。
//   G2 靠删 padding 来消溢出：省略号区域随之变形（10 号票定的度量是 4px 10px），
//      故 padding 必须原样在场。
//   G3 弹层横向可滚：overflow-y 非 visible 会把 overflow-x 的 visible 计算成
//      auto，只要还有 1px 溢出（亚像素 / 页面缩放）就重新长出滚动条；本组件
//      没有合法的横向滚动内容，横轴必须显式关掉。
//
// jsdom 说明：无布局引擎，宽度恒 0（像素层由真机 A/B 实测核验）；overflow-x
// longhand 在 jsdom 读作 'visible'（它只实现 overflow 简写），故横轴按规则源核验，
// box-sizing 两者都核（computed 采信注入的 style 元素）。
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
    // 反证：弹层自身仍是 content-box——根因在选项行与弹层内容盒的宽度关系上，
    // 不是在弹层自己的盒子模型上（改弹层的 box-sizing 只会把 max-width 度量挪走）
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
    // border-box 下 min-height 量边框盒：38 = 内容 30 + 上下 padding 8，即改前真机
    // 渲染出来的行高（模型弹层同为内容 30 + padding 8）。照抄 30 会把每行压矮 8px，
    // 与模型弹层分叉——两处渲染后的行高必须都是 38px。
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
