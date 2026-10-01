// tests/ui/custom-select-hidden.test.ts
// 隐藏 select 的提权补偿守卫（自定义下拉接管后的原生 select 尺寸/描边）。
//
// 病因：6081f7c 给隐藏 select 补过两条提权规则，ba131de 把 reader-settings.css
// 拆成 shell/rows/providers 时把规则弄丢、只留下引用它的注释（「后两条再补回被压
// 属性」悬空）。基础规则 #biliscript-reading-view .custom-select-hidden (1,1,0)
// 于是被两处更高优先级的原生 select 外观规则压回尺寸：
//   - 设置宿主回退规则 (1,2,0)（reader-settings-shell.css:176）→ 设置抽屉；
//   - Modal 的 select 规则 (1,1,1)（reader-settings-providers.css:124）→ 平台编辑。
// 后果：原生 select 以 100%×32px 绝对定位盖在自定义 trigger 上，点开是系统原生
// 方角弹层。
//
// 本测试按真实级联顺序注入源文件文本（style-injector.ts:82-84 / build.js:79-81：
// shell → rows → providers），直接判读 computed style：尺寸与其余被压属性都得
// 回到 1px 隐藏态。判定值即补偿规则声明的值（width/height 1px、padding 0、
// margin -1px、border 0、position absolute），字面量取自 rules 本身，不从被测
// CSS 反推。
//
// jsdom 失真与对策：jsdom 的 getComputedStyle 把「选择器列表」当成一条规则、取
// 列表内特异性的最大值（node_modules/jsdom/lib/jsdom/living/css/helpers/
// computed-style.js 的 Specificity.max(...)），浏览器则逐条命中选择器各算各的。
// providers.css:122-124 的原生 select 外观规则与 input[type="text"] 同列一条列表，
// jsdom 下被抬到 (1,2,1)、反压 Modal 补偿规则的 (1,2,0)（实测：只补规则不改注入
// 方式时 Modal 仍读作 100%/32px）。注入前把选择器列表拆成逐选择器规则（声明块
// 原样搬运，对级联语义等价），消掉这处失真，让 jsdom 与浏览器同判。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf8");

const SHELL_CSS = "extension/entry/styles/reader-settings-shell.css";
const ROWS_CSS = "extension/entry/styles/reader-settings-rows.css";
const PROVIDERS_CSS = "extension/entry/styles/reader-settings-providers.css";

// 按顶层逗号切分选择器列表（括号/方括号/引号内的逗号不算）。
function splitSelectorList(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < prelude.length; i += 1) {
    const ch = prelude[i];
    if (quote) {
      if (ch === quote && prelude[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(prelude.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(prelude.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

// 列表带规则体的分组 at-rule：内层仍是「选择器 { 声明 }」，需递归拆列表。
const GROUPING_AT_RULE = /^@(media|supports|layer|container)\b/;

// 把「选择器列表 { 声明 }」拆成逐选择器的多条规则（声明块原样保留）；分组 at-rule
// 递归，@keyframes / @starting-style 等保持原样。注释先摘掉——注释里有花括号与
// 分号，会打断块扫描（注释对级联无影响）。
function splitSelectorLists(css: string): string {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open === -1) {
      out.push(text.slice(i));
      break;
    }
    // 无块语句（@charset / @import）自带分号、没有声明块
    const semi = text.indexOf(";", i);
    if (semi !== -1 && semi < open) {
      out.push(text.slice(i, semi + 1));
      i = semi + 1;
      continue;
    }
    const prelude = text.slice(i, open);
    let depth = 1;
    let end = open + 1;
    while (end < text.length && depth > 0) {
      if (text[end] === "{") depth += 1;
      else if (text[end] === "}") depth -= 1;
      end += 1;
    }
    const block = text.slice(open, end); // 含花括号
    if (prelude.trim().startsWith("@")) {
      const inner = block.slice(1, -1);
      out.push(`${prelude}{${GROUPING_AT_RULE.test(prelude.trim()) ? splitSelectorLists(inner) : inner}}`);
    } else {
      for (const selector of splitSelectorList(prelude)) {
        out.push(`${selector} ${block}`);
      }
    }
    i = end;
  }
  return out.join("\n");
}

// 注入源文件文本，顺序即真实级联顺序（shell → rows → providers）。
function mountStyles(files: string[]): void {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  for (const file of files) {
    const style = document.createElement("style");
    style.textContent = splitSelectorLists(read(file));
    document.head.appendChild(style);
  }
}

// 设置抽屉里的隐藏 select。DOM 形状照 custom-select.ts:109-116 的接管结果：
// wrapper 内 trigger 与隐藏 select 并列，select 仍留在设置宿主内。
function mountDrawerSelect(): HTMLSelectElement {
  const view = document.createElement("div");
  view.id = "biliscript-reading-view";
  view.innerHTML = `
    <div class="biliscript-reading-settings-host">
      <div class="custom-select-wrapper">
        <button type="button" class="custom-select-trigger"><span class="custom-select-value">SRT</span></button>
        <select class="biliscript-set-select custom-select-hidden" tabindex="-1" aria-hidden="true">
          <option value="srt" selected>SRT</option>
        </select>
      </div>
    </div>`;
  document.body.appendChild(view);
  return view.querySelector<HTMLSelectElement>("select")!;
}

// 平台编辑 Modal 里的隐藏 select（协议下拉，provider-editor-modal.ts:721 的接管点）。
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
            <div class="custom-select-wrapper provider-editor-protocol-wrapper">
              <button type="button" class="custom-select-trigger"><span class="custom-select-value">OpenAI 兼容</span></button>
              <select class="provider-editor-protocol custom-select-hidden" tabindex="-1" aria-hidden="true">
                <option value="openai" selected>OpenAI 兼容</option>
              </select>
            </div>
          </div>
        </div>
      </section>
    </div>`;
  document.body.appendChild(view);
  return view.querySelector<HTMLSelectElement>("select")!;
}

// 隐藏态指纹：补偿规则声明的每一项都在场（尺寸 + 被设置宿主/Modal 压掉的内边距、
// 外边距、描边、定位）。
function hiddenMetrics(el: HTMLSelectElement) {
  const cs = getComputedStyle(el);
  return {
    position: cs.position,
    width: cs.width,
    height: cs.height,
    padding: cs.padding,
    margin: cs.margin,
    borderTopWidth: cs.borderTopWidth
  };
}

const HIDDEN = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: "0px",
  margin: "-1px",
  borderTopWidth: "0px"
};

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("隐藏 select 的提权补偿（自定义下拉接管后）", () => {
  it("设置抽屉（shell → rows）：原生 select 压到 1px 隐藏态，不被宿主回退规则的 100%×32px 盖回去", () => {
    mountStyles([SHELL_CSS, ROWS_CSS]);
    const select = mountDrawerSelect();
    expect(hiddenMetrics(select)).toEqual(HIDDEN);
  });

  it("平台编辑 Modal（rows → providers）：原生 select 压到 1px 隐藏态，不被 Modal 的 select 规则盖回去", () => {
    mountStyles([ROWS_CSS, PROVIDERS_CSS]);
    const select = mountModalSelect();
    expect(hiddenMetrics(select)).toEqual(HIDDEN);
  });
});
