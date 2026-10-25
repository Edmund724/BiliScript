// tests/entry/design-tokens-audit.test.ts
// 全系统 Design Tokens 架构审计与视觉回归静态收网契约测试：
// 1. 验证三层 Token 架构（Primitive -> Semantic + Component -> 业务样式）与加载时序
// 2. 审计全量样式表硬编码字号、圆角及裸色值基本清零
// 3. 验证全局字号缩放（--biliscript-reader-font-scale）完整联动所有界面组件
// 4. 验证 4 象限主题（Flyme / Editorial x Light / Dark）无任何悬空令牌引用

import { describe, expect, it } from "vitest";
import { readStyleFile, stripCssComments, stripCssCommentsKeepLines } from "./css-token-test-utils.js";

describe("Design Tokens 全局架构与静态审计契约", () => {
  describe("1. 三层 Token 架构与加载时序完整性", () => {
    it("tokens-primitive.css 作为 Primitive 层仅声明基础调色板与度量阶梯，无上层业务选择器", () => {
      const primitiveCss = stripCssComments(readStyleFile("extension/entry/styles/tokens-primitive.css"));
      // 必须声明在 :root
      expect(primitiveCss).toMatch(/:root\s*\{/);
      // 必须包含核心调色板与度量阶梯
      expect(primitiveCss).toContain("--biliscript-primitive-color-blue-500:");
      expect(primitiveCss).toContain("--biliscript-primitive-color-terracotta-500:");
      expect(primitiveCss).toContain("--biliscript-primitive-font-size-base:");
      expect(primitiveCss).toContain("--biliscript-primitive-radius-28:");
      expect(primitiveCss).toContain("--biliscript-primitive-corner-shape-squircle: squircle;");
      expect(primitiveCss).toContain("--biliscript-primitive-space-12:");

      // Primitive 层不得依赖业务选择器
      expect(primitiveCss).not.toContain("#biliscript-reading-view");
      expect(primitiveCss).not.toContain(".biliscript-");
    });

    it("reader-gate.css 作为中枢层统一定义 4 象限 Semantic 语义与 Component 组件层 Token", () => {
      const gateCss = stripCssComments(readStyleFile("extension/entry/styles/reader-gate.css"));
      // 语义字阶与圆角
      expect(gateCss).toContain("--biliscript-font-size-base:");
      expect(gateCss).toContain("--biliscript-radius-panel:");
      expect(gateCss).toContain("--biliscript-corner-shape: var(--biliscript-primitive-corner-shape-squircle);");
      // 组件层 Token
      expect(gateCss).toContain("--btn-radius:");
      expect(gateCss).toContain("--chip-radius:");
      expect(gateCss).toContain("--pill-radius:");
      expect(gateCss).toContain("--chat-input-radius:");
      expect(gateCss).toContain("--select-trigger-radius:");
      expect(gateCss).toContain("--toggle-track-radius:");
    });

    it("style-injector.ts 置顶优先注入 tokens-primitive.css 并保持级联顺序", () => {
      const injectorCode = readStyleFile("extension/shared/style-injector.ts");
      const match = injectorCode.match(/function getReaderStylePaths\(\): string\[\]\s*\{([\s\S]*?)\}/);
      expect(match, "必须包含 getReaderStylePaths 函数").not.toBeNull();
      const body = match![1];
      const paths = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

      expect(paths[0]).toBe("entry/styles/tokens-primitive.css");
      expect(paths[1]).toBe("entry/styles/reader.css");
      expect(paths[2]).toBe("entry/styles/reader-gate.css");

      // 对话三件套级联顺序
      const chatMatch = injectorCode.match(/const READER_CHAT_STYLE_PATHS = \[([\s\S]*?)\];/);
      expect(chatMatch).not.toBeNull();
      const chatPaths = [...chatMatch![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(chatPaths).toEqual([
        "entry/styles/github-markdown.css",
        "entry/styles/github-markdown-theme.css",
        "entry/styles/reader-chat.css"
      ]);
    });
  });

  describe("2. 全量业务样式表静态审计：零散落硬编码数值", () => {
    // 审计所有迁移样式表
    const AUDITED_STYLES = [
      "reader-gate.css",
      "reader.css",
      "reader-chat.css",
      "bilingual-subtitles.css",
      "reader-settings-shell.css",
      "reader-settings-rows.css",
      "reader-settings-providers.css",
      "custom-select.css",
      "toggle-switch.css",
      "github-markdown-theme.css",
      "player-ai.css"
    ];

    it("所有被审计样式表中的 border-radius 均消费令牌或合法特殊值（inherit/0）", () => {
      const violations: string[] = [];

      for (const fileName of AUDITED_STYLES) {
        const fullPath = `extension/entry/styles/${fileName}`;
        const content = stripCssCommentsKeepLines(readStyleFile(fullPath));
        const lines = content.split("\n");

        lines.forEach((line, idx) => {
          const lineNum = idx + 1;
          // gate 表前 50 行是重置/门控
          if (fileName === "reader-gate.css" && lineNum < 50) return;

          if (/^\s*border-radius\s*:/.test(line)) {
            const trimmed = line.trim();
            const isValid =
              /var\(--(?:biliscript-(?:primitive-)?radius|btn-radius|chip-radius|pill-radius|chat-input|select-|toggle-)/.test(
                trimmed
              ) ||
              /calc\([^)]*var\(--/.test(trimmed) ||
              /inherit|0(?:px)?/.test(trimmed);

            if (!isValid) {
              violations.push(`${fileName}:${lineNum}: ${trimmed}`);
            }
          }
        });
      }

      expect(violations, `发现未收敛的裸写 border-radius：\n${violations.join("\n")}`).toEqual([]);
    });

    it("所有非胶囊、非正圆、非直角的 border-radius 规则块均同步声明 corner-shape: squircle 或 inherit", () => {
      const violations: string[] = [];
      const cornerAuditedStyles = [...AUDITED_STYLES, "github-markdown.css"];

      for (const fileName of cornerAuditedStyles) {
        const fullPath = `extension/entry/styles/${fileName}`;
        const content = stripCssCommentsKeepLines(readStyleFile(fullPath));

        for (const match of content.matchAll(/\{([^{}]*)\}/g)) {
          const blockBody = match[1];
          const blockStartIdx = match.index ?? 0;
          const baseLine = content.slice(0, blockStartIdx).split("\n").length;
          const blockLines = blockBody.split("\n");

          blockLines.forEach((line, offset) => {
            const lineNum = baseLine + offset;
            if (fileName === "reader-gate.css" && lineNum < 50) return;

            const radiusMatch = line.match(/^\s*border-radius\s*:\s*([^;]+);/);
            if (!radiusMatch) return;
            const radiusVal = radiusMatch[1].trim();

            const isExempt =
              /^(?:0|0px|none)(?:\s+!important)?$/.test(radiusVal) ||
              /50%|--biliscript-(?:primitive-)?radius-circle/.test(radiusVal) ||
              /9999?px|100px|--biliscript-(?:primitive-)?radius-(?:pill|full)|--btn-radius|--chip-radius|--pill-radius-full|--toggle-track-radius|--chat-input-send-radius/.test(
                radiusVal
              );

            if (isExempt) return;

            if (/^inherit(?:\s+!important)?$/.test(radiusVal)) {
              if (!/\bcorner-shape\s*:\s*(?:inherit|squircle)\b/.test(blockBody)) {
                violations.push(`${fileName}:${lineNum}: border-radius: ${radiusVal} 缺少 corner-shape: inherit`);
              }
              return;
            }

            if (!/\bcorner-shape\s*:\s*squircle\b/.test(blockBody)) {
              violations.push(`${fileName}:${lineNum}: border-radius: ${radiusVal} 缺少 corner-shape: squircle`);
            }
          });
        }
      }

      expect(violations, `发现遗漏 corner-shape 的圆角规则块：\n${violations.join("\n")}`).toEqual([]);
    });

    it("所有被审计样式表中的排版 font-size 均消费令牌（或合法相对排版/装饰特例）", () => {
      const violations: string[] = [];
      const allowedSpecialTokens = [
        "inherit",
        "0.95em",
        "100%",
        "32px", // 历史金句水印引号装饰尺寸
        "34px", // 金句卡片固定引号装饰尺寸
        "clamp(16px, 5.5cqi, 21px)" // 金句卡片自适应容器查询字号
      ];

      for (const fileName of AUDITED_STYLES) {
        const fullPath = `extension/entry/styles/${fileName}`;
        const content = stripCssCommentsKeepLines(readStyleFile(fullPath));
        const lines = content.split("\n");

        lines.forEach((line, idx) => {
          const lineNum = idx + 1;
          // reader-gate.css 前 200 行包含字阶 token 的变量自身声明（calc(...) * scale）
          if (fileName === "reader-gate.css" && lineNum < 200) return;

          if (/^\s*font-size\s*:/.test(line)) {
            const trimmed = line.trim();
            const isSpecial = allowedSpecialTokens.some((spec) => trimmed.includes(spec));
            const isValidToken =
              /var\(--(?:biliscript-font-size|biliscript-reader-subtitle-font-size|btn-font-size|chip-font-size|pill-font-size|chat-input-font-size|select-)/.test(
                trimmed
              ) ||
              /calc\([^)]*var\(--biliscript-font-size/.test(trimmed);

            if (!isSpecial && !isValidToken) {
              violations.push(`${fileName}:${lineNum}: ${trimmed}`);
            }
          }
        });
      }

      expect(violations, `发现未收敛的裸写 font-size：\n${violations.join("\n")}`).toEqual([]);
    });

    it("业务样式中的常用属性中无裸写 HEX 颜色（除 tokens-primitive.css 与特定导出/遮罩外）", () => {
      const violations: string[] = [];

      for (const fileName of AUDITED_STYLES) {
        const fullPath = `extension/entry/styles/${fileName}`;
        const content = stripCssCommentsKeepLines(readStyleFile(fullPath));
        const lines = content.split("\n");

        lines.forEach((line, idx) => {
          const lineNum = idx + 1;
          const trimmed = line.trim();
          if (!trimmed) return;

          // 放行 reader-gate.css 前 580 行的主题 token 定义块
          if (fileName === "reader-gate.css" && lineNum < 580) return;

          // 放行 CSS mask-image 中纯黑 alpha 标记（如 #000 10px）
          if (trimmed.includes("mask-image:") && /#000(?:000)?\b/.test(trimmed)) return;

          // 放行 reader-chat.css 中思考极值彩虹渐变（.chat-thinking-ultra-gradient，特化视觉资产）
          if (fileName === "reader-chat.css" && lineNum >= 240 && lineNum <= 265) return;

          // 放行 reader.css 中 6 组用户导出金句卡片预设色盘（data-preset="..."）
          if (fileName === "reader.css" && lineNum >= 2410 && lineNum <= 2530) return;

          const hexMatch = trimmed.match(/#[0-9a-fA-F]{3,8}\b/g);
          if (hexMatch) {
            violations.push(`${fileName}:${lineNum}: ${trimmed}`);
          }
        });
      }

      expect(violations, `业务样式中发现未收敛的裸 HEX 色值：\n${violations.join("\n")}`).toEqual([]);
    });

    it("业务样式中的 rgba 阴影与描边均消费 -rgb 通道变量", () => {
      const violations: string[] = [];

      for (const fileName of AUDITED_STYLES) {
        const fullPath = `extension/entry/styles/${fileName}`;
        const content = stripCssCommentsKeepLines(readStyleFile(fullPath));
        const lines = content.split("\n");

        lines.forEach((line, idx) => {
          const lineNum = idx + 1;
          const trimmed = line.trim();
          if (!trimmed) return;

          // 放行 reader-gate.css 前 580 行的主题与材质定义
          if (fileName === "reader-gate.css" && lineNum < 580) return;

          // 放行流动星点粒子层径向渐变粒子
          if (fileName === "reader-chat.css" && trimmed.includes("radial-gradient(circle at")) return;

          // 放行 CSS mask-image 中的 alpha 遮罩
          if (trimmed.includes("mask-image:")) return;

          // 放行 reader.css 中 6 组用户导出金句卡片预设色盘（data-preset="..."）
          if (fileName === "reader.css" && lineNum >= 2410 && lineNum <= 2530) return;

          // 匹配裸写数字的 rgba(0, 0, 0, ...)
          const rawRgbMatch = trimmed.match(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g);
          if (rawRgbMatch) {
            violations.push(`${fileName}:${lineNum}: ${trimmed}`);
          }
        });
      }

      expect(violations, `业务样式中发现未收敛的裸数字 RGBA：\n${violations.join("\n")}`).toEqual([]);
    });
  });

  describe("3. 全局字号缩放联动契约（--biliscript-reader-font-scale）", () => {
    it("所有语义字阶令牌均挂接 --biliscript-reader-font-scale 进行等比缩放", () => {
      const gateCss = stripCssComments(readStyleFile("extension/entry/styles/reader-gate.css"));
      const scaleTokens = ["2xs", "xs", "sm", "sm-md", "base", "md-sm", "md", "lg", "xl", "2xl"];

      for (const token of scaleTokens) {
        const regex = new RegExp(`--biliscript-font-size-${token}:\\s*calc\\(var\\(--biliscript-primitive-font-size-[^)]+\\)\\s*\\*\\s*var\\(--biliscript-reader-font-scale,\\s*1\\)\\);`);
        expect(gateCss, `--biliscript-font-size-${token} 必须接入 font-scale 联动`).toMatch(regex);
      }
    });

    it("所有组件级字号令牌均消费可缩放的语义字阶令牌", () => {
      const gateCss = stripCssComments(readStyleFile("extension/entry/styles/reader-gate.css"));
      const componentFontTokens = [
        "--btn-font-size",
        "--chip-font-size",
        "--pill-font-size",
        "--chat-input-font-size",
        "--select-trigger-font-size",
        "--select-option-font-size",
        "--select-search-font-size"
      ];

      for (const token of componentFontTokens) {
        const regex = new RegExp(`${token}:\\s*var\\(--biliscript-font-size-[a-z0-9-]+\\);`);
        expect(gateCss, `${token} 必须直接消费 --biliscript-font-size-* 语义字阶`).toMatch(regex);
      }
    });
  });

  describe("4. 四象限主题完整性与无悬空 Token 引用", () => {
    it("reader-gate.css 中引用的所有 Primitive Token 均在 tokens-primitive.css 中存在（零悬空引用）", () => {
      const primitiveCss = stripCssComments(readStyleFile("extension/entry/styles/tokens-primitive.css"));
      const gateCss = stripCssComments(readStyleFile("extension/entry/styles/reader-gate.css"));

      const primitiveTokens = new Set<string>();
      for (const m of primitiveCss.matchAll(/(--biliscript-primitive-[a-z0-9-]+)\s*:/g)) {
        primitiveTokens.add(m[1]);
      }

      const referencedTokens = new Set<string>();
      for (const m of gateCss.matchAll(/var\((--biliscript-primitive-[a-z0-9-]+)/g)) {
        referencedTokens.add(m[1]);
      }

      const undefinedTokens: string[] = [];
      for (const ref of referencedTokens) {
        if (!primitiveTokens.has(ref)) {
          undefinedTokens.push(ref);
        }
      }

      expect(undefinedTokens, `reader-gate.css 中引用了未在 tokens-primitive.css 中声明的原始 Token：\n${undefinedTokens.join("\n")}`).toEqual([]);
    });

    it("4 象限主题（Flyme / Editorial x Light / Dark）完整覆盖核心色彩与材质语义 Token", () => {
      const gateCss = stripCssComments(readStyleFile("extension/entry/styles/reader-gate.css"));
      const rules = gateCss.match(/[^{}]+\{[^}]*\}/g) || [];

      function getQuadrantBlock(targetSelector: string): string {
        const hit = rules.find((r) => {
          const [head, body] = r.split("{");
          const selectors = head.split(",").map((s) => s.trim());
          return selectors.includes(targetSelector) && body.includes("--biliscript-reader-surface:");
        });
        return hit ? hit.split("{")[1] : "";
      }

      const flymeLight = getQuadrantBlock("#biliscript-reading-view");
      const flymeDark = getQuadrantBlock('#biliscript-reading-view[data-theme="dark"]');
      const editorialLight = getQuadrantBlock('#biliscript-reading-view[data-palette="editorial"]');
      const editorialDark = getQuadrantBlock('#biliscript-reading-view[data-theme="dark"][data-palette="editorial"]');

      expect(flymeLight.length, "必须找到 Flyme Light 主题块").toBeGreaterThan(0);
      expect(flymeDark.length, "必须找到 Flyme Dark 主题块").toBeGreaterThan(0);
      expect(editorialLight.length, "必须找到 Editorial Light 主题块").toBeGreaterThan(0);
      expect(editorialDark.length, "必须找到 Editorial Dark 主题块").toBeGreaterThan(0);

      // 核心 8 大基础色彩必须在 4 象限下均有覆写或继承
      const coreTokens = [
        "--biliscript-reader-surface",
        "--biliscript-reader-surface-2",
        "--biliscript-reader-surface-3",
        "--biliscript-reader-text",
        "--biliscript-reader-muted",
        "--biliscript-reader-faint",
        "--biliscript-reader-border",
        "--biliscript-reader-accent",
        "--biliscript-reader-card"
      ];

      for (const token of coreTokens) {
        expect(flymeLight, `Flyme Light 缺少 ${token}`).toContain(`${token}:`);
        expect(flymeDark, `Flyme Dark 缺少 ${token}`).toContain(`${token}:`);
        expect(editorialLight, `Editorial Light 缺少 ${token}`).toContain(`${token}:`);
        expect(editorialDark, `Editorial Dark 缺少 ${token}`).toContain(`${token}:`);
      }
    });
  });
});
