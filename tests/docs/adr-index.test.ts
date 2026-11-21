import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ADR_DIR = join(ROOT, "docs/adr");
const README = join(ADR_DIR, "README.md");
const read = (abs: string) => readFileSync(abs, "utf8");

const adrFiles = (): string[] =>
  readdirSync(ADR_DIR)
    .filter((name) => /^\d{4}-.+\.md$/.test(name))
    .sort();

const indexRows = (): { id: string; line: string }[] =>
  read(README)
    .split("\n")
    .map((line) => line.trim())
    .map((line) => ({ line, id: (line.match(/^\|\s*\[?(\d{4})/) ?? [])[1] }))
    .filter((row): row is { line: string; id: string } => Boolean(row.id));

const firstLineAfterTitle = (text: string): string => {
  const lines = text.split("\n");
  const titleAt = lines.findIndex((line) => line.startsWith("# "));
  for (let i = titleAt + 1; i < lines.length; i += 1) {
    if (lines[i].trim()) return lines[i].trim();
  }
  return "";
};

const revisionBlocks = (text: string): number =>
  text.split("\n").filter((line) => /^##\s*修订/.test(line.trim())).length;

const declaredRevisionCounts = (text: string): number[] =>
  [...text.matchAll(/(\d+)\s*(?:处|条|次)修订/g)].map((match) => Number(match[1]));

describe("docs/adr 体例守卫", () => {
  it("每篇 ADR 都在 README 索引里被提到", () => {
    const index = read(README);
    expect(adrFiles().length).toBeGreaterThan(0);
    const missing = adrFiles().filter((name) => !index.includes(name));
    expect(missing, `下列 ADR 未登记进 docs/adr/README.md 索引：${missing.join("、")}`).toEqual([]);
  });

  it("README 索引表里的每个编号要么有对应 MD，要么该行标了「已退役」", () => {
    const files = adrFiles();
    const rows = indexRows();
    expect(rows.length).toBeGreaterThan(0);
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
    expect(adrFiles().length).toBeGreaterThan(0);
    const offenders = adrFiles()
      .filter((name) => !firstLineAfterTitle(read(join(ADR_DIR, name))).includes("> 状态："));
    expect(offenders, `下列 ADR 标题后首条非空行不是「> 状态：…」：${offenders.join("、")}`).toEqual([]);
  });

  it("声明的修订处数与文末「## 修订」块数一致（状态行 / 索引行）", () => {
    const files = adrFiles();
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    let declaredSites = 0;
    const check = (site: string, declared: number[], blocks: number) => {
      declaredSites += declared.length;
      for (const count of declared) {
        if (count !== blocks) {
          offenders.push(`${site} 声明 ${count} 处修订，实际 ${blocks} 个「## 修订」块`);
        }
      }
    };
    for (const name of files) {
      const text = read(join(ADR_DIR, name));
      check(`${name} 状态行`, declaredRevisionCounts(firstLineAfterTitle(text)), revisionBlocks(text));
    }
    for (const row of indexRows()) {
      const name = files.find((file) => file.startsWith(`${row.id}-`));
      if (!name) continue;
      check(`README 索引 ${row.id} 行`, declaredRevisionCounts(row.line), revisionBlocks(read(join(ADR_DIR, name))));
    }
    expect(declaredSites, "没有任何 ADR 在状态行或索引行声明修订处数，守卫已空转").toBeGreaterThan(0);
    expect(offenders, `修订处数声明漂移：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("修订处数判据能识别漂移（合成样本）", () => {
    const drifted = [
      "# 某篇",
      "",
      "> 状态：有效｜2 处修订：甲；乙",
      "",
      "正文",
      "",
      "## 修订（A）",
      "",
      "## 修订（B）",
      "",
      "## 修订（C）",
      ""
    ].join("\n");
    expect(declaredRevisionCounts(firstLineAfterTitle(drifted))).toEqual([2]);
    expect(revisionBlocks(drifted)).toBe(3);
    expect(declaredRevisionCounts("> 状态：有效｜见 ADR-0006")).toEqual([]);
    expect(revisionBlocks("> 状态：有效")).toBe(0);
  });
});
