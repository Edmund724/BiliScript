import {
  INDEX_TRANSLATE_DEFAULT_MODEL,
  INDEX_TRANSLATE_MODEL_OPTIONS,
  INDEX_TRANSLATE_PROVIDER_ID,
  normalizeIndexTranslateModel
} from "../../ai/subtitle-translate-config.js";
import type { Settings } from "../../core/defaults.js";
import { state } from "../../core/state.js";
import {
  buildModelOptionValue,
  normalizeProviderModels,
  parseModelOptionValue,
  resolveCatalogModel
} from "../../shared/selected-provider.js";
import { escapeHtml } from "../../shared/string-utils.js";
import {
  initCustomSelect,
  rebuildCustomSelectOptions,
  setCustomSelectState,
  setCustomSelectValue
} from "../custom-select.js";
import type { ProviderRowItem } from "../provider-row.js";
import type { SettingsElements } from "./elements.js";

interface ProviderModelSelectGroup {
  provider: ProviderRowItem;
  providerId: string;
  label: string;
  models: string[];
}

export interface ModelSelectBindDeps {
  savePatch: (elements: SettingsElements, patch: Record<string, unknown>) => Promise<boolean>;
  loadAiProviders: () => Promise<ProviderRowItem[]>;
  syncSummaries: (elements: SettingsElements) => void;
}

function buildEnabledModelSelectGroups(aiProviders: ProviderRowItem[]): ProviderModelSelectGroup[] {
  return (aiProviders || [])
    .filter((p) => p && p.enabled !== false && String(p.id || "").trim() !== "")
    .map((provider) => ({
      provider,
      providerId: String(provider.id || ""),
      label: String(provider.name || provider.model || "自定义").trim() || "自定义",
      models: normalizeProviderModels(provider)
    }))
    .filter((g) => g.models.length > 0);
}

function renderGroupedModelOptionsHtml(
  groups: ProviderModelSelectGroup[],
  leadingEmptyOptionLabel: string
): string {
  const leading = leadingEmptyOptionLabel ? `<option value="">${escapeHtml(leadingEmptyOptionLabel)}</option>` : "";
  return (
    leading +
    groups
      .map((group) => {
        const optionsHtml = group.models
          .map((model) => {
            const val = buildModelOptionValue(group.providerId, model);
            return `<option value="${escapeHtml(val)}">${escapeHtml(model)}</option>`;
          })
          .join("");
        return `<optgroup label="${escapeHtml(group.label)}">${optionsHtml}</optgroup>`;
      })
      .join("")
  );
}

function renderProviderModelSelect(
  selectEl: HTMLSelectElement | null,
  aiProviders: ProviderRowItem[],
  currentProviderId?: unknown,
  currentModel?: unknown
): void {
  if (!selectEl) return;
  const groups = buildEnabledModelSelectGroups(aiProviders);
  if (!groups.length) {
    selectEl.innerHTML = '<option value="">暂无可用模型</option>';
    selectEl.value = "";
    selectEl.disabled = true;
    rebuildCustomSelectOptions(selectEl);
    setCustomSelectValue(selectEl, "");
    initCustomSelect(selectEl, "custom-select-wrapper");
    setCustomSelectState(selectEl, { disabled: true });
    return;
  }

  selectEl.disabled = false;
  selectEl.innerHTML = renderGroupedModelOptionsHtml(groups, "");

  const preferredProviderId = String(currentProviderId || "").trim();
  const preferredModel = String(currentModel || "").trim();
  const matchedGroup = preferredProviderId
    ? groups.find((g) => g.providerId === preferredProviderId) || groups[0]
    : groups[0];
  const resolvedModel = resolveCatalogModel(
    matchedGroup.provider,
    matchedGroup.providerId === preferredProviderId ? preferredModel : ""
  );
  const selectedValue = buildModelOptionValue(matchedGroup.providerId, resolvedModel);
  selectEl.value = selectedValue;
  rebuildCustomSelectOptions(selectEl);
  setCustomSelectValue(selectEl, selectedValue);
  initCustomSelect(selectEl, "custom-select-wrapper");
  setCustomSelectState(selectEl, { disabled: false });
}

