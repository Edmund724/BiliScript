// extension/search/search-order.ts
// 搜索顺序的零依赖叶（票 15 Q1-a）：把搜索平台「顺序」的两条纯函数收在一处——
//   ① normalizeSearchProviderOrder：searchProviderOrder 存储键的归一（脏值整体作废）；
//   ② providerOrderRank：排序键（order 下标 > 内置默认序下标，双哨兵，spec §12.2）。
// 两处调用方同调此叶，不再各自算键：智能链排序（search/search-chain.ts）与设置列表
// 渲染（ui/settings-panel.ts）。
//
// 叶纪律（票 15 Q2-a，tests/search/search-order.test.ts 有用例钉住）：本模块的存在
// 意义之一是**不必**经 search-chain.ts 接线——search-chain 静态 import
// search-executor → 六家在产适配器，设置抽屉只要一个排序键，走 search-chain 会把整包
// 搜索执行链拖进它的懒 chunk。故运行时相对 import 只允许零运行时依赖的
// core/presets.js（DEFAULT_SEARCH_PROVIDER_ORDER）；新增任何一条都会把适配器边重新
// 焊回设置 chunk，并在该用例上报红。
import { DEFAULT_SEARCH_PROVIDER_ORDER } from "../core/presets.js";

/**
 * searchProviderOrder 归一（spec §12.2）：整个键要么可信、要么不用——非数组 /
 * 元素非字符串或空串 / 含未知 id（不在当前记录集合中）/ 含重复 id → 返回 []（=
 * 无自定义顺序，回落内置默认序），不部分采纳、不抛错、不上报。
 */
export function normalizeSearchProviderOrder(raw: unknown, knownRecordIds: Iterable<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(knownRecordIds);
  const seen = new Set<string>();
  const order: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || value.trim() === "") return [];
    if (!known.has(value) || seen.has(value)) return [];
    seen.add(value);
    order.push(value);
  }
  return order;
}

/**
 * 顺序排序键（spec §12.2）：返回 [order 下标, 内置默认序下标] 二元组——
 *   - 首键：记录 id 在归一 order 中的下标；不在 order 中 → +Infinity（排到所有在
 *     order 中的记录之后）；
 *   - 次键：presetId 在 DEFAULT_SEARCH_PROVIDER_ORDER 中的下标；不在内置默认序中
 *     → 默认序长度（排到已知预设之后）。
 * 键相同的记录保持输入序（调用方依赖 Array#sort 的稳定性）。消费方按
 * 「首键不等比首键，否则比次键」比较；两侧（链解析 / 设置列表）的键算法只此一份。
 */
export function providerOrderRank(
  id: string,
  presetId: string,
  order: readonly string[]
): readonly [number, number] {
  const orderIndex = order.indexOf(id);
  const defaultIndex = DEFAULT_SEARCH_PROVIDER_ORDER.indexOf(presetId);
  return [
    orderIndex === -1 ? Number.POSITIVE_INFINITY : orderIndex,
    defaultIndex === -1 ? DEFAULT_SEARCH_PROVIDER_ORDER.length : defaultIndex
  ];
}
