// extension/core/search-mode.ts
// 搜索模式单源（spec §1 S6 / §12.1 / §12.5 第 2 行）：`activeSearchProviderId`
// 一值两义——某条在场记录 id = **单选**（只用该家、无回退、不消费冷却）；哨兵
// `SMART_SEARCH_ACTIVE_ID` 或空串 = **智能**（全组按链序串行回退、跳过冷却中的引擎）。
// 零依赖叶：UI（选中态）与 SW（链解析 / 自动激活）同源 import；别处不得手写哨兵
// 字面量比较。空串与哨兵同解：空串 = 存量「从未手选」状态，两者只在 UI 选中态上有别
// （空串 = 无选中行），故存量用户零迁移。
//
// 哨兵与记录 id 不可能碰撞：记录 id 只有两条生成路径——自动补齐的
// `"search_" + preset.id`（spec §1 S2）与生成式 `"search_" + base36 时间 + "_" +
// 随机`（ui/provider-row.ts，搜索族 idPrefix "search_"）——都以 `search_` 开头。

export const SMART_SEARCH_ACTIVE_ID = "__smart__";

export type SearchMode = "single" | "smart";

// 空串 / 空白 / null / undefined 与哨兵同解（都是智能链，spec §12.1）。
export function isSmartSearchActive(activeId: string | null | undefined): boolean {
  const id = String(activeId ?? "").trim();
  return id === "" || id === SMART_SEARCH_ACTIVE_ID;
}

// 模式判定：非哨兵且非空 = 单选（值即唯一候选的记录 id）。悬空 id 的兜底在链解析侧
// （spec §6.8：悬空按空处理走智能链），本判定只看取值形态。
export function resolveSearchMode(activeId: string | null | undefined): SearchMode {
  return isSmartSearchActive(activeId) ? "smart" : "single";
}
