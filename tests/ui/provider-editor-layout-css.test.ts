// tests/ui/provider-editor-layout-css.test.ts
// 票 10：矮容器滚动与 400px 窄面板的操作可达（结构性判据）。
//
// jsdom 没有布局几何，真机宽度 / 溢出判据留在票 12/13 的浏览器验收；这里锁住
// 支撑那两条结论的 CSS 契约：字段区独立滚动且底部动作常驻、模型行动作在窄面板
// 折行而不溢出、确认框在矮容器里可滚动、字段错误有不占位的隐藏态。
//
// 失败方式：任一规则被改回「整张 Dialog 滚动 / 模型行不折行 / 确认框无高度上限」，
// 真机上短视口或 400px 面板就会再次出现动作被裁掉。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const PROVIDERS_CSS = read("extension/entry/styles/reader-settings-providers.css");
const READER_CSS = read("extension/entry/styles/reader.css");

function ruleBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = Array.from(css.matchAll(new RegExp(`${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "g")));
  return matches.map((m) => m[1] ?? "").join("\n");
}

describe("平台编辑 Modal：矮容器滚动与窄面板折行", () => {
  it("Dialog 自身不滚动，字段区独立滚动（表头与底部动作常驻）", () => {
    expect(ruleBlock(PROVIDERS_CSS, "#biliscript-reading-view .provider-editor-dialog")).toContain(
      "overflow: hidden"
    );
    expect(ruleBlock(PROVIDERS_CSS, "#biliscript-reading-view .provider-editor-dialog")).toContain(
      "max-height: calc(100% - 48px)"
    );
    const body = ruleBlock(PROVIDERS_CSS, "#biliscript-reading-view .provider-editor-body");
    expect(body).toContain("overflow-y: auto");
    expect(body).toContain("min-height: 0");
  });

  it("表单是纵向 flex 容器，撑满 Dialog 并允许字段区收缩", () => {
    const form = ruleBlock(PROVIDERS_CSS, "#biliscript-reading-view .provider-editor-form");
    expect(form).toContain("display: flex");
    expect(form).toContain("flex-direction: column");
    expect(form).toContain("min-height: 0");
  });

  it("模型行在窄面板折行、输入框有可收缩的 flex 基准；底部动作可折行", () => {
    const row = ruleBlock(PROVIDERS_CSS, "#biliscript-reading-view .provider-editor-model-row");
    expect(row).toContain("flex-wrap: wrap");
    const input = ruleBlock(
      PROVIDERS_CSS,
      "#biliscript-reading-view .provider-editor-model-row .provider-editor-model-id"
    );
    expect(input).toContain("flex: 1 1 160px");
    expect(input).toContain("min-width: 0");
    expect(ruleBlock(PROVIDERS_CSS, "#biliscript-reading-view .provider-editor-foot")).toContain(
      "flex-wrap: wrap"
    );
  });

  it("400px 窄面板：两层弹层都按视口宽度收缩（不横向溢出）", () => {
    expect(ruleBlock(PROVIDERS_CSS, "#biliscript-reading-view .provider-editor-dialog")).toContain(
      "width: min(560px, calc(100% - 48px))"
    );
    expect(ruleBlock(READER_CSS, "#biliscript-reading-view .confirm-dialog")).toContain(
      "width: min(320px, calc(100% - 48px))"
    );
  });

  it("字段错误节点隐藏时不占位（无错误时布局与旧版一致）", () => {
    expect(ruleBlock(PROVIDERS_CSS, "#biliscript-reading-view .provider-editor-field-error[hidden]")).toContain(
      "display: none"
    );
  });

  it("确认框在矮容器内可滚动（标题、说明与动作都不被裁掉）", () => {
    const dialog = ruleBlock(READER_CSS, "#biliscript-reading-view .confirm-dialog");
    expect(dialog).toContain("max-height: calc(100% - 48px)");
    expect(dialog).toContain("overflow-y: auto");
    expect(dialog).toContain("overscroll-behavior: contain");
    expect(ruleBlock(READER_CSS, "#biliscript-reading-view .confirm-dialog-title")).toContain("font-weight: 700");
  });
});

describe("语义色、校验作用域、玻璃防透字与窄屏/字号缩放适配", () => {
  const ROWS_CSS = read("extension/entry/styles/reader-settings-rows.css");
  const SHELL_CSS = read("extension/entry/styles/reader-settings-shell.css");
  const GATE_CSS = read("extension/entry/styles/reader-gate.css");

  it("错误文案/边框/图标统一使用 --biliscript-reader-danger，不误用 --biliscript-reader-accent", () => {
    expect(ruleBlock(PROVIDERS_CSS, "#biliscript-reading-view .provider-editor-field-error")).toContain(
      "var(--biliscript-reader-danger)"
    );
    expect(ruleBlock(PROVIDERS_CSS, "#biliscript-reading-view .provider-editor-status[data-error=\"true\"]")).toContain(
      "var(--biliscript-reader-danger)"
    );
    expect(ruleBlock(PROVIDERS_CSS, "#biliscript-reading-view .provider-editor-model-result[data-state=\"error\"]")).toContain(
      "var(--biliscript-reader-danger)"
    );
    expect(ruleBlock(PROVIDERS_CSS, "#biliscript-reading-view .provider-editor-catalog-error")).toContain(
      "var(--biliscript-reader-danger)"
    );
    expect(ruleBlock(PROVIDERS_CSS, "#biliscript-reading-view .provider-editor-fetch-error")).toContain(
      "var(--biliscript-reader-danger)"
    );
    expect(ruleBlock(ROWS_CSS, "#biliscript-reading-view .provider-editor-host .ai-provider-model-error")).toContain(
      "var(--biliscript-reader-danger)"
    );
    expect(ruleBlock(SHELL_CSS, "#biliscript-reading-view .biliscript-reading-settings-host .biliscript-set-status[data-error=\"true\"]")).toContain(
      "var(--biliscript-reader-danger)"
    );
    expect(ruleBlock(READER_CSS, ".biliscript-reading-explain-card-state.is-error")).toContain(
      "var(--biliscript-reader-danger)"
    );
  });

  it(":user-valid / :user-invalid 严格收窄到带 required / pattern 约束的输入", () => {
    const providerValid = PROVIDERS_CSS.match(/.*:user-valid\s*\{[^}]*\}/g) ?? [];
    const providerInvalid = PROVIDERS_CSS.match(/.*:user-invalid\s*\{[^}]*\}/g) ?? [];
    expect(providerValid.length).toBeGreaterThan(0);
    expect(providerInvalid.length).toBeGreaterThan(0);
    for (const rule of [...providerValid, ...providerInvalid]) {
      expect(rule).toContain(":is([required], [pattern])");
    }

    const gateValid = GATE_CSS.match(/.*:user-valid\s*\{[^}]*\}/g) ?? [];
    const gateInvalid = GATE_CSS.match(/.*:user-invalid\s*\{[^}]*\}/g) ?? [];
    expect(gateValid.length).toBeGreaterThan(0);
    expect(gateInvalid.length).toBeGreaterThan(0);
    for (const rule of [...gateValid, ...gateInvalid]) {
      expect(rule).toContain(":is([required], [pattern])");
    }
    expect(gateInvalid[0]).toContain("var(--biliscript-reader-danger)");
  });

  it("子视图实底隔离底层头/表防 Flyme 透字叠影；底栏可折行、控件改 min-height 并支持长错换行", () => {
    expect(
      ruleBlock(
        PROVIDERS_CSS,
        "#biliscript-reading-view .provider-editor-dialog:has(> .provider-editor-fetch-dialog) > :is(.provider-editor-head, .provider-editor-form)"
      )
    ).toContain("visibility: hidden");
    const gateFetch = ruleBlock(GATE_CSS, 'body[data-biliscript-reader-mode="1"] #biliscript-reading-view .provider-editor-fetch-dialog');
    expect(gateFetch).toContain("background: var(--biliscript-reader-surface)");
    expect(gateFetch).toContain("backdrop-filter: none");

    expect(ruleBlock(PROVIDERS_CSS, "#biliscript-reading-view .provider-editor-fetch-foot")).toContain(
      "flex-wrap: wrap"
    );
    expect(ruleBlock(PROVIDERS_CSS, "#biliscript-reading-view .provider-editor-status")).toContain(
      "overflow-wrap: anywhere"
    );
    expect(ruleBlock(PROVIDERS_CSS, "#biliscript-reading-view .provider-editor-cancel")).toContain("min-height: 32px");
    expect(ruleBlock(PROVIDERS_CSS, "#biliscript-reading-view .provider-editor-save")).toContain("min-height: 32px");
  });
});
