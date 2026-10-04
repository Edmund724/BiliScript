// tests/ai/models-dev-catalog.test.ts
// 票据 01（upstream-model-facts/01）：构建期 models.dev 快照与 UI 目录产物。
//
// 两条接缝（seam）：
//   A. 生成脚本 scripts/sync-models-dev-catalog.mjs 的 CLI —— 产物只能由它产出。
//      测试用 --input 喂本地 fixture（不打网络）、--out/--report 写临时目录，
//      观察面 = 退出码 + stdout/stderr + 写出的产物字节。
//   B. 提交进仓库的产物模块 extension/ai/catalog/models-dev-catalog.generated.ts
//      的导出（UPSTREAM_CATALOG_SOURCE / UPSTREAM_CATALOG / lookupUpstreamModelMeta）。
//
// 先列系统可能失败的方式（每条都有对应用例）：
//   1. 某个映射上游在快照里缺失 / 为空 → 静默产出「12 家变 11 家」的产物；
//   2. 某个模型缺 name / modalities.input / limit.context / limit.output →
//      产物里出现 undefined 或 NaN；
//   3. 某上游 doc 为空 → 产物溯源信息失效；
//   4. 模型总数与对账常量不符（上游漂移）→ 悄悄重新生成一份漂移产物；
//   5. 产物带生成/抓取时间戳或键序不稳 → 每次重跑 git diff 非空（幂等破裂）；
//   6. contentHash 覆盖 api.json 全集而非 12 家子集 → 无关 provider 变动也报漂移；
//   7. 产物长出 import（静态/动态）→ 破坏零依赖叶子、可能被拖进某条图；
//   8. 上游数据进请求路径（provider-http / completion / adapters）→ 破红线。

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  UPSTREAM_CATALOG,
  UPSTREAM_CATALOG_SOURCE,
  lookupUpstreamModelMeta
} from "../../extension/ai/catalog/models-dev-catalog.generated.js";

const SCRIPT = "scripts/sync-models-dev-catalog.mjs";
const FIXTURE = "tests/fixtures/models-dev/sample-api.json";
// fixture 里 12 家映射上游的模型数之和（手数：2+2+1+1+1+1+2+1+1+1+1+1）。
// 与真产物对账用的远端常量 578 互不相干——这是「对账逻辑本身」的独立期望值。
const FIXTURE_MODEL_TOTAL = 15;

const tmpRoot = mkdtempSync(join(tmpdir(), "models-dev-catalog-"));

interface FixtureProvider {
  doc?: string;
  models: Record<string, Record<string, unknown>>;
}
type FixtureApi = Record<string, FixtureProvider>;

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

// 变体 fixture：在 commit 的 sample-api.json 上做定向改动，写到临时目录。
function writeVariant(name: string, mutate: (api: FixtureApi) => void): string {
  const api = JSON.parse(readFileSync(FIXTURE, "utf8")) as FixtureApi;
  mutate(api);
  const file = join(tmpRoot, `${name}.json`);
  writeFileSync(file, JSON.stringify(api));
  return file;
}

function outPath(name: string): string {
  return join(tmpRoot, `${name}.generated.ts`);
}

// 同一份 fixture + 同一个对账常量跑一次，返回产物文本。
function generate(name: string, input: string = FIXTURE, extra: string[] = []): string {
  const out = outPath(name);
  const run = runGenerator(["--input", input, "--out", out, ...extra]);
  expect(run.stderr, `生成失败：${run.stderr}`).toBe("");
  expect(run.status).toBe(0);
  return readFileSync(out, "utf8");
}

// 产品正文（生成器文件头注释之下）——注释里会点名「刻意不带的字段」，
// 直接对整个文件做 toContain 会被注释误伤。
function bodyOf(moduleText: string): string {
  const marker = moduleText.indexOf("export const UPSTREAM_CATALOG_SOURCE");
  expect(marker, "产物里没有 UPSTREAM_CATALOG_SOURCE").toBeGreaterThan(-1);
  return moduleText.slice(marker);
}

function contentHashOf(moduleText: string): string {
  const match = moduleText.match(/contentHash: "(sha256:[0-9a-f]{64})"/);
  expect(match, "产物里没有 sha256 contentHash").toBeTruthy();
  return match![1];
}

afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Windows 上偶发句柄未释放：临时目录残留不影响断言。
  }
});

