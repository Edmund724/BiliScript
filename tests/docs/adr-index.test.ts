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

const indexRows = (): { id: string; file: string; line: string }[] =>
  read(README)
    .split("\n")
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^\|\s*\[(\d{4})\]\(([^)]+)\)/);
      return match ? { id: match[1], file: match[2], line } : null;
    })
    .filter((row): row is { id: string; file: string; line: string } => row !== null);

const firstNonEmptyLineAfterTitle = (text: string): string => {
  const lines = text.split("\n");
  const titleAt = lines.findIndex((line) => line.startsWith("# "));
  return (
    lines
      .slice(titleAt + 1)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
};

describe("docs/adr 体例守卫", () => {
  it("ADR 文件与 README 索引表一一对应且从 0001 起连续编号", () => {
    const files = adrFiles();
    const rows = indexRows();
    expect(files.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.file)).toEqual(files);
    const expectedIds = files.map((_, index) => String(index + 1).padStart(4, "0"));
    expect(rows.map((row) => row.id)).toEqual(expectedIds);
    expect(files.map((name) => name.slice(0, 4))).toEqual(expectedIds);
  });

  it("任何 ADR 正文都不含不可解析的 .scratch/ 路径", () => {
    const offenders = adrFiles().filter((name) => read(join(ADR_DIR, name)).includes(".scratch/"));
    expect(offenders, `下列 ADR 正文回引了 .scratch/ 路径：${offenders.join("、")}`).toEqual([]);
  });

  it("每篇 ADR 标题与首条状态行符合统一当前态体例", () => {
    const files = adrFiles();
    const badTitles = files.filter((name) => !read(join(ADR_DIR, name)).startsWith(`# ADR-${name.slice(0, 4)}：`));
    expect(badTitles, `下列 ADR 标题未以「# ADR-XXXX：」开头：${badTitles.join("、")}`).toEqual([]);
    const badStatus = files.filter((name) => firstNonEmptyLineAfterTitle(read(join(ADR_DIR, name))) !== "> 状态：有效");
    expect(badStatus, `下列 ADR 状态行不是「> 状态：有效」：${badStatus.join("、")}`).toEqual([]);
  });

  it("任何 ADR 正文不保留历史「## 修订 / ## 补注」追加块或已淘汰状态", () => {
    const offenders = adrFiles().filter((name) => {
      const text = read(join(ADR_DIR, name));
      return /^##\s*(?:修订|补注|\d{4}-\d{2}-\d{2}\s*修订)/m.test(text) || /superseded|已退役/i.test(text);
    });
    expect(offenders, `下列 ADR 仍残留历史修订块或淘汰标记：${offenders.join("、")}`).toEqual([]);
  });
});
