// 设置分区 CSS 拆分守卫（arch-slim-4/04，Q8 源码口径）：reader.css 不得再含
// 设置分区标记，设置分区表组（2026-09 起三份 shell/rows/providers）必须持有；
// style-injector 三件套与 settings-panel 顶挂载接线在场。防倒退：设置样式一旦
// 回流主表，按需装载的 chunk 边就静默失效（主表常驻、分区表空挂）。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const READER_CSS = "extension/entry/styles/reader.css";
// 设置分区表组（2026-09 拆分）：三份按级联顺序排列，标记检查对拼接后全文做
//——单看任一份都不完整（provider-editor- 前缀跨 rows（模型下拉）与
// providers（Modal））。
const SETTINGS_CSS_FILES = [
  "extension/entry/styles/reader-settings-shell.css",
  "extension/entry/styles/reader-settings-rows.css",
  "extension/entry/styles/reader-settings-providers.css"
];
// 组件表（2026-10 从设置三件套抽出）：custom-select-* 规则与标记的家，随
// ui/custom-select.ts 组件走（2026-10 起不再随 settings-panel chunk 装载）。
const COMPONENT_CSS = "extension/entry/styles/custom-select.css";
const INJECTOR = "extension/shared/style-injector.ts";
const SETTINGS_PANEL = "extension/ui/settings-panel.ts";
const COMPONENT_MODULE = "extension/ui/custom-select.ts";

// 设置分区样式标记：拆分前全部在 reader.css，拆分后（2026-09 起表组三份）
// 不得回流 reader.css
const SETTINGS_MARKERS = ["biliscript-reading-settings-host", "provider-editor-"];
// 组件表标记（custom-select-*）：同样不得回流 reader.css，家在独立组件表
const COMPONENT_MARKER = "custom-select-";

// 选择器行（以 { 或 , 收尾的行）——注释行不参与，源码行才代表规则在场。
function selectorLines(css: string): string[] {
  return css
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(".custom-select-") && /[{,]\s*$/.test(line));
}

describe("设置分区 CSS 拆分（arch-slim-4/04）", () => {
  it("reader.css 不含设置分区与组件表标记（守卫回流）", () => {
    const text = read(READER_CSS);
    for (const marker of [...SETTINGS_MARKERS, COMPONENT_MARKER]) {
      expect(text.includes(marker), `${READER_CSS} 仍含设置分区标记 ${marker}`).toBe(false);
    }
  });

  it("设置分区表组持有全部设置分区标记，组件表持有组件标记", () => {
    const files = SETTINGS_CSS_FILES.map((rel) => read(rel));
    for (const marker of SETTINGS_MARKERS) {
      const holder = files.findIndex((text) => text.includes(marker));
      expect(holder, `设置分区表组缺少标记 ${marker}`).toBeGreaterThan(-1);
    }
    expect(read(COMPONENT_CSS).includes(COMPONENT_MARKER), `${COMPONENT_CSS} 缺少标记 ${COMPONENT_MARKER}`).toBe(true);
  });

  it("自定义下拉样式只在阅读视图内匹配（家里在独立组件表）", () => {
    // 组件表自身必须持有全部选择器行（规则不能再回流设置表）
    const componentLines = selectorLines(read(COMPONENT_CSS));
    expect(componentLines.length).toBeGreaterThan(0);
    expect(componentLines.filter((line) => !line.startsWith("#biliscript-reading-view "))).toEqual([]);

    // 四表合并后同样只许 #biliscript-reading-view 作用域（设置表里仅剩的
    // custom-select 引用是分区抬升的 :has(...) 选择器，也带作用域前缀）
    const selectorLinesAll = [...SETTINGS_CSS_FILES, COMPONENT_CSS]
      .map((rel) => read(rel))
      .join("\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.includes(".custom-select-") && /[{,]\s*$/.test(line),
      );
    const unscopedSelectors = selectorLinesAll.filter(
      (line) => !line.startsWith("#biliscript-reading-view "),
    );

    expect(selectorLinesAll.length).toBeGreaterThan(0);
    expect(unscopedSelectors).toEqual([]);
  });

  it("壳静态模板的 settings-group 留守 reader.css（不随分区搬走）", () => {
    expect(read(READER_CSS).includes("biliscript-reading-settings-group")).toBe(true);
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

  it("组件表接线：injector 暴露 ensureCustomSelectStyles 与路径，组件模块顶挂载，不塞进设置三件套数组", () => {
    const injector = read(INJECTOR);
    expect(injector).toMatch(/export function ensureCustomSelectStyles/);
    expect(injector).toMatch(/entry\/styles\/custom-select\.css/);

    // 不顶替原三份：设置三件套路径仍在数组里，组件表不进该数组
    const settingsPaths = injector.match(/const READER_SETTINGS_STYLE_PATHS = \[[^\]]*\]/);
    expect(settingsPaths, "READER_SETTINGS_STYLE_PATHS 未找到").not.toBeNull();
    for (const rel of [
      "entry/styles/reader-settings-shell.css",
      "entry/styles/reader-settings-rows.css",
      "entry/styles/reader-settings-providers.css"
    ]) {
      expect(settingsPaths![0], `设置三件套缺 ${rel}`).toContain(rel);
    }
    expect(settingsPaths![0].includes("custom-select.css")).toBe(false);

    // 组件模块顶挂载（settings-panel.ts:76 同款先例：求值即挂表）
    expect(read(COMPONENT_MODULE)).toMatch(/ensureCustomSelectStyles\(\)/);

    // dist 侧：build.js 的 cssEntries 按 entry/styles/ 目录派生（不再维护逐文件
    // 白名单）⇒「表住在入口目录里」即「会被 minify 进 dist」；运行时挂载用
    // getURL 取 dist 同相对路径，漏产物即 404（manifest 的 entry/styles/* 通配
    // 只放行不改产物）。故此处守卫两条：目录派生在场 + injector 声明的每张表都
    // 真的住在该目录里。
    const build = read("scripts/build.js");
    expect(build).toMatch(/const stylesDir = path\.join\(extensionRoot, "entry\/styles"\);/);
    expect(build).toMatch(/const cssEntries = fs\s*\n\s*\.readdirSync\(stylesDir\)/);

    const declaredStyles = [...injector.matchAll(/"entry\/styles\/[a-z-]+\.css"/g)].map((match) => match[0].slice(1, -1));
    expect(declaredStyles).toContain("entry/styles/custom-select.css");
    for (const rel of declaredStyles) {
      expect(existsSync(join(ROOT, "extension", rel)), `injector 声明的 ${rel} 不在入口目录里`).toBe(true);
    }
  });
});
