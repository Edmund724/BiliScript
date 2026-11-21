import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SOURCE = "https://models.dev/api.json";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRESETS_MODULE = "extension/core/presets.ts";

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
