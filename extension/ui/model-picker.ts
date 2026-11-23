import { getActiveReaderDocument } from "../shared/active-host.js";
import {
  dispatchCrossDocEvent,
  resolveNodeDocument,
  resolveNodeWindow,
  safeRemoveListener,
} from "../shared/cross-doc.js";
import { escapeHtml } from "../shared/string-utils.js";
import { requestProviderOriginsViaBackground } from "../core/host-permissions.js";
import {
  createOutsideClickDismissal,
  createSearchableOptionList,
  CUSTOM_SELECT_SEARCH_THRESHOLD,
  type OutsideClickDismissalController
} from "./custom-select.js";
import { READING_CHEVRON_DOWN_ICON } from "./reading-icons.js";
import type { ProviderRowElement, ProviderRowShowStatus } from "./provider-row.js";

const modelDropdownDismissal = createOutsideClickDismissal({
  wrapperSelector: ".ai-provider-model-wrapper",
  openDropdownSelector: ".ai-provider-model-dropdown:not([hidden])",
  triggerSelector: ".ai-provider-model-toggle",
  closeAll: () => closeAllModelDropdowns()
});

export interface ModelComboboxClasses {
  wrapperSelector: string;
  openDropdownSelector: string;
  triggerSelector: string;
  optionClass: string;
  searchItemClass: string;
  searchInputClass: string;
  emptyItemClass: string;
  messageClass: string;
  errorMessageClass?: string;
  loadingMessageClass?: string;
  countClass: string;
}

export type ModelComboboxMessageTone = "neutral" | "error" | "loading";

export interface ModelComboboxConfig {
  input: HTMLInputElement;
  toggle: HTMLButtonElement;
  dropdown: HTMLElement;
  classes: ModelComboboxClasses;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
  emptyMessage?: string;
  dismissal?: OutsideClickDismissalController;
  bindToggleClick?: boolean;
  onSelect?: (modelId: string) => void;
  onInput?: () => void;
  onClose?: () => void;
  onArrowDownOpen?: () => void;
  focusInputOnSelect?: boolean;
  signal?: AbortSignal;
}

export interface ModelCombobox {
  setOptions(models: readonly string[]): void;
  renderMessage(text: string, tone?: ModelComboboxMessageTone): void;
  open(): void;
  close(refocusToggle?: boolean): void;
  isOpen(): boolean;
  dispose(): void;
}

const PROVIDER_ROW_COMBOBOX_CLASSES: ModelComboboxClasses = {
  wrapperSelector: ".ai-provider-model-wrapper",
  openDropdownSelector: ".ai-provider-model-dropdown:not([hidden])",
  triggerSelector: ".ai-provider-model-toggle",
  optionClass: "ai-provider-model-option",
  searchItemClass: "ai-provider-model-search-item",
  searchInputClass: "ai-provider-model-search-input",
  emptyItemClass: "ai-provider-model-message ai-provider-model-empty",
  messageClass: "ai-provider-model-message",
  errorMessageClass: "ai-provider-model-message ai-provider-model-error",
  loadingMessageClass: "ai-provider-model-option ai-provider-model-loading",
  countClass: "ai-provider-model-count"
};

