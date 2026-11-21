import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const BUILD_CONTENT = "scripts/build-content.js";

const SLOT_KEY_PATTERN = /\b[A-Z_]*SLOT_KEY\s*=\s*"__BILISCRIPT_[A-Z_]+__"/;
const SLOT_MODULES = [
  "extension/shared/messaging.ts",
  "extension/shared/logging.ts",
  "extension/reader/reader-bus.ts",
  "extension/core/state.ts",
  "extension/shared/style-injector.ts",
  "extension/shared/content-event-bus.ts"
];

describe("跨实例共享槽守卫（构建期接线）", () => {
  it("build-content.js 声明守卫函数（共享槽 + mermaid 替身）并在 selfCheck 里调用", () => {
    const text = read(BUILD_CONTENT);
    expect(text.includes("function assertSharedSlotsInBothRegions()")).toBe(true);
    expect(text.includes("function assertMermaidStubsApplied()")).toBe(true);
    expect(
      /return\s*\(\s*assertSharedSlotsInBothRegions\(\)\s*&&\s*assertMermaidStubsApplied\(\)\s*&&\s*assertDualInstanceAllowlist\(\)\s*\);/.test(
        text
      )
    ).toBe(true);
  });

  it("五个共享槽模块各自按约定声明槽键（少一个守卫就漏一个）", () => {
    for (const rel of SLOT_MODULES) {
      expect(SLOT_KEY_PATTERN.test(read(rel)), `${rel} 未按约定声明 *_SLOT_KEY`).toBe(true);
    }
  });

  it("测试环境清槽清单覆盖全部共享槽键（新增槽必须同步）", () => {
    const setup = read("tests/setup.ts");
    const keys = [];
    for (const rel of SLOT_MODULES) {
      const match = /"(__BILISCRIPT_[A-Z_]+__)"/.exec(read(rel));
      expect(match, `${rel} 未找到槽键字面量`).not.toBe(null);
      keys.push(match![1]);
    }
    for (const key of keys) {
      expect(setup.includes(`delete slots.${key};`), `tests/setup.ts 未清 ${key}`).toBe(true);
    }
  });
});
