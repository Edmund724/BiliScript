// 家族行模块收敛锁定（架构评审候选 3 片 1）。
//
// options-rows / options-asr-rows / options-search-rows 三文件按族平铺同构
// 配置（行类名 / id 前缀 / 预设回落 / 显示名 / 删除报文 + ASR/搜索的选用
// radio 尾），片 1 收进 ui/provider-family.ts：每族一份声明（Record 全键覆盖）
// + createProviderFamilyRows 组合点工厂（行「编辑」回调直注，替换原模块级
// setter 单例）。三旧文件随搬运删除。本文件扫源码锁：
// 1. settings-panel 不再 import 三个旧 rows 模块（防回潮）；
// 2. 三个旧文件已删除；
// 3. provider-family.ts 不含模块级可变 handler 单例（let on...RowEdit /
//    let on...Handler 模式）；
// 4. 零调用点的死导出 setActiveAsrProvider / setActiveSearchProvider 不复活。
//
// 行为等价由 provider-row.test.ts / options-search-rows.test.ts 的既有断言
// 原样保留（迁移 import 后必须仍绿）兜底，本文件只锁结构。

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string) {
  const url = new URL(relativePath, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

function sourceExists(relativePath: string) {
  return existsSync(fileURLToPath(new URL(relativePath, import.meta.url)));
}

const LEGACY_ROWS_FILES = [
  "../../extension/ui/options-rows.ts",
  "../../extension/ui/options-asr-rows.ts",
  "../../extension/ui/options-search-rows.ts"
];

describe("家族行模块收敛（候选 3 片 1）", () => {
  it("settings-panel 不再 import 三个旧 rows 模块", () => {
    const source = readSource("../../extension/ui/settings-panel.ts");
    for (const legacy of ["options-rows", "options-asr-rows", "options-search-rows"]) {
      expect(source, `settings-panel 不得再引用 ${legacy}`).not.toContain(legacy);
    }
  });

  it("三个旧 rows 文件已删除", () => {
    for (const file of LEGACY_ROWS_FILES) {
      expect(sourceExists(file), `${file} 应已删除`).toBe(false);
    }
  });

  it("provider-family.ts：无模块级可变 handler 单例，工厂与全键声明就位", () => {
    expect(sourceExists("../../extension/ui/provider-family.ts")).toBe(true);
    const source = readSource("../../extension/ui/provider-family.ts");
    expect(source).toContain("createProviderFamilyRows(");
    expect(source).toContain("Record<ProviderEditorKind,");
    expect(
      source.match(/let\s+on\w*(RowEdit|Handler|Delete)\b/g) || [],
      "行回调改组合点注入，不得出现模块级 let on...RowEdit/Handler 单例"
    ).toEqual([]);
  });

  it("死导出 setActiveAsrProvider / setActiveSearchProvider 不复活", () => {
    const source = readSource("../../extension/ui/provider-family.ts");
    expect(source).not.toContain("setActiveAsrProvider");
    expect(source).not.toContain("setActiveSearchProvider");
  });
});
