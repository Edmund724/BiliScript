// tests/ai/models-dev-catalog-check.test.ts
// 票据 03（upstream-model-facts/03）：只读命令 pnpm catalog:check 的漂移 + 分歧报告。
//
// 两条接缝（seam）：
//   A. 脚本 scripts/check-models-dev-catalog.mjs 的 CLI —— fixture 离线跑，观察面 =
//      退出码 + stdout/stderr + 写出的报告文本。01/02 的产物用**真生成脚本**在临时
//      目录现生成（不手搓产物），检查脚本与生成器的裁剪口径必须逐字节等效。
//   B. 提交进仓库的真实输入 + 提交的快照（.scratch 工件，离线）——钉住票面点名的
//      三条已知冲突与 qwen3-max 的"不是分歧"。
//
// 先列系统可能失败的方式（每条都有对应用例）：
//   1. 漂移漏报：上游子集变了却退出 0 / 报 in sync（裁剪字段、键序、哈希口径与 01 不一致）；
//   2. 漂移误报：12 家之外的 provider 变了就报漂移（口径该是裁剪子集）；
//   3. 漂移报告不可追：只说"变了"，不给新增/移除/字段变化；
//   4. 分歧分类混淆：upstream-new / upstream-wins / hand-only 三类判错；
//   5. 已知冲突缺席：手写表解析读不到（单行条目/CRLF/引号键）、别名（k3→kimi-k3）没接上、
//      EXCEPTIONS/TAXONOMY 优先级错 → 三条已知冲突漏报；
//   6. 手写表解析静默失败：结构漂移后解析出空表 → 全部误报成 upstream-new；
//   7. qwen3-max 被误判成分歧（上游没有 effort 词表，同值塌陷是唯一形状）；
//   8. 报告不确定：两次跑内容不同（排序/时间戳进不该进的地方）；
//   9. 只读性被破坏：命令改了仓库文件（手写表/产物）；
//  10. 退出码语义糊：in sync / drift / 坏输入 分不清；
//  11. 红线：脚本进 extension 的静态图或请求路径。

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = "scripts/check-models-dev-catalog.mjs";
const FIXTURE_API = "tests/fixtures/models-dev/check-api.json";
const FIXTURE_PROFILES = "tests/fixtures/models-dev/check-profiles.ts";
const FIXTURE_ALIASES = "tests/fixtures/models-dev/check-aliases.json";

// fixture 的手数（独立于实现，逐条数 check-api.json；已用 01/02 生成器的对账参数验证）：
// 12 家里 13 个模型 / 12 个 reasoning / 10 个有词表 / 2 个缺口 / 6 个 effort 值集。
const FIXTURE_MODELS = 13;
const FIXTURE_COUNTS = "13/12/10/2/6";

// 提交进仓库的快照（01/02 的抓取工件，离线可读）与真产物。
const SNAPSHOT = ".scratch/tickets/upstream-model-facts/artifacts/models-dev-api.json";
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

// fixture 跑：默认 fixture 上游 + fixture 手写表 + 现生成的 01/02 产物。
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

// 真实文件跑：只换 --input（默认产物路径就是仓库里的真产物/真手写表）。
function realFileCheck(name: string, extraArgs: string[] = []): Run {
  return runWith(name, ["--input", SNAPSHOT, ...extraArgs]);
}

function fileContent(file: string): string {
  return readFileSync(file, "utf8");
}

// fixture 的 01/02 产物用真生成脚本产出：检查脚本的裁剪口径与生成器必须逐字节等效
// （不等效的话 in sync 用例会红）。
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

  // 本用例的对账对象是**上游快照的原始事实**：`--overrides none` 之外还显式
  // `--off-declarations none`——D1=A2 的本仓补声明（给 zhipuai/glm-5.2 补 toggle）是
  // 本仓事实增强，不是上游读到的形状；这份 fixture 的手写表正是按原始形状标定的，
  // checker 的三类判据（off 方向 / 档位未表达 / 关不掉声明与上游 toggle 冲突）必须各留
  // 一个例子。补声明本身的生成期行为由 tests/ai/models-dev-thinking.test.ts 的
  // 「能力补声明表」用例覆盖。
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

  // 真实手写表在工作区是 CRLF——解析器必须吃（否则整表解析成空，全部误报未覆盖）。
  writeFileSync(fixtureProfilesCrlf, readFileSync(FIXTURE_PROFILES, "utf8").replace(/\n/g, "\r\n"));
});

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows 上偶发句柄未释放：临时目录残留不影响断言。
  }
});

