// tests/ui/custom-select-hidden.test.ts
// 接管后隐藏 select 的回归守卫（设置抽屉 / 平台编辑 Modal 两个宿主上下文）。
//
// 旧病因：隐藏走 CSS 类 .custom-select-hidden 的 1px 视觉隐藏（position: absolute +
// 1px×1px + overflow: hidden），必须靠提权补偿规则跟宿主规则打特异性战争——6081f7c
// 补过两条，ba131de 把 reader-settings.css 拆成 shell/rows/providers 时把规则弄丢、
// 只留下引用它的注释，于是宿主回退规则 (1,2,0)（reader-settings-shell.css:176）与
// Modal 的 select 规则 (1,1,1)（reader-settings-providers.css:122-124）把 100%×32px
// 的原生 select 盖回 trigger 上，点开是系统原生方角弹层。
//
// 新机制：组件接管后只写一行内联样式 select.style.display = "none"。内联样式不进
// 特异性比较（只有宿主规则的 !important 能压过它），三份设置 CSS 里那些 100%×32px 的
// 原生 select 外观规则留着也无所谓；display:none 天然退出无障碍树与 Tab 序，
// tabIndex / aria-hidden 不再需要。
//
// 本测试守什么：即便三份真实设置 CSS 按真实级联顺序（shell → rows → providers，同
// style-injector.ts / build.js）全部注入，接管产物在两个宿主里的 computed display 也
// 必须恒为 none。有人把隐藏改回 CSS 类、或删掉那行内联样式让宿主规则重新盖住
// trigger，这里立刻变红。
//
// 隐藏由真实组件产出，不写进夹具：夹具只给「接管前」的宿主结构，隐藏是组件接管后
// 的可观察结果——夹具自己写死 style="display:none" 的话，删掉实现里的内联样式测试
// 也照样绿，守卫就废了。
//
// jsdom 说明：getComputedStyle 采信内联样式（实测 style="display:none" 读作 "none"），
// 与浏览器一致。隐藏既然由内联样式定胜负，旧文件那套 splitSelectorList /
// splitSelectorLists 拆分装置（为绕 jsdom「选择器列表取列表内最大特异性」失真而设）
// 不再需要，CSS 原样注入。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf8");

const SHELL_CSS = "extension/entry/styles/reader-settings-shell.css";
const ROWS_CSS = "extension/entry/styles/reader-settings-rows.css";
const PROVIDERS_CSS = "extension/entry/styles/reader-settings-providers.css";

// 注入源文件文本，顺序即真实级联顺序（shell → rows → providers）。
function mountStyles(): void {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  for (const file of [SHELL_CSS, ROWS_CSS, PROVIDERS_CSS]) {
    const style = document.createElement("style");
    style.textContent = read(file);
    document.head.appendChild(style);
  }
}

// 设置抽屉里待接管的原生 select（shell.css:176 的 .biliscript-set-select 规则域）。
function mountDrawerSelect(): HTMLSelectElement {
  const view = document.createElement("div");
  view.id = "biliscript-reading-view";
  view.innerHTML = `
    <div class="biliscript-reading-settings-host">
      <div class="biliscript-reading-row">
        <label for="downloadFormat">下载格式</label>
        <select id="downloadFormat" class="biliscript-set-select">
          <option value="srt" selected>SRT</option>
          <option value="txt">TXT</option>
        </select>
      </div>
    </div>`;
  document.body.appendChild(view);
  return view.querySelector<HTMLSelectElement>("select")!;
}

// 平台编辑 Modal 里待接管的原生 select（协议下拉，provider-editor-modal.ts 的接管点；
// providers.css:122-124 的原生 select 外观规则域）。
function mountModalSelect(): HTMLSelectElement {
  const view = document.createElement("div");
  view.id = "biliscript-reading-view";
  view.innerHTML = `
    <div class="provider-editor-host">
      <div class="provider-editor-mask"></div>
      <section class="provider-editor-dialog" role="dialog" aria-modal="true">
        <div class="provider-editor-body">
          <div class="provider-editor-field">
            <label class="provider-editor-label">协议</label>
            <select class="provider-editor-protocol">
              <option value="openai" selected>OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </div>
        </div>
      </section>
    </div>`;
  document.body.appendChild(view);
  return view.querySelector<HTMLSelectElement>("select")!;
}

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("接管后隐藏 select 的回归守卫（两个宿主上下文）", () => {
  it("设置抽屉（shell → rows → providers）：接管产物 computed display 恒为 none，宿主 select 外观规则盖不回来", async () => {
    mountStyles();
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    const select = mountDrawerSelect();

    initCustomSelect(select);

    expect(getComputedStyle(select).display).toBe("none");
  });

  it("平台编辑 Modal（shell → rows → providers）：接管产物 computed display 恒为 none，Modal 的 select 规则盖不回来", async () => {
    mountStyles();
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    const select = mountModalSelect();

    initCustomSelect(select);

    expect(getComputedStyle(select).display).toBe("none");
  });
});
