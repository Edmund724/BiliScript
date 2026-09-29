// ADR 体例守卫（docs/adr，见 docs/adr/README.md「体例规则」）：索引覆盖、编号落文件、
// 证据引用可解析、状态行在场四件可机械判定的事。防倒退：新 ADR 不登记索引或不加状态行、
// 正文回引 `.scratch/`（被 .gitignore 忽略且随时清空，仓库外读者解析不到）都会静默腐化体例。
// 编号清单一律从目录与索引表派生，不硬编码——0011 退役后不复用，硬编码清单会随下次编号说谎。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ADR_DIR = join(ROOT, "docs/adr");
const README = join(ADR_DIR, "README.md");
const read = (abs: string) => readFileSync(abs, "utf8");

// ADR 本体：NNNN-*.md。README.md 是索引不是裁决，不计入。
const adrFiles = (): string[] =>
  readdirSync(ADR_DIR)
    .filter((name) => /^\d{4}-.+\.md$/.test(name))
    .sort();

// 索引表的行：首格是四位编号（`| 0001 |` 或 `| [0001](0001-….md) |`）。
// 表头与分隔行不含四位编号，天然落选；关系列里的交叉引用（如「见 ADR-0006」）不是
// 编号格，不参与「编号有无落文件」的判定——退役编号只在它自己的行上声明退役。
const indexRows = (): { id: string; line: string }[] =>
  read(README)
    .split("\n")
    .map((line) => line.trim())
    .map((line) => ({ line, id: (line.match(/^\|\s*\[?(\d{4})/) ?? [])[1] }))
    .filter((row): row is { line: string; id: string } => Boolean(row.id));

// 状态行判据：标题后第一条非空行（标题 = 首个 `# ` 行）。
const firstLineAfterTitle = (text: string): string => {
  const lines = text.split("\n");
  const titleAt = lines.findIndex((line) => line.startsWith("# "));
  for (let i = titleAt + 1; i < lines.length; i += 1) {
    if (lines[i].trim()) return lines[i].trim();
  }
  return "";
};

describe("docs/adr 体例守卫", () => {
  it("每篇 ADR 都在 README 索引里被提到", () => {
    const index = read(README);
    expect(adrFiles().length).toBeGreaterThan(0); // 防空转：目录读空时下面的断言恒真
    const missing = adrFiles().filter((name) => !index.includes(name));
    expect(missing, `下列 ADR 未登记进 docs/adr/README.md 索引：${missing.join("、")}`).toEqual([]);
  });

  it("README 索引表里的每个编号要么有对应 MD，要么该行标了「已退役」", () => {
    const files = adrFiles();
    const rows = indexRows();
    expect(rows.length).toBeGreaterThan(0); // 防空转：表解析不出行时下面的断言恒真
    const broken = rows
      .filter((row) => !files.some((name) => name.startsWith(`${row.id}-`)))
      .filter((row) => !row.line.includes("已退役"))
      .map((row) => row.id);
    expect(broken, `索引表编号既无 MD 又未标「已退役」：${broken.join("、")}`).toEqual([]);
  });

  it("任何 ADR 正文都不含 .scratch/", () => {
    const offenders = adrFiles().filter((name) => read(join(ADR_DIR, name)).includes(".scratch/"));
    expect(offenders, `下列 ADR 正文回引了不可解析的 .scratch/ 路径：${offenders.join("、")}`).toEqual([]);
  });

  it("每篇 ADR 首行（标题后第一条非空行）是状态行", () => {
    expect(adrFiles().length).toBeGreaterThan(0); // 防空转：目录读空时下面的断言恒真
    const offenders = adrFiles()
      .filter((name) => !firstLineAfterTitle(read(join(ADR_DIR, name))).includes("> 状态："));
    expect(offenders, `下列 ADR 标题后首条非空行不是「> 状态：…」：${offenders.join("、")}`).toEqual([]);
  });
});