function renderIndexTranslateModelSelect(selectEl: HTMLSelectElement | null, currentModel?: unknown): void {
  if (!selectEl) return;
  selectEl.disabled = false;
  selectEl.innerHTML = INDEX_TRANSLATE_MODEL_OPTIONS.map((option) => {
    const val = buildModelOptionValue(INDEX_TRANSLATE_PROVIDER_ID, option.id);
    return `<option value="${escapeHtml(val)}">${escapeHtml(option.id)}</option>`;
  }).join("");
  const resolvedModel = normalizeIndexTranslateModel(currentModel);
  const selectedValue = buildModelOptionValue(INDEX_TRANSLATE_PROVIDER_ID, resolvedModel);
  selectEl.value = selectedValue;
  rebuildCustomSelectOptions(selectEl);
  setCustomSelectValue(selectEl, selectedValue);
  initCustomSelect(selectEl, "custom-select-wrapper");
  setCustomSelectState(selectEl, { disabled: false });
}

function setSubtitleTranslateSourceValue(
  selectEl: HTMLSelectElement | null,
  value: typeof INDEX_TRANSLATE_PROVIDER_ID | "custom"
): void {
  if (!selectEl) return;
  selectEl.value = value;
  setCustomSelectValue(selectEl, value);
  initCustomSelect(selectEl, "custom-select-wrapper");
}

function renderSubtitleTranslateSelects(
  elements: SettingsElements,
  aiProviders: ProviderRowItem[],
  s: Partial<Settings>
): void {
  const groups = buildEnabledModelSelectGroups(aiProviders);
  const preferredProviderId = String(s.subtitleTranslateProviderId || "").trim();
  const preferredModel = String(s.subtitleTranslateModel || "").trim();
  const isCustomProvider = Boolean(
    preferredProviderId &&
      preferredProviderId !== INDEX_TRANSLATE_PROVIDER_ID &&
      groups.some((group) => group.providerId === preferredProviderId)
  );

  if (!isCustomProvider) {
    setSubtitleTranslateSourceValue(elements.subtitleTranslateSource, INDEX_TRANSLATE_PROVIDER_ID);
    renderIndexTranslateModelSelect(
      elements.subtitleTranslateModel,
      preferredProviderId === INDEX_TRANSLATE_PROVIDER_ID ? preferredModel : ""
    );
    return;
  }

  setSubtitleTranslateSourceValue(elements.subtitleTranslateSource, "custom");
  renderProviderModelSelect(elements.subtitleTranslateModel, aiProviders, preferredProviderId, preferredModel);
}

export function renderAiModelSelects(
  elements: SettingsElements,
  providers: ProviderRowItem[],
  s: Partial<Settings>,
  syncSummaries?: (elements: SettingsElements) => void
): void {
  renderProviderModelSelect(elements.aiDefaultModel, providers, s.defaultModel, s.defaultAiModel);
  renderSubtitleTranslateSelects(elements, providers, s);
  syncSummaries?.(elements);
}

function commitModelSelection(options: {
  patch: Record<string, string>;
  prev: Record<string, string>;
  elements: SettingsElements;
  deps: ModelSelectBindDeps;
  rollback: () => void;
}): void {
  state.patchSettings(options.patch);
  options.deps.syncSummaries(options.elements);
  void options.deps.savePatch(options.elements, options.patch).then((saved) => {
    if (saved) return;
    state.patchSettings(options.prev);
    options.rollback();
  });
}

