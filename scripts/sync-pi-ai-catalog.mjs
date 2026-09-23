// 构建期生成模型目录产物（工单 model-catalog/01）。
//
// 读 @earendil-works/pi-ai 的 providers/data/*.json（devDependency，精确 pin），
// 裁剪成 extension/ai/catalog/pi-ai-catalog.generated.ts。产物是零 import 的
// 叶子模块，提交进仓库；构建只做打包，不在构建时现场生成（spec §产物形态）。
//
// 为什么读 JSON 而不跑 pi-ai 运行时：那 39 个 JSON 由上游 *.models.js 静态导入，
// 结构稳定（我们只需要 id/name/reasoning/input/contextWindow/maxTokens），
// 跑起来等于把整条 SDK 依赖树拖进生成期，零收益（spec §为什么不内置 pi-ai 本体）。
//
// 裁剪口径与决策见 spec.md「实现决策」：压平 api 分组（查表键只有
// (piProvider, modelId)，实测跨 api 同 id 重复为 0，此处生成期再断言一次）、
// 丢弃 cost / compat / thinkingLevelMap / baseUrl / provider / api。
//
// 用法：pnpm catalog:sync

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PI_AI_PACKAGE = "@earendil-works/pi-ai";
const MODULE_FILE = "extension/ai/catalog/pi-ai-catalog.generated.ts";

// vendor 的 11 个 provider 文件（spec §数据来源与范围）。顺序 = 产物内键序，
// 固定以保证幂等；不按字母排是为了让产物读者按 spec 的表核对。
const PI_PROVIDER_FILES = [
  "openai",
  "deepseek",
  "zai-coding-cn",
  "kimi-coding",
  "minimax-cn",
  "xiaomi",
  "opencode-go",
  "openrouter",
  "zai",
  "moonshotai",
  "minimax"
];

// 产物字段白名单（顺序 = 每行字段序）
const KEEP_FIELDS = ["id", "name", "reasoning", "input", "contextWindow", "maxTokens"];

// pin 版本下的模型总数（spec 表逐文件计数之和）。生成期对账：不是这个数说明
// 上游内容或路径变了——先确认 pin 版本，再同步本常量、spec 与测试。
const EXPECTED_MODEL_COUNT = 475;

function fail(message) {
  console.error(`sync-pi-ai-catalog: ${message}`);
  process.exit(1);
}

function piAiRoot() {
  return path.join(rootDir, "node_modules", ...PI_AI_PACKAGE.split("/"));
}

function readInstalledVersion() {
  const pkgPath = path.join(piAiRoot(), "package.json");
  if (!fs.existsSync(pkgPath)) {
    fail(`未找到 ${PI_AI_PACKAGE}，请先 pnpm install（本轮它是 devDependency）。`);
  }
  return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
}

