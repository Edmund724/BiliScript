import { getActiveReaderDocument, onActiveHostChange } from "../shared/active-host.js";
import {
  dispatchCrossDocEvent,
  isElementNode,
  isHtmlElement,
  isTagElement,
  resolveNodeDocument,
  resolveNodeWindow,
  safeRemoveListener,
} from "../shared/cross-doc.js";
import { ensureCustomSelectStyles } from "../shared/style-injector.js";
import { READING_CHEVRON_DOWN_ICON } from "./reading-icons.js";

ensureCustomSelectStyles();

let customSelectSeq = 0;

const shellOps = new WeakMap<
  HTMLSelectElement,
  {
    rebuild: () => HTMLLIElement[];
    syncDisplay: () => void;
    state: (next: CustomSelectState) => void;
    slots: (next: CustomSelectSlots) => void;
    dismiss: () => void;
  }
>();

export interface CustomSelectState {
  disabled?: boolean;
  busy?: boolean;
}

export function setCustomSelectValue(select: HTMLSelectElement, value: string): void {
  select.value = value;
  shellOps.get(select)?.syncDisplay();
}

export function setCustomSelectState(select: HTMLSelectElement, next: CustomSelectState): void {
  shellOps.get(select)?.state(next);
}

export interface CustomSelectSlots {
  optionsHost?: HTMLElement;
  extras?: readonly HTMLElement[];
  triggerExtra?: HTMLElement | null;
}

export function setCustomSelectSlots(select: HTMLSelectElement, slots: CustomSelectSlots): void {
  shellOps.get(select)?.slots(slots);
}

export function rebuildCustomSelectOptions(select: HTMLSelectElement): void {
  const ops = shellOps.get(select);
  if (!ops) return;
  const wrapper = select.closest<HTMLElement>(".custom-select-wrapper");
  const dropdown = wrapper?.querySelector<HTMLElement>(".custom-select-dropdown");
  const doc = resolveNodeDocument(select);
  const active = doc.activeElement;
  const hadListFocus = !!dropdown && !dropdown.hidden && isHtmlElement(active) && dropdown.contains(active);
  const options = ops.rebuild();
  if (!hadListFocus || !dropdown) return;
  if (dropdown.querySelector(".custom-select-search-input") === doc.activeElement) return;
  (options.find((option) => option.dataset.value === select.value) ?? options[0])?.focus();
}

export function closeAllCustomSelects(except?: HTMLElement): void {
  getActiveReaderDocument()
    .querySelectorAll<HTMLElement>('.custom-select-dropdown:not([data-inline="true"])')
    .forEach((dropdown) => {
      if (dropdown === except) return;
      dropdown.hidden = true;
      dropdown.closest(".custom-select-wrapper")?.querySelector<HTMLButtonElement>(".custom-select-trigger")?.setAttribute("aria-expanded", "false");
    });
  customSelectDismissal.sync();
}

export interface OutsideClickDismissalConfig {
  wrapperSelector: string;
  openDropdownSelector: string;
  triggerSelector: string;
  closeAll: () => void;
  closeOnEscape?: (dropdown: HTMLElement) => void;
}

export interface OutsideClickDismissalController {
  observeDropdown: (dropdown: HTMLElement) => void;
  sync: () => void;
  dispose: () => void;
}