describe("models.dev 目录生成器 CLI（01）", () => {
  it("产物形状与字段口径：12 家映射上游 + 每模型 6 个白名单字段，input 逐字照搬", () => {
    const text = generate("shape", FIXTURE, ["--expect-models", String(FIXTURE_MODEL_TOTAL)]);
    const body = bodyOf(text);

    // 逐家一行：id / doc（非空，逐字来自快照）/ 模型数。顺序 = 脚本里的映射表顺序。
    const expectedUpstreams = [
      `    { id: "deepseek", doc: "https://api-docs.deepseek.com/quick_start/pricing", models: 2 },`,
      `    { id: "alibaba-cn", doc: "https://www.alibabacloud.com/help/en/model-studio/models", models: 2 },`,
      `    { id: "zhipuai", doc: "https://docs.z.ai/guides/overview/pricing", models: 1 },`,
      `    { id: "kimi-code-plan-cn", doc: "https://www.kimi.com/code/docs/en/kimi-code/models.html", models: 1 },`,
      `    { id: "xiaomi", doc: "https://platform.xiaomimimo.com/#/docs", models: 1 },`,
      `    { id: "opencode-go", doc: "https://opencode.ai/docs/go", models: 1 },`,
      `    { id: "openrouter", doc: "https://openrouter.ai/models", models: 2 },`,
      `    { id: "stepfun-step-plan", doc: "https://platform.stepfun.com/docs/zh/step-plan/integrations/reasoning-api", models: 1 },`,
      `    { id: "modelscope", doc: "https://modelscope.cn/docs/model-service/API-Inference/intro", models: 1 },`,
      `    { id: "amd", doc: "https://developer.amd.com.cn/radeon/tokenfactory", models: 1 },`,
      `    { id: "sensenova", doc: "https://platform.sensenova.cn/docs", models: 1 },`,
      `    { id: "minimax-cn", doc: "https://platform.minimaxi.com/docs/guides/quickstart", models: 1 }`
    ];
    for (const line of expectedUpstreams) {
      expect(body, `缺上游行：${line}`).toContain(line);
    }

    // 逐模型行：6 个字段、字段序固定、input 数组逐字照搬（含 pdf/video/audio 与
    // 非 text 开头的顺序也不裁剪、不重排）。
    expect(body).toContain(
      `    "fx-pdf-first": { id: "fx-pdf-first", name: "Fixture PDF First", reasoning: true, input: ["pdf", "image", "text"], contextWindow: 200000, maxTokens: 8192 },`
    );
    expect(body).toContain(
      `    "fx-plain": { id: "fx-plain", name: "Fixture Plain", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 },`
    );
    expect(body).toContain(
      `    "fx-router-a": { id: "fx-router-a", name: "Fixture Router A", reasoning: true, input: ["text", "image", "video", "audio", "pdf"], contextWindow: 1000000, maxTokens: 2000000 },`
    );
    // id 里的 / 与 :、name 里的引号都按 JSON 转义，键与自带 id 同值。
    expect(body).toContain(
      `    "vendor/fx-model:v2": { id: "vendor/fx-model:v2", name: "Fixture Vendor Model V2", reasoning: false, input: ["image", "text"], contextWindow: 262144, maxTokens: 32768 },`
    );
    expect(body).toContain(
      `    "ZhipuAI/fx-quoted": { id: "ZhipuAI/fx-quoted", name: "Fixture \\"Quoted\\" Model", reasoning: true, input: ["text", "image", "pdf"], contextWindow: 200000, maxTokens: 32768 },`
    );

    // 裁剪：白名单之外的字段与未映射 provider 一律不进产物。
    for (const dropped of [
      "reasoning_options",
      "tool_call",
      "canonical_model_id",
      "release_date",
      "last_updated",
      "open_weights",
      "description",
      "cost",
      '"env"',
      '"npm"'
    ]) {
      expect(body, `产物漏带裁剪字段 ${dropped}`).not.toContain(dropped);
    }
    expect(body).not.toContain("gpt-fixture-plain");
    expect(body).not.toContain("sonar-fixture");
    expect(body).not.toContain("perplexity-agent");
  });

  it("幂等：同一份输入跑两遍字节相同，且产物里没有时间戳", () => {
    const first = generate("idem-a", FIXTURE, ["--expect-models", String(FIXTURE_MODEL_TOTAL)]);
    const second = generate("idem-b", FIXTURE, ["--expect-models", String(FIXTURE_MODEL_TOTAL)]);
    expect(second).toBe(first);

    // 时间戳（ISO 日期时间 / 中文日期 / 常见字段名）会让重跑 git diff 非空。
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(first).not.toMatch(/(generatedAt|capturedAt|fetchedAt|timestamp|Date\.now|new Date)/);
  });

  it("contentHash 只覆盖 12 家子集：未映射 provider 变了 hash 不变，映射 provider 变了 hash 变", () => {
    const base = generate("hash-base", FIXTURE, ["--expect-models", String(FIXTURE_MODEL_TOTAL)]);
    // 未映射 provider 的模型改名 + 新增一个未映射 provider：子集没动。
    const unrelated = writeVariant("hash-unrelated", (api) => {
      api.openai.models["gpt-fixture-plain"].name = "GPT Fixture Renamed";
      api["perplexity-agent"].models["sonar-fixture"].limit = { context: 1, output: 1 };
      api["new-unlisted"] = {
        doc: "https://example.com/new",
        models: { "new-model": { name: "New", reasoning: false } }
      };
    });
    // 映射 provider（deepseek）的模型改名：子集动了。
    const related = writeVariant("hash-related", (api) => {
      api.deepseek.models["fx-plain"].name = "Fixture Plain Renamed";
    });

    const unrelatedHash = contentHashOf(
      generate("hash-unrelated-out", unrelated, ["--expect-models", String(FIXTURE_MODEL_TOTAL)])
    );
    const relatedHash = contentHashOf(
      generate("hash-related-out", related, ["--expect-models", String(FIXTURE_MODEL_TOTAL)])
    );

    expect(unrelatedHash).toBe(contentHashOf(base));
    expect(relatedHash).not.toBe(contentHashOf(base));
  });

  it("对账：默认常量是 578，且每个映射上游必须存在、非空、带非空 doc", () => {
    // 不带 --expect-models 时按脚本里的对账常量（578）判，fixture 只有 15 个 → 必红。
    const mismatch = runGenerator(["--input", FIXTURE, "--out", outPath("default-expect")]);
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain("578");
    expect(mismatch.stderr).toContain("15");

    const wrong = runGenerator([
      "--input",
      FIXTURE,
      "--out",
      outPath("wrong-expect"),
      "--expect-models",
      String(FIXTURE_MODEL_TOTAL + 1)
    ]);
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toContain(String(FIXTURE_MODEL_TOTAL));

    const missingProvider = writeVariant("missing-provider", (api) => {
      delete api.amd;
    });
    const missing = runGenerator([
      "--input",
      missingProvider,
      "--out",
      outPath("missing-provider-out"),
      "--expect-models",
      String(FIXTURE_MODEL_TOTAL)
    ]);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("amd");

    const emptyProvider = writeVariant("empty-provider", (api) => {
      api.amd.models = {};
    });
    const empty = runGenerator([
      "--input",
      emptyProvider,
      "--out",
      outPath("empty-provider-out"),
      "--expect-models",
      String(FIXTURE_MODEL_TOTAL)
    ]);
    expect(empty.status).not.toBe(0);
    expect(empty.stderr).toContain("amd");

    const emptyDoc = writeVariant("empty-doc", (api) => {
      api.amd.doc = "";
    });
    const noDoc = runGenerator([
      "--input",
      emptyDoc,
      "--out",
      outPath("empty-doc-out"),
      "--expect-models",
      String(FIXTURE_MODEL_TOTAL)
    ]);
    expect(noDoc.status).not.toBe(0);
    expect(noDoc.stderr).toContain("doc");
  });

  it("缺字段 / 读不到输入 → 非零退出，且不写出半成品产物", () => {
    const missingOutput = writeVariant("missing-output", (api) => {
      delete api.deepseek.models["fx-plain"].limit;
    });
    const noOutputPath = outPath("missing-output-out");
    const missingOutputRun = runGenerator([
      "--input",
      missingOutput,
      "--out",
      noOutputPath,
      "--expect-models",
      String(FIXTURE_MODEL_TOTAL)
    ]);
    expect(missingOutputRun.status).not.toBe(0);
    expect(missingOutputRun.stderr).toContain("fx-plain");
    expect(existsSync(noOutputPath)).toBe(false);

    const badInputPath = outPath("bad-input-out");
    const missingInput = runGenerator([
      "--input",
      join(tmpRoot, "no-such-snapshot.json"),
      "--out",
      badInputPath
    ]);
    expect(missingInput.status).not.toBe(0);
    expect(missingInput.stderr).toContain("no-such-snapshot.json");
    expect(existsSync(badInputPath)).toBe(false);
  });

  it("--report：把本次 sync 的摘要（contentHash + 逐家模型数 + 字节数）写成文件", () => {
    const out = outPath("report-out");
    const report = join(tmpRoot, "01-sync-report.txt");
    const run = runGenerator([
      "--input",
      FIXTURE,
      "--out",
      out,
      "--report",
      report,
      "--expect-models",
      String(FIXTURE_MODEL_TOTAL)
    ]);
    expect(run.status).toBe(0);
    const text = readFileSync(report, "utf8");
    expect(text).toContain(contentHashOf(readFileSync(out, "utf8")));
    expect(text).toContain("deepseek: 2");
    expect(text).toContain("openrouter: 2");
    expect(text).toContain("source: https://models.dev/api.json");
    // 报告之外不得出现抓取时间——stdout 摘要里没有时间戳。
    expect(run.stdout).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

// ─────────────────────────── 接缝 B：提交进仓库的产物 ───────────────────────────

const GENERATED_MODULE = "extension/ai/catalog/models-dev-catalog.generated.ts";

// spec §preset → 上游 provider 的 12 家与逐家模型数（本会话对
// https://models.dev/api.json 实测，5,317,334 B / 226 个 provider）。
// 这是产物的独立期望值：产物与上游一致时必然相等，不等即「上游漂移了」或
// 「产物被手改过」——先确认 spec 记录与脚本常量，再同步本表。
const UPSTREAM_IDS = [
  "deepseek",
  "alibaba-cn",
  "zhipuai",
  "kimi-code-plan-cn",
  "xiaomi",
  "opencode-go",
  "openrouter",
  "stepfun-step-plan",
  "modelscope",
  "amd",
  "sensenova",
  "minimax-cn"
];
const UPSTREAM_MODEL_COUNTS: Record<string, number> = {
  deepseek: 4,
  "alibaba-cn": 91,
  zhipuai: 17,
  "kimi-code-plan-cn": 4,
  xiaomi: 9,
  "opencode-go": 33,
  openrouter: 390,
  "stepfun-step-plan": 5,
  modelscope: 7,
  amd: 6,
  sensenova: 5,
  "minimax-cn": 7
};
const EXPECTED_MODEL_COUNT = 578;

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
// 与 tests/ai/model-catalog.test.ts 同口径，注释先掐掉。
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

describe("models.dev 目录产物（01）", () => {
  it("12 家上游 / 578 个模型，逐家计数与实测一致", () => {
    expect(Object.keys(UPSTREAM_CATALOG)).toEqual(UPSTREAM_IDS);
    const counts = Object.fromEntries(
      Object.entries(UPSTREAM_CATALOG).map(([id, models]) => [id, Object.keys(models).length])
    );
    expect(counts).toEqual(UPSTREAM_MODEL_COUNTS);

    const total = Object.values(UPSTREAM_CATALOG).reduce(
      (sum, models) => sum + Object.keys(models).length,
      0
    );
    expect(total).toBe(EXPECTED_MODEL_COUNT);
    expect(UPSTREAM_CATALOG_SOURCE.upstreams.map((upstream) => upstream.id)).toEqual(UPSTREAM_IDS);
    expect(UPSTREAM_CATALOG_SOURCE.upstreams.map((upstream) => upstream.models)).toEqual(
      UPSTREAM_IDS.map((id) => UPSTREAM_MODEL_COUNTS[id])
    );
  });

  it("UPSTREAM_CATALOG_SOURCE：源头 URL + sha256 内容哈希 + 逐家非空 doc", () => {
    expect(UPSTREAM_CATALOG_SOURCE.source).toBe("https://models.dev/api.json");
    expect(UPSTREAM_CATALOG_SOURCE.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const upstream of UPSTREAM_CATALOG_SOURCE.upstreams) {
      expect(upstream.doc, `${upstream.id} 的 doc 为空`).toMatch(/^https:\/\/\S+$/);
    }
    // 人工裁定的那家（本仓 api.minimaxi.com/v1 ↔ 上游 minimax-cn）逐字记上游 doc
    const minimax = UPSTREAM_CATALOG_SOURCE.upstreams.find((upstream) => upstream.id === "minimax-cn");
    expect(minimax?.doc).toBe("https://platform.minimaxi.com/docs/guides/quickstart");
  });

  it("每个模型只带 6 个白名单字段，id 与键同值，模态取值不被裁剪", () => {
    const vocabulary = new Set<string>();
    for (const [upstreamId, models] of Object.entries(UPSTREAM_CATALOG)) {
      for (const [modelId, model] of Object.entries(models)) {
        const where = `${upstreamId}/${modelId}`;
        expect(Object.keys(model).sort(), where).toEqual(
          ["contextWindow", "id", "input", "maxTokens", "name", "reasoning"].sort()
        );
        expect(model.id, where).toBe(modelId);
        expect(typeof model.name === "string" && model.name.length > 0, where).toBe(true);
        expect(typeof model.reasoning, where).toBe("boolean");
        expect(Number.isInteger(model.contextWindow) && model.contextWindow > 0, where).toBe(true);
        expect(Number.isInteger(model.maxTokens) && model.maxTokens > 0, where).toBe(true);
        expect(model.input.length, where).toBeGreaterThan(0);
        for (const modality of model.input) {
          expect(typeof modality === "string" && modality.length > 0, where).toBe(true);
          vocabulary.add(modality);
        }
      }
    }
    // 上游 12 家的 modalities.input 全部取值集合：pdf/video/audio 逐字照搬，
    // 展示口径的裁剪是 09/10 号票的事（本票不许裁）。
    expect([...vocabulary].sort()).toEqual(["audio", "image", "pdf", "text", "video"]);

    // 逐字抽检（期望值来自本会话对上游快照的直接读取）。
    expect(UPSTREAM_CATALOG["deepseek"]["deepseek-v4-pro"]).toEqual({
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      reasoning: true,
      input: ["text"],
      contextWindow: 1000000,
      maxTokens: 393216
    });
    expect(UPSTREAM_CATALOG["kimi-code-plan-cn"]["k3"].input).toEqual(["text", "image", "video"]);
    // id 形态保真：大小写混排 + 前缀 + `/`，且 name 与 id 不同值
    expect(UPSTREAM_CATALOG["modelscope"]["ZhipuAI/GLM-4.6"]).toEqual({
      id: "ZhipuAI/GLM-4.6",
      name: "GLM-4.6",
      reasoning: true,
      input: ["text"],
      contextWindow: 202752,
      maxTokens: 98304
    });
    expect(UPSTREAM_CATALOG["minimax-cn"]["MiniMax-M2"]).toEqual({
      id: "MiniMax-M2",
      name: "MiniMax-M2",
      reasoning: true,
      input: ["text"],
      contextWindow: 204800,
      maxTokens: 131072
    });
  });

  it("查表：键 = (upstreamId, modelId)，精确匹配、不折叠大小写、未命中返回 null", () => {
    expect(lookupUpstreamModelMeta("deepseek", "deepseek-v4-pro")?.maxTokens).toBe(393216);
    expect(lookupUpstreamModelMeta("kimi-code-plan-cn", "k3")?.contextWindow).toBe(1048576);
    expect(lookupUpstreamModelMeta("no-such-upstream", "k3")).toBeNull();
    // k3 是 kimi 的模型，拿 deepseek 查应当落空（键含 upstream）
    expect(lookupUpstreamModelMeta("deepseek", "k3")).toBeNull();
    // 不做大小写折叠：id 形态由上游决定
    expect(lookupUpstreamModelMeta("kimi-code-plan-cn", "K3")).toBeNull();
    expect(lookupUpstreamModelMeta(undefined, "k3")).toBeNull();
    expect(lookupUpstreamModelMeta("kimi-code-plan-cn", undefined)).toBeNull();
  });

  it("叶子：产物零 import，唯一的静态引用者是 UI 目录域模块", () => {
    const source = readFileSync(GENERATED_MODULE, "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/^\s*export\s+[^;]*?\s+from\s/m);
    expect(source).not.toMatch(/\bimport\s*\(/);
    // 10 号票把 UI 目录切到这份产物：唯一消费者是 ai/model-catalog.ts（它自己只能被
    // ui/lazy-model-catalog.ts 动态 import，且已在 build.js 的 SW 静态图禁区清单里）。
    expect(staticImportersOf("models-dev-catalog.generated")).toEqual(["ai/model-catalog.ts"]);
  });

  it("红线：请求路径不引用上游目录产物（构建期数据不进请求链）", () => {
    const requestPath = [
      "extension/core/provider-http.ts",
      "extension/ai/completion.ts",
      ...walk("extension/ai/adapters")
    ];
    for (const file of requestPath) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} 引用了 models.dev 目录产物`).not.toMatch(
        /models-dev-catalog|UPSTREAM_CATALOG|lookupUpstreamModelMeta|models\.dev/
      );
    }
  });

  it("产物里没有生成/抓取时间戳（幂等硬要求）", () => {
    const source = readFileSync(GENERATED_MODULE, "utf8");
    expect(source).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(source).not.toMatch(/(generatedAt|capturedAt|fetchedAt|timestamp|Date\.now|new Date)/);
  });
});