// 读一个 provider 文件并按 (api 分组 → model id) 压平成 modelId → 元数据。
// 跨 api 的同 id 重复是断言不是覆盖：实测为 0，一旦上游插进来，静默丢一条
// 才是要避免的失败方式。
function readProvider(providerFile) {
  const jsonPath = path.join(piAiRoot(), "dist", "providers", "data", `${providerFile}.json`);
  if (!fs.existsSync(jsonPath)) {
    fail(`上游数据文件不存在：${path.relative(rootDir, jsonPath)}（pin 版本变了？）`);
  }
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const models = new Map();
  for (const [api, group] of Object.entries(data)) {
    for (const [modelId, model] of Object.entries(group)) {
      if (models.has(modelId)) {
        fail(
          `${providerFile}: model id "${modelId}" 同时挂在多个 api 分组下（含 ${api}）。` +
            `查表键 (piProvider, modelId) 不再唯一，需重新审议压平决策（spec 实现决策 1）。`
        );
      }
      const picked = {};
      for (const field of KEEP_FIELDS) {
        const value = model[field];
        if (value === undefined || value === null) {
          fail(`${providerFile}/${modelId}: 上游缺字段 ${field}，产物字段口径需复核。`);
        }
        picked[field] = value;
      }
      models.set(modelId, picked);
    }
  }
  return models;
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

function renderModule({ version, providers, totalModels }) {
  const blocks = providers.map(({ file, models }) => {
    const rows = [...models].map(
      ([modelId, model]) => `    ${JSON.stringify(modelId)}: ${emitModel(model)},`
    );
    return `  ${JSON.stringify(file)}: {\n${rows.join("\n")}\n  },`;
  });

  const header = `// ${MODULE_FILE} — 生成产物，勿手改。
//
// 来源：${PI_AI_PACKAGE}@${version}（devDependency，精确 pin）
// 生成：pnpm catalog:sync（scripts/sync-pi-ai-catalog.mjs）
// 口径：${PI_PROVIDER_FILES.length} 个 provider 文件 / ${totalModels} 个模型，每个模型只保留
//       ${KEEP_FIELDS.join(" / ")}。
//
// 刻意不带的字段（spec「明确不带」）：cost / compat / thinkingLevelMap /
// baseUrl / provider / api。前两个是线格式与价格的第二事实源；api 分组键
// 被压平——查表键只有 (piProvider, modelId)，生成期断言跨 api 同 id 重复为 0。
//
// 叶子纪律：本模块零 import（静态/动态都没有），只导出纯数据与一个纯查表
// 函数，对齐 ai/protocol-vocab.ts「词表叶不拖入协议栈」。消费方只能经
// ui/lazy-model-catalog.ts 动态 import，不得进 SW 静态图。
//
// 产物是提交进仓库的构建期数据，重跑幂等（git diff 为空）；与上游同步的唯一
// 动作是改 package.json 的 pin 后重跑本脚本。
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

// 数据版本（UI 的 title 展示用）：没有生成时间戳——时间戳会让产物每次都变，
// 幂等（git diff 为空）是硬要求。
export const PI_AI_CATALOG_SOURCE = {
  package: "${PI_AI_PACKAGE}",
  version: "${version}",
  providers: ${PI_PROVIDER_FILES.length},
  models: ${totalModels}
} as const;

export const PI_AI_CATALOG: Readonly<Record<string, Readonly<Record<string, CatalogModelMeta>>>> = {
${blocks.join("\n")}
};

// 查表：键是 (piProvider, modelId)，protocol 不参与（spec §查表语义）。
// 精确匹配、不做大小写折叠；查不到返回 null，不抛错、不回落猜测值。
export function lookupModelMeta(piProvider: unknown, modelId: unknown): CatalogModelMeta | null {
  if (typeof piProvider !== "string" || typeof modelId !== "string") {
    return null;
  }
  const table = PI_AI_CATALOG[piProvider];
  if (!table) {
    return null;
  }
  return table[modelId] ?? null;
}
`;
}

function main() {
  const version = readInstalledVersion();
  const providers = PI_PROVIDER_FILES.map((file) => ({ file, models: readProvider(file) }));
  const totalModels = providers.reduce((sum, provider) => sum + provider.models.size, 0);
  if (totalModels !== EXPECTED_MODEL_COUNT) {
    fail(
      `模型总数为 ${totalModels}，pin 版本 ${version} 下应为 ${EXPECTED_MODEL_COUNT}。` +
        `请确认上游内容/pin 版本，再同步本常量、spec 与 tests/ai/model-catalog.test.ts 的期望值。`
    );
  }

  const output = renderModule({ version, providers, totalModels });
  const outputPath = path.join(rootDir, MODULE_FILE);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output);
  console.log(
    `sync-pi-ai-catalog: ${MODULE_FILE} <- ${PI_AI_PACKAGE}@${version}，` +
      `${providers.length} 个 provider / ${totalModels} 个模型 / ${Buffer.byteLength(output)} B`
  );
  for (const { file, models } of providers) {
    console.log(`  ${file}: ${models.size}`);
  }
}

main();