export function createOutsideClickDismissal({
  wrapperSelector,
  openDropdownSelector,
  triggerSelector,
  closeAll,
  closeOnEscape
}: OutsideClickDismissalConfig): OutsideClickDismissalController {
  const observedDropdowns = new WeakSet<HTMLElement>();
  const trackedDropdowns = new Set<HTMLElement>();
  const openDropdowns = new Set<HTMLElement>();
  let listening = false;
  let boundDoc: Document | null = null;
  let disposed = false;

  const detachListeners = (): void => {
    if (!listening) return;
    safeRemoveListener(boundDoc, "click", onDocumentClickCapture, true);
    safeRemoveListener(boundDoc, "keydown", onDocumentKeyDownCapture, true);
    boundDoc = null;
    listening = false;
  };

  const attachListeners = (doc: Document): void => {
    boundDoc = doc;
    boundDoc.addEventListener("click", onDocumentClickCapture, true);
    boundDoc.addEventListener("keydown", onDocumentKeyDownCapture, true);
    listening = true;
  };

  const sync = (): void => {
    if (disposed) return;
    for (const node of [...trackedDropdowns]) {
      try {
        if (!node.isConnected) {
          trackedDropdowns.delete(node);
          openDropdowns.delete(node);
          continue;
        }
        if (node.hidden) {
          openDropdowns.delete(node);
        } else {
          openDropdowns.add(node);
        }
      } catch {
        trackedDropdowns.delete(node);
        openDropdowns.delete(node);
      }
    }
    for (const node of [...openDropdowns]) {
      try {
        if (node.hidden || !node.isConnected) {
          openDropdowns.delete(node);
        }
      } catch {
        openDropdowns.delete(node);
      }
    }
    const activeDoc = getActiveReaderDocument();
    const hasOpen = openDropdowns.size > 0 || activeDoc.querySelector(openDropdownSelector) !== null;
    if (hasOpen) {
      if (!listening) {
        attachListeners(activeDoc);
      } else if (boundDoc !== activeDoc) {
        detachListeners();
        attachListeners(activeDoc);
      }
    } else if (listening) {
      detachListeners();
    }
  };

  const observersByCtor = new Map<typeof MutationObserver, MutationObserver>();

  const getDropdownObserver = (dropdown: HTMLElement): MutationObserver | null => {
    const win = resolveNodeWindow(dropdown) as Window & {
      MutationObserver?: typeof MutationObserver;
    };
    const Ctor =
      win?.MutationObserver ??
      (typeof MutationObserver === "function" ? MutationObserver : undefined);
    if (typeof Ctor !== "function") {
      return null;
    }
    const existing = observersByCtor.get(Ctor);
    if (existing) {
      return existing;
    }
    const observer = new Ctor((records) => {
      if (disposed) return;
      for (const record of records) {
        try {
          const target = record.target;
          if (!isHtmlElement(target)) continue;
          if (target.hidden || !target.isConnected) {
            openDropdowns.delete(target);
          } else {
            openDropdowns.add(target);
          }
        } catch {
        }
      }
      sync();
    });
    observersByCtor.set(Ctor, observer);
    return observer;
  };

  const onDocumentClickCapture = (event: MouseEvent): void => {
    const activeDoc = getActiveReaderDocument();
    if (activeDoc.querySelector(openDropdownSelector) === null) {
      sync();
      return;
    }
    if (isElementNode(event.target) && event.target.closest(wrapperSelector)) return;
    event.stopImmediatePropagation();
    closeAll();
    sync();
  };

  const onDocumentKeyDownCapture = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    const activeDoc = getActiveReaderDocument();
    const dropdown = activeDoc.querySelector<HTMLElement>(openDropdownSelector);
    if (!dropdown) {
      sync();
      return;
    }
    const trigger = dropdown.closest(wrapperSelector)?.querySelector<HTMLElement>(triggerSelector) ?? null;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (closeOnEscape) {
      closeOnEscape(dropdown);
    } else {
      closeAll();
    }
    sync();
    trigger?.focus({ preventScroll: true });
    if (isHtmlElement(activeDoc.activeElement) && dropdown.contains(activeDoc.activeElement)) {
      activeDoc.activeElement.blur();
    }
  };

  const stopHostWatch = onActiveHostChange(() => {
    if (disposed) return;
    detachListeners();
    for (const node of [...trackedDropdowns]) {
      try {
        if (!node.isConnected) {
          trackedDropdowns.delete(node);
          openDropdowns.delete(node);
          continue;
        }
        if (!node.hidden) {
          node.hidden = true;
          node.closest(wrapperSelector)?.querySelector<HTMLElement>(triggerSelector)?.setAttribute("aria-expanded", "false");
        }
      } catch {
        trackedDropdowns.delete(node);
        openDropdowns.delete(node);
      }
    }
    for (const node of [...openDropdowns]) {
      try {
        if (!node.hidden) {
          node.hidden = true;
          node.closest(wrapperSelector)?.querySelector<HTMLElement>(triggerSelector)?.setAttribute("aria-expanded", "false");
        }
      } catch {
      }
    }
    openDropdowns.clear();
    closeAll();
    sync();
  });

  const observeDropdown = (dropdown: HTMLElement): void => {
    if (disposed) return;
    trackedDropdowns.add(dropdown);
    if (observedDropdowns.has(dropdown)) {
      if (!dropdown.hidden) openDropdowns.add(dropdown);
      sync();
      return;
    }
    observedDropdowns.add(dropdown);
    try {
      getDropdownObserver(dropdown)?.observe(dropdown, {
        attributes: true,
        attributeFilter: ["hidden"]
      });
    } catch {
    }
    if (!dropdown.hidden) {
      openDropdowns.add(dropdown);
    }
    sync();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stopHostWatch();
    for (const observer of observersByCtor.values()) {
      try {
        observer.disconnect();
      } catch {
      }
    }
    observersByCtor.clear();
    trackedDropdowns.clear();
    openDropdowns.clear();
    detachListeners();
  };

  return { observeDropdown, sync, dispose };
}