// 变体 fixture：在 check-api.json 上做定向改动，写到临时目录。
function writeVariant(name: string, mutate: (api: any) => void): string {
  const api = JSON.parse(readFileSync(FIXTURE_API, "utf8"));
  mutate(api);
  const file = join(tmpRoot, `${name}.json`);
  writeFileSync(file, JSON.stringify(api, null, 2));
  return file;
}

// 报告去掉抓取时间后逐字节可比（幂等硬要求）。
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

// ───────────────────────── 接缝 A：CLI（fixture，离线）─────────────────────────

describe("catalog:check CLI（漂移）", () => {
  it("in sync：同一份上游子集 → 退出 0 + stdout 打 in sync，且 stdout 没有抓取时间", () => {
    const run = runCheck("in-sync");

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("in sync");
    expect(run.stdout).not.toContain("DRIFT");
    // 抓取时间只允许出现在报告里（产物/stdout 幂等）。
    expect(run.stdout).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(run.stdout).toContain("exit: 0");
    // stdout 只打摘要：三类分歧计数 + 报告落点。
    expect(run.stdout).toContain("upstream-wins=3");
    expect(run.stdout).toContain("upstream-new=1");
    expect(run.stdout).toContain("hand-only=2");
    expect(run.stdout).toMatch(/报告[:：] .*\.md/);

    // 报告里抓取时间有且只有一处（标题块那一行）。
    const stamps = run.report.split("\n").filter((line) => /抓取时间/.test(line));
    expect(stamps).toHaveLength(1);
    expect(run.report).toContain("in sync");
  });

  it("drift：字段变化 / 新增 / 移除 → 退出 1 + 逐家差异（stdout 摘要 + 报告明细）", () => {
    const drifted = writeVariant("drifted", (api) => {
      api["zhipuai"].models["glm-5.2"].limit.context = 131072; // 字段变化
      api["deepseek"].models["fx-new-reasoning"] = {
        id: "fx-new-reasoning",
        name: "FX New Reasoning",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
        modalities: { input: ["text"] },
        limit: { context: 131072, output: 32768 },
        last_updated: "2026-10-01"
      };
      delete api["xiaomi"].models["mimo-v2.5-pro"]; // 移除
    });
    const run = runCheck("drift", { input: drifted });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("DRIFT");
    expect(run.stdout).not.toContain("in sync");
    expect(run.stdout).toContain("exit: 1");
    // 逐家差异摘要（按 provider 分组，无差异的家也在）。
    expect(run.stdout).toContain("deepseek: 新增 1 / 移除 0 / 字段变化 0");
    expect(run.stdout).toContain("zhipuai: 新增 0 / 移除 0 / 字段变化 1");
    expect(run.stdout).toContain("xiaomi: 新增 0 / 移除 1 / 字段变化 0");
    expect(run.stdout).toContain("minimax-cn: 新增 0 / 移除 0 / 字段变化 0");

    // 报告明细：三条差异都能追到具体模型与字段。
    const driftSection = sectionOf(run.report, "## 1. 漂移（快照 vs 上游）");
    expect(driftSection).toContain("deepseek/fx-new-reasoning");
    expect(driftSection).toContain("xiaomi/mimo-v2.5-pro");
    expect(driftSection).toContain("zhipuai/glm-5.2");
    expect(driftSection).toMatch(/contextWindow: (204800 → 131072|131072 → 204800)/);
    // 漂移时点明"分歧清单基于提交的旧产物"，不让人误当成已同步的结论。
    expect(run.report).toContain("先同步");
  });

  it("12 家之外的 provider 变了不报漂移（口径 = 裁剪后的子集）", () => {
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

    // 脚本没有"写产物"的口子（只有报告）：--out 是未知参数。
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

    // 手写表结构变了（引用了不存在的 class）必须硬错，不许静默当成"未覆盖"。
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

    // ① 手写声明可关闭（thinking 开关），上游词表没有开关也没有 none。
    expect(wins).toContain("zhipuai/glm-5.2");
    expect(wins).toContain("CLASSES.fx-glm-effort");
    expect(wins).toContain("上游没有 toggle");
    // ② 手写只声明"永远思考"、没表达任何档位，上游有 effort 档位。
    expect(wins).toContain("zhipuai/glm-5.3");
    expect(wins).toContain("手写未表达");
    // ③ 手写声明关不掉（always），上游有 toggle；且命中经别名（本仓口径 id ≠ 上游 id）。
    expect(wins).toContain("kimi-code-plan-cn/k3");
    expect(wins).toContain("别名 kimi-k3");
    expect(wins).toContain("上游有 toggle");
    // 每条都带双方证据：上游 last_updated + doc URL、本仓注释里的出处域名。
    expect(wins).toContain("last_updated 2026-06-13");
    expect(wins).toContain("docs.z.ai");
    expect(wins).toContain("docs.bigmodel.cn");
    expect(wins).toContain("platform.kimi.ai");
    // 处置是"删除候选"（Q1=B），但本票只报告、不删（删减归 04）。
    expect(wins).toContain("删除候选");
    expect(wins).toContain("04");

    // 只有这三条是 upstream-wins：override 平台（平台级产品裁定）不进这一类。
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
    // 有兜底（unknownClass）的平台不算"未覆盖"。
    expect(fresh).not.toContain("modelscope/fx-scope-model");
    expect(fresh).not.toContain("xiaomi/mimo-v2.5-pro");
  });

  it("hand-only：上游缺口（无词表）但手写表有结论 → 保留", () => {
    const run = runCheck("hand-only");
    const only = sectionOf(run.report, "## 4. hand-only");
    // 上游 reasoning:true 但无 reasoning_options；手写经 TAXONOMY / unknownClass 命中。
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
    // 平台级形状 + 上游逐模型形状分布都要在（可见性，不许一笔带过）。
    expect(platform).toMatch(/toggle/);
    expect(platform).toMatch(/无词表|缺口/);
  });

  it("手写表解析必须吃 CRLF 与单行条目（否则全部误报成未覆盖）", () => {
    const crlf = runCheck("crlf", { profiles: fixtureProfilesCrlf });
    expect(crlf.status).toBe(0);
    expect(crlf.stdout).toContain("upstream-wins=3");
    const wins = sectionOf(crlf.report, "## 2. upstream-wins");
    // 单行条目（`"fx-glm-always": { thinkingClass: "always" },`）也要解析出来。
    expect(wins).toContain("zhipuai/glm-5.3");
    expect(wins).toContain("CLASSES.fx-glm-always");
    // 引用完整性：解析出的条目数写进报告（结构漂移肉眼可见）。
    expect(crlf.report).toMatch(/CLASSES 6 \/ TAXONOMY 4 \/ EXCEPTIONS 2 \/ PROVIDERS 12/);
  });
});

