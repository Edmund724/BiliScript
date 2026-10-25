// tests/entry/tokens-primitive.test.ts
// Primitive Token 原始层契约测试：
// 验证 tokens-primitive.css 的客观基础调色板与基础度量阶梯，以及 style-injector 的置顶注入。

import { describe, expect, it } from "vitest";
import { readStyleFile } from "./css-token-test-utils.js";

const TOKENS_PRIMITIVE_CSS = "extension/entry/styles/tokens-primitive.css";
const INJECTOR_TS = "extension/shared/style-injector.ts";

describe("Primitive Tokens: tokens-primitive.css 原始层契约", () => {
  it("tokens-primitive.css 存在且在 :root 下声明完整的客观基础度量阶梯", () => {
    const css = readStyleFile(TOKENS_PRIMITIVE_CSS);

    // 6 档基础字阶（11px–20px）
    expect(css).toContain("--biliscript-primitive-font-size-11: 11px;");
    expect(css).toContain("--biliscript-primitive-font-size-12: 12px;");
    expect(css).toContain("--biliscript-primitive-font-size-14: 14px;");
    expect(css).toContain("--biliscript-primitive-font-size-16: 16px;");
    expect(css).toContain("--biliscript-primitive-font-size-18: 18px;");
    expect(css).toContain("--biliscript-primitive-font-size-20: 20px;");

    // 基础圆角阶梯（4px, 8px, 14px, 20px, 28px, 999px, 50% 及辅助档）
    expect(css).toContain("--biliscript-primitive-radius-4: 4px;");
    expect(css).toContain("--biliscript-primitive-radius-6: 6px;");
    expect(css).toContain("--biliscript-primitive-radius-8: 8px;");
    expect(css).toContain("--biliscript-primitive-radius-10: 10px;");
    expect(css).toContain("--biliscript-primitive-radius-12: 12px;");
    expect(css).toContain("--biliscript-primitive-radius-14: 14px;");
    expect(css).toContain("--biliscript-primitive-radius-16: 16px;");
    expect(css).toContain("--biliscript-primitive-radius-20: 20px;");
    expect(css).toContain("--biliscript-primitive-radius-24: 24px;");
    expect(css).toContain("--biliscript-primitive-radius-28: 28px;");
    expect(css).toContain("--biliscript-primitive-radius-full: 999px;");
    expect(css).toContain("--biliscript-primitive-radius-circle: 50%;");

    // 基础间距阶梯（4px, 8px, 12px, 16px, 20px, 24px 及辅助档）
    expect(css).toContain("--biliscript-primitive-space-0: 0px;");
    expect(css).toContain("--biliscript-primitive-space-2: 2px;");
    expect(css).toContain("--biliscript-primitive-space-4: 4px;");
    expect(css).toContain("--biliscript-primitive-space-6: 6px;");
    expect(css).toContain("--biliscript-primitive-space-8: 8px;");
    expect(css).toContain("--biliscript-primitive-space-10: 10px;");
    expect(css).toContain("--biliscript-primitive-space-12: 12px;");
    expect(css).toContain("--biliscript-primitive-space-14: 14px;");
    expect(css).toContain("--biliscript-primitive-space-16: 16px;");
    expect(css).toContain("--biliscript-primitive-space-20: 20px;");
    expect(css).toContain("--biliscript-primitive-space-24: 24px;");
    expect(css).toContain("--biliscript-primitive-space-28: 28px;");
    expect(css).toContain("--biliscript-primitive-space-32: 32px;");
  });

  it("tokens-primitive.css 覆盖 4 象限主题所需的客观基础色板与 RGB 通道", () => {
    const css = readStyleFile(TOKENS_PRIMITIVE_CSS);

    // Flyme 蓝族
    expect(css).toContain("--biliscript-primitive-color-blue-500: #008cff;");
    expect(css).toContain("--biliscript-primitive-color-blue-500-rgb: 0, 140, 255;");
    expect(css).toContain("--biliscript-primitive-color-blue-400: #3d9bff;");
    expect(css).toContain("--biliscript-primitive-color-blue-400-rgb: 61, 155, 255;");
    expect(css).toContain("--biliscript-primitive-color-blue-600: #2e6fc2;");
    expect(css).toContain("--biliscript-primitive-color-blue-600-rgb: 46, 111, 194;");

    // 灰阶中性色
    expect(css).toContain("--biliscript-primitive-color-gray-50: #f2f3f5;");
    expect(css).toContain("--biliscript-primitive-color-gray-100: #f0f1f3;");
    expect(css).toContain("--biliscript-primitive-color-gray-200: #e9ebef;");
    expect(css).toContain("--biliscript-primitive-color-gray-300: #e3e5ea;");
    expect(css).toContain("--biliscript-primitive-color-gray-500: #8a8e96;");
    expect(css).toContain("--biliscript-primitive-color-gray-600: #666a71;");
    expect(css).toContain("--biliscript-primitive-color-gray-950: #17181a;");
    expect(css).toContain("--biliscript-primitive-color-gray-950-rgb: 23, 24, 26;");

    // 暗色灰阶
    expect(css).toContain("--biliscript-primitive-color-dark-gray-100: #ecedef;");
    expect(css).toContain("--biliscript-primitive-color-dark-gray-100-rgb: 236, 237, 239;");
    expect(css).toContain("--biliscript-primitive-color-dark-gray-400: #9ca0a8;");
    expect(css).toContain("--biliscript-primitive-color-dark-gray-500: #787c86;");
    expect(css).toContain("--biliscript-primitive-color-dark-gray-800: #26282d;");
    expect(css).toContain("--biliscript-primitive-color-dark-gray-900: #1b1c20;");
    expect(css).toContain("--biliscript-primitive-color-dark-gray-950: #101114;");
    expect(css).toContain("--biliscript-primitive-color-dark-gray-950-rgb: 16, 17, 20;");

    // Editorial 暖纸族
    expect(css).toContain("--biliscript-primitive-color-paper-50: #faf7f2;");
    expect(css).toContain("--biliscript-primitive-color-paper-100: #f3ede2;");
    expect(css).toContain("--biliscript-primitive-color-paper-200: #e8e0d2;");
    expect(css).toContain("--biliscript-primitive-color-paper-250: #e6dfd3;");
    expect(css).toContain("--biliscript-primitive-color-paper-300: #e4dccb;");
    expect(css).toContain("--biliscript-primitive-color-paper-500: #8c8277;");
    expect(css).toContain("--biliscript-primitive-color-paper-600: #655b52;");
    expect(css).toContain("--biliscript-primitive-color-paper-950: #231f1c;");
    expect(css).toContain("--biliscript-primitive-color-paper-950-rgb: 35, 31, 28;");

    // 赤陶族
    expect(css).toContain("--biliscript-primitive-color-terracotta-500: #b85435;");
    expect(css).toContain("--biliscript-primitive-color-terracotta-500-rgb: 184, 84, 53;");
    expect(css).toContain("--biliscript-primitive-color-terracotta-600: #9c4527;");
    expect(css).toContain("--biliscript-primitive-color-terracotta-600-rgb: 156, 69, 39;");
    expect(css).toContain("--biliscript-primitive-color-terracotta-400: #e07a5f;");
    expect(css).toContain("--biliscript-primitive-color-terracotta-400-rgb: 224, 122, 95;");

    // 功能状态色与通用
    expect(css).toContain("--biliscript-primitive-color-green-500: #3fb950;");
    expect(css).toContain("--biliscript-primitive-color-red-500: #d93025;");
    expect(css).toContain("--biliscript-primitive-color-red-400: #f2555a;");
    expect(css).toContain("--biliscript-primitive-color-amber-500: #ff9f0a;");
    expect(css).toContain("--biliscript-primitive-color-amber-600: #d89e2e;");
    expect(css).toContain("--biliscript-primitive-color-mask-rgb: 20, 16, 12;");
  });

  it("shared/style-injector.ts 在 getReaderStylePaths 首位声明 tokens-primitive.css", () => {
    const injectorCode = readStyleFile(INJECTOR_TS);
    expect(injectorCode).toMatch(/return\s*\[\s*["']entry\/styles\/tokens-primitive\.css["']/);
  });
});
