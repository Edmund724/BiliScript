// 上游 provider 映射（构建期数据源脚本共享的单源）。
//
// preset → models.dev provider id。**唯一来源 = extension/core/presets.ts 的
// PRESETS[].catalogProvider**（10 号票起）：本模块不再自持一份映射表，只做两件事——
//   1. 读 presets.ts 的**源码文本**，取出每个 preset 登记的上游 provider id；
//   2. 按固定的**产物键序**（UPSTREAM_PRESET_ORDER）投影成脚本用的列表。
//
// 为什么"读文本"而不是 import：本仓库 package.json 是 `"type": "commonjs"`，Node
// 会把 `.ts` 当 CommonJS TypeScript 解析，`import { PRESETS } from
// "../extension/core/presets.ts"` 直接报 `Unexpected token 'export'`（node v25.8.0
// 实测）。构建期脚本因此一律「读源码文本、不执行仓库代码」——同
// scripts/check-models-dev-catalog.mjs 对待手写表的口径。
//
// 顺序 = 产物内键序，固定以保证幂等（01 UI 目录与 02 思考事实的键序/内容哈希都由
// 它决定）。它是**输出排序**事实，不是第二份映射表：provider id 一律来自 presets.ts，
// 本清单只列 preset id，且下面 fail-loud 校验「PRESETS 里每个登记了 catalogProvider
// 的 preset 都在此列、此列每一项都登记了 catalogProvider」——新增 preset 忘进此列
// 不会静默少一家产物，而是脚本直接报错。
//
// 顺序为什么不是 PRESETS 序：spec §preset → 上游 provider 先列 `api` 字段与 preset
// baseUrl 逐字相同的 11 家，minimax（人工裁定的一家）单列在表末；01/02 产物已按此序
// 提交（改序 = 换 contentHash = 动 02 产物），故 10 号票保持原序。
//
// 01（UI 目录）与 02（思考事实）共用这一张表：两份产物对「12 家是谁」必须同一口径。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SOURCE = "https://models.dev/api.json";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRESETS_MODULE = "extension/core/presets.ts";

// 产物键序（见文件头）：preset id，provider id 由 presets.ts 提供。
const UPSTREAM_PRESET_ORDER = [
  "deepseek",
  "qwen",
  "zhipu",
  "moonshot",
  "mimo",
  "opencodego",
  "openrouter",
  "stepfun",
  "modelscope",
  "amd",
  "sensenova",
  "minimax"
];

// 读 presets.ts 的 PRESETS 数组：逐行取 `id: "…"` 与可选的 `catalogProvider: "…"`。
// 表内一行一个 preset（含 protocolBaseUrls 的行内对象），故逐行解析是稳的；一旦
// 将来改成跨行条目，本函数会取不到 catalogProvider —— 那会在下面的完整性校验里
// fail-loud（该 preset 在序里却没有 provider），不会静默漏产物。
function readPresetCatalogProviders() {
  const text = fs.readFileSync(path.join(rootDir, PRESETS_MODULE), "utf8");
  const start = text.indexOf("export const PRESETS");
  if (start < 0) {
    throw new Error(`models-dev-upstream-providers: ${PRESETS_MODULE} 里找不到 export const PRESETS`);
  }
  const open = text.indexOf("[", start);
  const close = text.indexOf("\n];", open + 1);
  if (open < 0 || close < 0) {
    throw new Error(`models-dev-upstream-providers: 解析不了 ${PRESETS_MODULE} 的 PRESETS 数组字面量`);
  }
  const providers = new Map();
  for (const line of text.slice(open + 1, close).split("\n")) {
    const id = /\bid:\s*"([^"]+)"/.exec(line);
    if (!id) continue;
    if (providers.has(id[1])) {
      throw new Error(`models-dev-upstream-providers: ${PRESETS_MODULE} 里 preset id "${id[1]}" 重复`);
    }
    const provider = /\bcatalogProvider:\s*"([^"]+)"/.exec(line);
    providers.set(id[1], provider ? provider[1] : undefined);
  }
  if (providers.size === 0) {
    throw new Error(`models-dev-upstream-providers: ${PRESETS_MODULE} 的 PRESETS 数组解析出 0 个 preset`);
  }
  return providers;
}

function buildUpstreamProviders() {
  const providers = readPresetCatalogProviders();
  const missing = UPSTREAM_PRESET_ORDER.filter((preset) => !providers.get(preset));
  if (missing.length > 0) {
    throw new Error(
      `models-dev-upstream-providers: 序里的 preset 在 ${PRESETS_MODULE} 的 PRESETS 里没有 catalogProvider：` +
        `${missing.join(", ")} —— 新增/改名 preset 后同步 UPSTREAM_PRESET_ORDER 与 presets.ts 的登记。`
    );
  }
  const unlisted = [...providers.entries()]
    .filter(([id, provider]) => provider && !UPSTREAM_PRESET_ORDER.includes(id))
    .map(([id]) => id);
  if (unlisted.length > 0) {
    throw new Error(
      `models-dev-upstream-providers: ${PRESETS_MODULE} 里登记了 catalogProvider 但不在 UPSTREAM_PRESET_ORDER 的 preset：` +
        `${unlisted.join(", ")} —— 新增 preset 必须进序，否则它会静默缺席两份产物。`
    );
  }
  if (new Set(UPSTREAM_PRESET_ORDER).size !== UPSTREAM_PRESET_ORDER.length) {
    throw new Error("models-dev-upstream-providers: UPSTREAM_PRESET_ORDER 有重复项");
  }
  return UPSTREAM_PRESET_ORDER.map((preset) => ({ preset, id: providers.get(preset) }));
}

export const UPSTREAM_PROVIDERS = buildUpstreamProviders();
