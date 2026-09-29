// docs/agents/domain.md 守卫：它是 agent 探路前的第一入口，两件事必须与仓库同步。
// 一、红线索引覆盖 docs/adr/README.md「审查红线」的全部 ADR——红线分散在 0003 / 0005 /
// 0008 / 0009 四篇正文里，只读「相关的那一篇」会漏掉其余三条，README 新增红线而这里不跟
// 就是重新漏一遍。二、文档里出现的 ADR 编号与文件名都必须在 docs/adr/ 真实存在——上游 skill
// 模板带的示例仓库（0001-event-sourced-orders 之类）留在文档里会被当成本仓事实。
// 判据全部从 README 与目录派生，不硬编码编号清单。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ADR_DIR = join(ROOT, "docs/adr");
const README = join(ADR_DIR, "README.md");
const DOMAIN = join(ROOT, "docs/agents/domain.md");
const read = (abs: string) => readFileSync(abs, "utf8");

const adrFiles = (): string[] =>
  readdirSync(ADR_DIR)
    .filter((name) => /^\d{4}-.+\.md$/.test(name))
    .sort();

// README「审查红线」小节：`- **ADR-0003：…` 起首的条目即红线清单。
const redlineIds = (): string[] => {
  const lines = read(README).split("\n");
  const start = lines.findIndex((line) => line.trim() === "## 审查红线");
  const rest = start < 0 ? [] : lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const section = (end < 0 ? rest : rest.slice(0, end)).join("\n");
  return [...section.matchAll(/^- \*\*ADR-(\d{4})/gm)].map((match) => match[1]);
};

// 编号在 README 索引里标了「已退役」的行没有对应 MD，引用它不算悬空。
const retiredIds = (): string[] =>
  read(README)
    .split("\n")
    .filter((line) => line.includes("已退役") && /^\|\s*\[?(\d{4})/.test(line.trim()))
    .map((line) => (line.match(/^\|\s*\[?(\d{4})/) ?? [])[1])
    .filter(Boolean);

describe("docs/agents/domain.md 守卫", () => {
  it("红线索引覆盖 README 审查红线的全部 ADR", () => {
    const ids = redlineIds();
    expect(ids.length).toBeGreaterThan(0); // 防空转：README 小节解析空时下面的断言恒真
    const domain = read(DOMAIN);
    const missing = ids.filter((id) => !domain.includes(`ADR-${id}`));
    expect(missing, `domain.md 红线索引未收录：${missing.map((id) => `ADR-${id}`).join("、")}`).toEqual([]);
  });

  it("domain.md 引用的 ADR 编号都有对应正文", () => {
    const files = adrFiles();
    const retired = retiredIds();
    const cited = [...new Set([...read(DOMAIN).matchAll(/ADR-(\d{4})/g)].map((match) => match[1]))];
    expect(cited.length).toBeGreaterThan(0); // 防空转：文档不再引用任何 ADR 时下面的断言失去意义
    const dangling = cited.filter(
      (id) => !retired.includes(id) && !files.some((name) => name.startsWith(`${id}-`))
    );
    expect(dangling, `domain.md 引用了不存在的 ADR：${dangling.join("、")}`).toEqual([]);
  });

  it("domain.md 提到的 ADR 文件名都真实存在", () => {
    const files = adrFiles();
    const cited = [...new Set([...read(DOMAIN).matchAll(/\b\d{4}-[A-Za-z0-9._-]+\.md\b/g)].map((m) => m[0]))];
    expect(cited.length).toBeGreaterThan(0); // 防空转：文档不再列举 ADR 文件名时下面的断言失去意义
    const dangling = cited.filter((name) => !files.includes(name));
    expect(dangling, `domain.md 列举了不存在的 ADR 文件：${dangling.join("、")}`).toEqual([]);
  });
});
