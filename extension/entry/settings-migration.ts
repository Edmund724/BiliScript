// extension/entry/settings-migration.ts
// 安装/更新一次性设置迁移的决策半边（纯函数，就地变异；执行与落盘仍由
// background 的 initializeSettingsStorage 统一走全量写，本函数不触碰 storage
// ——background.js 有 35KB 体积守卫，迁移逻辑必须保持最小字节量）。
//
// 2026-09 AI 键默认开迁移：enablePlayerAiQuickAction 默认值 false → true
// （core/defaults.ts）。旧版本的所有落盘路径（设置面板整包保存、旧安装迁移的
// 全量键落盘）都会把当时的默认值 false 显式写进 storage.sync，存量 false
// 分不清「用户刻意关闭」与「历史默认值被动落盘」。本决策把存量 false 改写回
// 新默认 true，并把 aiBtnDefaultOnMigrated 旗标置进同一份合并对象随全量写
// 落盘。旗标在未置位时无条件置位（review r1/P1-1：若只在翻转分支置位，
// 新装/原 true 队列的用户显式关闭 AI 键后，下一次扩展更新重跑迁移会把他
// 的显式 false 再翻转回 true）——旗标保证迁移只生效一次，此后用户显式
// 关闭的值不会被后续更新翻转。
//
// 取舍（有意为之）：存量用户里曾刻意关闭按钮的会被这次迁移重新打开一次，
// 需要再手动关一次——在不引入用户可见确认弹窗的前提下无法区分两种 false，
// 而不改写则默认翻转对全部存量安装（含提出该诉求用户的浏览器）无效。
//
// 2026-09 免 Key 搜索预设自动激活（spec §1 S2）：同一钩子上的第二件一次性迁移，
// 决策半边同样写成纯函数（planSearchPresetsAutoActivation），写入（记录 → 链首 →
// flag，flag 最后写）归 background 的 autoActivateSearchPresets。

import { SEARCH_PROVIDER_PRESETS, type SearchProviderPreset, type SearchProviderType } from "../core/presets.js";

// 旗标未置位 → 无条件置旗标（存量显式 false 一并改写回 true）；旗标已置位 →
// 原样返回。旗标键
// 已进 DEFAULT_SETTINGS 键面（settings 存储白名单自动覆盖），随调用方的
// 全量写持久化。
export function applyPlayerAiQuickActionDefaultOnMigration(
  syncCurrent: Record<string, unknown>
): Record<string, unknown> {
  if (!syncCurrent.aiBtnDefaultOnMigrated) {
    if (syncCurrent.enablePlayerAiQuickAction === false) {
      syncCurrent.enablePlayerAiQuickAction = true;
    }
    syncCurrent.aiBtnDefaultOnMigrated = true;
  }
  return syncCurrent;
}

// ===== 免 Key 预设自动激活（spec §1 S2 / §2「自动激活规则（S2 展开）」）=====

// 自动补齐的搜索记录形状：记录仍只有 id / presetId / name / type / baseUrl /
// enabled 六个字段（search/search-provider-normalize.ts），access 只挂预设表。
export interface SearchPresetAutoRecord {
  id: string;
  presetId: string;
  name: string;
  type: SearchProviderType;
  baseUrl: string;
  enabled: boolean;
}

export interface SearchPresetsAutoActivationSettings {
  searchPresetsAutoActivated?: boolean;
  activeSearchProviderId?: string;
}

export interface SearchPresetsAutoActivationPlan {
  // 需补缺的记录（已有同 presetId 记录不在此列，也就不会被改写）
  providersToAdd: SearchPresetAutoRecord[];
  // 仅在链首为空或悬空时携带（值 = 预设表首项的生成 id，即 search_firecrawl）
  activeSearchProviderId?: string;
  // flag 未置位即需写（即使本轮一条记录都没补也要写，否则判定会在每次启动重跑）
  shouldWriteFlag: boolean;
}

// 决策半边（纯函数，不触碰 storage）：安装/更新时按 presetId 对四条 keyless 预设
// 查缺补齐、链首仅在为空或悬空时写、并置一次性 flag。写入顺序（记录 → 链首 →
// flag）与 flag 最后写的理由见 background 的 autoActivateSearchPresets（任一步
// 失败时 flag 未落盘，下一次 onInstalled 重试整段；判据按 presetId 使重试安全）。
export function planSearchPresetsAutoActivation(
  settings: SearchPresetsAutoActivationSettings,
  providers: ReadonlyArray<{ id: string; presetId?: string }>,
  presets: readonly SearchProviderPreset[] = SEARCH_PROVIDER_PRESETS
): SearchPresetsAutoActivationPlan {
  // ① flag 已置位 = 唯一整体跳过的情形（不加记录、不动链首、不重写 flag）
  if (settings.searchPresetsAutoActivated === true) {
    return { providersToAdd: [], shouldWriteFlag: false };
  }

  const existingIds = new Set(providers.map((provider) => provider.id));
  const existingPresetIds = new Set(providers.map((provider) => String(provider.presetId || "").trim()));

  // ② 补齐四条 keyless 预设（豆包 / Exa 两条 free-quota 一律不建）：判据是
  // presetId 而非 id——用户手加过的同一家（生成式 id）不会被误判为缺失。
  const providersToAdd: SearchPresetAutoRecord[] = [];
  for (const preset of presets) {
    if (preset.access !== "keyless") continue;
    if (existingPresetIds.has(preset.id)) continue;
    providersToAdd.push({
      id: `search_${preset.id}`,
      presetId: preset.id,
      name: preset.name,
      type: preset.type,
      baseUrl: preset.baseUrl,
      enabled: true
    });
  }

  // ③ 链首：空或悬空（指向不存在的记录）时写预设表首项的生成 id；已有且指向
  // 存在记录的链首原样不动（不重排、不改写）。
  const activeId = String(settings.activeSearchProviderId || "").trim();
  const headPreset = presets[0];
  const headId = headPreset ? `search_${headPreset.id}` : "";
  const plan: SearchPresetsAutoActivationPlan = { providersToAdd, shouldWriteFlag: true };
  if (headId && (!activeId || !existingIds.has(activeId))) {
    plan.activeSearchProviderId = headId;
  }
  return plan;
}
