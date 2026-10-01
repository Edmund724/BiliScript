// extension/search/search-chain.ts
// 回退链（spec §1 S1/S3/S4、§2、§3 落点表第 8 行）：
//   ① 本文件（批次①c）只放**纯函数** resolveSearchChain——链解析：进组判据
//      （记录的 presetId 查预设表得 access）、排序（链首 → 预设表顺序）、去重、
//      产出「有序候选 + 各自 Key」（S4 的单趟回传形状，SW 是唯一知道 Key 的一侧）；
//   ② 执行器 executeSearchChain / classifySearchFailure / SEARCH_CHAIN_BUDGET_MS
//      属批次②，落点预留在此文件下方（届时链级预算 30s、失败分类保序、静默回退
//      与整链无果一条 notice 都在那一批）。
// 纯函数纪律：零 Chrome API / 零 DOM / 不改写入参；Key 只经返回值中转，不进日志。
import { SEARCH_PROVIDER_PRESETS, type SearchProviderPreset } from "../core/presets.js";
import type { SearchProvider } from "./search-provider-normalize.js";

// 链候选（= ResolveSearchProviderResponse.chain 的元素形状，S4 单一形状）。
export interface SearchChainCandidate {
  provider: { id: string; name: string; type: string; baseUrl: string };
  apiKey: string;
}

// 解析回退链：链成员是**记录**（S1），成员资格由记录的 presetId 查预设表得出
// （§7「只挂预设表，记录不带副本」）：
//   - 查不到预设表（脏值 / 未知 presetId）→ 不进候选（最保守）；
//   - 记录须 enabled !== false；
//   - access === "keyless" 无条件进；access === "free-quota" 仅该记录有 Key 才进；
//   - 排序 = activeId 指向的在组记录排链首，其余按预设表顺序（同表项保持记录
//     输入顺序）；activeId 为空或悬空（不存在 / 不在组）→ 无链首，严格按表序；
//   - 按记录 id 去重（链首不重复出现）；
//   - keyless 无 Key 时候选的 apiKey 为 ""（适配器据此不产鉴权头）。
export function resolveSearchChain(
  providers: ReadonlyArray<SearchProvider>,
  keys: Record<string, string> | null | undefined,
  activeId: string | null | undefined,
  presets: readonly SearchProviderPreset[]
): SearchChainCandidate[] {
  // presetId → 预设（表序 + access）；同 id 重复预设取表内首个
  const presetById = new Map<string, { index: number; access: SearchProviderPreset["access"] }>();
  presets.forEach((preset, index) => {
    if (!presetById.has(preset.id)) presetById.set(preset.id, { index, access: preset.access });
  });

  const included: Array<{ candidate: SearchChainCandidate; index: number }> = [];
  // 按记录 id 去重：seenIds 只装已进组的 id（同 id 的后续记录一律跳过）
  const seenIds = new Set<string>();
  for (const record of providers) {
    if (seenIds.has(record.id)) continue;
    if (record.enabled === false) continue;
    const preset = presetById.get(String(record.presetId || "").trim());
    if (!preset) continue;
    const apiKey = String(keys?.[record.id] ?? "").trim();
    if (preset.access === "free-quota" && !apiKey) continue;
    seenIds.add(record.id);
    included.push({
      candidate: {
        provider: {
          id: record.id,
          name: record.name,
          type: record.type,
          baseUrl: record.baseUrl
        },
        apiKey
      },
      index: preset.index
    });
  }

  // 稳定按预设表顺序（同表项保持记录输入顺序）
  included.sort((a, b) => a.index - b.index);

  const headId = String(activeId || "").trim();
  const headIndex = headId ? included.findIndex((entry) => entry.candidate.provider.id === headId) : -1;
  const ordered =
    headIndex > 0
      ? [included[headIndex], ...included.filter((_entry, index) => index !== headIndex)]
      : included;

  return ordered.map((entry) => entry.candidate);
}

// ===== 批次② 落点（本批次不实现）=====
// export const SEARCH_CHAIN_BUDGET_MS = 30000;
// export function classifySearchFailure(error: unknown): "quota" | "auth" | "other";
// export async function executeSearchChain(candidates, query, deps): Promise<...>;
