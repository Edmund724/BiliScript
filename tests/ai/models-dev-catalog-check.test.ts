import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = "scripts/check-models-dev-catalog.mjs";
const FIXTURE_API = "tests/fixtures/models-dev/check-api.json";
const FIXTURE_PROFILES = "tests/fixtures/models-dev/check-profiles.ts";
const FIXTURE_ALIASES = "tests/fixtures/models-dev/check-aliases.json";

const FIXTURE_MODELS = 14;
const FIXTURE_COUNTS = "14/12/10/2/6";

const REPO_CATALOG = "extension/ai/catalog/models-dev-catalog.generated.ts";
const REPO_ASSIGNMENTS = "extension/ai/catalog/models-dev-thinking.generated.ts";
const REPO_PROFILES = "extension/ai/thinking-profiles.ts";
const DEFAULT_REPORT = ".scratch/tickets/upstream-model-facts/artifacts/03-catalog-check.md";

const tmpRoot = mkdtempSync(join(tmpdir(), "catalog-check-"));
const fixtureCatalog = join(tmpRoot, "fixture-catalog.generated.ts");
const fixtureAssignments = join(tmpRoot, "fixture-thinking.generated.ts");
const fixtureProfilesCrlf = join(tmpRoot, "profiles-crlf.ts");

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  report: string;
}

