// tests/ai/models-dev-thinking.test.ts
// 票据 02（upstream-model-facts/02）：上游思考事实的编译产物（值集表 + 指派表）。
//
// 两条接缝（seam）：
//   A. 生成脚本 scripts/sync-models-dev-thinking.mjs 的 CLI —— 产物只能由它产出。
//      测试用 --input 喂 tests/fixtures/models-dev/sample-api.json（不打网络），
//      --out/--report/--matrix 写临时目录；观察面 = 退出码 + stdout/stderr +
//      写出的产物字节 + 报告/矩阵文本。
//   B. 提交进仓库的产物模块 extension/ai/catalog/models-dev-thinking.generated.ts
//      的导出（UPSTREAM_THINKING_SOURCE / VALUESETS / ASSIGNMENTS /
//      DEPRECATED_MODELS / MODEL_ID_ALIASES / lookupThinkingFact）。
//
// 先列系统可能失败的方式（每条都有对应用例）：
//   1. 值集没去重（同结构多条）或去重过头（budget 区间不同的结构被合并）→
//      指派指向错误的档位空间；
//   2. effort 词表被裁剪/重排/排序 → 上游顺序即事实，UI 档位顺序随之错；
//   3. off 可表达性判错（有 toggle 或无 none 时判成关得掉/关不掉）→ 请求侧
//      发出上游不认的档位；
//   4. 63 个无词表模型没按 canonical_model_id 借词 → 静默丢档；canonical 的
//      provider 前缀解析错 → 借到别的平台的词表；
//   5. 大小写折叠缺失（amd / minimax-cn / modelscope 的 id 大小写混排）→
//      请求原样大小写查不到；
//   6. 别名表缺失或指向不存在的上游 id → 查表落空；
//   7. 未知模型不 fail-closed（返回臆造档位）→ 请求侧发出上游不认的参数；
//   8. deprecated 模型被删掉或没标记（"表里有但废弃"与"表里没有"行为不同）；
//   9. 产物把 578 条原始记录全塞进来 / 逐平台逐模型规则 → 体积失控；
//  10. 产物长出 import（静态/动态）或进 SW 静态图 → 破叶子纪律；
//  11. 上游漂移（模型/推理/缺口/effort 值集计数变了）→ 静默生成漂移产物；
//  12. 生成不幂等（时间戳/键序不稳）→ 每次重跑 git diff 非空；
//  13. 上游数据进请求路径（provider-http → completion → adapters）→ 破红线。

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ASSIGNMENTS,
  DEPRECATED_MODELS,
  MODEL_ID_ALIASES,
  UPSTREAM_THINKING_SOURCE,
  VALUESETS,
  lookupThinkingFact
} from "../../extension/ai/catalog/models-dev-thinking.generated.js";

const SCRIPT = "scripts/sync-models-dev-thinking.mjs";
const FIXTURE = "tests/fixtures/models-dev/sample-api.json";
// fixture 的 12 家映射上游手数（独立于实现，逐条数 sample-api.json）：
// 模型 15 / reasoning 12 / 有 reasoning_options 9 / 缺口 3 / effort 值集 5。
// 与真产物的对账常量 578/415/352/63/30 互不相干——这是「对账逻辑本身」的期望值。
const FIXTURE_COUNTS = "15/12/9/3/5";

const tmpRoot = mkdtempSync(join(tmpdir(), "models-dev-thinking-"));

interface GeneratorRun {
  status: number;
  stdout: string;
  stderr: string;
}

function runGenerator(args: string[]): GeneratorRun {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  return {
    status: result.status ?? -1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? "")
  };
}

function outPath(name: string): string {
  return join(tmpRoot, `${name}.generated.ts`);
}

interface FixtureProvider {
  models: Record<string, Record<string, unknown>>;
}
type FixtureApi = Record<string, FixtureProvider>;

// 变体 fixture：在 commit 的 sample-api.json 上做定向改动，写到临时目录。
function writeVariant(name: string, mutate: (api: FixtureApi) => void): string {
  const api = JSON.parse(readFileSync(FIXTURE, "utf8")) as FixtureApi;
  mutate(api);
  const file = join(tmpRoot, `${name}.json`);
  writeFileSync(file, JSON.stringify(api));
  return file;
}

