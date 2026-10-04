// extension/ai/model-catalog.ts — 模型目录域模块：把构建期产物（models.dev 上游
// 目录）接到 preset / host 识别上（upstream-model-facts/10 起改源；模块本身是
// model-catalog/02+03）。
//
// 与产物的分工：catalog/models-dev-catalog.generated.ts 是零 import 的叶子（纯数据 +
// (上游 provider, modelId) 精确查表）；本模块才允许碰 core/presets.ts 与 host 索引，
// 因此**不是叶子**——它只能被 UI 经 ui/lazy-model-catalog.ts 动态 import，不得
// 出现在 SW 静态图（spec 不变式 5；scripts/build.js 的 SW 静态图守卫 + 
// tests/ai/model-catalog.test.ts 的静态边用例各自把关）。
//
// 查表口径（spec 裁定 13）：精确匹配 → 折叠大小写 → 别名表。**别名表唯一一份**在
// 02 号票的产物 catalog/models-dev-thinking.generated.ts（MODEL_ID_ALIASES，如
// kimi-k3↔k3、modelscope 的 ZhipuAI/ 前缀），本模块只 import 它、不复制第二份；
// 键空间仍是 (上游 provider, modelId)，protocol 不参与。
//
// 只读纪律（spec 不变式 1/2）：本模块不落盘、不进 AiProvider 存储、不参与请求
// 体构造。它不在 provider-http.ts → completion.ts → adapters/* 那条链上。

import { PRESETS, type AiProviderPreset } from "../core/presets.js";
import { hostOf, presetIdForHost } from "../core/preset-host-index.js";
import {
  UPSTREAM_CATALOG,
  lookupUpstreamModelMeta,
  type CatalogModelMeta
} from "./catalog/models-dev-catalog.generated.js";
import { MODEL_ID_ALIASES } from "./catalog/models-dev-thinking.generated.js";

export { UPSTREAM_CATALOG_SOURCE } from "./catalog/models-dev-catalog.generated.js";
export type { CatalogModelMeta };

// 无数据白名单与 preset→上游 provider 映射同源在 core/presets.ts（NO_CATALOG_PRESETS
// 常量 + catalogProvider 字段）：这里不再复制第二份清单。运行时不需要白名单——已知
// 预设没有 catalogProvider 就是「没有目录数据」，白名单的职责只是让「新增 preset 忘配」
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
 * provider 记录 → models.dev 上游 provider id（产物上层键）。查不到返回 null。
 *
 * 键是 presetId → catalogProvider（显式映射优先，单源 = core/presets.ts），未命中或
 * custom 才用 baseUrl 的 host 兜底。protocol 完全不参与：元数据是模型属性不是线格式
 * 属性，而 provider 记录里的 protocol 是可能配错的（spec §查表语义）。
 */
export function resolveCatalogProvider(presetId: unknown, baseUrl: unknown): string | null {
  const id = typeof presetId === "string" ? presetId.trim() : "";
  if (id) {
    const preset = presetById(id);
    if (preset) {
      if (preset.catalogProvider) {
        return preset.catalogProvider;
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
  return presetById(hostPresetId)?.catalogProvider ?? null;
}

// 查表键解析（spec 裁定 13 的三级；与 02 产物 lookupThinkingFact 的 resolveThinkingKey
// 同序同口径，但不共用函数——那边只覆盖有词表的 reasoning 模型，本目录覆盖全部 578 条）：
//   精确 → 折叠大小写（上游 id 大小写混排：modelscope 的 ZhipuAI/GLM-4.6、minimax-cn 的
//   MiniMax-M2）→ 别名表（02 产物 MODEL_ID_ALIASES 的 localId = 本仓/用户口径 id）。
// 别名指向的 upstream 可能不在 12 家目录里（如 moonshotai/kimi-k2.6）——那就查不到，
// 返回 null，不回落猜测值。
function resolveCatalogKey(
  providerId: string,
  modelId: string
): { providerId: string; modelId: string } | null {
  if (lookupUpstreamModelMeta(providerId, modelId)) {
    return { providerId, modelId };
  }
  const folded = modelId.toLowerCase();
  for (const candidate of Object.keys(UPSTREAM_CATALOG[providerId] ?? {})) {
    if (candidate.toLowerCase() === folded) {
      return { providerId, modelId: candidate };
    }
  }
  for (const alias of MODEL_ID_ALIASES) {
    if (alias.provider !== providerId || alias.localId.toLowerCase() !== folded) {
      continue;
    }
    const slash = alias.upstream.indexOf("/");
    if (slash > 0 && slash < alias.upstream.length - 1) {
      return { providerId: alias.upstream.slice(0, slash), modelId: alias.upstream.slice(slash + 1) };
    }
  }
  return null;
}

/**
 * UI 口径的一步查表：草稿的 (presetId, baseUrl) + 模型 id → 元数据。
 * 查不到一律 null（UI 据此整栏静默隐藏，不显示占位），不回落猜测值。
 */
export function lookupCatalogMeta(
  presetId: unknown,
  baseUrl: unknown,
  modelId: unknown
): CatalogModelMeta | null {
  const providerId = resolveCatalogProvider(presetId, baseUrl);
  if (!providerId) {
    return null;
  }
  const id = typeof modelId === "string" ? modelId.trim() : "";
  if (!id) {
    return null;
  }
  const key = resolveCatalogKey(providerId, id);
  return key ? lookupUpstreamModelMeta(key.providerId, key.modelId) : null;
}
