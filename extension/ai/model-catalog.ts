// extension/ai/model-catalog.ts — 模型目录域模块：把构建期产物（pi-ai 目录）接到
// preset / host 识别上（model-catalog/02+03）。
//
// 与产物的分工：catalog/pi-ai-catalog.generated.ts 是零 import 的叶子（纯数据 +
// (piProvider, modelId) 精确查表）；本模块才允许碰 core/presets.ts 与 host 索引，
// 因此**不是叶子**——它只能被 UI 经 ui/lazy-model-catalog.ts 动态 import，不得
// 出现在 SW 静态图（spec 不变式 5；scripts/build.js 的 SW 静态图守卫 + 
// tests/ai/model-catalog.test.ts 的静态边用例各自把关）。
//
// 只读纪律（spec 不变式 1/2）：本模块不落盘、不进 AiProvider 存储、不参与请求
// 体构造。它不在 provider-http.ts → completion.ts → adapters/* 那条链上。

import { PRESETS, type AiProviderPreset } from "../core/presets.js";
import { hostOf, presetIdForHost } from "../core/preset-host-index.js";
import { lookupModelMeta, type CatalogModelMeta } from "./catalog/pi-ai-catalog.generated.js";

export { PI_AI_CATALOG_SOURCE } from "./catalog/pi-ai-catalog.generated.js";
export type { CatalogModelMeta };

// 无数据白名单与 preset→piProvider 映射同源在 core/presets.ts（NO_CATALOG_PRESETS
// 常量 + piProvider 字段）：这里不再复制第二份清单。运行时不需要白名单——已知
// 预设没有 piProvider 就是「没有目录数据」，白名单的职责只是让「新增 preset 忘配」
// 在测试期变红（tests/ai/model-catalog.test.ts 的覆盖用例）。

// 「身份由 baseUrl 决定」的预设：custom 的语义就是用户自填端点，presetId 不携带
// 平台身份，故照旧走 host 兜底（ticket 03 验收：custom + api.xiaomimimo.com 命中
// xiaomi）。其它已知预设（含 ollama 这类无数据的）presetId 就是权威身份，命中即
// 不再看 baseUrl——否则把平台 A 的端点填进平台 B 的记录会被目录"纠正"成 A 的
// 元数据，等于把配置错误传染进展示层。
const IDENTITYLESS_PRESETS = new Set<string>(["custom"]);

function presetById(id: string): AiProviderPreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/**
 * provider 记录 → pi-ai provider 目录名（列表文件名）。查不到返回 null。
 *
 * 键是 presetId → piProvider（显式映射优先），未命中或 custom 才用 baseUrl 的
 * host 兜底。protocol 完全不参与：元数据是模型属性不是线格式属性，而 provider
 * 记录里的 protocol 是可能配错的（spec §查表语义）。
 */
export function resolvePiProvider(presetId: unknown, baseUrl: unknown): string | null {
  const id = typeof presetId === "string" ? presetId.trim() : "";
  if (id) {
    const preset = presetById(id);
    if (preset) {
      if (preset.piProvider) {
        return preset.piProvider;
      }
      if (!IDENTITYLESS_PRESETS.has(preset.id)) {
        return null;
      }
    }
  }
  const host = hostOf(baseUrl);
  if (!host) {
    return null;
  }
  const hostPresetId = presetIdForHost(host);
  if (!hostPresetId) {
    return null;
  }
  return presetById(hostPresetId)?.piProvider ?? null;
}

/**
 * UI 口径的一步查表：草稿的 (presetId, baseUrl) + 模型 id → 元数据。
 * 查不到一律 null（UI 据此整栏静默隐藏，不显示占位）。
 */
export function lookupCatalogMeta(
  presetId: unknown,
  baseUrl: unknown,
  modelId: unknown
): CatalogModelMeta | null {
  const piProvider = resolvePiProvider(presetId, baseUrl);
  if (!piProvider) {
    return null;
  }
  return lookupModelMeta(piProvider, modelId);
}