const customSelectDismissal = createOutsideClickDismissal({
  wrapperSelector: ".custom-select-wrapper",
  openDropdownSelector: '.custom-select-dropdown:not([hidden]):not([data-inline="true"])',
  triggerSelector: ".custom-select-trigger",
  closeAll: () => closeAllCustomSelects(),
  closeOnEscape: (dropdown) => {
    const select = dropdown.closest(".custom-select-wrapper")?.querySelector<HTMLSelectElement>("select");
    const dismiss = select ? shellOps.get(select)?.dismiss : undefined;
    if (dismiss) {
      dismiss();
    } else {
      closeAllCustomSelects();
    }
  }
});

export interface SearchableOptionListConfig {
  dropdown: HTMLElement;
  searchItemClass: string;
  searchInputClass: string;
  placeholder: string;
  ariaLabel: string;
  emptyItemClass: string;
  getOptions: () => HTMLLIElement[];
  isSearchEnabled: () => boolean;
  onSelect: (option: HTMLLIElement) => void;
  onClose: (refocusTrigger: boolean) => void;
  onTab?: () => void;
  isDisabled?: () => boolean;
  preferSelectedOnSearchEnter?: boolean;
  fallbackToSelectedOnRove?: boolean;
  enableHomeEnd?: boolean;
  enableSpaceSelect?: boolean;
  onFilter?: (visibleCount: number, totalCount: number, keyword: string) => void;
  signal?: AbortSignal;
}

export interface SearchableOptionListController {
  readonly searchItem: HTMLLIElement;
  readonly searchInput: HTMLInputElement;
  readonly emptyItem: HTMLLIElement;
  isSearchEnabled: () => boolean;
  filter: () => void;
  reset: () => void;
  syncHost: (host: HTMLElement) => void;
}

