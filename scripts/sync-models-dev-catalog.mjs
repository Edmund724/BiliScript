// 构建期生成 UI 目录产物（工单 upstream-model-facts/01）。
//
// 抓 https://models.dev/api.json，裁剪成本仓需要的 12 个上游 provider，产出
// extension/ai/catalog/models-dev-catalog.generated.ts。产物是零 import 的叶子
// 模块，提交进仓库；构建只做打包，不在构建时现场生成（spec §产物形态）。
//
// 为什么直读源头而不是沿用 pi-ai 快照：`scripts/sync-pi-ai-catalog.mjs` 读的是
// devDependency @earendil-works/pi-ai 里那 39 个 JSON，而它们本身就是 pi-ai 发版
// 时从 models.dev 重新生成的快照 —— 等于隔了两层转发（spec §背景）。本脚本直连
// models.dev，所以「上游变了」这件事在本仓只剩一次转发（对账常量 + contentHash）。
//
// 与 pi-ai 脚本一致的三条纪律：
//   1. 字段白名单口径固定，裁剪掉线格式/价格类第二事实源（reasoning_options /
//      tool_call / cost / canonical_model_id … 是 02/09/10 号票的事）；
//   2. 生成期对账：模型总数不是常量就 fail（上游漂移必须吵，不能悄悄换一份产物）；
//   3. 重跑幂等：产物里没有生成/抓取时间戳，同一份上游数据两次输出字节相同。
//
// 用法：
//   pnpm catalog:sync:upstream
//   node scripts/sync-models-dev-catalog.mjs \
//     [--input <path|url>] [--out <path>] [--expect-models <n>] [--report <path>]
//
//   --input          读本地 api.json 快照（默认直连 https://models.dev/api.json）。
//                    给离线跑、测试 fixture 与「同一份数据两次比对」用。
//   --out            产物落点（默认 extension/ai/catalog/models-dev-catalog.generated.ts）。
//   --expect-models  覆盖对账常量；只给 fixture 用，生产不许改（改了等于关掉对账）。
//   --report         另把本次 sync 的摘要写成文件（抓取时间只允许出现在这里，
//                    绝不进产物）。

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SOURCE, UPSTREAM_PROVIDERS } from "./models-dev-upstream-providers.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_FILE = "extension/ai/catalog/models-dev-catalog.generated.ts";

// preset → 上游 provider 的单源在 extension/core/presets.ts 的 PRESETS[].catalogProvider
// （10 号票起）：本脚本经 scripts/models-dev-upstream-providers.mjs 读取它（该模块按
// presets.ts 源码取值并校验完整性），不再自持映射列表；02 号票的思考事实产物共用同一
// 份投影，两份产物对「12 家是谁」因此是同一口径（新增 preset 漏配即脚本报错）。

// 产物字段白名单（顺序 = 每行字段序）与上游字段的对应关系（spec §范围 3）。
const KEEP_FIELDS = ["id", "name", "reasoning", "input", "contextWindow", "maxTokens"];

// 12 家合计模型总数（spec §preset → 上游 provider：「12 家共 578 个模型」）。
// 生成期对账：不是这个数说明上游内容或路径变了 —— 先确认 pin（上游 api.json 无
// 版本号，只有 contentHash）与 spec 记录，再同步本常量、spec 与
// tests/ai/models-dev-catalog.test.ts 的期望值。
const EXPECTED_MODEL_COUNT = 578;

function fail(message) {
  console.error(`sync-models-dev-catalog: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    input: DEFAULT_SOURCE,
    out: MODULE_FILE,
    report: null,
    expectModels: EXPECTED_MODEL_COUNT
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--input" || flag === "--out" || flag === "--report" || flag === "--expect-models") {
      if (value === undefined) fail(`${flag} 缺参数值`);
      i += 1;
      if (flag === "--input") options.input = value;
      else if (flag === "--out") options.out = value;
      else if (flag === "--report") options.report = value;
      else {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) fail(`--expect-models 需要正整数，收到 "${value}"`);
        options.expectModels = parsed;
      }
      continue;
    }
    fail(
      `未知参数 "${flag}"。用法：--input <path|url> --out <path> --expect-models <n> --report <path>`
    );
  }
  return options;
}

async function readSnapshot(input) {
  if (/^https?:\/\//.test(input)) {
    let response;
    try {
      response = await fetch(input);
    } catch (error) {
      fail(`抓取 ${input} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      fail(`抓取 ${input} 失败：HTTP ${response.status} ${response.statusText}`);
    }
    return { text: await response.text(), fetched: true };
  }
  if (!fs.existsSync(input)) {
    fail(`输入快照不存在：${input}`);
  }
  return { text: fs.readFileSync(input, "utf8"), fetched: false };
}

