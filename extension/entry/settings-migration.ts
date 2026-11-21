import { SEARCH_PROVIDER_PRESETS, type SearchProviderPreset, type SearchProviderType } from "../core/presets.js";
import { SMART_SEARCH_ACTIVE_ID, isSmartSearchActive } from "../core/search-mode.js";
import {
  INDEX_TRANSLATE_PROVIDER_ID,
  normalizeIndexTranslateModel
} from "../ai/subtitle-translate-config.js";

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

export function applySubtitleTranslateDefaultMigration(
  syncCurrent: Record<string, unknown>
): Record<string, unknown> {
  const rawProviderId = typeof syncCurrent.subtitleTranslateProviderId === "string"
    ? syncCurrent.subtitleTranslateProviderId.trim()
    : "";
  if (!rawProviderId || rawProviderId === INDEX_TRANSLATE_PROVIDER_ID) {
    syncCurrent.subtitleTranslateProviderId = INDEX_TRANSLATE_PROVIDER_ID;
    syncCurrent.subtitleTranslateModel = normalizeIndexTranslateModel(syncCurrent.subtitleTranslateModel);
  }
  return syncCurrent;
}

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
  providersToAdd: SearchPresetAutoRecord[];
  activeSearchProviderId?: string;
  shouldWriteFlag: boolean;
}

export function planSearchPresetsAutoActivation(
  settings: SearchPresetsAutoActivationSettings,
  providers: ReadonlyArray<{ id: string; presetId?: string }>,
  presets: readonly SearchProviderPreset[] = SEARCH_PROVIDER_PRESETS
): SearchPresetsAutoActivationPlan {
  if (settings.searchPresetsAutoActivated === true) {
    return { providersToAdd: [], shouldWriteFlag: false };
  }

  const existingIds = new Set(providers.map((provider) => provider.id));
  const existingPresetIds = new Set(providers.map((provider) => String(provider.presetId || "").trim()));

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

  const activeId = String(settings.activeSearchProviderId || "").trim();
  const plan: SearchPresetsAutoActivationPlan = { providersToAdd, shouldWriteFlag: true };
  if (!activeId || (!isSmartSearchActive(activeId) && !existingIds.has(activeId))) {
    plan.activeSearchProviderId = SMART_SEARCH_ACTIVE_ID;
  }
  return plan;
}