export function createSearchableOptionList(config: SearchableOptionListConfig): SearchableOptionListController {
  const doc = resolveNodeDocument(config.dropdown);
  const searchItem = doc.createElement("li");
  searchItem.className = config.searchItemClass;
  searchItem.setAttribute("role", "presentation");
  const searchInput = doc.createElement("input");
  searchInput.type = "text";
  searchInput.className = config.searchInputClass;
  searchInput.placeholder = config.placeholder;
  searchInput.setAttribute("aria-label", config.ariaLabel);
  searchInput.autocomplete = "off";
  searchInput.spellcheck = false;
  searchItem.appendChild(searchInput);

  const emptyItem = doc.createElement("li");
  emptyItem.className = config.emptyItemClass;
  emptyItem.setAttribute("role", "presentation");
  emptyItem.textContent = "无匹配选项";
  emptyItem.hidden = true;
  emptyItem.style.display = "none";

  const filter = (): void => {
    const kw = searchInput.value.trim().toLowerCase();
    const options = config.getOptions();
    let visibleCount = 0;
    options.forEach((node) => {
      const text = (node.textContent || "").toLowerCase();
      const match = !kw || text.includes(kw);
      node.hidden = !match;
      node.style.display = match ? "" : "none";
      if (match) visibleCount++;
    });
    emptyItem.hidden = visibleCount > 0;
    emptyItem.style.display = visibleCount > 0 ? "none" : "";
    config.onFilter?.(visibleCount, options.length, kw);
  };

  const reset = (): void => {
    if (!config.isSearchEnabled()) return;
    searchInput.value = "";
    config.getOptions().forEach((node) => {
      node.hidden = false;
      node.style.display = "";
    });
    emptyItem.hidden = true;
    emptyItem.style.display = "none";
  };

  const syncHost = (host: HTMLElement): void => {
    const enabled = config.isSearchEnabled();
    if (enabled) {
      if (searchItem.parentElement !== host) {
        host.prepend(searchItem);
      }
    } else {
      searchItem.remove();
    }
    config.getOptions().forEach((node) => {
      if (node.parentElement !== host) host.appendChild(node);
    });
    if (enabled) {
      if (emptyItem.parentElement !== host) {
        host.appendChild(emptyItem);
      }
    } else {
      emptyItem.remove();
    }
  };

  const onSearchClick = (e: MouseEvent): void => e.stopPropagation();
  const onSearchInput = (e: Event): void => {
    e.stopPropagation();
    filter();
  };
  const onSearchKeyDown = (e: KeyboardEvent): void => {
    if (config.isDisabled?.()) return;
    if (e.isComposing) return;
    const options = config.getOptions();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      options.find((o) => !o.hidden)?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target =
        (config.preferSelectedOnSearchEnter
          ? options.find((o) => !o.hidden && o.dataset.selected === "true")
          : undefined) || options.find((o) => !o.hidden);
      if (target) config.onSelect(target);
    } else if (e.key === "Escape") {
      e.preventDefault();
      config.onClose(true);
    } else if (e.key === "Tab") {
      config.onTab?.();
    }
  };

  function getOuterOpenDropdown(dropdown: HTMLElement): HTMLElement {
    let current = dropdown;
    while (true) {
      const parentDropdown = current.parentElement?.closest<HTMLElement>(".custom-select-dropdown:not([hidden])");
      if (!parentDropdown || parentDropdown === current) {
        return current;
      }
      current = parentDropdown;
    }
  }

  function isHiddenInScope(el: HTMLElement, scopeRoot: HTMLElement): boolean {
    let cur: HTMLElement | null = el;
    while (cur && cur !== scopeRoot) {
      if (cur.hidden) {
        return true;
      }
      cur = cur.parentElement;
    }
    return Boolean(scopeRoot.hidden);
  }

  function getVisibleOptionColumns(scopeRoot: HTMLElement): HTMLElement[] {
    const candidates = Array.from(
      scopeRoot.querySelectorAll<HTMLElement>(".custom-select-list, .biliscript-bilingual-list, .custom-select-dropdown")
    );
    return candidates.filter((col) => {
      if (isHiddenInScope(col, scopeRoot)) return false;
      return Array.from(col.querySelectorAll<HTMLElement>(".custom-select-option")).some(
        (opt) =>
          !opt.hidden &&
          opt.getAttribute("aria-disabled") !== "true" &&
          opt.closest(".custom-select-list, .biliscript-bilingual-list, .custom-select-dropdown") === col
      );
    });
  }

  function getPreferredColumnOption(column: HTMLElement): HTMLElement | null {
    const options = Array.from(column.querySelectorAll<HTMLElement>(".custom-select-option")).filter(
      (opt) =>
        !opt.hidden &&
        opt.getAttribute("aria-disabled") !== "true" &&
        opt.closest(".custom-select-list, .biliscript-bilingual-list, .custom-select-dropdown") === column
    );
    return options.find((opt) => opt.dataset.selected === "true") ?? options[0] ?? null;
  }

  function getInternalTabbables(scopeRoot: HTMLElement): HTMLElement[] {
    const selector =
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(scopeRoot.querySelectorAll<HTMLElement>(selector)).filter((el) => {
      if (el.getAttribute("aria-disabled") === "true") return false;
      if (isHiddenInScope(el, scopeRoot)) return false;
      if (el.classList.contains("custom-select-trigger")) return false;
      return true;
    });
  }

  const onDropdownKeyDown = (e: KeyboardEvent): void => {
    if (config.isDisabled?.()) return;
    const activeDoc = resolveNodeDocument(config.dropdown);
    if (activeDoc.activeElement === searchInput) return;
    const outerDropdown = getOuterOpenDropdown(config.dropdown);
    const isNested = outerDropdown !== config.dropdown;
    const active = activeDoc.activeElement;
    const isForeignInteractiveControl =
      isHtmlElement(active) &&
      active !== config.dropdown &&
      config.dropdown.contains(active) &&
      !active.classList.contains("custom-select-option") &&
      !config.getOptions().includes(active as HTMLLIElement);

    if (e.key === "Escape") {
      if (isNested) return;
      e.preventDefault();
      config.onClose(true);
      return;
    }

    if (e.key === "Tab") {
      if (isNested) return;
      const tabbables = getInternalTabbables(outerDropdown);
      const hasTargetInside =
        isHtmlElement(active) && outerDropdown.contains(active)
          ? tabbables.some((el) => {
              if (el === active) return false;
              const pos = active.compareDocumentPosition(el);
              return e.shiftKey
                ? Boolean(pos & 2)
                : Boolean(pos & 4);
            })
          : false;
      if (!hasTargetInside) {
        config.onTab?.();
      }
      return;
    }

    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const columns = getVisibleOptionColumns(outerDropdown);
      if (columns.length > 1 && isHtmlElement(active)) {
        const currentCol = active.closest(".custom-select-list, .biliscript-bilingual-list, .custom-select-dropdown");
        const colIdx = isHtmlElement(currentCol) ? columns.indexOf(currentCol) : -1;
        if (colIdx !== -1) {
          const targetIdx = e.key === "ArrowRight" ? colIdx + 1 : colIdx - 1;
          if (targetIdx >= 0 && targetIdx < columns.length) {
            const targetOption = getPreferredColumnOption(columns[targetIdx]);
            if (targetOption) {
              e.preventDefault();
              e.stopPropagation();
              targetOption.focus();
            }
          }
        }
      }
      return;
    }

    if (isForeignInteractiveControl) {
      return;
    }

    const visibleOptions = config.getOptions().filter((o) => !o.hidden);
    if (visibleOptions.length === 0) {
      return;
    }
    const current =
      isTagElement(active, "li") && visibleOptions.includes(active)
        ? visibleOptions.indexOf(active)
        : config.fallbackToSelectedOnRove
          ? visibleOptions.findIndex((o) => o.dataset.selected === "true")
          : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (isNested) e.stopPropagation();
      if (e.key === "ArrowUp" && current <= 0) {
        if (config.isSearchEnabled()) {
          searchInput.focus();
        } else if (current === 0) {
          visibleOptions[0]?.focus();
        }
      } else {
        const next =
          e.key === "ArrowDown"
            ? visibleOptions[Math.min(visibleOptions.length - 1, current === -1 ? 0 : current + 1)]
            : visibleOptions[Math.max(0, current - 1)];
        next?.focus();
      }
    } else if (e.key === "Home" && config.enableHomeEnd) {
      e.preventDefault();
      if (isNested) e.stopPropagation();
      visibleOptions[0]?.focus();
    } else if (e.key === "End" && config.enableHomeEnd) {
      e.preventDefault();
      if (isNested) e.stopPropagation();
      visibleOptions[visibleOptions.length - 1]?.focus();
    } else if (e.key === "Enter" || (e.key === " " && config.enableSpaceSelect)) {
      e.preventDefault();
      if (isNested) e.stopPropagation();
      const option = current >= 0 ? visibleOptions[current] : visibleOptions[0];
      if (option) config.onSelect(option);
    }
  };

  const cleanup = (): void => {
    safeRemoveListener(searchInput, "click", onSearchClick);
    safeRemoveListener(searchInput, "input", onSearchInput);
    safeRemoveListener(searchInput, "keydown", onSearchKeyDown);
    safeRemoveListener(config.dropdown, "keydown", onDropdownKeyDown);
    if (config.signal) {
      safeRemoveListener(config.signal, "abort", cleanup);
    }
  };

  if (!config.signal?.aborted) {
    searchInput.addEventListener("click", onSearchClick);
    searchInput.addEventListener("input", onSearchInput);
    searchInput.addEventListener("keydown", onSearchKeyDown);
    config.dropdown.addEventListener("keydown", onDropdownKeyDown);
    config.signal?.addEventListener("abort", cleanup, { once: true });
  }

  return {
    searchItem,
    searchInput,
    emptyItem,
    isSearchEnabled: config.isSearchEnabled,
    filter,
    reset,
    syncHost
  };
}