// 一个模型的 6 个白名单字段。缺任何一项都 fail —— 静默写 undefined / NaN 才是要
// 避免的失败方式（上游字段一旦改名，产物必须立刻吵，而不是变成半张表）。
function pickModel(upstreamId, modelId, model) {
  if (!model || typeof model !== "object") {
    fail(`${upstreamId}/${modelId}: 上游模型不是对象`);
  }
  if (model.id !== modelId) {
    fail(
      `${upstreamId}/${modelId}: 模型自带 id 与它的键不一致（${JSON.stringify(model.id)}），` +
        `产物以键为查表键，需重新审议。`
    );
  }
  if (typeof model.name !== "string" || model.name.length === 0) {
    fail(`${upstreamId}/${modelId}: 上游缺 name，产物字段口径需复核。`);
  }
  if (typeof model.reasoning !== "boolean") {
    fail(`${upstreamId}/${modelId}: 上游缺 reasoning，产物字段口径需复核。`);
  }
  const input = model.modalities && model.modalities.input;
  if (!Array.isArray(input) || input.length === 0 || input.some((item) => typeof item !== "string" || item.length === 0)) {
    fail(`${upstreamId}/${modelId}: 上游缺 modalities.input，产物字段口径需复核。`);
  }
  for (const [field, value] of [
    ["limit.context", model.limit && model.limit.context],
    ["limit.output", model.limit && model.limit.output]
  ]) {
    if (!Number.isInteger(value) || value <= 0) {
      fail(`${upstreamId}/${modelId}: 上游缺 ${field}（收到 ${JSON.stringify(value)}），产物字段口径需复核。`);
    }
  }
  return {
    id: modelId,
    name: model.name,
    reasoning: model.reasoning,
    input: [...input],
    contextWindow: model.limit.context,
    maxTokens: model.limit.output
  };
}

// 裁剪：只取映射表里的 12 家，逐家校验存在 / 非空 / doc 非空，再逐模型走白名单。
function cropCatalog(api) {
  const upstreams = UPSTREAM_PROVIDERS.map(({ preset, id }) => {
    const provider = api[id];
    if (!provider || typeof provider !== "object") {
      fail(`快照里没有上游 provider "${id}"（preset ${preset}）。上游改了 provider id？先核对 spec 的映射表。`);
    }
    if (typeof provider.doc !== "string" || provider.doc.length === 0) {
      fail(`上游 provider "${id}" 的 doc 为空，产物溯源信息失效。`);
    }
    const upstreamModels = provider.models;
    if (!upstreamModels || typeof upstreamModels !== "object" || Object.keys(upstreamModels).length === 0) {
      fail(`上游 provider "${id}" 的 models 为空，产物会是空目录。`);
    }
    const models = {};
    for (const [modelId, model] of Object.entries(upstreamModels)) {
      models[modelId] = pickModel(id, modelId, model);
    }
    return { id, doc: provider.doc, models };
  });
  return upstreams;
}

// contentHash 只覆盖「裁剪后的 12 家子集」：api.json 里另有 200+ provider，
// 它们变了与本仓目录无关，不该让本仓报漂移（spec §范围 4）。
function hashCatalog(upstreams) {
  return createHash("sha256").update(JSON.stringify(upstreams), "utf8").digest("hex");
}

function emitModel(model) {
  const parts = [
    `id: ${JSON.stringify(model.id)}`,
    `name: ${JSON.stringify(model.name)}`,
    `reasoning: ${model.reasoning ? "true" : "false"}`,
    `input: [${model.input.map((item) => JSON.stringify(item)).join(", ")}]`,
    `contextWindow: ${model.contextWindow}`,
    `maxTokens: ${model.maxTokens}`
  ];
  return `{ ${parts.join(", ")} }`;
}

