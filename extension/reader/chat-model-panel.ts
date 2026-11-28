import {
  normalizeAiInitialQuickPrompts,
  normalizeAiThinkingLevel
} from "../core/validators.js";
import { DEFAULT_SETTINGS } from "../core/defaults.js";
import type { OverviewSetupErrorClass } from "../core/overview-setup-error.js";
import type { ThinkingLevelInput } from "../ai/thinking-levels.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import type { GetSettingsResponse } from "../shared/messaging-protocol.js";
import {
  getActiveReaderWindow,
  getOpenerDocument,
  onActiveHostChange,
} from "../shared/active-host.js";
import { pinOpenerRealmWrappers, registerDetachedDocumentCleanup } from "./detached-window.js";
import {
  isHtmlElement,
  prefersActiveReducedMotion,
  resolveNodeDocument,
  resolveNodeWindow,
  safeRemoveListener,
  scheduleMigratingFrame,
  setInnerHtmlPreservingOpenerRealm,
  type MigratingFrameHandle,
} from "../shared/cross-doc.js";
import { trySetPointerCapture } from "../shared/dom-utils.js";
import { escapeHtml } from "../shared/string-utils.js";
import { renderUiIcon } from "../ui/icon-registry.js";
import {
  SELECTED_PROVIDER_KEY,
  MODEL_OPTION_SEPARATOR,
  buildModelOptionValue,
  normalizeProviderModels,
  parseModelOptionValue
} from "../shared/selected-provider.js";
import {
  applyProviderPrefs,
  chatSessionState,
  setAiThinkingLevel,
  setSelectedModelValue,
  setWebSearchEnabled as setWebSearchEnabledState,
  type ChatSessionProvider
} from "../chat/chat-state.js";
import {
  thinkingLevelValueLabel,
  thinkingViewOf,
  type ThinkingPickerEntry,
  type ThinkingView
} from "../chat/thinking-picker.js";

export const THINKING_LEVEL_KEY = "biliscript_ai_thinking_level";
export { SELECTED_PROVIDER_KEY, MODEL_OPTION_SEPARATOR, buildModelOptionValue, parseModelOptionValue };

export interface ProviderPrefsStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export type ChatSetupTarget = {
  errorClass: OverviewSetupErrorClass;
  providerId: string;
};

const SNAP_THRESHOLD = 0.1;
const ULTRA_BURST_MS = 420;
const MODEL_CHIP_MAX_WIDTH = 420;
const MODEL_CHIP_MIN_WIDTH = 92;
const MODEL_PANEL_MIN_WIDTH = 240;
const MODEL_PANEL_MAX_WIDTH = 320;

let chipMeasureCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;

function getChipMeasureCanvas(): OffscreenCanvas | HTMLCanvasElement {
  if (!chipMeasureCanvas) {
    if (typeof OffscreenCanvas !== "undefined") {
      try {
        chipMeasureCanvas = new OffscreenCanvas(1, 1);
      } catch {
        chipMeasureCanvas = null;
      }
    }
    if (!chipMeasureCanvas) {
      chipMeasureCanvas = getOpenerDocument().createElement("canvas");
    }
  }
  return chipMeasureCanvas;
}

function prefersReducedMotion(target?: Element | null): boolean {
  return prefersActiveReducedMotion(target);
}

function measureTextWidth(text: string, style?: CSSStyleDeclaration | null): number {
  const ctx = getChipMeasureCanvas().getContext("2d");
  if (!ctx) {
    return text.length * 8;
  }
  const fontStyle = style?.fontStyle || "normal";
  const fontVariant = style?.fontVariant || "normal";
  const fontWeight = style?.fontWeight || "400";
  const fontSize = style?.fontSize || "13px";
  const fontFamily = style?.fontFamily || "sans-serif";
  ctx.font = `${fontStyle} ${fontVariant} ${fontWeight} ${fontSize} ${fontFamily}`;
  return ctx.measureText(text).width;
}

function formatProviderLabel(provider: { name?: string; model?: unknown }): string {
  const name = String(provider.name || "").trim();
  if (name) {
    return name;
  }
  return String(provider.model || "").trim();
}

function displayModelName(model: string): string {
  const slash = model.lastIndexOf("/");
  if (slash < 0 || slash === model.length - 1) {
    return model;
  }
  return model.slice(slash + 1);
}

interface ProviderGroup {
  provider: ChatSessionProvider;
  providerId: string;
  label: string;
  models: string[];
}

function resolveOptionValue(
  saved: string,
  groups: ProviderGroup[],
  optionValues: Set<string>
): string {
  if (!saved) return "";
  if (optionValues.has(saved)) return saved;
  const group = groups.find((g) => g.providerId === saved);
  if (group && group.models.length) {
    return buildModelOptionValue(group.providerId, group.models[0]);
  }
  return "";
}

