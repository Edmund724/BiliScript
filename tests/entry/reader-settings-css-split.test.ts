import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const READER_CSS = "extension/entry/styles/reader.css";
const SETTINGS_CSS_FILES = [
  "extension/entry/styles/reader-settings-shell.css",
  "extension/entry/styles/reader-settings-rows.css",
  "extension/entry/styles/reader-settings-providers.css"
];
const COMPONENT_CSS = "extension/entry/styles/custom-select.css";
const INJECTOR = "extension/shared/style-injector.ts";
const SETTINGS_PANEL = "extension/ui/settings-panel.ts";
const COMPONENT_MODULE = "extension/ui/custom-select.ts";

const SETTINGS_MARKERS = ["biliscript-reading-settings-host", "provider-editor-"];
const COMPONENT_MARKER = "custom-select-";

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
    const componentLines = selectorLines(read(COMPONENT_CSS));
    expect(componentLines.length).toBeGreaterThan(0);
    expect(componentLines.filter((line) => !line.startsWith("#biliscript-reading-view "))).toEqual([]);

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
    expect(injector).toMatch(/entry\/styles\/reader-settings-shell\.css/);
    expect(injector).toMatch(/entry\/styles\/reader-settings-rows\.css/);
    expect(injector).toMatch(/entry\/styles\/reader-settings-providers\.css/);
    expect(injector.includes('"entry/styles/reader-settings.css"')).toBe(false);

    const panel = read(SETTINGS_PANEL);
    expect(panel).toMatch(/ensureReaderSettingsStyles\(\)/);
    expect(panel).toMatch(/whenReaderSettingsStylesReady/);
  });

  it("组件表接线：injector 暴露 ensureCustomSelectStyles 与路径，组件模块顶挂载，不塞进设置三件套数组", () => {
    const injector = read(INJECTOR);
    expect(injector).toMatch(/export function ensureCustomSelectStyles/);
    expect(injector).toMatch(/entry\/styles\/custom-select\.css/);

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

    expect(read(COMPONENT_MODULE)).toMatch(/ensureCustomSelectStyles\(\)/);

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