function renderModule({ source, contentHash, upstreams, totalModels }) {
  const blocks = upstreams.map(({ id, models }) => {
    const rows = Object.entries(models).map(
      ([modelId, model]) => `    ${JSON.stringify(modelId)}: ${emitModel(model)},`
    );
    return `  ${JSON.stringify(id)}: {\n${rows.join("\n")}\n  },`;
  });
  const sourceRows = upstreams.map(
    ({ id, doc, models }) =>
      `    { id: ${JSON.stringify(id)}, doc: ${JSON.stringify(doc)}, models: ${Object.keys(models).length} },`
  );

  const header = `// ${MODULE_FILE} — 生成产物，勿手改。
//
// 来源：${source}（构建期抓取；上游没有版本号，溯源靠下面的 source + contentHash）
// 生成：pnpm catalog:sync:upstream（scripts/sync-models-dev-catalog.mjs）
// 口径：${upstreams.length} 个上游 provider / ${totalModels} 个模型，每个模型只保留
//       ${KEEP_FIELDS.join(" / ")}（input ← modalities.input，逐字照搬全部取值）。
//
// 刻意不带的字段（01 号票非目标，留给 02/09/10 号票）：reasoning_options /
// tool_call / interleaved / canonical_model_id / cost / release_date /
// last_updated / status / description / family / attachment / structured_output /
// temperature / knowledge / open_weights / modalities.output；上游 provider 的
// env / npm / api / name 也不带 —— 线格式方言由本仓平台层持有（spec 决策 4）。
//
// 叶子纪律：本模块零 import（静态/动态都没有），只导出纯数据与一个纯查表函数，
// 对齐 ai/protocol-vocab.ts「词表叶不拖入协议栈」。消费方只准经 UI 侧懒加载入口
// 动态 import，不得进 SW 静态图（scripts/build.js 的 assertBackgroundStaticGraphSlim）。
//
// 产物是提交进仓库的构建期数据：同一份上游数据重跑幂等（git diff 为空），所以这里
// 没有生成/抓取时间戳 —— 抓取时间只出现在 --report 写的报告文件里。上游数据只在
// 构建期被读；请求路径（provider-http → completion → adapters）绝不引用本模块。
`;

  return `${header}
export interface CatalogModelMeta {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: readonly string[];
  readonly contextWindow: number;
  readonly maxTokens: number;
}

// 数据版本（UI 的 title 展示用）：contentHash = 下面 12 家子集数据的 sha256，
// 不含 api.json 里其余 provider；据此判断「上游这份目录是否还是同一份」。
export const UPSTREAM_CATALOG_SOURCE = {
  source: ${JSON.stringify(source)},
  contentHash: "sha256:${contentHash}",
  upstreams: [
${sourceRows.join("\n")}
  ]
} as const;

export const UPSTREAM_CATALOG: Readonly<Record<string, Readonly<Record<string, CatalogModelMeta>>>> = {
${blocks.join("\n")}
};

// 查表：键是 (upstreamId, modelId)——preset 到 upstreamId 的映射留在调用侧
// （10 号票搬进 presets.ts）。精确匹配、不做大小写折叠；查不到返回 null，
// 不抛错、不回落猜测值。
export function lookupUpstreamModelMeta(upstreamId: unknown, modelId: unknown): CatalogModelMeta | null {
  if (typeof upstreamId !== "string" || typeof modelId !== "string") {
    return null;
  }
  const table = UPSTREAM_CATALOG[upstreamId];
  if (!table) {
    return null;
  }
  return table[modelId] ?? null;
}
`;
}

function summaryLines({ source, input, contentHash, upstreams, totalModels, bytes }) {
  const lines = [
    `sync-models-dev-catalog: ${upstreams.length} 个上游 provider / ${totalModels} 个模型 / ${bytes} B`,
    `  source: ${source}`,
    `  input: ${input}`,
    `  contentHash: sha256:${contentHash}`
  ];
  for (const { id, models } of upstreams) {
    lines.push(`  ${id}: ${Object.keys(models).length}`);
  }
  return lines;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { text, fetched } = await readSnapshot(options.input);

  let api;
  try {
    api = JSON.parse(text);
  } catch (error) {
    fail(`输入不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!api || typeof api !== "object" || Array.isArray(api)) {
    fail(`输入顶层不是 provider 表（${options.input}）。`);
  }

  const upstreams = cropCatalog(api);
  const totalModels = upstreams.reduce((sum, upstream) => sum + Object.keys(upstream.models).length, 0);
  if (totalModels !== options.expectModels) {
    fail(
      `模型总数为 ${totalModels}，对账常量是 ${options.expectModels}。` +
        `上游内容或路径变了 —— 先确认上游这份快照（contentHash）与 spec 记录，` +
        `再同步脚本常量、spec 与 tests/ai/models-dev-catalog.test.ts 的期望值。`
    );
  }

  const contentHash = hashCatalog(upstreams);
  const output = renderModule({
    source: DEFAULT_SOURCE,
    contentHash,
    upstreams,
    totalModels
  });
  const outputPath = path.resolve(rootDir, options.out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output);

  const bytes = Buffer.byteLength(output);
  const lines = summaryLines({
    source: DEFAULT_SOURCE,
    input: options.input,
    contentHash,
    upstreams,
    totalModels,
    bytes
  });
  console.log(lines.join("\n"));

  if (options.report) {
    // 报告文件是**唯一**允许出现抓取时间的地方（产物必须幂等）。
    const reportPath = path.resolve(rootDir, options.report);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const capturedAt = new Date().toISOString();
    fs.writeFileSync(
      reportPath,
      `${lines.join("\n")}\n  capturedAt: ${capturedAt}${fetched ? " (fetched)" : " (local input)"}\n`
    );
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