function bindProviderModelSelect(
  selectEl: HTMLSelectElement | null,
  providerKey: "defaultModel" | "subtitleTranslateProviderId",
  modelKey: "defaultAiModel" | "subtitleTranslateModel",
  elements: SettingsElements,
  deps: ModelSelectBindDeps,
  onRollback?: (providers: ProviderRowItem[], prevProviderId: string, prevModel: string) => void
): void {
  selectEl?.addEventListener("change", () => {
    const { providerId, model } = parseModelOptionValue(selectEl.value || "");
    if (!providerId || !model) return;
    const prevProviderId = String(state.settings?.[providerKey] || "").trim();
    const prevModel = String(state.settings?.[modelKey] || "").trim();
    commitModelSelection({
      patch: { [providerKey]: providerId, [modelKey]: model },
      prev: { [providerKey]: prevProviderId, [modelKey]: prevModel },
      elements,
      deps,
      rollback: () => {
        void deps.loadAiProviders().then((providers) => {
          if (onRollback) {
            onRollback(providers, prevProviderId, prevModel);
          } else {
            renderProviderModelSelect(selectEl, providers, prevProviderId, prevModel);
          }
          deps.syncSummaries(elements);
        });
      }
    });
  });
}

function bindSubtitleTranslateSourceSelect(
  elements: SettingsElements,
  deps: ModelSelectBindDeps
): void {
  elements.subtitleTranslateSource.addEventListener("change", () => {
    const source = elements.subtitleTranslateSource.value;
    const prevProviderId = String(state.settings?.subtitleTranslateProviderId || "").trim();
    const prevModel = String(state.settings?.subtitleTranslateModel || "").trim();
    const prev = { subtitleTranslateProviderId: prevProviderId, subtitleTranslateModel: prevModel };

    if (source === INDEX_TRANSLATE_PROVIDER_ID) {
      renderIndexTranslateModelSelect(elements.subtitleTranslateModel, INDEX_TRANSLATE_DEFAULT_MODEL);
      commitModelSelection({
        patch: {
          subtitleTranslateProviderId: INDEX_TRANSLATE_PROVIDER_ID,
          subtitleTranslateModel: INDEX_TRANSLATE_DEFAULT_MODEL
        },
        prev,
        elements,
        deps,
        rollback: () => {
          void deps.loadAiProviders().then((providers) => {
            renderSubtitleTranslateSelects(elements, providers, prev);
            deps.syncSummaries(elements);
          });
        }
      });
      return;
    }

    void deps.loadAiProviders().then((providers) => {
      const groups = buildEnabledModelSelectGroups(providers);
      if (!groups.length) {
        renderProviderModelSelect(elements.subtitleTranslateModel, providers);
        deps.syncSummaries(elements);
        return;
      }
      const chosenGroup = groups[0];
      const chosenModel = resolveCatalogModel(chosenGroup.provider);
      renderProviderModelSelect(elements.subtitleTranslateModel, providers, chosenGroup.providerId, chosenModel);
      commitModelSelection({
        patch: {
          subtitleTranslateProviderId: chosenGroup.providerId,
          subtitleTranslateModel: chosenModel
        },
        prev,
        elements,
        deps,
        rollback: () => {
          renderSubtitleTranslateSelects(elements, providers, prev);
          deps.syncSummaries(elements);
        }
      });
    });
  });
}

export function bindModelSelectEvents(
  elements: SettingsElements,
  deps: ModelSelectBindDeps
): void {
  bindProviderModelSelect(elements.aiDefaultModel, "defaultModel", "defaultAiModel", elements, deps);
  bindSubtitleTranslateSourceSelect(elements, deps);
  bindProviderModelSelect(
    elements.subtitleTranslateModel,
    "subtitleTranslateProviderId",
    "subtitleTranslateModel",
    elements,
    deps,
    (providers, prevProviderId, prevModel) => {
      renderSubtitleTranslateSelects(elements, providers, {
        subtitleTranslateProviderId: prevProviderId,
        subtitleTranslateModel: prevModel
      });
    }
  );
}