// ─────────────── 接缝 B：真实文件 + 提交快照（离线，票面验收） ───────────────

// 提交的快照在 `.scratch/`（本仓 gitignore 的构建/抓取工件区，与 01/02 的产物同处），
// 新克隆里可能没有：没有就跳过这一组（已知冲突的形状已由接缝 A 的 fixture 钉住，
// 那两个模型 id 与真表同名）。
const hasSnapshot = existsSync(SNAPSHOT);

describe.skipIf(!hasSnapshot)("catalog:check（真产物 + 提交快照）", () => {
  it("快照与提交产物一致 → in sync；两条已知冲突落在 upstream-wins，qwen3-max 落注记", () => {
    // 提交的快照就是 01/02 产物的来源，所以这里必然 in sync（也顺带钉住裁剪口径
    // 与 01 生成器逐字节等效）。
    const run = realFileCheck("real-snapshot");
    expect(run.status, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain("in sync");

    const wins = sectionOf(run.report, "## 2. upstream-wins");
    // 票面 §5 点名的三条（04 号票删掉手写条目后，这里的断言要跟着改）。13 号票 canonical
    // 优先后 kimi-code-plan-cn/k3 的上游事实从 toggle+low-high-max 变为 low-high-max ——
    // 手写专条（always + effort，无 off）与上游不再矛盾，k3 因此离开 upstream-wins
    // （分歧条数 3 → 2；该行的现状由 13 号票验收与 13-canonical-priority 验证器覆盖）。
    expect(wins).toContain("zhipuai/glm-5.2");
    expect(wins).toContain("zhipuai/glm-5.3");
    expect(wins).not.toContain("kimi-code-plan-cn/k3");
    // 上游侧证据：真实 last_updated 与 provider doc URL。
    expect(wins).toContain("last_updated 2026-06-13");
    expect(wins).toContain("last_updated 2026-08-14");
    expect(wins).toContain("https://docs.z.ai/");

    // 本仓出处（手写表注释里的域名）也要带上。
    expect(wins).toContain("docs.bigmodel.cn");

    // qwen3-max：上游 [toggle, budget_tokens max 81920] 无 effort → 不是分歧。
    const notes = sectionOf(run.report, "## 5. 注记：不是分歧");
    expect(notes).toContain("alibaba-cn/qwen3-max");
    expect(notes).toContain("81920");
    expect(notes).toContain("不是分歧");
    expect(wins).not.toContain("alibaba-cn/qwen3-max");
    // k3-256k（同 provider 的另一个 id）落 upstream-new（手写侧没有任何条目命中）。
    const news = sectionOf(run.report, "## 3. upstream-new");
    expect(news).toContain("kimi-code-plan-cn/k3-256k");
    expect(news).toContain("last_updated 2026-07-16");
    expect(news).toContain("https://www.kimi.com/code/docs");

    // 三类分区都在且有计数（报告可读性）。
    expect(run.report).toMatch(/## 3\. upstream-new[^\n]*\d+ 条/);
    expect(run.report).toMatch(/## 4\. hand-only[^\n]*\d+ 条/);
    expect(run.report).toMatch(/## 7\. 双方都无结论/);
    // 手写表解析口径写进报告（人能看到解析了多少条目）。
    // CLASSES 22 / EXCEPTIONS 7 = 19 号票收尾删掉 kimi-k3* 专条 + 随之孤儿化的 class。
    expect(run.report).toMatch(/CLASSES 22 \/ TAXONOMY 16 \/ EXCEPTIONS 7 \/ PROVIDERS 14/);
  });

});

// 接线与红线：不依赖快照，任何克隆都必须跑。
describe("catalog:check 接线与红线", () => {
  it("package.json 接线：catalog:check 只加一行，既有两条命令不动（11 号票删 pi-ai 后 catalog:sync 已移除）", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["catalog:check"]).toBe("node scripts/check-models-dev-catalog.mjs");
    expect(pkg.scripts["catalog:sync:upstream"]).toBe("node scripts/sync-models-dev-catalog.mjs");
    expect(pkg.scripts["catalog:sync:thinking"]).toBe("node scripts/sync-models-dev-thinking.mjs");

    // 默认报告落点 = 票面工件路径。
    expect(readFileSync(SCRIPT, "utf8")).toContain(DEFAULT_REPORT);
  });

  it("红线：脚本不进 extension 静态图，只 import scripts 内的单源，不碰请求路径", () => {
    const source = readFileSync(SCRIPT, "utf8");
    // 只准 import node: 与 scripts/ 内的共享单源（12 家映射）；不 import extension/
    // 任何文件（手写表与产物按**文本**读，不执行仓库代码）。
    for (const match of source.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*"([^"]+)"/g)) {
      expect(match[1], `脚本不许 import ${match[1]}`).toMatch(/^\.\/|^node:/);
    }
    // 手写表与产物只按**文本**读：不执行仓库代码（无动态 import / require / eval）。
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\beval\s*\(|new Function\b/);
    // 请求路径一个文件都不许出现。
    for (const file of ["extension/core/provider-http.ts", "extension/ai/completion.ts", "extension/ai/adapters"]) {
      expect(source, `脚本引用了 ${file}`).not.toContain(file);
    }
    // extension 侧没有静态引用（dev 脚本不该被扩展代码拖进任何图）。
    const referencing = walk("extension").filter((file) => readFileSync(file, "utf8").includes("check-models-dev-catalog"));
    expect(referencing).toEqual([]);
  });
});