export interface CreateReaderChatModelPanelDeps {
  chip: HTMLButtonElement;
  chipModel: HTMLElement;
  chipLevel: HTMLElement;
  panelList: HTMLElement;
  panel: HTMLElement;
  thinkingToggle: HTMLElement;
  thinkingRow: HTMLElement;
  thinkingRowValue: HTMLElement;
  thinkingHint?: HTMLElement | null;
  webSearchPill?: HTMLElement | null;
  storage?: ProviderPrefsStorage;
  hidePanel: () => void;
  openSettings: () => void;
  pickLevel?: (level: ThinkingLevelInput) => void;
  onSelect?: (value: string) => void;
}

export interface ReaderChatModelPanel {
  reload: (opts?: { preferredProviderId?: string }) => Promise<void>;
  setThinkingLevel: (level: ThinkingLevelInput) => Promise<void>;
  setWebSearchEnabled: (enabled: boolean) => Promise<void>;
  getSelectedValue: () => string;
  selectValue: (value: string) => void;
  hasSelectableModels: () => boolean;
  resolveSetupTarget: () => ChatSetupTarget;
  renderChip: () => void;
  renderPanel: () => void;
  renderThinkingPicker: (view: ThinkingView) => void;
}

export function createReaderChatModelPanel(deps: CreateReaderChatModelPanelDeps): ReaderChatModelPanel {
  const {
    chip,
    chipModel,
    chipLevel,
    panelList,
    panel,
    thinkingToggle,
    thinkingRow,
    thinkingRowValue,
    thinkingHint = null,
    webSearchPill = null
  } = deps;

  const storage =
    deps.storage ||
    (typeof chrome !== "undefined" && chrome?.storage?.local ? chrome.storage.local : undefined);

  let storedSelectedProviderId = "";
  let selectedValue = "";
  let explicitlyCleared = false;
  let lastCatalogKey: string | null = null;

  let chipLevelLabel: string | null = null;
  let committedView: ThinkingView | null = null;
  let renderedStructureKey = "";
  let currentTierEntries: ThinkingPickerEntry[] = [];
  let currentActiveIndex = -1;
  let lastThumbPct: number | null = null;
  let isDraggingThumb = false;
  let thumbTransitionCleanup: (() => void) | null = null;
  let wasAtMax = false;
  let isBursting = false;
  let burstTimer: ReturnType<typeof setTimeout> | null = null;
  let renderedWebSearchEnabled: boolean | null = null;
  let widthRafHandle: MigratingFrameHandle | null = null;

  function getProviderGroups(): ProviderGroup[] {
    return chatSessionState.providers
      .map((provider) => ({
        provider,
        providerId: String(provider.id || ""),
        label: formatProviderLabel(provider),
        models: normalizeProviderModels(provider)
      }))
      .filter((group) => group.models.length > 0);
  }

  function hasSelectableModels(): boolean {
    return chatSessionState.providers.some((provider) => normalizeProviderModels(provider).length > 0);
  }

  function resolveMissingModelProviderId(): string {
    const providers = chatSessionState.providers;
    if (!providers.length) {
      return "";
    }
    const storedSelected = parseModelOptionValue(storedSelectedProviderId).providerId;
    const preferredId = String(chatSessionState.aiPrefs.defaultModel || "").trim();
    for (const candidate of [preferredId, storedSelected]) {
      if (candidate && providers.some((provider) => String(provider.id || "") === candidate)) {
        return candidate;
      }
    }
    return String(providers[0]?.id || "").trim();
  }

  function resolveSetupTarget(): ChatSetupTarget {
    if (chatSessionState.providers.length > 0 && !hasSelectableModels()) {
      return {
        errorClass: "no-model",
        providerId: resolveMissingModelProviderId()
      };
    }
    return { errorClass: "no-provider", providerId: "" };
  }

  function setSelectedProvider(value: string): void {
    storedSelectedProviderId = String(value || "").trim();
    if (storage) {
      void storage.set({ [SELECTED_PROVIDER_KEY]: storedSelectedProviderId }).catch(() => {});
    }
  }

  function syncSelectedValueState(nextValue: string): void {
    selectedValue = nextValue;
    setSelectedModelValue(nextValue);
    if (chip) {
      if (nextValue) {
        chip.dataset.selectedValue = nextValue;
      } else {
        delete chip.dataset.selectedValue;
      }
    }
  }

  function getSelectedValue(): string {
    return selectedValue;
  }

  function syncCatalogFromState({
    preferredProviderId = "",
    persistFallback = false,
    force = false
  }: { preferredProviderId?: string; persistFallback?: boolean; force?: boolean } = {}): ProviderGroup[] {
    const groups = getProviderGroups();
    const catalogKey =
      chatSessionState.providers.length === 0
        ? "EMPTY_PROVIDERS"
        : groups.length === 0
          ? "NO_MODELS"
          : groups.map((g) => `${g.providerId}\u0002${g.label}\u0002${g.models.join("\u0003")}`).join("\u0004");

    if (!force && catalogKey === lastCatalogKey) {
      return groups;
    }
    lastCatalogKey = catalogKey;

    if (!groups.length) {
      syncSelectedValueState("");
      explicitlyCleared = false;
      return groups;
    }

    const optionValues = new Set(
      groups.flatMap((group) => group.models.map((model) => buildModelOptionValue(group.providerId, model)))
    );
    const firstValue = buildModelOptionValue(groups[0].providerId, groups[0].models[0]);

    if (explicitlyCleared && !preferredProviderId) {
      syncSelectedValueState("");
      return groups;
    }

    const defaultProviderId = String(chatSessionState.aiPrefs.defaultModel || "").trim();
    const defaultModelId = String(chatSessionState.aiPrefs.defaultAiModel || "").trim();
    const defaultCompound =
      defaultProviderId && defaultModelId
        ? buildModelOptionValue(defaultProviderId, defaultModelId)
        : "";
    const candidates = force
      ? [preferredProviderId, storedSelectedProviderId, defaultCompound, defaultProviderId]
      : [preferredProviderId, selectedValue, storedSelectedProviderId, defaultCompound, defaultProviderId];

    let matched = "";
    for (const candidate of candidates) {
      matched = resolveOptionValue(String(candidate || "").trim(), groups, optionValues);
      if (matched) break;
    }
    syncSelectedValueState(matched || firstValue);
    explicitlyCleared = false;

    if (persistFallback && selectedValue && selectedValue !== storedSelectedProviderId) {
      setSelectedProvider(selectedValue);
    }
    return groups;
  }

  function measureChipContentWidth(): number {
    const model = String(chipModel?.textContent || "").trim() || "未配置平台";
    const level = String(chipLevel?.textContent || "").trim();
    const chipWin = chip ? resolveNodeWindow(chip) : getActiveReaderWindow();
    const computedStyle = chip ? chipWin.getComputedStyle(chip) : null;
    const measuredTextWidth =
      measureTextWidth(model, computedStyle) +
      (level ? measureTextWidth(level, computedStyle) : 0);
    const extraBuffer = chipMeasureCanvas?.getContext("2d") ? 48 : 44;
    return Math.ceil(measuredTextWidth + extraBuffer);
  }

  function getModelChipMaxWidth(): number {
    const inputBar = chip?.closest<HTMLElement>(".chat-input-bar");
    const barWidth = inputBar ? inputBar.clientWidth : 0;
    if (barWidth > 0) {
      return Math.max(MODEL_CHIP_MIN_WIDTH, Math.floor(barWidth * 0.6));
    }
    return MODEL_CHIP_MAX_WIDTH;
  }

  function updateChipWidth(): void {
    if (!chip) {
      return;
    }
    const desiredWidth = measureChipContentWidth();
    const maxWidth = getModelChipMaxWidth();
    const nextWidth = Math.max(MODEL_CHIP_MIN_WIDTH, Math.min(desiredWidth, maxWidth));
    chip.style.width = `${nextWidth}px`;
  }

  function scheduleChipWidthUpdate(preferredWin?: Window | null): void {
    if (widthRafHandle) {
      return;
    }
    let fired = false;
    const handle = scheduleMigratingFrame(
      () => {
        fired = true;
        widthRafHandle = null;
        updateChipWidth();
      },
      { targetNode: chip, preferredWin }
    );
    if (!fired) {
      widthRafHandle = handle;
    }
  }

  function measureModelPanelWidth(): number {
    const visibleWidth = chip ? chip.getBoundingClientRect().width : 0;
    const source = visibleWidth > 0 ? visibleWidth : measureChipContentWidth();
    return Math.max(MODEL_PANEL_MIN_WIDTH, Math.min(Math.ceil(source), MODEL_PANEL_MAX_WIDTH));
  }

  function syncUltraBurst(nextAtMax: boolean): void {
    if (nextAtMax && !wasAtMax && !prefersReducedMotion(thinkingRow ?? chip)) {
      isBursting = true;
      if (burstTimer !== null) {
        clearTimeout(burstTimer);
      }
      burstTimer = setTimeout(() => {
        burstTimer = null;
        isBursting = false;
        thinkingToggle.querySelector(".chat-thinking-track")?.classList.remove("is-ultra-burst");
      }, ULTRA_BURST_MS);
    } else if (!nextAtMax || prefersReducedMotion()) {
      if (burstTimer !== null) {
        clearTimeout(burstTimer);
        burstTimer = null;
      }
      isBursting = false;
    }
    wasAtMax = nextAtMax;
  }

  function renderChip(): void {
    const groups = syncCatalogFromState();
    chip.disabled = false;
    if (!groups.length) {
      chipModel.textContent = chatSessionState.providers.length > 0 ? "未配置模型" : "未配置平台";
      chipLevel.textContent = "";
      updateChipWidth();
      return;
    }
    const parsed = parseModelOptionValue(selectedValue);
    const matchedGroup = groups.find((group) =>
      group.providerId === parsed.providerId && group.models.includes(parsed.model)
    );
    if (!matchedGroup) {
      chipModel.textContent = "未配置平台";
      chipLevel.textContent = chipLevelLabel ?? thinkingLevelValueLabel(chatSessionState.aiThinkingLevel);
      updateChipWidth();
      return;
    }
    const platform = matchedGroup.label;
    const modelName = displayModelName(parsed.model);
    chipModel.textContent = platform ? `${platform}·${modelName}` : modelName;
    chipLevel.textContent = chipLevelLabel ?? thinkingLevelValueLabel(chatSessionState.aiThinkingLevel);
    updateChipWidth();
  }

  function syncSelectedModel(): void {
    panelList.querySelectorAll<HTMLButtonElement>(".chat-model-option").forEach((btn) => {
      const selected = btn.dataset.value === selectedValue;
      btn.classList.toggle("is-selected", selected);
      btn.setAttribute("aria-current", selected ? "true" : "false");
      if (selected) {
        if (!btn.querySelector(".chat-model-check")) {
          btn.insertAdjacentHTML("beforeend", '<span class="chat-model-check" aria-hidden="true">✓</span>');
        }
      } else {
        btn.querySelector(".chat-model-check")?.remove();
      }
    });
  }

  function focusModelOption(btn: HTMLButtonElement): void {
    btn.scrollIntoView?.({ block: "nearest" });
    btn.focus({ preventScroll: true });
  }

  function refreshThinkingUi(): void {
    const selected = parseModelOptionValue(selectedValue);
    const provider = chatSessionState.providers.find((item) => item.id === selected.providerId);
    const view = thinkingViewOf({
      presetId: String(provider?.presetId || ""),
      baseUrl: String(provider?.baseUrl || ""),
      model: selected.model || String(provider?.model || ""),
      level: chatSessionState.aiThinkingLevel,
      stream: true
    });
    renderThinkingPicker(view);
  }

  function applySelectedValue(nextValue: string): void {
    const normalizedValue = String(nextValue || "");
    const { providerId } = parseModelOptionValue(normalizedValue);
    explicitlyCleared = !providerId;
    syncSelectedValueState(normalizedValue);
    setSelectedProvider(providerId ? normalizedValue : "");
    syncSelectedModel();
    refreshThinkingUi();
    deps.onSelect?.(selectedValue);
  }

  function renderPanel(): void {
    const groups = syncCatalogFromState();
    panel.style.width = `${measureModelPanelWidth()}px`;
    panelList.hidden = false;
    if (!groups.length) {
      const emptyLabel = chatSessionState.providers.length > 0 ? "当前平台未配置可用模型" : "未配置平台";
      const emptyHtml =
        `<div class="chat-model-empty"><span>${emptyLabel}</span>` +
        '<button type="button" class="chat-model-empty-settings">前往设置</button></div>';
      const wrappedEmpty = setInnerHtmlPreservingOpenerRealm(panelList, emptyHtml);
      pinOpenerRealmWrappers(wrappedEmpty);
      thinkingRow.hidden = true;
      const settingsBtn = panelList.querySelector<HTMLButtonElement>(".chat-model-empty-settings");
      settingsBtn?.addEventListener("click", (event) => {
        event.stopPropagation();
        deps.hidePanel();
        deps.openSettings();
      });
      settingsBtn?.focus({ preventScroll: true });
      return;
    }
    thinkingRow.hidden = false;
    const current = selectedValue;
    const parts: string[] = [];
    for (const group of groups) {
      parts.push(`<div class="chat-model-group">${escapeHtml(group.label)}</div>`);
      for (const model of group.models) {
        const value = buildModelOptionValue(group.providerId, model);
        const isSelected = value === current;
        parts.push(
          `<button type="button" class="chat-model-option${isSelected ? " is-selected" : ""}"` +
            ` data-value="${escapeHtml(value)}" aria-current="${isSelected ? "true" : "false"}">` +
            `<span class="chat-model-option-name">${escapeHtml(displayModelName(model))}</span>` +
            (isSelected ? '<span class="chat-model-check" aria-hidden="true">✓</span>' : "") +
            "</button>"
        );
      }
    }
    const wrappedOptions = setInnerHtmlPreservingOpenerRealm(panelList, parts.join(""));
    pinOpenerRealmWrappers(wrappedOptions);
    panelList.querySelectorAll<HTMLButtonElement>(".chat-model-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.getAttribute("data-value") || "";
        if (value && value !== selectedValue) {
          applySelectedValue(value);
        }
        btn.focus({ preventScroll: true });
      });
    });
    const selected = panelList.querySelector<HTMLButtonElement>(".chat-model-option.is-selected");
    if (selected) {
      focusModelOption(selected);
    }
  }

  panelList.addEventListener("keydown", (event) => {
    const options = Array.from(panelList.querySelectorAll<HTMLButtonElement>(".chat-model-option"));
    if (options.length === 0) {
      return;
    }
    const docActive = resolveNodeDocument(panelList).activeElement;
    const active = isHtmlElement(docActive)
      ? docActive.closest<HTMLButtonElement>(".chat-model-option")
      : null;
    const activeIndex = active ? options.indexOf(active) : -1;
    const selectedIndex = options.findIndex((btn) => btn.classList.contains("is-selected"));
    const currentIndex = activeIndex >= 0 ? activeIndex : Math.max(0, selectedIndex);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = Math.min(options.length - 1, currentIndex + 1);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = Math.max(0, currentIndex - 1);
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = options.length - 1;
    } else if ((event.key === "Enter" || event.key === " ") && activeIndex >= 0) {
      event.preventDefault();
      options[activeIndex].click();
      return;
    }
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    focusModelOption(options[nextIndex]);
  });

  function commitButton(btn: HTMLElement | null | undefined): void {
    if (!btn) {
      return;
    }
    if (btn.dataset.writes === "true") {
      const level = btn.dataset.level || "off";
      if (deps.pickLevel) {
        deps.pickLevel(level);
      } else {
        void setThinkingLevel(level);
      }
    }
  }

  async function setThinkingLevel(level: ThinkingLevelInput): Promise<void> {
    setAiThinkingLevel(normalizeAiThinkingLevel(level));
    refreshThinkingUi();
    if (storage) {
      await storage.set({ [THINKING_LEVEL_KEY]: chatSessionState.aiThinkingLevel }).catch(() => {});
    }
    await sendRuntimeMessage({ type: "save-settings", settings: { aiThinkingLevel: chatSessionState.aiThinkingLevel } }).catch(() => null);
  }

  function spinWebSearchPill(enabled: boolean): void {
    if (!webSearchPill) return;
    webSearchPill.classList.remove("is-spinning-on", "is-spinning-off");
    webSearchPill.classList.add(enabled ? "is-spinning-on" : "is-spinning-off");
  }

  function renderWebSearchEnabled(): void {
    if (!webSearchPill) return;
    const enabled = chatSessionState.webSearchEnabled;
    const changed = renderedWebSearchEnabled !== null && renderedWebSearchEnabled !== enabled;
    renderedWebSearchEnabled = enabled;
    webSearchPill.classList.toggle("is-active", enabled);
    webSearchPill.setAttribute("aria-pressed", enabled ? "true" : "false");
    if (changed) spinWebSearchPill(enabled);
  }

  if (webSearchPill) {
    webSearchPill.addEventListener("click", () => {
      void setWebSearchEnabled(!chatSessionState.webSearchEnabled);
    });
    webSearchPill.addEventListener("animationend", (event) => {
      if (event.animationName.startsWith("biliscript-web-search-meridian")) {
        webSearchPill.classList.remove("is-spinning-on", "is-spinning-off");
      }
    });
  }

  async function setWebSearchEnabled(enabled: boolean): Promise<void> {
    setWebSearchEnabledState(Boolean(enabled));
    renderWebSearchEnabled();
    await sendRuntimeMessage({ type: "save-settings", settings: { webSearchEnabled: chatSessionState.webSearchEnabled } }).catch(() => null);
  }

  async function loadStoredPrefs(): Promise<Record<string, unknown>> {
    if (!storage) {
      return {};
    }
    try {
      return (await storage.get([SELECTED_PROVIDER_KEY, THINKING_LEVEL_KEY])) || {};
    } catch {
      return {};
    }
  }

  async function reload({ preferredProviderId = "" }: { preferredProviderId?: string } = {}): Promise<void> {
    const [providersResp, settingsResp, storedPrefs] = await Promise.all([
      sendRuntimeMessage({ type: "ai-providers-list" }),
      sendRuntimeMessage({ type: "get-settings" }).catch(
        (): GetSettingsResponse => ({ ok: false, error: "" })
      ),
      loadStoredPrefs()
    ]);
    storedSelectedProviderId = String(storedPrefs[SELECTED_PROVIDER_KEY] || "").trim();
    const providers = Array.isArray(providersResp?.providers) ? providersResp.providers : [];
    const settings = settingsResp?.ok ? settingsResp.settings : null;
    applyProviderPrefs({
      providers: providers
        .filter((p) => p.enabled)
        .map((p) => ({
          id: String(p.id || ""),
          name: typeof p.name === "string" ? p.name : undefined,
          model: p.model,
          models: normalizeProviderModels(p),
          baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : undefined,
          presetId: typeof p.presetId === "string" ? p.presetId : undefined,
          enabled: p.enabled
        })),
      aiPrefs: {
        aiSystemPrompt: String(settings?.aiSystemPrompt || "").trim(),
        aiInitialQuickPrompts: normalizeAiInitialQuickPrompts(settings?.aiInitialQuickPrompts),
        defaultModel: String(settings?.defaultModel || "").trim(),
        defaultAiModel: String(settings?.defaultAiModel || "").trim()
      },
      aiThinkingLevel: normalizeAiThinkingLevel(
        settingsResp?.settings?.aiThinkingLevel ?? storedPrefs[THINKING_LEVEL_KEY] ?? DEFAULT_SETTINGS.aiThinkingLevel
      ),
      webSearchEnabled: Boolean(settings?.webSearchEnabled)
    });
    explicitlyCleared = false;
    syncCatalogFromState({ preferredProviderId, persistFallback: true, force: true });
    renderWebSearchEnabled();
    refreshThinkingUi();
  }

  function renderThinkingPicker(view: ThinkingView): void {
    const groups = syncCatalogFromState();
    committedView = view;
    const entries = view.entries;
    chipLevelLabel = view.label;
    thinkingRowValue.textContent = view.label;
    thinkingRow.hidden = groups.length === 0;

    if (entries.length === 0) {
      syncUltraBurst(false);
      renderedStructureKey = "";
      currentTierEntries = [];
      currentActiveIndex = -1;
      thinkingToggle.innerHTML = "";
    } else {
      const defaultEntry = entries.find((entry) => entry.level === "default") ?? null;
      const tierEntries: ThinkingPickerEntry[] = entries.filter((entry) => entry.level !== "default");
      const structureKey = entries.map((entry) => `${entry.level}:${entry.label}`).join("|");
      currentTierEntries = tierEntries;
      currentActiveIndex = tierEntries.findIndex((entry) => entry.effective);

      if (structureKey !== renderedStructureKey || thinkingToggle.children.length === 0) {
        renderedStructureKey = structureKey;
        const parts: string[] = [];

        if (defaultEntry) {
          parts.push(
            `<button type="button" class="chat-thinking-btn chat-thinking-reset"` +
              ` data-level="${escapeHtml(defaultEntry.level)}"` +
              ` title="恢复默认（Default）" aria-label="恢复默认（Default）">` +
              `<span class="chat-thinking-btn-label" hidden>${escapeHtml(defaultEntry.label)}</span>` +
              renderUiIcon("reset") +
              `</button>`
          );
        }

        if (tierEntries.length === 1) {
          const entry = tierEntries[0];
          parts.push(
            `<div class="chat-thinking-single">` +
              `<span class="chat-thinking-single-label">支持档位</span>` +
              `<button type="button" class="chat-thinking-btn chat-thinking-single-pill"` +
              ` data-level="${escapeHtml(entry.level)}">` +
              `<span class="chat-thinking-btn-label">${escapeHtml(entry.label)}</span>` +
              `</button>` +
              `</div>`
          );
        } else if (tierEntries.length >= 2) {
          const n = tierEntries.length;
          const ticksHtml = tierEntries
            .map((entry, idx) => {
              const stopPct = (idx / (n - 1)) * 100;
              return (
                `<button type="button" class="chat-thinking-btn chat-thinking-tick" tabindex="-1" aria-hidden="true"` +
                ` style="left:${stopPct}%" data-index="${idx}"` +
                ` data-level="${escapeHtml(entry.level)}"` +
                ` title="${escapeHtml(entry.label)}">` +
                `<span class="chat-thinking-btn-label" hidden>${escapeHtml(entry.label)}</span>` +
                `</button>`
              );
            })
            .join("");

          parts.push(
            `<div class="chat-thinking-track" tabindex="0" role="slider" aria-label="思考强度"` +
              ` aria-valuemin="0" aria-valuemax="${n - 1}">` +
              `<div class="chat-thinking-range">` +
              `<div class="chat-thinking-rail"></div>` +
              `<div class="chat-thinking-fill">` +
              `<div class="chat-thinking-ultra-gradient"></div>` +
              `<div class="chat-thinking-energy"></div>` +
              `</div>` +
              ticksHtml +
              `<div class="chat-thinking-thumb"></div>` +
              `</div>` +
              `</div>`
          );
        }

        const wrappedThinking = setInnerHtmlPreservingOpenerRealm(thinkingToggle, parts.join(""));
        pinOpenerRealmWrappers(wrappedThinking);
        bindThinkingControls();
      }

      const allBtns = Array.from(thinkingToggle.querySelectorAll<HTMLButtonElement>(".chat-thinking-btn"));
      entries.forEach((entry, idx) => {
        const btn = allBtns[idx];
        if (!btn) {
          return;
        }
        btn.classList.toggle("is-active", entry.effective);
        btn.dataset.effective = entry.effective ? "true" : "false";
        btn.dataset.writes = entry.writesPreference ? "true" : "false";
        btn.setAttribute("aria-current", entry.effective ? "true" : "false");
        if (btn.classList.contains("chat-thinking-reset")) {
          btn.disabled = !entry.writesPreference;
          btn.setAttribute("aria-disabled", entry.writesPreference ? "false" : "true");
        }
      });

      if (tierEntries.length >= 2) {
        const n = tierEntries.length;
        const activeIndex = currentActiveIndex;
        const hasThumb = activeIndex >= 0;
        const pct = hasThumb ? (activeIndex / (n - 1)) * 100 : 0;
        const fillWidth = hasThumb && activeIndex > 0 ? `calc(${pct}% + 12px)` : "0px";
        const hasSparkle = hasThumb && activeIndex > 0;
        const atMax = n >= 3 && hasThumb && activeIndex >= n - 1;
        syncUltraBurst(atMax);

        const track = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-track");
        const range = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-range");
        const fill = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-fill");
        const thumb = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-thumb");
        if (track && fill && thumb) {
          track.classList.toggle("is-sparkle", hasSparkle);
          track.classList.toggle("is-max", atMax);
          track.classList.toggle("is-ultra-burst", isBursting);
          track.setAttribute("aria-valuenow", String(hasThumb ? activeIndex : 0));
          track.setAttribute("aria-valuetext", view.label);
          fill.style.width = fillWidth;
          thumb.hidden = !hasThumb;
          updateThumbPosition(thumb, range, pct, hasThumb);
        }
      } else {
        syncUltraBurst(false);
        lastThumbPct = null;
      }
    }

    renderChip();
    if (thinkingHint) {
      thinkingHint.textContent = view.hint ?? "";
      thinkingHint.hidden = view.hint === null;
    }
  }

  function updateThumbPosition(
    thumb: HTMLElement,
    range: HTMLElement | null,
    pct: number,
    hasThumb: boolean
  ): void {
    if (!hasThumb) {
      thumb.style.left = `${pct}%`;
      thumb.style.transform = "";
      thumb.style.transition = "";
      lastThumbPct = null;
      return;
    }

    if (lastThumbPct === null || isDraggingThumb || prefersReducedMotion()) {
      thumb.style.left = `${pct}%`;
      thumb.style.transform = "";
      thumb.style.transition = "";
      lastThumbPct = pct;
      return;
    }

    if (lastThumbPct === pct) {
      thumb.style.left = `${pct}%`;
      return;
    }

    const rangeWidth = range ? range.getBoundingClientRect().width : 0;
    if (rangeWidth <= 0) {
      thumb.style.left = `${pct}%`;
      thumb.style.transform = "";
      thumb.style.transition = "";
      lastThumbPct = pct;
      return;
    }

    let currentTx = 0;
    const thumbWin = resolveNodeWindow(thumb);
    if (typeof thumbWin !== "undefined" && typeof thumbWin.getComputedStyle === "function") {
      const computed = thumbWin.getComputedStyle(thumb).transform;
      const tf = (computed && computed !== "none") ? computed : thumb.style.transform;
      if (tf && tf !== "none") {
        const matrixMatch = /matrix\([^,]+,[^,]+,[^,]+,[^,]+,\s*([^,\)]+)/.exec(tf);
        if (matrixMatch) {
          currentTx = parseFloat(matrixMatch[1]) || 0;
        } else {
          const txMatch = /translateX\(\s*([-\d.]+)px\)/.exec(tf);
          if (txMatch) {
            currentTx = parseFloat(txMatch[1]) || 0;
          }
        }
      }
    }

    const prevTargetX = (lastThumbPct / 100) * rangeWidth;
    const currentVisualX = prevTargetX + currentTx;
    const newTargetX = (pct / 100) * rangeWidth;
    const deltaX = currentVisualX - newTargetX;

    thumb.style.left = `${pct}%`;

    if (Math.abs(deltaX) < 0.5) {
      thumb.style.transform = "";
      thumb.style.transition = "";
      lastThumbPct = pct;
      return;
    }

    thumb.style.transition = "none";
    thumb.style.transform = `translateX(${deltaX}px)`;
    void thumb.offsetWidth;

    thumb.style.transition = "transform 0.18s var(--biliscript-reader-ease-spring, cubic-bezier(0.32, 0.72, 0, 1))";
    thumb.style.transform = "translateX(0)";

    if (thumbTransitionCleanup) {
      thumbTransitionCleanup();
      thumbTransitionCleanup = null;
    }
    const onTransitionEnd = (e?: Event): void => {
      if (e && e.target !== thumb) return;
      thumb.removeEventListener("transitionend", onTransitionEnd);
      thumbTransitionCleanup = null;
      thumb.style.transition = "";
      thumb.style.transform = "";
    };
    thumbTransitionCleanup = () => {
      thumb.removeEventListener("transitionend", onTransitionEnd);
    };
    thumb.addEventListener("transitionend", onTransitionEnd, { once: true });

    lastThumbPct = pct;
  }

  function bindThinkingControls(): void {
    let suppressNextClick = false;
    thinkingToggle.querySelectorAll<HTMLButtonElement>(".chat-thinking-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (suppressNextClick) {
          suppressNextClick = false;
          return;
        }
        commitButton(btn);
      });
    });

    const track = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-track");
    const range = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-range");
    const fill = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-fill");
    const thumb = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-thumb");
    const tickButtons = Array.from(thinkingToggle.querySelectorAll<HTMLButtonElement>(".chat-thinking-tick"));
    if (!track || !range || !fill || !thumb || tickButtons.length < 2) {
      return;
    }

    let dragging = false;
    let previewNearest = 0;
    let cachedRangeRect: DOMRect | null = null;
    let dragObserver: ResizeObserver | null = null;

    const refreshRangeRect = (): void => {
      if (range) {
        cachedRangeRect = range.getBoundingClientRect();
      }
    };

    const onDragWindowResize = (): void => {
      if (dragging) {
        refreshRangeRect();
      }
    };

    function previewAt(pos: number): number {
      const n = currentTierEntries.length;
      const clamped = Math.max(0, Math.min(n - 1, pos));
      const nearest = Math.round(clamped);
      const snapped = Math.abs(clamped - nearest) <= SNAP_THRESHOLD ? nearest : clamped;
      const pct = (snapped / (n - 1)) * 100;
      thumb!.hidden = false;
      thumb!.style.transition = "none";
      thumb!.style.transform = "";
      thumb!.style.left = `${pct}%`;
      lastThumbPct = pct;
      fill!.style.width = snapped <= 0 ? "0px" : `calc(${pct}% + 12px)`;
      const hasSparkle = snapped > 0;
      const atMax = n >= 3 && nearest >= n - 1 && snapped >= n - 1 - SNAP_THRESHOLD;
      track!.classList.toggle("is-sparkle", hasSparkle);
      track!.classList.toggle("is-max", atMax);
      syncUltraBurst(atMax);
      track!.classList.toggle("is-ultra-burst", isBursting);
      thinkingRowValue.textContent = currentTierEntries[nearest]?.label ?? "";
      return nearest;
    }

    function posFromClientX(clientX: number): number | null {
      const rect = dragging ? (cachedRangeRect ?? range!.getBoundingClientRect()) : range!.getBoundingClientRect();
      if (!rect || rect.width <= 0) {
        return null;
      }
      const n = currentTierEntries.length;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return ratio * (n - 1);
    }

    let dragResizeWin: Window | null = null;
    let stopDragHostWatch: (() => void) | null = null;

    track.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== undefined) {
        return;
      }
      dragging = true;
      isDraggingThumb = true;
      track.classList.add("is-dragging");
      refreshRangeRect();
      dragResizeWin = resolveNodeWindow(track);
      dragResizeWin?.addEventListener("resize", onDragWindowResize);
      const Obs =
        (dragResizeWin as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)?.ResizeObserver ??
        (typeof ResizeObserver !== "undefined" ? ResizeObserver : undefined);
      if (Obs) {
        dragObserver = new Obs(() => {
          if (dragging) {
            refreshRangeRect();
          }
        });
        dragObserver.observe(range);
      }
      stopDragHostWatch?.();
      stopDragHostWatch = onActiveHostChange(() => {
        finishDrag(false);
      });
      const pos = posFromClientX(e.clientX);
      if (pos === null) {
        finishDrag(false);
        return;
      }
      trySetPointerCapture(track, e.pointerId);
      previewNearest = previewAt(pos);
    });

    track.addEventListener("pointermove", (e: PointerEvent) => {
      if (!dragging) {
        return;
      }
      const pos = posFromClientX(e.clientX);
      if (pos === null) {
        return;
      }
      previewNearest = previewAt(pos);
    });

    function finishDrag(commit: boolean): void {
      if (!dragging) {
        return;
      }
      dragging = false;
      isDraggingThumb = false;
      stopDragHostWatch?.();
      stopDragHostWatch = null;
      safeRemoveListener(dragResizeWin, "resize", onDragWindowResize);
      dragResizeWin = null;
      if (dragObserver) {
        try {
          dragObserver.disconnect();
        } catch {
        }
        dragObserver = null;
      }
      cachedRangeRect = null;
      track!.classList.remove("is-dragging");
      if (!commit) {
        if (committedView) {
          renderThinkingPicker(committedView);
        }
        return;
      }
      suppressNextClick = true;
      setTimeout(() => {
        suppressNextClick = false;
      }, 0);
      commitButton(tickButtons[previewNearest]);
    }

    track.addEventListener("pointerup", () => finishDrag(true));
    track.addEventListener("pointercancel", () => finishDrag(false));

    track.addEventListener("keydown", (e: KeyboardEvent) => {
      const n = currentTierEntries.length;
      let nextIdx: number | null = null;
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        nextIdx = currentActiveIndex < 0 ? 0 : Math.min(n - 1, currentActiveIndex + 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        nextIdx = currentActiveIndex < 0 ? 0 : Math.max(0, currentActiveIndex - 1);
      } else if (e.key === "Home") {
        nextIdx = 0;
      } else if (e.key === "End") {
        nextIdx = n - 1;
      }
      if (nextIdx === null) {
        return;
      }
      e.preventDefault();
      commitButton(tickButtons[nextIdx]);
    });
  }

  const onChipResize = () => {
    if (chip?.isConnected) {
      scheduleChipWidthUpdate();
    }
  };
  let boundResizeWin: Window | null = chip ? resolveNodeWindow(chip) : getActiveReaderWindow();
  boundResizeWin?.addEventListener("resize", onChipResize);
  registerDetachedDocumentCleanup((targetDoc) => {
    const targetWin = targetDoc.defaultView;
    if (boundResizeWin && targetWin && boundResizeWin === targetWin) {
      safeRemoveListener(boundResizeWin, "resize", onChipResize);
      boundResizeWin = null;
    }
  });
  onActiveHostChange((ctx) => {
    safeRemoveListener(boundResizeWin, "resize", onChipResize);
    boundResizeWin = ctx.win;
    boundResizeWin?.addEventListener("resize", onChipResize);
    if (chip?.isConnected) {
      scheduleChipWidthUpdate(ctx.win);
    }
  });

  return {
    reload,
    setThinkingLevel,
    setWebSearchEnabled,
    getSelectedValue,
    selectValue: applySelectedValue,
    hasSelectableModels,
    resolveSetupTarget,
    renderChip,
    renderPanel,
    renderThinkingPicker
  };
}
