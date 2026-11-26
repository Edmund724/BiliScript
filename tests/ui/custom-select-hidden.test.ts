import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf8");

const SHELL_CSS = "extension/entry/styles/reader-settings-shell.css";
const ROWS_CSS = "extension/entry/styles/reader-settings-rows.css";
const PROVIDERS_CSS = "extension/entry/styles/reader-settings-providers.css";
const CUSTOM_SELECT_CSS = "extension/entry/styles/custom-select.css";

function mountStyles(): void {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  for (const file of [CUSTOM_SELECT_CSS, SHELL_CSS, ROWS_CSS, PROVIDERS_CSS]) {
    const style = document.createElement("style");
    style.textContent = read(file);
    document.head.appendChild(style);
  }
}

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
  it("设置抽屉（custom-select → shell → rows → providers）：接管产物 computed display 恒为 none，宿主 select 外观规则盖不回来", async () => {
    mountStyles();
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    const select = mountDrawerSelect();

    initCustomSelect(select);

    expect(getComputedStyle(select).display).toBe("none");
  });

  it("平台编辑 Modal（custom-select → shell → rows → providers）：接管产物 computed display 恒为 none，Modal 的 select 规则盖不回来", async () => {
    mountStyles();
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    const select = mountModalSelect();

    initCustomSelect(select);

    expect(getComputedStyle(select).display).toBe("none");
  });
});

describe("组件表（extension/entry/styles/custom-select.css，2026-10 从设置三件套抽出）", () => {
  it("收起规则与度量规则都在组件表内（漏带即列表常开 / 弹层裸奔）", () => {
    const css = read(CUSTOM_SELECT_CSS);
    expect(css).toMatch(
      /#biliscript-reading-view \.custom-select-dropdown\[hidden\]\s*\{[^}]*display:\s*none/
    );
    expect(css).toMatch(/#biliscript-reading-view \.custom-select-dropdown\s*\{[^}]*max-width:\s*260px/);
    expect(css).toMatch(/#biliscript-reading-view \.custom-select-trigger\s*\{[^}]*height:\s*32px/);
    expect(css).toMatch(/#biliscript-reading-view \.custom-select-option\s*\{[^}]*min-height:\s*38px/);
    expect(css).toMatch(/#biliscript-reading-view \.custom-select-wrapper\s*\{[^}]*position:\s*relative/);
    expect(css).toMatch(/#biliscript-reading-view \.custom-select-arrow svg\s*\{[^}]*stroke-width:\s*var\(--select-arrow-stroke-width,\s*1\.75\)/);
  });

  it("搬走后设置表不重复声明，且同度量的模型弹层声明仍在场（两边渲染度量都不变）", () => {
    const rows = read(ROWS_CSS);
    expect(rows).toMatch(
      /#biliscript-reading-view \.provider-editor-host \.ai-provider-model-dropdown\s*\{[^}]*max-width:\s*260px/
    );
    expect(rows).toMatch(
      /#biliscript-reading-view \.provider-editor-host \.ai-provider-model-dropdown\[hidden\]\s*\{[^}]*display:\s*none/
    );
    for (const file of [SHELL_CSS, ROWS_CSS, PROVIDERS_CSS]) {
      const css = read(file);
      expect(css, `${file} 仍声明 .custom-select-wrapper`).not.toMatch(/\.custom-select-wrapper/);
      expect(css, `${file} 仍声明 .custom-select-trigger`).not.toMatch(/\.custom-select-trigger/);
      expect(css, `${file} 仍声明 .custom-select-arrow`).not.toMatch(/\.custom-select-arrow/);
      expect(css, `${file} 仍声明 .custom-select-option`).not.toMatch(/\.custom-select-option/);
    }
  });

  it("模型弹层与组件下拉同规格（分叉锁定）：行盒模型/行高/padding/两轴溢出一致", () => {
    const declOf = (block: string, prop: string): string => {
      const hit = block.match(new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;]+);`));
      expect(hit, `规则块里没有 ${prop} 声明`).not.toBeNull();
      return hit![1].trim();
    };
    const blockFrom = (css: string, re: RegExp): string => {
      const hit = css.match(re);
      expect(hit, `规则块未找到：${re}`).not.toBeNull();
      return hit![0];
    };

    const compOption = blockFrom(read(CUSTOM_SELECT_CSS), /#biliscript-reading-view \.custom-select-option\s*\{[^}]*\}/);
    const modelOption = blockFrom(
      read(ROWS_CSS),
      /#biliscript-reading-view \.provider-editor-host \.ai-provider-model-option,[\s\S]*?\.ai-provider-model-message\s*\{[^}]*\}/
    );
    for (const prop of ["box-sizing", "min-height", "padding"]) {
      expect(declOf(modelOption, prop), `${prop} 两族分叉（改一处必须同时改另一处）`).toBe(
        declOf(compOption, prop)
      );
    }
    const modelOptionOnly = blockFrom(
      read(ROWS_CSS),
      /#biliscript-reading-view \.provider-editor-host \.ai-provider-model-option\s*\{[^}]*\}/
    );
    expect(declOf(modelOptionOnly, "line-height"), "line-height 两族分叉（改一处必须同时改另一处）").toBe(
      declOf(compOption, "line-height")
    );
    const modelMessage = blockFrom(
      read(ROWS_CSS),
      /#biliscript-reading-view \.provider-editor-host \.ai-provider-model-message\s*\{[^}]*\}/
    );
    expect(modelMessage).not.toMatch(/line-height:\s*30px/);

    const compDropdown = blockFrom(read(CUSTOM_SELECT_CSS), /#biliscript-reading-view \.custom-select-dropdown\s*\{[^}]*\}/);
    const modelDropdown = blockFrom(
      read(ROWS_CSS),
      /#biliscript-reading-view \.provider-editor-host \.ai-provider-model-dropdown\s*\{[^}]*\}/
    );
    for (const prop of ["max-width", "max-height", "overflow-x", "overflow-y"]) {
      expect(declOf(modelDropdown, prop), `${prop} 两族分叉（改一处必须同时改另一处）`).toBe(
        declOf(compDropdown, prop)
      );
    }
    expect(declOf(compDropdown, "overflow-x")).toBe("hidden");
    expect(declOf(modelOption, "box-sizing")).toBe("border-box");
  });

  it("四条规则按真实级联顺序注入：展开态可见，收起态 computed display 为 none", async () => {
    mountStyles();
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    const select = mountDrawerSelect();
    initCustomSelect(select);
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    const trigger = wrapper.querySelector<HTMLElement>(".custom-select-trigger")!;
    const dropdown = wrapper.querySelector<HTMLElement>(".custom-select-dropdown")!;

    expect(dropdown.hidden).toBe(true);
    expect(getComputedStyle(dropdown).display).toBe("none");

    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(dropdown.hidden).toBe(false);
    expect(getComputedStyle(dropdown).display).not.toBe("none");
  });
});
