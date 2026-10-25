// tests/entry/migrate-reader-shell.test.ts
// 阅读主面板与门控样式迁移契约测试（工单 04）：
// 验证 reader.css 与 reader-gate.css 规则块中消除了硬编码的圆角与字号，
// 全部迁移至语义/组件/原始 Token，保证字阶缩放与圆角统一。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const READER_CSS = "extension/entry/styles/reader.css";
const GATE_CSS = "extension/entry/styles/reader-gate.css";
const PRIMITIVE_CSS = "extension/entry/styles/tokens-primitive.css";

function readFile(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("04 Migrate Reader Shell: reader.css & reader-gate.css Token 迁移契约", () => {
  describe("1. reader.css 与 reader-gate.css 移除硬编码 border-radius", () => {
    it("reader.css 中的所有 border-radius 均消费 --biliscript-radius-* 或组件 Token", () => {
      const text = stripComments(readFile(READER_CSS));
      const lines = text.split("\n");
      const violations: string[] = [];

      lines.forEach((line, index) => {
        if (/border-radius\s*:/.test(line)) {
          const trimmed = line.trim();
          // 允许消费 var(--biliscript-radius-*) 或 var(--btn-radius / --chip-radius / --pill-radius)
          const isValid =
            /var\(--(?:biliscript-radius|btn-radius|chip-radius|pill-radius)/.test(trimmed) ||
            /inherit/.test(trimmed);
          if (!isValid) {
            violations.push(`Line ${index + 1}: ${trimmed}`);
          }
        }
      });

      expect(violations, `reader.css 中不应有裸写圆角，未迁移行：\n${violations.join("\n")}`).toEqual([]);
    });

    it("reader-gate.css 规则块中的所有 border-radius 均消费 Token 或 inherit", () => {
      const text = stripComments(readFile(GATE_CSS));
      const lines = text.split("\n");
      const violations: string[] = [];

      lines.forEach((line, index) => {
        // 门控规则块从第 50 行后开始出现具体组件样式
        if (/border-radius\s*:/.test(line)) {
          const trimmed = line.trim();
          const isValid =
            /var\(--(?:biliscript-radius|btn-radius|chip-radius|pill-radius)/.test(trimmed) ||
            /inherit/.test(trimmed);
          if (!isValid) {
            violations.push(`Line ${index + 1}: ${trimmed}`);
          }
        }
      });

      expect(violations, `reader-gate.css 规则块中不应有裸写圆角，未迁移行：\n${violations.join("\n")}`).toEqual([]);
    });
  });

  describe("2. reader.css 与 reader-gate.css 移除硬编码 font-size", () => {
    it("reader.css 中的排版字号均迁移为 --biliscript-font-size-* 或组件 Token（等比响应缩放）", () => {
      const text = stripComments(readFile(READER_CSS));
      const lines = text.split("\n");
      const violations: string[] = [];

      // 允许的非字阶特例：装饰性引号尺寸（32px, 34px）、clamp 响应式卡片正文、相对字号 0.95em
      const allowedSpecial = [
        "32px",
        "34px",
        "clamp(16px, 5.5cqi, 21px)",
        "0.95em"
      ];

      lines.forEach((line, index) => {
        if (/font-size\s*:/.test(line)) {
          const trimmed = line.trim();
          const isAllowedSpecial = allowedSpecial.some((spec) => trimmed.includes(spec));
          const isValidToken =
            /var\(--(?:biliscript-font-size|biliscript-reader-subtitle-font-size|btn-font-size|chip-font-size|pill-font-size)/.test(
              trimmed
            );

          if (!isAllowedSpecial && !isValidToken) {
            violations.push(`Line ${index + 1}: ${trimmed}`);
          }
        }
      });

      expect(violations, `reader.css 中排版字号必须使用语义 Token，未迁移行：\n${violations.join("\n")}`).toEqual([]);
    });

    it("reader-gate.css 规则块中的字号均使用 Token 表达", () => {
      const text = stripComments(readFile(GATE_CSS));
      const lines = text.split("\n");
      const violations: string[] = [];

      lines.forEach((line, index) => {
        // 排除 :root 或变量声明区（变量定义行如 --biliscript-font-size-*: calc(...) 允许包含 primitive）
        if (/^\s*font-size\s*:/.test(line)) {
          const trimmed = line.trim();
          const isValidToken =
            /var\(--(?:biliscript-font-size|biliscript-reader-subtitle-font-size|btn-font-size|chip-font-size|pill-font-size)/.test(
              trimmed
            );
          if (!isValidToken) {
            violations.push(`Line ${index + 1}: ${trimmed}`);
          }
        }
      });

      expect(violations, `reader-gate.css 规则块中不应有裸写字号，未迁移行：\n${violations.join("\n")}`).toEqual([]);
    });
  });

  describe("3. reader-gate.css 规则块与 reader.css 外壳清理残余裸 HEX 与裸 RGBA", () => {
    it("reader-gate.css 规则块（第 590 行起）中无裸 HEX 色值（全部使用 Token）", () => {
      const text = stripComments(readFile(GATE_CSS));
      const lines = text.split("\n");
      const violations: string[] = [];

      lines.forEach((line, index) => {
        const lineNum = index + 1;
        if (lineNum >= 590) {
          const trimmed = line.trim();
          if (trimmed.startsWith("/*") || trimmed.startsWith("*")) return;
          const hex = trimmed.match(/#[0-9a-fA-F]{3,8}\b/g);
          if (hex) {
            violations.push(`Line ${lineNum}: ${trimmed}`);
          }
        }
      });

      expect(violations, `reader-gate.css 业务规则块中不应存在裸 HEX 颜色，违规行：\n${violations.join("\n")}`).toEqual([]);
    });

    it("reader-gate.css 规则块（第 590 行起）中的 rgba 均消费 primitive 的 -rgb 通道变量", () => {
      const text = stripComments(readFile(GATE_CSS));
      const lines = text.split("\n");
      const violations: string[] = [];

      lines.forEach((line, index) => {
        const lineNum = index + 1;
        if (lineNum >= 590) {
          const trimmed = line.trim();
          if (trimmed.startsWith("/*") || trimmed.startsWith("*")) return;
          const rawRgba = trimmed.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g);
          if (rawRgba) {
            violations.push(`Line ${lineNum}: ${trimmed}`);
          }
        }
      });

      expect(violations, `reader-gate.css 业务规则块中的 rgba 必须消费 -rgb 通道变量，违规行：\n${violations.join("\n")}`).toEqual([]);
    });

    it("reader.css 基础壳与面板规则中的变量回退值不裸写硬编码颜色", () => {
      const text = stripComments(readFile(READER_CSS));
      const lines = text.split("\n");
      const violations: string[] = [];

      // 仅检查前 300 行（面板壳与头部图标基础声明）
      lines.slice(0, 300).forEach((line, index) => {
        const trimmed = line.trim();
        if (/var\(--biliscript-reader-[^,]+,\s*(?:#[0-9a-fA-F]+|rgba?\(\s*\d+)/.test(trimmed)) {
          violations.push(`Line ${index + 1}: ${trimmed}`);
        }
      });

      expect(violations, `reader.css 基础壳中不应出现裸 HEX/RGBA 回退值：\n${violations.join("\n")}`).toEqual([]);
    });
  });

  describe("4. 字阶缩放与语义响应体系", () => {
    it("tokens-primitive.css 与 reader-gate.css 支持完整字阶与圆角语义阶梯", () => {
      const primitive = readFile(PRIMITIVE_CSS);
      const gate = readFile(GATE_CSS);

      // 面板外壳圆角与胶囊圆角
      expect(gate).toContain("--biliscript-radius-panel: var(--biliscript-primitive-radius-28)");
      expect(gate).toContain("--biliscript-radius-pill: var(--biliscript-primitive-radius-pill)");

      // 验证 15px 字阶在 primitive 与 gate 中的完备支持
      expect(primitive).toContain("--biliscript-primitive-font-size-15: 15px;");
      expect(gate).toContain("--biliscript-font-size-15:");
    });
  });
});