function generate(name: string, input: string = FIXTURE, extra: string[] = []): string {
  const out = outPath(name);
  // fixture 是 12 家的合成小快照：本仓真实别名表的目标（k3 / step-3.7-flash /
  // moonshotai/kimi-k2.6 / ZhipuAI/GLM-4.6）都不在里面，所以默认 --aliases none
  // （生产默认是脚本里的 MODEL_ID_ALIASES）；要测别名机制就传 --aliases <path>。
  const run = runGenerator([
    "--input",
    input,
    "--out",
    out,
    "--aliases",
    "none",
    "--expect-counts",
    FIXTURE_COUNTS,
    ...extra
  ]);
  expect(run.stderr, `生成失败：${run.stderr}`).toBe("");
  expect(run.status).toBe(0);
  return readFileSync(out, "utf8");
}

// 产品正文（生成器文件头注释之下）——注释里会点名「刻意不带的字段」，
// 直接对整个文件做 toContain 会被注释误伤。
function bodyOf(moduleText: string): string {
  const marker = moduleText.indexOf("export const UPSTREAM_THINKING_SOURCE");
  expect(marker, "产物里没有 UPSTREAM_THINKING_SOURCE").toBeGreaterThan(-1);
  return moduleText.slice(marker);
}

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows 上偶发句柄未释放：临时目录残留不影响断言。
  }
});

// ─────────────────────────── 接缝 A：生成脚本 CLI ───────────────────────────

