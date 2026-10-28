// tests/entry/migrate-settings-providers.test.ts
// 设置抽屉与 Provider 配置列表样式迁移契约测试（reader-settings-*.css）：
// 验证：
// 1. 设置外壳（reader-settings-shell.css）、配置行（reader-settings-rows.css）、
//    Provider 列表/编辑面板（reader-settings-providers.css）中的硬编码 border-radius
//    已全部替换为 --biliscript-radius-* 或组件级 token（--btn-radius, --pill-radius, --chip-radius, --select-*）。
// 2. 全部硬编码 font-size（含 calc(Npx * scale)）已替换为 --biliscript-font-size-* 或组件 token。
// 3. 消除裸写 HEX 颜色与裸写 RGBA 通道值，改为消费语义或 Primitive 变量。
// 4. 外边距、内边距与间隙中的标准间距数值均替换为 --biliscript-space-* 变量。

import { describe, expect, it } from "vitest";
import { readStyleFile, stripCssComments } from "./css-token-test-utils.js";

const SETTINGS_FILES = [
  "extension/entry/styles/reader-settings-shell.css",
  "extension/entry/styles/reader-settings-rows.css",
  "extension/entry/styles/reader-settings-providers.css"
] as const;

describe("设置抽屉与 Provider 配置列表 Token 迁移契约", () => {
  describe("1. 圆角 Token 迁移契约（border-radius）", () => {
    it("reader-settings-*.css 中无任何硬编码像素圆角（28px, 16px, 14px, 8px, 4px, 2px, 999px 等）与 50%", () => {
      for (const file of SETTINGS_FILES) {
        const text = stripCssComments(readStyleFile(file));
        const lines = text.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith("border-radius:")) {
            // 允许的值：0, 0px，或者必须使用 var(...)
            const isZero = /^border-radius:\s*0(?:px)?\s*;?$/.test(line);
            const hasVar = line.includes("var(");
            expect(
              isZero || hasVar,
              `${file} 第 ${i + 1} 行存在硬编码圆角: "${line}"`
            ).toBe(true);

            // 确保不包含裸写的典型阶梯数值（如 28px, 999px, 50% 等没有被 var 包裹）
            // 匹配 var 外部的裸 px 或 50%
            const withoutVars = line.replace(/var\([^)]+\)/g, "");
            expect(
              withoutVars,
              `${file} 第 ${i + 1} 行在 var 外部含有裸数值: "${line}"`
            ).not.toMatch(/\b(?:\d+px|50%)\b/);
          }
        }
      }
    });

    it("设置外壳、通用输入框与弹窗外壳消费 --biliscript-radius-panel 或相关组件变量", () => {
      const shell = stripCssComments(readStyleFile("extension/entry/styles/reader-settings-shell.css"));
      const rows = stripCssComments(readStyleFile("extension/entry/styles/reader-settings-rows.css"));
      const providers = stripCssComments(readStyleFile("extension/entry/styles/reader-settings-providers.css"));

      // shell 抽屉外壳
      expect(shell).toMatch(/\.biliscript-reading-settings-panel\s*\{[^}]*border-radius:\s*var\(--biliscript-radius-panel\)/);
      // shell 输入框
      expect(shell).toMatch(/\.biliscript-set-input[^}]*\{[^}]*border-radius:\s*var\(--biliscript-radius-panel\)/);

      // rows 模型下拉
      expect(rows).toMatch(/\.ai-provider-model-dropdown\s*\{[^}]*border-radius:\s*var\(--select-dropdown-radius/);
      // rows 提供商行：白卡式 flush 子卡片，圆角取 --card-child-radius（同心圆角
      // scoped 变量，定义在 reader-settings-shell.css 的抽屉壳上）
      expect(rows).toMatch(/\.ai-provider-row[^}]*\{[^}]*border-radius:\s*var\(--card-child-radius\)/);
      // rows 状态点圆形
      expect(rows).toMatch(/\.provider-row-dot\s*\{[^}]*border-radius:\s*var\(--biliscript-radius-circle\)/);
      // rows 徽章胶囊
      expect(rows).toMatch(/\.provider-row-badge\s*\{[^}]*border-radius:\s*(?:var\(--chip-radius|var\(--biliscript-radius-pill\))/);

      // providers 编辑对话框
      expect(providers).toMatch(/\.provider-editor-dialog\s*\{[^}]*border-radius:\s*var\(--biliscript-radius-panel\)/);
      // providers 按钮胶囊圆角
      expect(providers).toMatch(/\.provider-editor-save\s*\{[^}]*border-radius:\s*(?:var\(--btn-radius|var\(--biliscript-radius-pill\))/);
      // providers 获取模型弹窗外壳
      expect(providers).toMatch(/\.provider-editor-fetch-dialog\s*\{[^}]*border-radius:\s*var\(--biliscript-radius-panel\)/);
    });
  });

  describe("2. 字号 Token 迁移契约（font-size）", () => {
    it("reader-settings-*.css 中无任何裸写像素字号（如 12px, 13px, 14px, 16px 等）", () => {
      for (const file of SETTINGS_FILES) {
        const text = stripCssComments(readStyleFile(file));
        const lines = text.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith("font-size:")) {
            // 不得含有裸写数字 px（无论是 14px 还是 calc(14px * scale)）
            expect(
              line,
              `${file} 第 ${i + 1} 行存在硬编码像素字号: "${line}"`
            ).not.toMatch(/\d+px/);

            // 必须使用 var(--biliscript-font-size-* 或 var(--btn-font-size 等
            expect(
              line.includes("var(--biliscript-font-size-") ||
              line.includes("var(--btn-font-size") ||
              line.includes("var(--pill-font-size") ||
              line.includes("var(--chip-font-size") ||
              line.includes("var(--select-"),
              `${file} 第 ${i + 1} 行未消费语义或组件字阶 Token: "${line}"`
            ).toBe(true);
          }
        }
      }
    });

    it("标题消费 --biliscript-font-size-lg 或 md，正文与控件消费 base，次级与徽标消费 sm", () => {
      const shell = stripCssComments(readStyleFile("extension/entry/styles/reader-settings-shell.css"));
      const rows = stripCssComments(readStyleFile("extension/entry/styles/reader-settings-rows.css"));
      const providers = stripCssComments(readStyleFile("extension/entry/styles/reader-settings-providers.css"));

      // shell 分区标题
      expect(shell).toMatch(/\.biliscript-set-h\s*\{[^}]*font-size:\s*var\(--biliscript-font-size-lg\)/);
      // shell 提示文本
      expect(shell).toMatch(/\.biliscript-set-hint\s*\{[^}]*font-size:\s*var\(--biliscript-font-size-sm\)/);
      // shell 输入框
      expect(shell).toMatch(/\.biliscript-set-input[^}]*\{[^}]*font-size:\s*var\(--biliscript-font-size-base\)/);

      // rows 选项行
      expect(rows).toMatch(/\.ai-provider-model-option[^}]*\{[^}]*font-size:\s*var\(--select-option-font-size/);
      // rows 平台名称与模型副行
      expect(rows).toMatch(/\.provider-row-name\s*\{[^}]*font-size:\s*var\(--biliscript-font-size-base\)/);
      expect(rows).toMatch(/\.provider-row-model\s*\{[^}]*font-size:\s*var\(--biliscript-font-size-base\)/);

      // providers 弹窗标题
      expect(providers).toMatch(/\.provider-editor-title\s*\{[^}]*font-size:\s*var\(--biliscript-font-size-md\)/);
      // providers 标签与输入框
      expect(providers).toMatch(/\.provider-editor-label\s*\{[^}]*font-size:\s*var\(--biliscript-font-size-base\)/);
      // providers 模型元数据小标
      expect(providers).toMatch(/\[data-model-meta\]\s*\{[^}]*font-size:\s*var\(--biliscript-font-size-sm\)/);
    });
  });

  describe("3. 色彩与材质 Token 迁移契约（Hex & RGBA）", () => {
    it("reader-settings-*.css 中无裸 HEX 颜色（包括历史残留 #00aeec, #999 等）", () => {
      for (const file of SETTINGS_FILES) {
        const text = stripCssComments(readStyleFile(file));
        const hexMatches = text.match(/#[0-9a-fA-F]{3,8}(?![a-zA-Z0-9_-])/g) || [];
        expect(hexMatches, `${file} 中不应存在硬编码 HEX 颜色`).toEqual([]);
      }
    });

    it("reader-settings-*.css 中无裸写数值 RGBA（除使用 var(--*-rgb) 构造外）", () => {
      for (const file of SETTINGS_FILES) {
        const text = stripCssComments(readStyleFile(file));
        // 匹配 rgba(数字, 数字, 数字
        const rawRgbaMatches = text.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g) || [];
        expect(rawRgbaMatches, `${file} 中不应存在裸数值 rgba`).toEqual([]);
      }
    });
  });

  describe("4. 间距 Token 迁移契约（padding / margin / gap）", () => {
    it("reader-settings-*.css 中的常用外边距、内边距与间隙中的标准阶梯数值均消费 --biliscript-space-*", () => {
      const standardSpacingRegex = /\b(?:4|6|8|10|12|14|16|20|24|28|32)px\b/;
      for (const file of SETTINGS_FILES) {
        const text = stripCssComments(readStyleFile(file));
        const lines = text.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (/^(?:padding|margin|gap|row-gap|column-gap|padding-[a-z]+|margin-[a-z]+)\s*:/.test(line)) {
            // 放行与 custom-select 下拉选项行规格严格锁定的 4px 10px（tests/ui/custom-select-hidden.test.ts 契约）
            if (line.includes("4px 10px")) continue;
            const withoutVars = line.replace(/var\([^)]+\)/g, "").replace(/calc\([^)]+\)/g, "");
            expect(
              withoutVars,
              `${file} 第 ${i + 1} 行存在未消费令牌的标准间距字面量: "${line}"`
            ).not.toMatch(standardSpacingRegex);
          }
        }
      }
    });

    it("设置外壳内边距、行间距与弹窗主要间距均消费 --biliscript-space-* 令牌", () => {
      const shell = stripCssComments(readStyleFile("extension/entry/styles/reader-settings-shell.css"));
      const rows = stripCssComments(readStyleFile("extension/entry/styles/reader-settings-rows.css"));
      const providers = stripCssComments(readStyleFile("extension/entry/styles/reader-settings-providers.css"));

      expect(shell).toMatch(/\.biliscript-reading-settings-panel\s*\{[^}]*padding:\s*var\(--biliscript-space-md\)\s*var\(--biliscript-space-14\)/);
      expect(rows).toMatch(/\.ai-providers-list[^}]*\{[^}]*gap:\s*var\(--biliscript-space-sm\)/);
      expect(providers).toMatch(/\.provider-editor-head\s*\{[^}]*padding:\s*var\(--biliscript-space-14\)\s*var\(--biliscript-space-lg\)\s*var\(--biliscript-space-10\)/);
    });
  });
});