export function createModelCombobox(config: ModelComboboxConfig): ModelCombobox {
  const { input, toggle, dropdown, classes } = config;
  const optionToken = classes.optionClass.trim().split(/\s+/)[0] || "model-picker-option";
  const optionSelector = `.${optionToken}`;

  const win = resolveNodeWindow(dropdown) as Window & { AbortController?: typeof AbortController };
  const AbortCtor = typeof win?.AbortController === "function" ? win.AbortController : AbortController;
  const abort = new AbortCtor();
  const { signal } = abort;
  let disposed = false;
  let availableModels: string[] = [];
  let optionLis: HTMLLIElement[] = [];
  let countLi: HTMLLIElement | null = null;

  const ownedDismissal = config.dismissal
    ? null
    : createOutsideClickDismissal({
        wrapperSelector: classes.wrapperSelector,
        openDropdownSelector: classes.openDropdownSelector,
        triggerSelector: classes.triggerSelector,
        closeAll: () => close(false),
        closeOnEscape: () => close(true)
      });
  const dismissal = config.dismissal ?? ownedDismissal!;
  dismissal.observeDropdown(dropdown);

  function close(refocusToggle = false): void {
    const wasOpen = !dropdown.hidden;
    dropdown.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    dismissal.sync();
    searchableList.reset();
    if (wasOpen) {
      config.onClose?.();
    }
    if (refocusToggle) {
      toggle.focus({ preventScroll: true });
    }
  }

  function chooseOption(option: HTMLElement): void {
    const modelId = option.dataset.model;
    if (modelId) {
      input.value = modelId;
    }
    close(false);
    if (config.focusInputOnSelect) {
      input.focus({ preventScroll: true });
    }
    if (modelId) {
      config.onSelect?.(modelId);
    }
  }

  const searchableList = createSearchableOptionList({
    dropdown,
    searchItemClass: classes.searchItemClass,
    searchInputClass: classes.searchInputClass,
    placeholder: config.searchPlaceholder ?? "搜索模型...",
    ariaLabel: config.searchAriaLabel ?? "搜索模型",
    emptyItemClass: classes.emptyItemClass,
    getOptions: () => optionLis,
    isSearchEnabled: () => optionLis.length >= CUSTOM_SELECT_SEARCH_THRESHOLD,
    onSelect: chooseOption,
    onClose: (refocusTrigger) => close(refocusTrigger),
    onTab: () => close(false),
    enableHomeEnd: true,
    enableSpaceSelect: true,
    onFilter: (visibleCount, totalCount, kw) => {
      if (!countLi) return;
      countLi.textContent = kw
        ? `匹配 ${visibleCount} / ${totalCount} 个模型`
        : `已加载 ${totalCount} 个模型`;
    },
    signal
  });

  function renderOptions(): void {
    const doc = resolveNodeDocument(dropdown);
    dropdown.innerHTML = "";
    optionLis = [];
    countLi = null;

    if (availableModels.length === 0) {
      if (config.emptyMessage) {
        const emptyMsg = doc.createElement("li");
        emptyMsg.className = classes.messageClass;
        emptyMsg.setAttribute("role", "presentation");
        emptyMsg.textContent = config.emptyMessage;
        dropdown.appendChild(emptyMsg);
      }
      return;
    }

    const currentModel = input.value.trim();
    optionLis = availableModels.map((modelId) => {
      const li = doc.createElement("li");
      li.className = classes.optionClass;
      li.dataset.model = modelId;
      li.textContent = modelId;
      li.setAttribute("role", "option");
      li.tabIndex = -1;
      const selected = modelId === currentModel;
      li.dataset.selected = selected ? "true" : "false";
      li.setAttribute("aria-selected", selected ? "true" : "false");
      return li;
    });

    searchableList.reset();
    searchableList.syncHost(dropdown);

    countLi = doc.createElement("li");
    countLi.className = classes.countClass;
    countLi.setAttribute("role", "presentation");
    countLi.textContent = `已加载 ${availableModels.length} 个模型`;
    dropdown.appendChild(countLi);
  }

  function focusInitialItem(): void {
    if (searchableList.isSearchEnabled()) {
      searchableList.searchInput.focus();
    } else if (optionLis.length > 0) {
      (optionLis.find((o) => o.dataset.selected === "true") ?? optionLis[0])?.focus();
    }
  }

  function setOptions(models: readonly string[]): void {
    if (disposed) return;
    availableModels = [...models];
    if (!dropdown.hidden) {
      renderOptions();
      if (searchableList.isSearchEnabled()) {
        searchableList.searchInput.focus();
      }
    }
  }

  function renderMessage(text: string, tone: ModelComboboxMessageTone = "neutral"): void {
    if (disposed) return;
    const doc = resolveNodeDocument(dropdown);
    dropdown.innerHTML = "";
    optionLis = [];
    countLi = null;
    const li = doc.createElement("li");
    li.className =
      tone === "error"
        ? (classes.errorMessageClass ?? classes.messageClass)
        : tone === "loading"
          ? (classes.loadingMessageClass ?? classes.messageClass)
          : classes.messageClass;
    li.setAttribute("role", "presentation");
    li.textContent = text;
    dropdown.appendChild(li);
    dropdown.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    dismissal.sync();
  }

  function open(): void {
    if (disposed) return;
    renderOptions();
    dropdown.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    dismissal.sync();
    focusInitialItem();
  }

  function isOpen(): boolean {
    return !dropdown.hidden;
  }

  const onInputEvent = (): void => {
    if (!dropdown.hidden) {
      close(false);
    }
    config.onInput?.();
  };
  input.addEventListener("input", onInputEvent);

  const onInputKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "ArrowDown" && dropdown.hidden) {
      e.preventDefault();
      if (config.onArrowDownOpen) {
        config.onArrowDownOpen();
      } else {
        open();
      }
    }
  };
  input.addEventListener("keydown", onInputKeyDown);

  const onToggleClick = (e: MouseEvent): void => {
    e.stopPropagation();
    if (isOpen()) {
      close(false);
    } else {
      open();
    }
  };
  if (config.bindToggleClick !== false) {
    toggle.addEventListener("click", onToggleClick);
  }

  const onDropdownClick = (e: MouseEvent): void => {
    const option = (e.target as HTMLElement | null)?.closest<HTMLElement>(optionSelector);
    if (!option || !option.dataset.model) return;
    e.stopPropagation();
    chooseOption(option);
  };
  dropdown.addEventListener("click", onDropdownClick);

  const onExternalAbort = (): void => dispose();
  if (config.signal) {
    if (config.signal.aborted) {
      dispose();
    } else {
      config.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    safeRemoveListener(config.signal, "abort", onExternalAbort);
    safeRemoveListener(input, "input", onInputEvent);
    safeRemoveListener(input, "keydown", onInputKeyDown);
    if (config.bindToggleClick !== false) {
      safeRemoveListener(toggle, "click", onToggleClick);
    }
    safeRemoveListener(dropdown, "click", onDropdownClick);
    abort.abort();
    close(false);
    ownedDismissal?.dispose();
  }

  return {
    setOptions,
    renderMessage,
    open,
    close,
    isOpen,
    dispose
  };
}