function resolveFieldLabel(select: HTMLSelectElement): HTMLLabelElement | null {
  const doc = resolveNodeDocument(select);
  const explicit = select.labels?.[0] ?? (select.id ? doc.querySelector<HTMLLabelElement>(`label[for="${select.id}"]`) : null);
  if (explicit) return explicit;
  const prev = select.previousElementSibling;
  return isTagElement(prev, "label") ? prev : null;
}

function buildOptionNode(option: HTMLOptionElement): HTMLLIElement {
  const li = resolveNodeDocument(option).createElement("li");
  li.className = "custom-select-option";
  li.dataset.value = option.value;
  if (option.dataset.triggerLabel) {
    li.dataset.triggerLabel = option.dataset.triggerLabel;
  }
  if (option.dir) {
    li.dir = option.dir;
  }
  li.textContent = option.textContent || option.value;
  li.setAttribute("role", "option");
  li.tabIndex = -1;
  const selected = option.selected;
  li.dataset.selected = selected ? "true" : "false";
  li.setAttribute("aria-selected", selected ? "true" : "false");
  return li;
}

export interface CustomSelectOptions {
  onChange?: (select: HTMLSelectElement) => void;
  searchable?: boolean;
  inline?: boolean;
}

export const CUSTOM_SELECT_SEARCH_THRESHOLD = 8;

