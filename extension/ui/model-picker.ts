// extension/ui/model-picker.ts
// 可搜索模型组合框（createModelCombobox）与平台行异步拉取适配器（wireModelPicker）：
//   - createModelCombobox 统一承接引导页（entry/onboarding.ts）与设置/编辑 Modal
//     （wireModelPicker）共用的可搜索模型下拉：选项渲染、ARIA（role="option" /
//     aria-selected / aria-expanded）、搜索过滤、键盘漫游（ArrowDown 展开 / Home / End /
//     Space / Enter / Tab / Esc）、计数尾行、外点收起与 dispose 清理。
//   - wireModelPicker 为平台行（AI / ASR）薄适配层：点击 toggle 先按手势同步链申请
//     baseUrl 域名 host 权限，再拉取模型列表并喂给组合框。
//
// DOM 契约沿用 AI 侧既有类名（ai-provider-model-wrapper / -toggle /
// -dropdown / -option / -message / -error / -loading / -count），reader.css
// 样式与组件自持的捕获期外点收起逻辑对两侧同时生效。只有输入框类名按行型注入
//（ai-provider-model / asr-provider-model），供收集/探针逻辑按行型取值。

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
  /** 可选共享外点收起控制器（如平台行模块级单实例）；省略时组合框自建并在 dispose 时销毁。 */
  dismissal?: OutsideClickDismissalController;
  /** 点击 toggle 是否由组合框直接开合（默认 true；异步拉取适配器传 false 自行编排点击）。 */
  bindToggleClick?: boolean;
  /** 选中模型并收起下拉后触发。 */
  onSelect?: (modelId: string) => void;
  /** 用户编辑主输入框触发。 */
  onInput?: () => void;
  /** 下拉由开转关时触发。 */
  onClose?: () => void;
  /** 输入框聚焦且下拉关闭时按 ArrowDown 的动作，默认打开下拉。 */
  onArrowDownOpen?: () => void;
  /** 选中选项后是否将焦点归还主输入框（默认 false）。 */
  focusInputOnSelect?: boolean;
  /** 外部中止信号：中止时自动 dispose。 */
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
  const doc = dropdown.ownerDocument || document;
  const optionToken = classes.optionClass.trim().split(/\s+/)[0] || "model-picker-option";
  const optionSelector = `.${optionToken}`;

  const abort = new AbortController();
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

  input.addEventListener("input", () => {
    if (!dropdown.hidden) {
      close(false);
    }
    config.onInput?.();
  }, { signal });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && dropdown.hidden) {
      e.preventDefault();
      if (config.onArrowDownOpen) {
        config.onArrowDownOpen();
      } else {
        open();
      }
    }
  }, { signal });

  if (config.bindToggleClick !== false) {
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isOpen()) {
        close(false);
      } else {
        open();
      }
    }, { signal });
  }

  dropdown.addEventListener("click", (e) => {
    const option = (e.target as HTMLElement | null)?.closest<HTMLElement>(optionSelector);
    if (!option || !option.dataset.model) return;
    e.stopPropagation();
    chooseOption(option);
  }, { signal });

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
    config.signal?.removeEventListener("abort", onExternalAbort);
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
  // 关联 label 与字段错误（省略 = 不写 id，行内复用同一控件的旧调用方不受影响）
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
      // 选值即输入：draft 模型（provider-editor 片 3）靠 input 事件回写真源
      modelInput.dispatchEvent(new Event("input", { bubbles: true }));
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
    const isStale = (): boolean =>
      !toggle.isConnected || !dropdown.isConnected || generation !== fetchGeneration || !combobox.isOpen();

    try {
      // 手势同步链：本次点击直达代申请（此前零 await，见 tests/ui/
      // options-save-gesture.test.ts 的调用方扫描），拒绝则只在下拉内提示。
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
      const message = (error as Error).message;
      combobox.renderMessage(
        message && message.includes("port closed") ? "连接中断，请重试" : (message || "拉取失败"),
        "error"
      );
    } finally {
      if (generation === fetchGeneration) {
        fetchInFlight = false;
      }
    }
  });
}

export function closeAllModelDropdowns(): void {
  document.querySelectorAll<HTMLElement>(".ai-provider-model-dropdown").forEach((dropdown) => {
    dropdown.hidden = true;
  });
  document.querySelectorAll<HTMLElement>(".ai-provider-model-toggle").forEach((toggle) => {
    toggle.setAttribute("aria-expanded", "false");
  });
  modelDropdownDismissal.sync();
}