export interface ModelPickerFieldOptions {
  inputClass: string;
  placeholder: string;
  value: string;
  inputId?: string;
}

export function buildModelPickerField({ inputClass, placeholder, value, inputId }: ModelPickerFieldOptions): string {
  return `
    <div class="ai-provider-model-wrapper">
      <input class="${inputClass}" type="text"${inputId ? ` id="${inputId}"` : ""} placeholder="${placeholder}" value="${escapeHtml(value)}" />
      <button type="button" class="ai-provider-model-toggle" title="从 baseUrl 拉取可用模型" aria-label="从 baseUrl 拉取可用模型" aria-haspopup="listbox" aria-expanded="false">
        ${READING_CHEVRON_DOWN_ICON}
      </button>
      <ul class="ai-provider-model-dropdown" hidden></ul>
    </div>`;
}

export interface ModelPickerFetchContext {
  baseUrl: string;
  apiKey: string;
  providerId: string;
}

export interface ModelPickerFetchResult {
  ok?: boolean;
  models?: string[];
  error?: string;
}

export interface WireModelPickerOptions {
  inputClass: string;
  baseUrlClass: string;
  apiKeyClass: string;
  statusClass: string;
  showStatus: ProviderRowShowStatus;
  fetchModels: (ctx: ModelPickerFetchContext) => Promise<ModelPickerFetchResult | null>;
  isKeyRequired?: () => boolean;
  hasSavedKey?: () => boolean;
}

