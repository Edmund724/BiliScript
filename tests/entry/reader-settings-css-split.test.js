// 设置分区 CSS 拆分守卫（arch-slim-4/04，Q8 源码口径）：reader.css 不得再含
// 设置分区标记，设置分区表组（2026-09 起三份 shell/rows/providers）必须持有；
// style-injector 三件套与 settings-panel 顶挂载接线在场。防倒退：设置样式一旦
// 回流主表，按需装载的 chunk 边就静默失效（主表常驻、分区表空挂）。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const READER_CSS = "extension/entry/styles/reader.css";
// 设置分区表组（2026-09 拆分）：三份按级联顺序排列，标记检查对拼接后全文做
//——单看任一份都不完整（provider-editor- 前缀跨 rows（模型下拉）与
// providers（Modal），custom-select- 跨 shell（焦点/校验态）与 rows）。
const SETTINGS_CSS_FILES = [
  "extension/entry/styles/reader-settings-shell.css",
  "extension/entry/styles/reader-settings-rows.css",
  "extension/entry/styles/reader-settings-providers.css"
];
const INJECTOR = "extension/shared/style-injector.ts";
const SETTINGS_PANEL = "extension/ui/settings-panel.ts";
const BUILD_JS = "scripts/build.js";

// 设置分区样式标记：拆分前全部在 reader.css，拆分后（2026-09 起表组三份）
// 不得回流 reader.css
const SETTINGS_MARKERS = ["boc-reading-settings-host", "provider-editor-", "custom-select-"];

describe("设置分区 CSS 拆分（arch-slim-4/04）", () => {
  it("reader.css 不含设置分区标记（守卫回流）", () => {
    const text = read(READER_CSS);
    for (const marker of SETTINGS_MARKERS) {
      expect(text.includes(marker), `${READER_CSS} 仍含设置分区标记 ${marker}`).toBe(false);
    }
  });

  it("设置分区表组持有全部设置分区标记与 settings-panel 本体规则", () => {
    const files = SETTINGS_CSS_FILES.map((rel) => read(rel));
    for (const marker of SETTINGS_MARKERS) {
      const holder = files.findIndex((text) => text.includes(marker));
      expect(holder, `设置分区表组缺少标记 ${marker}`).toBeGreaterThan(-1);
    }
    expect(read(SETTINGS_CSS_FILES[0]).includes("boc-reading-settings-panel")).toBe(true);
  });

  it("自定义下拉样式只在阅读视图内匹配", () => {
    const selectorLines = SETTINGS_CSS_FILES.map((rel) => read(rel))
      .join("\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.includes(".custom-select-") && /[{,]\s*$/.test(line),
      );
    const unscopedSelectors = selectorLines.filter(
      (line) => !line.startsWith("#boc-reading-view "),
    );

    expect(selectorLines.length).toBeGreaterThan(0);
    expect(unscopedSelectors).toEqual([]);
  });

  it("壳静态模板的 settings-group 留守 reader.css（不随分区搬走）", () => {
    expect(read(READER_CSS).includes("boc-reading-settings-group")).toBe(true);
  });

  it("style-injector 暴露设置表三件套（ensure/whenReady）与三份路径，settings-panel 顶挂载接线", () => {
    const injector = read(INJECTOR);
    expect(injector).toMatch(/export function ensureReaderSettingsStyles/);
    expect(injector).toMatch(/export function whenReaderSettingsStylesReady/);
    // 三份路径全部在列表里（顺序即级联顺序）；旧单文件路径不得残留
    expect(injector).toMatch(/entry\/styles\/reader-settings-shell\.css/);
    expect(injector).toMatch(/entry\/styles\/reader-settings-rows\.css/);
    expect(injector).toMatch(/entry\/styles\/reader-settings-providers\.css/);
    expect(injector.includes('"entry/styles/reader-settings.css"')).toBe(false);

    const panel = read(SETTINGS_PANEL);
    // 模块顶层 ensure（player-ai.ts:29 先例：求值即挂表）
    expect(panel).toMatch(/ensureReaderSettingsStyles\(\)/);
    // 首建分支门控：等 onload ready 再渲染
    expect(panel).toMatch(/whenReaderSettingsStylesReady/);
  });

  it("build.js 持有设置分区表组三份独立 minify 入口", () => {
    const buildJs = read(BUILD_JS);
    for (const rel of SETTINGS_CSS_FILES) {
      expect(buildJs.includes(rel.replace("extension/", "")), `build.js 缺入口 ${rel}`).toBe(true);
    }
  });
});