describe("思考事实生成器 CLI（02）", () => {
  it("值集归一：toggle/effort/budget_tokens 可共存，按结构去重，effort 保留上游顺序", () => {
    const body = bodyOf(generate("valuesets"));

    // fixture 12 家里有词表的 10 个模型 → 7 个不同结构（toggle 去重 4 次）。
    // 期望值手写在下面（独立于实现：逐条来自 fixture 的 reasoning_options）。
    // 省缺口径：表里只写有值的部分（缺省 = toggle false / effort 无 / budget 无）。
    const expectedRows = [
      `  "b:-81920": { label: "always-budget", budget: { max: 81920 } },`,
      `  "high-max": { label: "always-effort", effort: ["high", "max"] },`,
      `  "low-high": { label: "always-effort", effort: ["low", "high"] },`,
      `  "low-medium-high": { label: "always-effort", effort: ["low", "medium", "high"] },`,
      `  "none-low-medium-high": { label: "hybrid-effort-none", effort: ["none", "low", "medium", "high"] },`,
      `  "toggle": { label: "hybrid-switch", toggle: true },`,
      `  "toggle+low-high-max": { label: "hybrid-switch-effort", toggle: true, effort: ["low", "high", "max"] },`
    ];
    for (const row of expectedRows) {
      expect(body, `缺值集行：${row}`).toContain(row);
    }

    // 去重：值集行数正好 7（不多不少）。行首锚定 `  "<id>": { label:`，避免
    // 被 ASSIGNMENTS 里的模型行误计。
    const valuesetRows = [...body.matchAll(/^ {2}"[^"]+": \{ label:/gm)];
    expect(valuesetRows).toHaveLength(expectedRows.length);

    // effort 顺序逐字照搬（上游 ["none","low","medium","high"] 没有按字母重排）。
    expect(body).toContain(`effort: ["none", "low", "medium", "high"]`);
    // 12 家之外的 provider（fixture 的 openai/gpt-fixture-reasoning 有 effort
    // low/high）不贡献值集、也不进表：low-high 只来自 stepfun 的 fx-step。
    expect(body).not.toContain("gpt-fixture-reasoning");
    expect(body).not.toContain("gpt-fixture-plain");
  });

  it("指派表：有词表模型逐条指派，无词表的模型不进表（不臆造档位）", () => {
    const body = bodyOf(generate("assignments"));

    const expectedAssignments = [
      `  "deepseek": {\n    "fx-pdf-first": "toggle+low-high-max",\n  },`,
      `  "alibaba-cn": {\n    "fx-video": "b:-81920",\n  },`,
      `  "zhipuai": {\n    "fx-glm": "high-max",\n  },`,
      `  "kimi-code-plan-cn": {\n    "fx-kimi": "toggle",\n  },`,
      `  "xiaomi": {\n    "fx-mimo": "toggle",\n  },`,
      `  "openrouter": {\n    "fx-router-a": "low-medium-high",\n  },`,
      `  "stepfun-step-plan": {\n    "fx-step": "low-high",\n  },`,
      `  "modelscope": {\n    "ZhipuAI/fx-quoted": "toggle",\n  },`,
      `  "sensenova": {\n    "fx-sense": "none-low-medium-high",\n  }`
    ];
    for (const row of expectedAssignments) {
      expect(body, `缺指派行：${row}`).toContain(row);
    }

    // fixture 里 amd / minimax-cn 的唯一模型都没有 reasoning_options，
    // 且没有 canonical_model_id 可借 → 不出现在指派表里。
    expect(body).not.toContain(`"Fx-AMD-Upper"`);
    expect(body).not.toContain(`"fx-minimax"`);
    // 产物只带 (provider, modelId) → valuesetId 的指派，不带逐模型参数记录。
    for (const dropped of ["reasoning_options", "canonical_model_id", "budget_tokens", "contextWindow", "maxTokens"]) {
      expect(body, `产物漏带裁剪字段 ${dropped}`).not.toContain(dropped);
    }
  });

  it("canonical 借词：缺口按 canonical_model_id 到原生 provider 取词表，借不到就标未知", () => {
    // fixture：opencode-go/fx-go 无 reasoning_options，canonical_model_id = xiaomi/fx-mimo
    // （toggle 词表）→ 借到 xiaomi 的值集，进指派表。
    const body = bodyOf(generate("borrow"));
    expect(body).toContain(`  "opencode-go": {\n    "fx-go": "toggle",\n  },`);
    // 12 个 reasoning / 9 个有词表 / 3 个缺口：1 个借到（fx-go），2 个未知（amd/minimax）。
    expect(body).toContain(`  "toggle": { label: "hybrid-switch", toggle: true },`);
    expect(body).toContain("    borrowed: 1,");
    expect(body).toContain("    unknown: 2,");
    // 借不到的不进指派表（没有臆造档位）。
    expect(body).not.toContain(`"Fx-AMD-Upper"`);
    expect(body).not.toContain(`"fx-minimax"`);

    // 借不到的三条路径都必须软失败（fail-closed，而不是借错平台或猜档位）：
    // (1) canonical 指向快照里没有的 provider；(2) canonical 没有 provider 前缀；
    // (3) canonical 指向的模型本身也没有词表。
    const brokenCanonical = writeVariant("borrow-broken-canonical", (api) => {
      api["opencode-go"].models["fx-go"].canonical_model_id = "no-such-provider/fx-mimo";
    });
    const noPrefix = writeVariant("borrow-no-prefix", (api) => {
      api["opencode-go"].models["fx-go"].canonical_model_id = "fx-mimo";
    });
    const emptyTarget = writeVariant("borrow-empty-target", (api) => {
      api["opencode-go"].models["fx-go"].canonical_model_id = "minimax-cn/fx-minimax";
    });
    for (const [index, input] of [brokenCanonical, noPrefix, emptyTarget].entries()) {
      const text = bodyOf(generate(`borrow-unresolved-${index}`, input));
      expect(text, `变体 ${index} 不该借到词表`).not.toContain(`"fx-go"`);
      expect(text).toContain("    borrowed: 0,");
      expect(text).toContain("    unknown: 3,");
    }
  });

  it("别名表：查表兜底 + 缺口补录，目标指错一律硬错（不许静默落空）", () => {
    // 别名 fixture：一条查表兜底（kimi-k3 → 上游 fx-kimi），一条缺口补录
    // （amd/Fx-AMD-Upper 借 xiaomi/fx-mimo）—— 与真实别名表同一条代码路径。
    const aliasFixture = join(tmpRoot, "aliases.json");
    writeFileSync(
      aliasFixture,
      JSON.stringify([
        {
          provider: "kimi-code-plan-cn",
          localId: "kimi-k3",
          upstream: "kimi-code-plan-cn/fx-kimi",
          reason: "fixture：上游实际 id 是 fx-kimi（真实表里是 k3）。"
        },
        {
          provider: "amd",
          localId: "Fx-AMD-Upper",
          upstream: "xiaomi/fx-mimo",
          reason: "fixture：amd 托管的同名模型借 xiaomi 的开关词表。"
        }
      ])
    );
    const body = bodyOf(generate("aliases", FIXTURE, ["--aliases", aliasFixture]));
    // 别名条目逐字进产物（含理由），target 的值集与目标模型一致。
    expect(body).toContain(
      `  { provider: "kimi-code-plan-cn", localId: "kimi-k3", upstream: "kimi-code-plan-cn/fx-kimi", valuesetId: "toggle", reason: "fixture：上游实际 id 是 fx-kimi（真实表里是 k3）。" },`
    );
    // 缺口补录：amd 从「未知词表」变成「借词进表」（另一个缺口 fx-go 走 canonical）。
    expect(body).toContain(`  "amd": {\n    "Fx-AMD-Upper": "toggle",\n  },`);
    expect(body).toContain("    borrowed: 2,");
    expect(body).toContain("    unknown: 1,");

    // 目标指错 = 硬错（别名指错等于静默落空，必须吵）。
    const badAliases: [string, Record<string, string>][] = [
      ["target-missing", { provider: "kimi-code-plan-cn", localId: "kimi-k3", upstream: "no-such-provider/x", reason: "目标不存在" }],
      ["target-empty", { provider: "kimi-code-plan-cn", localId: "kimi-k3", upstream: "minimax-cn/fx-minimax", reason: "目标没有词表" }],
      ["provider-unknown", { provider: "openai", localId: "gpt-fixture-reasoning", upstream: "openai/gpt-fixture-reasoning", reason: "不在 12 家里" }],
      ["upstream-malformed", { provider: "kimi-code-plan-cn", localId: "kimi-k3", upstream: "fx-kimi", reason: "缺 provider 前缀" }]
    ];
    for (const [name, alias] of badAliases) {
      const file = join(tmpRoot, `aliases-${name}.json`);
      writeFileSync(file, JSON.stringify([alias]));
      const run = runGenerator([
        "--input",
        FIXTURE,
        "--out",
        outPath(`aliases-${name}-out`),
        "--aliases",
        file,
        "--expect-counts",
        FIXTURE_COUNTS
      ]);
      expect(run.status, `别名 ${name} 应当硬错`).not.toBe(0);
      expect(run.stderr).toContain("sync-models-dev-thinking");
    }
  });

  it("对账：默认常量是真产物的 578/415/352/63/30，fixture 不带覆盖参数必红", () => {
    // 不带 --expect-counts 时按脚本常量（真产物口径）判，fixture 只有 15/12/9/3/5 → 必红。
    const mismatch = runGenerator(["--input", FIXTURE, "--out", outPath("default-expect"), "--aliases", "none"]);
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain("578");
    expect(mismatch.stderr).toContain("15");

    const wrong = runGenerator([
      "--input",
      FIXTURE,
      "--out",
      outPath("wrong-expect"),
      "--aliases",
      "none",
      "--expect-counts",
      "15/12/9/4/5"
    ]);
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toContain("gaps");
    // 参数形状错也硬错。
    const malformed = runGenerator([
      "--input",
      FIXTURE,
      "--out",
      outPath("malformed-expect"),
      "--aliases",
      "none",
      "--expect-counts",
      "15/12"
    ]);
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain("--expect-counts");
  });

  it("上游形状漂移必须吵：未知 option 类型 / 未知 effort 词 / 未知键", () => {
    const unknownType = writeVariant("drift-type", (api) => {
      api["zhipuai"].models["fx-glm"].reasoning_options = [{ type: "thinking_level", values: ["high"] }];
    });
    const unknownEffort = writeVariant("drift-effort", (api) => {
      api["zhipuai"].models["fx-glm"].reasoning_options = [{ type: "effort", values: ["ultra"] }];
    });
    const unknownKey = writeVariant("drift-key", (api) => {
      api["zhipuai"].models["fx-glm"].reasoning_options = [{ type: "budget_tokens", min: 1, max: 2, step: 3 }];
    });
    for (const [index, input] of [unknownType, unknownEffort, unknownKey].entries()) {
      const run = runGenerator([
        "--input",
        input,
        "--out",
        outPath(`drift-${index}`),
        "--aliases",
        "none",
        "--expect-counts",
        FIXTURE_COUNTS
      ]);
      expect(run.status, `漂移用例 ${index} 应当硬错`).not.toBe(0);
      expect(run.stderr).toContain("sync-models-dev-thinking");
    }
  });

  it("幂等：同一份输入跑两遍字节相同；contentHash 覆盖值集/指派/别名", () => {
    const first = generate("idem-a");
    const second = generate("idem-b");
    expect(second).toBe(first);
    const hashOf = (text: string) => text.match(/contentHash: "(sha256:[0-9a-f]{64})"/)?.[1];
    expect(hashOf(first)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashOf(second)).toBe(hashOf(first));

    // 映射模型改了 → hash 变（值集/指派随之变）。这里换成另一个已存在的 effort 组合，
    // 保持对账计数不变，只让值集与指派变。
    const changed = writeVariant("hash-changed", (api) => {
      api["zhipuai"].models["fx-glm"].reasoning_options = [{ type: "effort", values: ["low", "medium"] }];
    });
    const changedHash = hashOf(generate("idem-changed", changed));
    expect(changedHash).not.toBe(hashOf(first));

    // 12 家之外的 provider 改了 → hash 不变（产物只覆盖 12 家）。
    const unrelated = writeVariant("hash-unrelated", (api) => {
      api.openai.models["gpt-fixture-reasoning"].reasoning_options = [{ type: "toggle" }];
      api["new-unlisted"] = { models: { "new-model": { id: "new-model", reasoning: true } } };
    });
    expect(hashOf(generate("idem-unrelated", unrelated))).toBe(hashOf(first));
  });

  it("--report / --matrix：63 个缺口逐条可追，矩阵是逐 (provider, 模型, 档位空间) 的工件", () => {
    const out = outPath("report-out");
    const report = join(tmpRoot, "02-sync-report.txt");
    const matrix = join(tmpRoot, "02-valueset-matrix.tsv");
    const run = runGenerator([
      "--input",
      FIXTURE,
      "--out",
      out,
      "--aliases",
      "none",
      "--expect-counts",
      FIXTURE_COUNTS,
      "--report",
      report,
      "--matrix",
      matrix
    ]);
    expect(run.status).toBe(0);

    const reportText = readFileSync(report, "utf8");
    expect(reportText).toContain("contentHash: sha256:");
    expect(reportText).toContain("有词表 9 / 缺口 3");
    // 缺口逐条：3 个缺口（fx-go 借到 / Fx-AMD-Upper、fx-minimax 未知）。
    expect(reportText).toContain("缺口逐条");
    expect(reportText).toContain("opencode-go/fx-go ← canonical:xiaomi/fx-mimo");
    expect(reportText).toContain("amd/Fx-AMD-Upper  未知词表");
    expect(reportText).toContain("minimax-cn/fx-minimax  未知词表");
    // 别名表逐条理由进报告（可审）。
    expect(reportText).toContain("别名表");

    const matrixText = readFileSync(matrix, "utf8");
    const lines = matrixText.trimEnd().split("\n");
    // 表头 + 12 个 reasoning 模型（缺口也在，未知词表的档位空间留空）。
    expect(lines[0].split("\t")).toEqual([
      "provider",
      "modelId",
      "deprecated",
      "source",
      "valuesetId",
      "label",
      "toggle",
      "effort",
      "budgetMin",
      "budgetMax",
      "off"
    ]);
    expect(lines).toHaveLength(1 + 12);
    const rowOf = (prefix: string) => lines.find((line) => line.startsWith(`${prefix}\t`));
    expect(rowOf("deepseek\tfx-pdf-first")).toContain("\tdirect\t");
    expect(rowOf("deepseek\tfx-pdf-first")).toContain("true");
    expect(rowOf("opencode-go\tfx-go")).toContain("\tcanonical:xiaomi/fx-mimo\ttoggle\thybrid-switch");
    expect(rowOf("amd\tFx-AMD-Upper")).toContain("\tunknown\t\t\t\t\t\t");
    expect(rowOf("alibaba-cn\tfx-video")).toContain("\tb:-81920\talways-budget\tfalse\t\t\t81920\t");
  });
});

// ─────────────────────────── 接缝 B：提交进仓库的产物 ───────────────────────────

const GENERATED_MODULE = "extension/ai/catalog/models-dev-thinking.generated.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.(ts|js)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

// 静态边：import|export <clause> from "<相对路径>"（纯类型引入不计——构建后消失）。
// 与 tests/ai/models-dev-catalog.test.ts 同口径，注释先掐掉。
const STATIC_EDGE_RE = /(?:^|\n)[ \t]*(?:import|export)\s+([^;]*?)\s+from\s*["'](\.[^"']+)["']/g;
const BLOCK_COMMENT_RE = /^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm;
const TYPE_ONLY_CLAUSE_RE = /^\s*type\b|^\{\s*type\s/;

function staticImportersOf(fragment: string): string[] {
  const importers = new Set<string>();
  for (const file of walk("extension")) {
    const source = readFileSync(file, "utf8").replace(BLOCK_COMMENT_RE, "");
    for (const match of source.matchAll(STATIC_EDGE_RE)) {
      if (match[2].includes(fragment) && !TYPE_ONLY_CLAUSE_RE.test(match[1])) {
        importers.add(relative("extension", file).split(sep).join("/"));
      }
    }
  }
  return [...importers];
}

describe("思考事实产物（02）", () => {
  it("查表：精确命中 + 折叠大小写，未知模型 fail-closed 返回 null", () => {
    const pro = lookupThinkingFact("deepseek", "deepseek-v4-pro");
    expect(pro?.valuesetId).toBe("toggle+low-high-max");
    expect(pro?.toggle).toBe(true);
    expect(pro?.effort).toEqual(["low", "high", "max"]);
    expect(pro?.budget).toBeNull();
    expect(pro?.off).toBe("toggle");
    expect(pro?.label).toBe("hybrid-switch-effort");
    expect(pro?.deprecated).toBe(false);

    // 折叠大小写：上游 id 大小写混排（amd / minimax-cn / modelscope 都是），
    // 请求侧给什么大小写都要命中同一份事实。
    expect(lookupThinkingFact("minimax-cn", "minimax-m3")?.valuesetId).toBe(
      lookupThinkingFact("minimax-cn", "MiniMax-M3")?.valuesetId
    );
    expect(lookupThinkingFact("amd", "deepseek-v4.1-flash")?.effort).toEqual(
      lookupThinkingFact("amd", "DeepSeek-V4.1-Flash")?.effort
    );
    expect(lookupThinkingFact("modelscope", "zhipuai/glm-4.6")?.valuesetId).toBe(
      lookupThinkingFact("modelscope", "ZhipuAI/GLM-4.6")?.valuesetId
    );

    // 未知模型 / 未知 provider / 非字符串入参：一律 null（请求侧不发任何思考字段）。
    expect(lookupThinkingFact("deepseek", "no-such-model")).toBeNull();
    expect(lookupThinkingFact("no-such-provider", "deepseek-v4-pro")).toBeNull();
    expect(lookupThinkingFact("deepseek", "")).toBeNull();
    expect(lookupThinkingFact(undefined, "deepseek-v4-pro")).toBeNull();
    expect(lookupThinkingFact("deepseek", undefined)).toBeNull();
    // 大小写折叠不跨 provider：k3 是 kimi 的模型，拿 deepseek 查必须落空。
    expect(lookupThinkingFact("deepseek", "k3")).toBeNull();
  });

  it("别名表：显式、可审、逐条注明上游 id 与理由，且查表按别名命中", () => {
    // 票面点名的四条（kimi-k3 / step-3.7 / kimi-k2.6 / modelscope 的 ZhipuAI/ 前缀）。
    const required: [string, string, string][] = [
      ["kimi-code-plan-cn", "kimi-k3", "kimi-code-plan-cn/k3"],
      ["stepfun-step-plan", "step-3.7", "stepfun-step-plan/step-3.7-flash"],
      ["opencode-go", "kimi-k2.6", "moonshotai/kimi-k2.6"],
      ["modelscope", "GLM-4.6", "modelscope/ZhipuAI/GLM-4.6"]
    ];
    for (const [provider, localId, upstream] of required) {
      const alias = MODEL_ID_ALIASES.find((entry) => entry.provider === provider && entry.localId === localId);
      expect(alias, `缺别名：${provider}/${localId}`).toBeTruthy();
      expect(alias?.upstream, `别名 ${localId} 的上游 id`).toBe(upstream);
      // 逐条注明理由（可审）；指向的值集必须真实存在。
      expect((alias?.reason ?? "").length, `别名 ${localId} 缺理由`).toBeGreaterThan(10);
      expect(VALUESETS[alias!.valuesetId], `别名 ${localId} 的值集不存在`).toBeTruthy();
    }
    // 每一条都有理由 + 值集存在（不只是点名的那四条）。
    for (const alias of MODEL_ID_ALIASES) {
      expect(alias.upstream.includes("/"), `${alias.localId} 的 upstream 不是 "<provider>/<modelId>"`).toBe(true);
      expect(alias.reason.length).toBeGreaterThan(10);
      expect(VALUESETS[alias.valuesetId]).toBeTruthy();
    }

    // kimi-k3 → 上游 k3（canonical_model_id = moonshotai/kimi-k3）的同一份事实。
    expect(lookupThinkingFact("kimi-code-plan-cn", "kimi-k3")?.valuesetId).toBe(
      lookupThinkingFact("kimi-code-plan-cn", "k3")?.valuesetId
    );
    expect(lookupThinkingFact("kimi-code-plan-cn", "KIMI-K3")?.valuesetId).toBe(
      lookupThinkingFact("kimi-code-plan-cn", "k3")?.valuesetId
    );
    // step-3.7 → 上游 step-3.7-flash（上游没有 step-3.7 本身）。
    expect(lookupThinkingFact("stepfun-step-plan", "step-3.7")?.effort).toEqual(["low", "medium", "high"]);
    // opencode-go/kimi-k2.6 上游词表为空（deprecated + 空数组）→ 借原生 moonshotai 的
    // 同名模型（toggle）。
    expect(lookupThinkingFact("opencode-go", "kimi-k2.6")?.toggle).toBe(true);
    // modelscope 的 GLM-4.6 带命名空间前缀：裸 id 与上游 id 命中同一份事实。
    expect(lookupThinkingFact("modelscope", "GLM-4.6")?.valuesetId).toBe(
      lookupThinkingFact("modelscope", "ZhipuAI/GLM-4.6")?.valuesetId
    );
    // 别名不越 provider：kimi-k3 是 kimi-code-plan-cn 的别名，拿 sensenova 查不该借用它。
    expect(lookupThinkingFact("sensenova", "no-such-kimi")?.valuesetId ?? null).toBeNull();
  });

  it("352 个有词表模型全部有指派；63 个缺口逐条可追（借到了 / 标未知）", () => {
    const { counts } = UPSTREAM_THINKING_SOURCE;
    expect(counts).toEqual({
      models: 578,
      reasoning: 415,
      withOptions: 352,
      gaps: 63,
      // 63 个缺口里 7 个借到原生词表（6 条 canonical + 1 条别名），其余 56 个标未知。
      borrowed: 7,
      unknown: 56,
      effortSets: 30,
      valuesets: 50,
      deprecated: 9,
      aliases: 6
    });

    // 352 直接 + 7 借词 = 359 条指派，与指派表实际行数一致。
    const assignedRows = Object.values(ASSIGNMENTS).reduce(
      (total, rows) => total + Object.keys(rows).length,
      0
    );
    expect(assignedRows).toBe(counts.withOptions + counts.borrowed);
    expect(Object.values(ASSIGNMENTS).every((rows) => Object.keys(rows).length > 0)).toBe(true);
    // 未知词表的模型不进指派表（没有臆造档位）。
    expect(ASSIGNMENTS["amd"]?.["MiniCPM5-2B"]).toBeUndefined();
    expect(ASSIGNMENTS["minimax-cn"]?.["MiniMax-M2"]).toBeUndefined();
    expect(lookupThinkingFact("minimax-cn", "MiniMax-M2")).toBeNull();
    // 借词逐条：canonical 借词实证（spec §词汇覆盖缺口）——opencode-go 的 mimo-v2.6-pro
    // 借 xiaomi 的同名模型；alibaba-cn 的 glm-5.2 借 zhipuai。
    expect(ASSIGNMENTS["opencode-go"]?.["mimo-v2.6-pro"]).toBe(ASSIGNMENTS["xiaomi"]?.["mimo-v2.6-pro"]);
    expect(ASSIGNMENTS["alibaba-cn"]?.["glm-5.2"]).toBe(ASSIGNMENTS["zhipuai"]?.["glm-5.2"]);
  });

  it("deprecated 保留并标记：进表 + fact.deprecated，beta 不算", () => {
    // 上游 9 个 status: deprecated 的 reasoning 模型全部保留进表（不删）。
    expect(DEPRECATED_MODELS).toHaveLength(9);
    expect(DEPRECATED_MODELS).toContain("deepseek/deepseek-v4-flash");
    expect(DEPRECATED_MODELS).toContain("opencode-go/qwen3.7-max");
    for (const key of DEPRECATED_MODELS) {
      const slash = key.indexOf("/");
      const fact = lookupThinkingFact(key.slice(0, slash), key.slice(slash + 1));
      expect(fact, `${key} 应当可查（deprecated 不进表就不是"保留"）`).toBeTruthy();
      expect(fact?.deprecated, `${key} 的 deprecated 标记`).toBe(true);
    }
    // 非 deprecated：标记为 false（表里有但废弃 ≠ 表里没有）。
    expect(lookupThinkingFact("deepseek", "deepseek-v4-pro")?.deprecated).toBe(false);
    // status: beta 不是 deprecated（xiaomi 的 ultraspeed 变体）。
    expect(lookupThinkingFact("xiaomi", "mimo-v2.5-pro-ultraspeed")?.deprecated).toBe(false);
    expect(DEPRECATED_MODELS).not.toContain("xiaomi/mimo-v2.5-pro-ultraspeed");
    // 未知模型不是 deprecated（是 null）。
    expect(lookupThinkingFact("deepseek", "no-such-model")).toBeNull();
  });

  it("未知词表 fail-closed：查表 null，且请求路径不引用本产物（请求侧发不出参数）", () => {
    // 请求侧的「不发参」契约 = 查表返回 null（唯一入口）。适配器接线的产品语义是
    // 08 号票的事，本票只钉住事实层这一侧。
    expect(lookupThinkingFact("deepseek", "no-such-model")).toBeNull();
    expect(lookupThinkingFact("openrouter", "openrouter/auto")).toBeNull();
    expect(lookupThinkingFact("modelscope", "Qwen/Qwen3-235B-A22B-Thinking-2507")).toBeNull();

    // 红线：上游数据只在构建期被读，产物不进请求路径（provider-http → completion → adapters）。
    const requestPath = [
      "extension/core/provider-http.ts",
      "extension/ai/completion.ts",
      ...walk("extension/ai/adapters")
    ];
    for (const file of requestPath) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} 引用了思考事实产物`).not.toMatch(
        /models-dev-thinking|UPSTREAM_THINKING_SOURCE|lookupThinkingFact|models\.dev/
      );
    }
  });

  it("体积上限：值集表 + 指派表，远小于「把 578 条原始记录塞进来」", () => {
    const source = readFileSync(GENERATED_MODULE, "utf8");
    const bytes = new TextEncoder().encode(source).length;
    // 今日 thinking-profiles.ts 是 31,324 B（本产物 31,171 B，更小）；上限 32,768 B 留出
    // 上游漂移余量。反例尺度：pi-ai 目录产物 80,791 B / 435 模型（逐模型记录）；
    // 本产物是 50 条值集 + 359 条指派。
    expect(bytes).toBeLessThan(32768);
    expect(VALUESETS["toggle"]).toBeTruthy();
    expect(Object.keys(VALUESETS)).toHaveLength(UPSTREAM_THINKING_SOURCE.counts.valuesets);
  });

  it("叶子：产物零 import，extension 里还没有静态引用者，且 build.js 把它列为 SW 静态图禁区", () => {
    const source = readFileSync(GENERATED_MODULE, "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/^\s*export\s+[^;]*?\s+from\s/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    // 02 号票不接消费者（05/06 才用）：在那之前它必须不在任何静态图里。
    expect(staticImportersOf("models-dev-thinking.generated")).toEqual([]);

    // SW 静态图守卫（票面 §7）：scripts/build.js 的禁区清单必须点名本文件。
    const build = readFileSync("scripts/build.js", "utf8");
    const list = build.slice(build.indexOf("BACKGROUND_FORBIDDEN_STATIC_SOURCES"), build.indexOf("function assertBackgroundStaticGraphSlim"));
    expect(list).toContain("models-dev-thinking\\.generated\\.ts");
  });

  it("产物里没有生成/抓取时间戳（幂等硬要求）", () => {
    const source = readFileSync(GENERATED_MODULE, "utf8");
    expect(source).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(source).not.toMatch(/(generatedAt|capturedAt|fetchedAt|timestamp|Date\.now|new Date)/);
  });
});
