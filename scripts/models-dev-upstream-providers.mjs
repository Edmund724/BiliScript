import { execFileSync } from "node:child_process";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const DEFAULT_SOURCE = "https://models.dev/api.json";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRESETS_MODULE = "extension/core/presets.ts";
const esbuildEntry = createRequire(import.meta.url).resolve("esbuild");
const ESBUILD_BUNDLE_SCRIPT = [
  "const { buildSync } = require(process.argv[1]);",
  "const result = buildSync({",
  "  entryPoints: [process.argv[2]],",
  "  bundle: true,",
  "  write: false,",
  '  format: "cjs",',
  '  platform: "node",',
  '  logLevel: "silent"',
  "});",
  'process.stdout.write(result.outputFiles?.[0]?.text ?? "");'
].join("\n");

export const UPSTREAM_PRESET_ORDER = [
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
  "minimax",
  "gemini"
];

export function readPresetCatalogProviders(presetsPath = path.join(rootDir, PRESETS_MODULE)) {
  const code = execFileSync(
    process.execPath,
    ["-e", ESBUILD_BUNDLE_SCRIPT, esbuildEntry, presetsPath],
    { encoding: "utf8" }
  );
  if (!code.trim()) {
    throw new Error(`models-dev-upstream-providers: 编译 ${presetsPath} 未产出可执行代码`);
  }
  const moduleObj = { exports: {} };
  const wrapper = new vm.Script(
    `(function (exports, require, module, __filename, __dirname) {\n${code}\n})`,
    { filename: presetsPath }
  ).runInThisContext();
  wrapper(
    moduleObj.exports,
    createRequire(presetsPath),
    moduleObj,
    presetsPath,
    path.dirname(presetsPath)
  );
  const presets = moduleObj.exports?.PRESETS;
  if (!Array.isArray(presets)) {
    throw new Error(`models-dev-upstream-providers: ${presetsPath} 未导出 PRESETS 数组`);
  }
  const providers = new Map();
  for (const entry of presets) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id) {
      throw new Error(`models-dev-upstream-providers: ${presetsPath} 的 PRESETS 存在缺少有效 id 的条目`);
    }
    if (providers.has(entry.id)) {
      throw new Error(`models-dev-upstream-providers: ${presetsPath} 里 preset id "${entry.id}" 重复`);
    }
    if (entry.catalogProvider !== undefined && (typeof entry.catalogProvider !== "string" || !entry.catalogProvider)) {
      throw new Error(
        `models-dev-upstream-providers: ${presetsPath} 里 preset "${entry.id}" 的 catalogProvider 非法`
      );
    }
    providers.set(entry.id, entry.catalogProvider);
  }
  if (providers.size === 0) {
    throw new Error(`models-dev-upstream-providers: ${presetsPath} 的 PRESETS 数组解析出 0 个 preset`);
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