export function initCustomSelect(
  select: HTMLSelectElement,
  wrapperClass = "custom-select-wrapper",
  options: CustomSelectOptions = {}
): void {
  if (select.dataset.customSelectInitialized === "1") return;
  select.dataset.customSelectInitialized = "1";

  const inline = options.inline === true;
  const onChange = options.onChange;
  if (onChange) {
    select.addEventListener("change", () => onChange(select));
  }

  const doc = resolveNodeDocument(select);
  const currentValue = select.value;

  const wrapper = doc.createElement("div");
  wrapper.className = wrapperClass;

  const trigger = doc.createElement("button");
  trigger.type = "button";
  trigger.className = "custom-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", inline ? "true" : "false");

  const fieldLabel = resolveFieldLabel(select);
  const selectLabel = select.getAttribute("aria-label");
  if (fieldLabel) {
    if (!fieldLabel.id) {
      fieldLabel.id = `custom-select-label-${++customSelectSeq}`;
    }
    trigger.id = `custom-select-trigger-${++customSelectSeq}`;
    fieldLabel.htmlFor = trigger.id;
  }

  const valueSpan = doc.createElement("span");
  valueSpan.className = "custom-select-value";
  if (fieldLabel) {
    valueSpan.id = `custom-select-value-${++customSelectSeq}`;
    trigger.setAttribute("aria-labelledby", `${fieldLabel.id} ${valueSpan.id}`);
  }
  const currentOption = Array.from(select.options).find((o) => o.value === currentValue) ?? select.options[0];
  valueSpan.textContent = currentOption?.dataset.triggerLabel || currentOption?.textContent || "";
  const syncLabelBasedName = (): void => {
    if (fieldLabel || !selectLabel) return;
    trigger.setAttribute("aria-label", `${selectLabel} ${valueSpan.textContent}`.trim());
  };
  syncLabelBasedName();

  const arrow = doc.createElement("span");
  arrow.className = "custom-select-arrow";
  arrow.innerHTML = READING_CHEVRON_DOWN_ICON;

  trigger.appendChild(valueSpan);
  trigger.appendChild(arrow);

  const dropdown = doc.createElement("ul");
  dropdown.className = "custom-select-dropdown";
  if (inline) {
    dropdown.dataset.inline = "true";
    dropdown.hidden = false;
  } else {
    dropdown.hidden = true;
  }
  dropdown.id = `custom-select-dropdown-${++customSelectSeq}`;
  dropdown.setAttribute("role", "listbox");
  if (fieldLabel) {
    dropdown.setAttribute("aria-labelledby", fieldLabel.id);
  } else if (selectLabel) {
    dropdown.setAttribute("aria-label", selectLabel);
  }
  trigger.setAttribute("aria-controls", dropdown.id);

  let optionNodes: HTMLLIElement[] = [];

  select.parentElement!.insertBefore(wrapper, select);
  wrapper.appendChild(select);
  select.style.display = "none";
  wrapper.appendChild(trigger);
  wrapper.appendChild(dropdown);
  if (!inline) {
    customSelectDismissal.observeDropdown(dropdown);
  }

  const setExpanded = (open: boolean): void => {
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
  };

  const markSelected = (option: HTMLElement): void => {
    optionNodes.forEach((o) => {
      o.dataset.selected = "false";
      o.setAttribute("aria-selected", "false");
    });
    option.dataset.selected = "true";
    option.setAttribute("aria-selected", "true");
  };

  const syncDisplayFromValue = (): void => {
    const option = optionNodes.find((o) => o.dataset.value === select.value);
    const active = option ?? optionNodes[0];
    if (option) {
      valueSpan.textContent = option.dataset.triggerLabel || option.textContent || "";
      markSelected(option);
    } else {
      valueSpan.textContent = optionNodes[0]?.dataset.triggerLabel || optionNodes[0]?.textContent || "";
      optionNodes.forEach((o) => {
        o.dataset.selected = "false";
        o.setAttribute("aria-selected", "false");
      });
    }
    if (active?.dir) {
      valueSpan.dir = active.dir;
    } else {
      valueSpan.removeAttribute("dir");
    }
    syncLabelBasedName();
  };
  let slots: CustomSelectSlots = {};
  let placedTriggerExtra: HTMLElement | null = null;

  const shouldEnableSearch = (): boolean =>
    options.searchable !== undefined
      ? options.searchable
      : select.options.length >= CUSTOM_SELECT_SEARCH_THRESHOLD;

  const closeList = (refocusTrigger: boolean): void => {
    if (inline) {
      searchableList.reset();
      return;
    }
    dropdown.hidden = true;
    customSelectDismissal.sync();
    setExpanded(false);
    searchableList.reset();
    if (!refocusTrigger) return;
    trigger.focus({ preventScroll: true });
    const activeEl = resolveNodeDocument(dropdown).activeElement;
    if (isHtmlElement(activeEl) && dropdown.contains(activeEl)) {
      activeEl.blur();
    }
  };

  const chooseOption = (option: HTMLElement): void => {
    const value = option.dataset.value;
    if (value === undefined) return;
    setCustomSelectValue(select, value);
    closeList(true);
    dispatchCrossDocEvent(select, "change", { bubbles: true });
  };

  const searchableList = createSearchableOptionList({
    dropdown,
    searchItemClass: "custom-select-search-item",
    searchInputClass: "custom-select-search-input",
    placeholder: "搜索...",
    ariaLabel: "搜索选项",
    emptyItemClass: "custom-select-empty",
    getOptions: () => optionNodes,
    isSearchEnabled: shouldEnableSearch,
    onSelect: chooseOption,
    onClose: closeList,
    onTab: () => closeList(true),
    isDisabled: () => trigger.disabled,
    preferSelectedOnSearchEnter: true,
    fallbackToSelectedOnRove: true,
    enableHomeEnd: true,
    enableSpaceSelect: true
  });

  const applySlots = (): void => {
    (slots.extras ?? []).forEach((extra) => {
      if (extra.parentElement !== dropdown) dropdown.appendChild(extra);
    });
    const triggerExtra = slots.triggerExtra ?? null;
    if (placedTriggerExtra && placedTriggerExtra !== triggerExtra) {
      if (placedTriggerExtra.id && trigger.getAttribute("aria-describedby") === placedTriggerExtra.id) {
        trigger.removeAttribute("aria-describedby");
      }
      placedTriggerExtra.remove();
    }
    placedTriggerExtra = triggerExtra;
    if (triggerExtra) {
      if (triggerExtra.parentElement !== trigger) trigger.insertBefore(triggerExtra, arrow);
      if (triggerExtra.id) trigger.setAttribute("aria-describedby", triggerExtra.id);
    }
    const host = slots.optionsHost ?? dropdown;
    searchableList.syncHost(host);
  };

  const refreshOptionNodes = (): HTMLLIElement[] => {
    optionNodes.forEach((node) => node.remove());
    optionNodes = Array.from(select.options).map((option) => buildOptionNode(option));
    applySlots();
    syncDisplayFromValue();
    return optionNodes;
  };

  refreshOptionNodes();

  const applyState = (next: CustomSelectState): void => {
    if (next.disabled !== undefined) {
      trigger.disabled = next.disabled;
      select.disabled = next.disabled;
      if (next.disabled && !inline) closeList(true);
    }
    if (next.busy !== undefined) {
      trigger.setAttribute("aria-busy", next.busy ? "true" : "false");
    }
  };

  shellOps.set(select, {
    rebuild: refreshOptionNodes,
    syncDisplay: syncDisplayFromValue,
    state: applyState,
    slots: (next) => {
      slots = next;
      applySlots();
    },
    dismiss: () => closeList(true)
  });

  const openList = (): void => {
    if (inline || trigger.disabled) return;
    closeAllCustomSelects(dropdown);
    dropdown.hidden = false;
    customSelectDismissal.sync();
    setExpanded(true);
    searchableList.reset();
    if (shouldEnableSearch()) {
      searchableList.searchInput.focus();
    } else {
      (optionNodes.find((o) => o.dataset.selected === "true") || optionNodes[0])?.focus();
    }
  };

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (inline || trigger.disabled) return;
    if (dropdown.hidden) {
      openList();
    } else {
      closeList(true);
    }
  });

  trigger.addEventListener("keydown", (e) => {
    if (inline || trigger.disabled) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openList();
    }
  });

  dropdown.addEventListener("click", (e) => {
    if (trigger.disabled) return;
    const option = (e.target as HTMLElement).closest<HTMLElement>(".custom-select-option");
    if (!option) return;
    e.stopPropagation();
    chooseOption(option);
  });
}