export function wireModelPicker(
  row: ProviderRowElement,
  { inputClass, baseUrlClass, apiKeyClass, statusClass, showStatus, fetchModels, isKeyRequired, hasSavedKey }: WireModelPickerOptions
): void {
  const modelInput = row.querySelector<HTMLInputElement>(`.${inputClass}`);
  const toggle = row.querySelector<HTMLButtonElement>(".ai-provider-model-toggle");
  const dropdown = row.querySelector<HTMLElement>(".ai-provider-model-dropdown");
  if (!modelInput || !toggle || !dropdown) {
    return;
  }

  let fetchGeneration = 0;
  let fetchInFlight = false;
  const cancelInFlight = (): void => {
    fetchGeneration += 1;
    fetchInFlight = false;
  };

  const combobox = createModelCombobox({
    input: modelInput,
    toggle,
    dropdown,
    classes: PROVIDER_ROW_COMBOBOX_CLASSES,
    dismissal: modelDropdownDismissal,
    bindToggleClick: false,
    onSelect: () => {
      dispatchCrossDocEvent(modelInput, "input", { bubbles: true });
    },
    onInput: cancelInFlight,
    onClose: cancelInFlight,
    onArrowDownOpen: () => toggle.click()
  });

  toggle.addEventListener("click", async (e) => {
    e.stopPropagation();
    const statusNode = row.querySelector<HTMLElement>(`.${statusClass}`);
    const baseUrl = (row.querySelector<HTMLInputElement>(`.${baseUrlClass}`)?.value ?? "").trim();
    const apiKey = (row.querySelector<HTMLInputElement>(`.${apiKeyClass}`)?.value ?? "").trim();

    if (!baseUrl) {
      showStatus(statusNode, "请先填写 baseUrl", true);
      return;
    }

    if (combobox.isOpen()) {
      cancelInFlight();
      closeAllModelDropdowns();
      return;
    }
    if (fetchInFlight) {
      return;
    }
    closeAllModelDropdowns();

    if (statusNode) {
      statusNode.textContent = "";
      statusNode.hidden = true;
    }

    const keyRequired = isKeyRequired ? isKeyRequired() : false;
    const savedKey = hasSavedKey ? hasSavedKey() : false;
    if (keyRequired && !apiKey && !savedKey) {
      combobox.renderMessage("请先填写 API Key", "error");
      return;
    }
    combobox.renderMessage("正在拉取模型列表...", "loading");

    const generation = ++fetchGeneration;
    fetchInFlight = true;
    const isStale = (): boolean => {
      try {
        return !toggle.isConnected || !dropdown.isConnected || generation !== fetchGeneration || !combobox.isOpen();
      } catch {
        return true;
      }
    };

    try {
      const permission = await requestProviderOriginsViaBackground([baseUrl]);
      if (isStale()) return;
      if (!permission.ok) {
        combobox.renderMessage(permission.error || "未取得该平台域名权限，无法拉取模型列表", "error");
        return;
      }
      const resp = await fetchModels({
        baseUrl,
        apiKey,
        providerId: row.dataset.providerId || ""
      });
      if (isStale()) return;

      if (resp?.ok && Array.isArray(resp.models) && resp.models.length > 0) {
        combobox.setOptions(resp.models);
      } else if (resp?.ok) {
        combobox.renderMessage("未找到可用模型");
      } else {
        combobox.renderMessage(resp?.error || "拉取失败", "error");
      }
    } catch (error) {
      if (isStale()) return;
      const message = (error as Error)?.message;
      try {
        combobox.renderMessage(
          message && message.includes("port closed") ? "连接中断，请重试" : (message || "拉取失败"),
          "error"
        );
      } catch {
      }
    } finally {
      if (generation === fetchGeneration) {
        fetchInFlight = false;
      }
    }
  });
}

export function closeAllModelDropdowns(): void {
  const doc = getActiveReaderDocument();
  doc.querySelectorAll<HTMLElement>(".ai-provider-model-dropdown").forEach((dropdown) => {
    dropdown.hidden = true;
  });
  doc.querySelectorAll<HTMLElement>(".ai-provider-model-toggle").forEach((toggle) => {
    toggle.setAttribute("aria-expanded", "false");
  });
  modelDropdownDismissal.sync();
}
