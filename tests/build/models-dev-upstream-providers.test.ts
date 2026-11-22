import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  UPSTREAM_PRESET_ORDER,
  UPSTREAM_PROVIDERS,
  readPresetCatalogProviders
} from "../../scripts/models-dev-upstream-providers.mjs";
import { PRESETS } from "../../extension/core/presets.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "biliscript-presets-parse-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeFixture(name: string, content: string): string {
  const filePath = join(tmpRoot, name);
  writeFileSync(filePath, content);
  return filePath;
}

describe("models-dev-upstream-providers 编译期 presets.ts 读取", () => {
  it("读取仓库真实 extension/core/presets.ts 与运行时 PRESETS 保持一致", () => {
    const providers = readPresetCatalogProviders();
    expect(providers.size).toBe(PRESETS.length);
    expect(UPSTREAM_PROVIDERS.map((entry) => entry.preset)).toEqual(UPSTREAM_PRESET_ORDER);
    expect(UPSTREAM_PROVIDERS.find((entry) => entry.preset === "gemini")).toEqual({
      preset: "gemini",
      id: "google"
    });
    expect(providers.get("ollama")).toBeUndefined();
  });

  it("支持跨行对象、任意缩进、尾随逗号、import type 与常量引用", () => {
    const fixture = writeFixture(
      "multiline-presets.ts",
      [
        'import type { AiProtocol } from "./missing-type-only.js";',
        'const GOOGLE_PROVIDER = "google";',
        "export interface DemoPreset {",
        "  id: string;",
        "  protocol?: AiProtocol;",
        "  catalogProvider?: string;",
        "}",
        "export const PRESETS: readonly DemoPreset[] = [",
        "  {",
        '    id: "alpha",',
        '    catalogProvider: "alpha-upstream",',
        "  },",
        "  {",
        '    id: "beta",',
        "    catalogProvider: GOOGLE_PROVIDER,",
        "  },",
        "  {",
        '    id: "local",',
        "  },",
        "];"
      ].join("\n")
    );

    const providers = readPresetCatalogProviders(fixture);
    expect([...providers.entries()]).toEqual([
      ["alpha", "alpha-upstream"],
      ["beta", "google"],
      ["local", undefined]
    ]);
  });

  it("对重复 id、缺失 PRESETS、空数组与非法 catalogProvider 显式抛错", () => {
    const duplicate = writeFixture(
      "dup.ts",
      'export const PRESETS = [{ id: "a", catalogProvider: "p1" }, { id: "a", catalogProvider: "p2" }];'
    );
    const missing = writeFixture("missing.ts", "export const OTHER = [];");
    const empty = writeFixture("empty.ts", "export const PRESETS = [];");
    const invalidProvider = writeFixture("bad-provider.ts", 'export const PRESETS = [{ id: "a", catalogProvider: "" }];');

    expect(() => readPresetCatalogProviders(duplicate)).toThrow(/preset id "a" 重复/);
    expect(() => readPresetCatalogProviders(missing)).toThrow(/未导出 PRESETS 数组/);
    expect(() => readPresetCatalogProviders(empty)).toThrow(/解析出 0 个 preset/);
    expect(() => readPresetCatalogProviders(invalidProvider)).toThrow(/catalogProvider 非法/);
  });
});