function spawnNode(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
  return { status: result.status ?? -1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

let reportSeq = 0;
function reportPath(name: string): string {
  reportSeq += 1;
  return join(tmpRoot, `${String(reportSeq).padStart(2, "0")}-${name}.md`);
}

interface Overrides {
  input?: string;
  catalog?: string;
  assignments?: string;
  profiles?: string;
  extra?: string[];
}

function runWith(name: string, extraArgs: string[]): Run {
  const report = reportPath(name);
  const run = spawnNode([SCRIPT, ...extraArgs, "--report", report]);
  let text = "";
  try {
    text = readFileSync(report, "utf8");
  } catch {
    text = "";
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, report: text };
}

function runCheck(name: string, overrides: Overrides = {}): Run {
  return runWith(name, [
    "--input",
    overrides.input ?? FIXTURE_API,
    "--catalog",
    overrides.catalog ?? fixtureCatalog,
    "--assignments",
    overrides.assignments ?? fixtureAssignments,
    "--profiles",
    overrides.profiles ?? FIXTURE_PROFILES,
    ...(overrides.extra ?? [])
  ]);
}

function fileContent(file: string): string {
  return readFileSync(file, "utf8");
}

beforeAll(() => {
  const catalog = spawnNode([
    "scripts/sync-models-dev-catalog.mjs",
    "--input",
    FIXTURE_API,
    "--out",
    fixtureCatalog,
    "--expect-models",
    String(FIXTURE_MODELS)
  ]);
  expect(catalog.stderr, `fixture 01 产物生成失败：${catalog.stderr}`).toBe("");
  expect(catalog.status).toBe(0);

  const assignments = spawnNode([
    "scripts/sync-models-dev-thinking.mjs",
    "--input",
    FIXTURE_API,
    "--out",
    fixtureAssignments,
    "--aliases",
    FIXTURE_ALIASES,
    "--redirects",
    "none",
    "--overrides",
    "none",
    "--off-declarations",
    "none",
    "--expect-counts",
    FIXTURE_COUNTS
  ]);
  expect(assignments.stderr, `fixture 02 产物生成失败：${assignments.stderr}`).toBe("");
  expect(assignments.status).toBe(0);

  writeFileSync(fixtureProfilesCrlf, readFileSync(FIXTURE_PROFILES, "utf8").replace(/\n/g, "\r\n"));
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
  } catch {
  }
});

function writeVariant(name: string, mutate: (api: any) => void): string {
  const api = JSON.parse(readFileSync(FIXTURE_API, "utf8"));
  mutate(api);
  const file = join(tmpRoot, `${name}.json`);
  writeFileSync(file, JSON.stringify(api, null, 2));
  return file;
}

function stripCaptureTime(report: string): string {
  return report
    .split("\n")
    .filter((line) => !/抓取时间/.test(line))
    .join("\n");
}

function sectionOf(report: string, heading: string): string {
  const start = report.indexOf(heading);
  expect(start, `报告缺章节 ${heading}`).toBeGreaterThan(-1);
  const rest = report.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|js)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

describe("catalog:check CLI（漂移）", () => {
  it("in sync：同一份上游子集 → 退出 0 + stdout 打 in sync，且 stdout 没有抓取时间", () => {
    const run = runCheck("in-sync");

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("in sync");
    expect(run.stdout).not.toContain("DRIFT");
    expect(run.stdout).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(run.stdout).toContain("exit: 0");
    expect(run.stdout).toContain("upstream-wins=3");
    expect(run.stdout).toContain("upstream-new=1");
    expect(run.stdout).toContain("hand-only=2");
    expect(run.stdout).toMatch(/报告[:：] .*\.md/);

    const stamps = run.report.split("\n").filter((line) => /抓取时间/.test(line));
    expect(stamps).toHaveLength(1);
    expect(run.report).toContain("in sync");
  });

  it("drift：字段变化 / 新增 / 移除 → 退出 1 + 逐家差异（stdout 摘要 + 报告明细）", () => {
    const drifted = writeVariant("drifted", (api) => {
      api["zhipuai"].models["glm-5.2"].limit.context = 131072;
      api["deepseek"].models["fx-new-reasoning"] = {
        id: "fx-new-reasoning",
        name: "FX New Reasoning",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
        modalities: { input: ["text"] },
        limit: { context: 131072, output: 32768 },
        last_updated: "2026-10-01"
      };
      delete api["xiaomi"].models["mimo-v2.5-pro"];
    });
    const run = runCheck("drift", { input: drifted });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("DRIFT");
    expect(run.stdout).not.toContain("in sync");
    expect(run.stdout).toContain("exit: 1");
    expect(run.stdout).toContain("deepseek: 新增 1 / 移除 0 / 字段变化 0");
    expect(run.stdout).toContain("zhipuai: 新增 0 / 移除 0 / 字段变化 1");
    expect(run.stdout).toContain("xiaomi: 新增 0 / 移除 1 / 字段变化 0");
    expect(run.stdout).toContain("minimax-cn: 新增 0 / 移除 0 / 字段变化 0");

    const driftSection = sectionOf(run.report, "## 1. 漂移（快照 vs 上游）");
    expect(driftSection).toContain("deepseek/fx-new-reasoning");
    expect(driftSection).toContain("xiaomi/mimo-v2.5-pro");
    expect(driftSection).toContain("zhipuai/glm-5.2");
    expect(driftSection).toMatch(/contextWindow: (204800 → 131072|131072 → 204800)/);
    expect(run.report).toContain("先同步");
  });

  it("13 家之外的 provider 变了不报漂移（口径 = 裁剪后的子集）", () => {
    const unrelated = writeVariant("unrelated", (api) => {
      api.openai.models["fx-gpt-reasoning"].limit.context = 123456;
      api["new-unlisted-provider"] = {
        id: "new-unlisted-provider",
        doc: "https://example.com",
        models: {
          "brand-new": {
            id: "brand-new",
            name: "Brand New",
            reasoning: true,
            modalities: { input: ["text"] },
            limit: { context: 1000, output: 1000 }
          }
        }
      };
    });
    const run = runCheck("unrelated", { input: unrelated });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("in sync");
  });

  it("只读：跑完 fixture / 仓库产物 / 手写表内容都不变，脚本也没有 --out", () => {
    const watched = [FIXTURE_API, FIXTURE_PROFILES, REPO_CATALOG, REPO_ASSIGNMENTS, REPO_PROFILES];
    const before = watched.map(fileContent);
    runCheck("readonly");
    expect(watched.map(fileContent)).toEqual(before);

    const withOut = runCheck("readonly-out", { extra: ["--out", join(tmpRoot, "nope.ts")] });
    expect(withOut.status).toBe(2);
    expect(withOut.stderr).toContain("--out");
  });

  it("同一份输入两次跑，报告（除抓取时间）逐字节相同", () => {
    const first = runCheck("idem-a");
    const second = runCheck("idem-b");
    expect(stripCaptureTime(second.report)).toBe(stripCaptureTime(first.report));
    expect(stripCaptureTime(first.report).length).toBeGreaterThan(2000);
  });

  it("坏输入 / 坏产物 / 坏手写表 → 退出 2（硬错，不是 drift）", () => {
    const missing = runCheck("bad-input", { input: join(tmpRoot, "no-such.json") });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("check-models-dev-catalog");

    const malformedFile = join(tmpRoot, "malformed.json");
    writeFileSync(malformedFile, "{ not json");
    const malformed = runCheck("bad-json", { input: malformedFile });
    expect(malformed.status).toBe(2);

    const badCatalog = join(tmpRoot, "bad-catalog.ts");
    writeFileSync(badCatalog, "export const nothing = 1;\n");
    const noHash = runCheck("bad-catalog", { catalog: badCatalog });
    expect(noHash.status).toBe(2);
    expect(noHash.stderr).toContain("contentHash");

    const badProfiles = join(tmpRoot, "bad-profiles.ts");
    writeFileSync(badProfiles, "export const TAXONOMY = [];\n");
    const noTables = runCheck("bad-profiles", { profiles: badProfiles });
    expect(noTables.status).toBe(2);
    expect(noTables.stderr).toContain("CLASSES");

    const danglingClass = join(tmpRoot, "dangling-class.ts");
    writeFileSync(
      danglingClass,
      readFileSync(FIXTURE_PROFILES, "utf8").replace('class: "fx-glm-always"', 'class: "fx-no-such-class"')
    );
    const dangling = runCheck("dangling-class", { profiles: danglingClass });
    expect(dangling.status).toBe(2);
    expect(dangling.stderr).toContain("fx-no-such-class");
  });
});

describe("catalog:check CLI（上游 vs 手写分歧）", () => {
  it("upstream-wins：三类判据各一例（off 方向 / 档位未表达 / 关不掉声明与上游 toggle 冲突）", () => {
    const run = runCheck("wins");
    expect(run.status).toBe(0);
    const wins = sectionOf(run.report, "## 2. upstream-wins");

    expect(wins).toContain("zhipuai/glm-5.2");
    expect(wins).toContain("CLASSES.fx-glm-effort");
    expect(wins).toContain("上游没有 toggle");
    expect(wins).toContain("zhipuai/glm-5.3");
    expect(wins).toContain("手写未表达");
    expect(wins).toContain("kimi-code-plan-cn/k3");
    expect(wins).toContain("别名 kimi-k3");
    expect(wins).toContain("上游有 toggle");
    expect(wins).toContain("last_updated 2026-06-13");
    expect(wins).toContain("docs.z.ai");
    expect(wins).toContain("docs.bigmodel.cn");
    expect(wins).toContain("platform.kimi.ai");
    expect(wins).toContain("删除候选");
    expect(wins).toContain("04");

    expect(wins).not.toContain("opencode-go/fx-go-model");
    expect(wins).not.toContain("openrouter/fx/router-model");
    expect(wins).not.toContain("qwen3-max");
  });

  it("upstream-new：上游有词表、手写表没覆盖（没有兜底 class 的平台）", () => {
    const run = runCheck("new");
    const fresh = sectionOf(run.report, "## 3. upstream-new");
    expect(fresh).toContain("stepfun-step-plan/step-9-preview");
    expect(fresh).toContain("last_updated 2026-09-20");
    expect(fresh).toContain("platform.stepfun.com");
    expect(fresh).not.toContain("modelscope/fx-scope-model");
    expect(fresh).not.toContain("xiaomi/mimo-v2.5-pro");
  });

  it("hand-only：上游缺口（无词表）但手写表有结论 → 保留", () => {
    const run = runCheck("hand-only");
    const only = sectionOf(run.report, "## 4. hand-only");
    expect(only).toContain("minimax-cn/MiniMax-M2");
    expect(only).toContain("CLASSES.fx-minimax-always");
    expect(only).toContain("modelscope/fx-scope-model");
    expect(only).toContain("CLASSES.fx-qwen-switch");
    expect(only).toContain("unknownClass");
    expect(only).toContain("保留");
    expect(only).not.toContain("zhipuai/glm-5.2");
  });

  it("qwen3-max：上游没有 effort 词表 → 同值塌陷不是分歧，进注记不进 upstream-wins", () => {
    const run = runCheck("qwen3-max");
    const notes = sectionOf(run.report, "## 5. 注记：不是分歧");
    expect(notes).toContain("alibaba-cn/qwen3-max");
    expect(notes).toContain("无 effort");
    expect(notes).toContain("81920");
    expect(notes).toContain("不是分歧");
    expect(sectionOf(run.report, "## 2. upstream-wins")).not.toContain("qwen3-max");
  });

  it("override 平台单独成区：手写是平台级裁定，不逐格报成分歧（但形状要看得到）", () => {
    const run = runCheck("platform");
    const platform = sectionOf(run.report, "## 6. 平台级声明");
    for (const id of ["opencodego", "openrouter", "amd", "sensenova"]) {
      expect(platform, `平台级区缺 ${id}`).toContain(id);
    }
    expect(platform).toContain("platform-level");
    expect(platform).toContain("不逐格对比");
    expect(platform).toMatch(/toggle/);
    expect(platform).toMatch(/无词表|缺口/);
  });

  it("手写表解析必须吃 CRLF 与单行条目（否则全部误报成未覆盖）", () => {
    const crlf = runCheck("crlf", { profiles: fixtureProfilesCrlf });
    expect(crlf.status).toBe(0);
    expect(crlf.stdout).toContain("upstream-wins=3");
    const wins = sectionOf(crlf.report, "## 2. upstream-wins");
    expect(wins).toContain("zhipuai/glm-5.3");
    expect(wins).toContain("CLASSES.fx-glm-always");
    expect(crlf.report).toMatch(/CLASSES 6 \/ TAXONOMY 4 \/ EXCEPTIONS 2 \/ PROVIDERS 13/);
  });
});

describe("catalog:check 接线与红线", () => {
  it("package.json 接线：catalog:check 只加一行，既有两条命令不动（11 号票删 pi-ai 后 catalog:sync 已移除）", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["catalog:check"]).toBe("node scripts/check-models-dev-catalog.mjs");
    expect(pkg.scripts["catalog:sync:upstream"]).toBe("node scripts/sync-models-dev-catalog.mjs");
    expect(pkg.scripts["catalog:sync:thinking"]).toBe("node scripts/sync-models-dev-thinking.mjs");

    expect(readFileSync(SCRIPT, "utf8")).toContain(DEFAULT_REPORT);
  });

  it("红线：脚本不进 extension 静态图，只 import scripts 内的单源，不碰请求路径", () => {
    const source = readFileSync(SCRIPT, "utf8");
    for (const match of source.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*"([^"]+)"/g)) {
      expect(match[1], `脚本不许 import ${match[1]}`).toMatch(/^\.\/|^node:/);
    }
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\beval\s*\(|new Function\b/);
    for (const file of ["extension/core/provider-http.ts", "extension/ai/completion.ts", "extension/ai/adapters"]) {
      expect(source, `脚本引用了 ${file}`).not.toContain(file);
    }
    const referencing = walk("extension").filter((file) => readFileSync(file, "utf8").includes("check-models-dev-catalog"));
    expect(referencing).toEqual([]);
  });
});
