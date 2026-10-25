// 自定义下拉组件（ADR-0007：设置页下拉统一到本组件）。原生 select 仍是值源
// 与表单收集链，组件只做展示与交互壳；listbox 键盘与 ARIA 语义在组件内自持：
// trigger 上 Enter/Space 展开，↑/↓ 在选项间漫游（首尾不循环），Home/End 跳首尾，
// Enter/Space 选中并关闭，Esc 关闭归焦 trigger，Tab 关闭并正常离开。
//
// 组件表随组件走（2026-10 从 reader-settings-{rows,shell,providers}.css 抽出）：
// 模块求值即挂 link，设置抽屉与阅读面板两侧都不再依赖 settings-panel chunk 的装载
// 时机（settings-panel.ts 顶挂载同款先例）。
//
// 浮层内容的所有权（2026-10 深化）：调用方可以声明「浮层里除选项行外还要挂什么」
//（setCustomSelectSlots：选项行落点 / 常驻节点 / trigger 插位）。组件换整批选项只摘
// 自己产出的 <li>，声明进来的节点全程不脱离文档——换项因此也不销毁浮层内的滚动位置
//（真机 run13：滚动位置不在节点身份里，子树一脱离文档 scrollTop 就归零）。调用方不
// 需要知道替换实现，也不需要自己快照滚动位置、自己按引用把卡片搬回去。
import { ensureCustomSelectStyles } from "../shared/style-injector.js";

ensureCustomSelectStyles();

let customSelectSeq = 0;

// 已初始化 select 的壳内部操作（initCustomSelect 建壳时登记）：
// - rebuild：重读原生选项、重建 listbox 项、按现值重派生显示，返回新那批项（rebuildCustomSelectOptions
//   的壳内实现；返回项集是为了让「打开态按现值重认焦点」只认组件自己的节点，不去浮层子树里按类名捞）。
// - syncDisplay：仅按现值重派生显示（setCustomSelectValue 外部写值入口消费）。
// - state：禁用/忙碌状态写到壳（setCustomSelectState 的壳内实现）。
// - slots：按声明把调用方的节点就位（setCustomSelectSlots 的壳内实现）。
// 未初始化的 select 查不到，四条路径都退化为「空操作 / 裸写原生 select」。
const shellOps = new WeakMap<
  HTMLSelectElement,
  {
    rebuild: () => HTMLLIElement[];
    syncDisplay: () => void;
    state: (next: CustomSelectState) => void;
    slots: (next: CustomSelectSlots) => void;
  }
>();

// 组件状态（禁用 / 忙碌）：二者相互独立——票 03 的状态机在切轨期间同时置两者
//（「busy + 禁用」），空态/转写中态只置 disabled。
export interface CustomSelectState {
  disabled?: boolean;
  /** 省略即保持现态；true 时写 trigger 的 aria-busy（组件表消费它出忙碌点）。 */
  busy?: boolean;
}

// 外部写值的唯一入口（ADR-0007 修订）：与 chooseOption 共用同一条「写值 + 同步
// 显示」路径，「显示 = 现值」由此成为组件内部不变式。不 dispatch change——水合
// 是程序化写值，派发会被即时保存监听（asrAutoFallback / webSearchMaxToolCalls 的
// change 即落盘）误判成用户改选；change 只属于用户选中。未初始化的 select 只写值：
// initCustomSelect 随后按现值派生显示，故「先写值后初始化」与「先初始化后写值」
// 同一条路径。
export function setCustomSelectValue(select: HTMLSelectElement, value: string): void {
  select.value = value;
  shellOps.get(select)?.syncDisplay();
}

// 组件状态的唯一入口（10 号票第 6 条 / 票 03 的状态机）：消费者不该去 poke 组件内部
// 的 trigger 节点，禁用与忙碌都由这里写。两件事各自独立、可分开置也可同时置：
// - disabled → trigger.disabled（真守卫：禁用时点击与键盘都不展开列表，见事件处理器里
//   的 disabled 早退；只靠 CSS pointer-events 挡不住键盘，也挡不住程序化 click）
//   + 同步 select.disabled（值源语义不变：collect* 仍读 .value，.value 不被本函数碰）。
// - busy → trigger 的 aria-busy，组件表消费它出忙碌点。
// 打开态中被置 disabled 时收拢列表（列表留在场上会与「不可用」自相矛盾），并尝试把
// 焦点交还 trigger——disabled 的按钮接不住焦点，此时焦点离开列表项、落回 body。
// 未初始化（含已销毁）退化为 no-op——与 rebuildCustomSelectOptions 同口径：
// 不建壳、不抛，也不写 select.disabled（无壳可同步）。
export function setCustomSelectState(select: HTMLSelectElement, next: CustomSelectState): void {
  shellOps.get(select)?.state(next);
}

// 浮层内容的槽位声明（第四条外部入口，2026-10 深化）：调用方声明「浮层里除选项行外
// 还要挂什么」，组件在每次重铺时按声明保留/重挂这些节点——消费者的节点从此不进组件的
// 换项实现（旧实现是 dropdown.replaceChildren()，把调用方挂进浮层/trigger 的节点一起
// 摘掉，逼消费方自己按引用搬回、自己快照滚动位置、自己按内部类名捞选项行）。
export interface CustomSelectSlots {
  // 选项行的落点（省略 = 弹层本体）：组件只在这里换自己产出的 <li>，不动这里别的节点。
  optionsHost?: HTMLElement;
  // 浮层里除选项行外要保留的节点（如卡片根）：按声明顺序常驻弹层本体下，重铺不摘、
  // 不在场则装回——组件的换项实现不碰它们的子树。组件从不摘调用方的节点：从声明里
  // 撤下的节点由调用方自己摘（triggerExtra 是唯一的例外，见下：那个插位只能坐一枚）。
  extras?: readonly HTMLElement[];
  // trigger 内的固定插位（如徽标）：放在值区之后、箭头之前；节点带 id 时由组件把它接上
  // trigger 的 aria-describedby。撤下（null / 省略）时把上一枚摘掉并清掉那条描述关系。
  triggerExtra?: HTMLElement | null;
}

// 槽位声明的唯一入口（与上面三条同形态）：整批声明、重复调用幂等，传入即生效（当次
// 就把声明里的节点就位、把选项行搬到新的落点）。省略/空声明 = 现状：选项行直接铺在
// 弹层本体下、浮层里没有别的节点。未初始化（含已销毁）退化为 no-op——不替调用方凭空
// 建壳，与 rebuildCustomSelectOptions / setCustomSelectState 同口径。
export function setCustomSelectSlots(select: HTMLSelectElement, slots: CustomSelectSlots): void {
  shellOps.get(select)?.slots(slots);
}

// 选项集在初始化之后变化的唯一入口（08 号票的必需前置：选轨控件每轮抓取/转写收尾
// 都要换整批选项，旧实现是每次重建原生 select；initCustomSelect 的
// dataset.customSelectInitialized === "1" 让重复 init 直接 return，故没有别的路径）。
// 职责边界：只重读 select.options 重建 listbox 项、按写入后的实际 select.value
// 重派生显示（沿用 syncDisplayFromValue 的「显示 = 现值」不变式）——**壳（trigger
// 元素、它的 id、aria-controls/aria-haspopup/aria-expanded/aria-labelledby 关系）
// 一律不重建**，调用方写进 trigger 的 disabled / aria-busy 等状态因此不会被抹掉。
// 打开状态下重建焦点会随项一起消失，故按现值重认一项（值不在新集合里则回落到首项，
// 与 openList 同口径）；收起态不动焦点。未初始化（含已销毁）退化为 no-op——不替调用方
// 凭空建壳（调用方按自己的时机 init，本函数只服务「已建壳后换项集」这一件事）。
export function rebuildCustomSelectOptions(select: HTMLSelectElement): void {
  const ops = shellOps.get(select);
  if (!ops) return;
  const wrapper = select.closest<HTMLElement>(".custom-select-wrapper");
  const dropdown = wrapper?.querySelector<HTMLElement>(".custom-select-dropdown");
  const hadListFocus = !!dropdown && !dropdown.hidden && document.activeElement instanceof HTMLElement && dropdown.contains(document.activeElement);
  const options = ops.rebuild();
  if (!hadListFocus || !dropdown) return;
  if (dropdown.querySelector(".custom-select-search-input") === document.activeElement) return;
  // 按现值重认一项（值不在新集合里则回落首项，与 openList 同口径）：整批 <li> 已换新，
  // 旧焦点节点已脱离文档。认的是组件自己那批节点——浮层子树里可能有调用方声明进来的
  // 内容，也可能嵌着另一枚组件壳（双语卡片的副列），按类名在子树里捞会捞错人。
  (options.find((option) => option.dataset.value === select.value) ?? options[0])?.focus();
}

// 关闭全部下拉并同步 aria-expanded（外点关闭与组件内切换共用，避免
// hidden 复位了 aria 没复位）
export function closeAllCustomSelects(except?: HTMLElement): void {
  document.querySelectorAll<HTMLElement>(".custom-select-dropdown").forEach((dropdown) => {
    if (dropdown === except) return;
    dropdown.hidden = true;
    dropdown.closest(".custom-select-wrapper")?.querySelector<HTMLButtonElement>(".custom-select-trigger")?.setAttribute("aria-expanded", "false");
  });
  customSelectDismissal.sync();
}

export interface OutsideClickDismissalConfig {
  wrapperSelector: string;
  openDropdownSelector: string;
  closeAll: () => void;
}

export interface OutsideClickDismissalController {
  observeDropdown: (dropdown: HTMLElement) => void;
  sync: () => void;
}

const nativeHiddenDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidden");

// 下拉弹层自持的捕获期外点收起控制器：仅在至少一枚弹层展开期间挂载 document
// capture click 监听，全部收起后立即卸载（常态全关时 document 零点击监听）；
// capture 阶段先于 Modal 等宿主的 bubble stopPropagation 触发，宿主无需重复代理。
export function createOutsideClickDismissal({
  wrapperSelector,
  openDropdownSelector,
  closeAll
}: OutsideClickDismissalConfig): OutsideClickDismissalController {
  const observedDropdowns = new WeakSet<HTMLElement>();
  const openDropdowns = new Set<HTMLElement>();
  let listening = false;

  const sync = (): void => {
    for (const node of openDropdowns) {
      if (node.hidden || !node.isConnected) {
        openDropdowns.delete(node);
      }
    }
    const hasOpen = openDropdowns.size > 0 || document.querySelector(openDropdownSelector) !== null;
    if (hasOpen && !listening) {
      document.addEventListener("click", onDocumentClickCapture, true);
      listening = true;
    } else if (!hasOpen && listening) {
      document.removeEventListener("click", onDocumentClickCapture, true);
      listening = false;
    }
  };

  const onDocumentClickCapture = (event: MouseEvent): void => {
    if (!(event.target instanceof Element) || !event.target.closest(wrapperSelector)) {
      closeAll();
    }
    sync();
  };

  const observeDropdown = (dropdown: HTMLElement): void => {
    if (observedDropdowns.has(dropdown)) {
      if (!dropdown.hidden) openDropdowns.add(dropdown);
      sync();
      return;
    }
    observedDropdowns.add(dropdown);
    if (nativeHiddenDescriptor?.get && nativeHiddenDescriptor?.set) {
      Object.defineProperty(dropdown, "hidden", {
        configurable: true,
        enumerable: nativeHiddenDescriptor.enumerable ?? true,
        get(this: HTMLElement) {
          return nativeHiddenDescriptor.get!.call(this);
        },
        set(this: HTMLElement, value: boolean) {
          nativeHiddenDescriptor.set!.call(this, value);
          if (this.hidden) {
            openDropdowns.delete(this);
          } else {
            openDropdowns.add(this);
          }
          sync();
        }
      });
    }
    if (!dropdown.hidden) {
      openDropdowns.add(dropdown);
    }
    sync();
  };

  return { observeDropdown, sync };
}

const customSelectDismissal = createOutsideClickDismissal({
  wrapperSelector: ".custom-select-wrapper",
  openDropdownSelector: ".custom-select-dropdown:not([hidden])",
  closeAll: () => closeAllCustomSelects()
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

// 可搜索选项列表与键盘漫游底座（custom-select 与 model-picker 共用）：
// 负责搜索输入框与「无匹配选项」占位项的挂载、大小写不敏感子串过滤、IME 合成态守卫，
// 以及搜索框与列表项之间的 ↑/↓/Home/End/Enter/Space/Escape/Tab 焦点漫游。
export function createSearchableOptionList(config: SearchableOptionListConfig): SearchableOptionListController {
  const searchItem = document.createElement("li");
  searchItem.className = config.searchItemClass;
  searchItem.setAttribute("role", "presentation");
  const searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.className = config.searchInputClass;
  searchInput.placeholder = config.placeholder;
  searchInput.setAttribute("aria-label", config.ariaLabel);
  searchInput.autocomplete = "off";
  searchInput.spellcheck = false;
  searchItem.appendChild(searchInput);

  const emptyItem = document.createElement("li");
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

  searchInput.addEventListener("click", (e) => e.stopPropagation());
  searchInput.addEventListener("input", (e) => {
    e.stopPropagation();
    filter();
  });
  searchInput.addEventListener("keydown", (e) => {
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
  });

  config.dropdown.addEventListener("keydown", (e) => {
    if (config.isDisabled?.()) return;
    if (document.activeElement === searchInput) return;
    const visibleOptions = config.getOptions().filter((o) => !o.hidden);
    if (visibleOptions.length === 0) {
      if (e.key === "Escape") {
        e.preventDefault();
        config.onClose(true);
      }
      return;
    }
    const active = document.activeElement;
    const current =
      active instanceof HTMLLIElement && visibleOptions.includes(active)
        ? visibleOptions.indexOf(active)
        : config.fallbackToSelectedOnRove
          ? visibleOptions.findIndex((o) => o.dataset.selected === "true")
          : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
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
      visibleOptions[0]?.focus();
    } else if (e.key === "End" && config.enableHomeEnd) {
      e.preventDefault();
      visibleOptions[visibleOptions.length - 1]?.focus();
    } else if (e.key === "Enter" || (e.key === " " && config.enableSpaceSelect)) {
      e.preventDefault();
      const option = current >= 0 ? visibleOptions[current] : visibleOptions[0];
      if (option) config.onSelect(option);
    } else if (e.key === "Escape") {
      e.preventDefault();
      config.onClose(true);
    } else if (e.key === "Tab") {
      config.onTab?.();
    }
  });

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

// 字段名的来路：显式 label（labels / label[for]）优先，否则认同级前置 label
// ——Modal 里的 label 既没有 for 也没包住 select，只能按位置认。
function resolveFieldLabel(select: HTMLSelectElement): HTMLLabelElement | null {
  const explicit = select.labels?.[0] ?? (select.id ? document.querySelector<HTMLLabelElement>(`label[for="${select.id}"]`) : null);
  if (explicit) return explicit;
  const prev = select.previousElementSibling;
  return prev instanceof HTMLLabelElement ? prev : null;
}

// 原生选项 → listbox 项（唯一产地，init 建壳与 rebuildCustomSelectOptions 共用）：
// 值一律进 dataset.value，选中态按原生 option.selected 写 data-selected + aria-selected。
function buildOptionNode(option: HTMLOptionElement): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "custom-select-option";
  li.dataset.value = option.value;
  li.textContent = option.textContent || option.value;
  li.setAttribute("role", "option");
  li.tabIndex = -1;
  const selected = option.selected;
  li.dataset.selected = selected ? "true" : "false";
  li.setAttribute("aria-selected", selected ? "true" : "false");
  return li;
}

// 建壳的可选接线：onChange 在建壳时就绑在原生 select 上（用户改选的那次 change 由
// 组件的 chooseOption 写值后派发），随壳一起存活——壳被整块重建时新节点随建壳重新
// 接线，调用方不必在渲染入口按节点去重补绑。省略 = 只建壳。
export interface CustomSelectOptions {
  onChange?: (select: HTMLSelectElement) => void;
  /** 是否启用搜索过滤。省略时自动按选项数 >= CUSTOM_SELECT_SEARCH_THRESHOLD 决定。 */
  searchable?: boolean;
}

/** 自动开启搜索的选项数量阈值 */
export const CUSTOM_SELECT_SEARCH_THRESHOLD = 8;

export function initCustomSelect(
  select: HTMLSelectElement,
  wrapperClass = "custom-select-wrapper",
  options: CustomSelectOptions = {}
): void {
  if (select.dataset.customSelectInitialized === "1") return;
  select.dataset.customSelectInitialized = "1";

  const onChange = options.onChange;
  if (onChange) {
    select.addEventListener("change", () => onChange(select));
  }

  const currentValue = select.value;

  const wrapper = document.createElement("div");
  wrapper.className = wrapperClass;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "custom-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  // 可访问名落在 trigger 上：隐藏 select 退出无障碍树后，label[for] 指向一个用户
  // 碰不到的控件，只念当前值（"SRT，按钮"）等于丢了「这是哪个设置」。字段名的两条
  // 来路：显式/同级 label，或 select 自带的 aria-label（阅读面板工具条的选轨控件
  // 没有字段 label，只有 aria-label）。名字恒为「字段名 + 当前值」。
  const fieldLabel = resolveFieldLabel(select);
  const selectLabel = select.getAttribute("aria-label");
  if (fieldLabel) {
    if (!fieldLabel.id) {
      fieldLabel.id = `custom-select-label-${++customSelectSeq}`;
    }
    // 标签的 for 就近重指到 trigger：不重指的话点标签会把焦点送进那个已
    // display:none 的隐藏 select（用户看不到任何反应）。select 自身的 id 保留，
    // byIdIn / collect* 系列仍按 id 取值。
    trigger.id = `custom-select-trigger-${++customSelectSeq}`;
    fieldLabel.htmlFor = trigger.id;
  }

  const valueSpan = document.createElement("span");
  valueSpan.className = "custom-select-value";
  if (fieldLabel) {
    valueSpan.id = `custom-select-value-${++customSelectSeq}`;
    trigger.setAttribute("aria-labelledby", `${fieldLabel.id} ${valueSpan.id}`);
  }
  const currentOption = Array.from(select.options).find((o) => o.value === currentValue) ?? select.options[0];
  valueSpan.textContent = currentOption?.textContent || "";
  // label 路径：名字由「字段标签 + 当前值」两个节点拼成（aria-labelledby），值改名字
  // 自动重算，无需在写回处同步。aria-label 路径：无字段 label 时用它当字段名，按
  // 「字段名 + 当前值」拼成 trigger 的 aria-label，随 syncDisplayFromValue 按现值重算。
  const syncLabelBasedName = (): void => {
    if (fieldLabel || !selectLabel) return;
    trigger.setAttribute("aria-label", `${selectLabel} ${valueSpan.textContent}`.trim());
  };
  syncLabelBasedName();

  const arrow = document.createElement("span");
  arrow.className = "custom-select-arrow";
  arrow.innerHTML = `<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>`;

  trigger.appendChild(valueSpan);
  trigger.appendChild(arrow);

  const dropdown = document.createElement("ul");
  dropdown.className = "custom-select-dropdown";
  dropdown.hidden = true;
  dropdown.id = `custom-select-dropdown-${++customSelectSeq}`;
  dropdown.setAttribute("role", "listbox");
  if (fieldLabel) {
    dropdown.setAttribute("aria-labelledby", fieldLabel.id);
  } else if (selectLabel) {
    dropdown.setAttribute("aria-label", selectLabel);
  }
  trigger.setAttribute("aria-controls", dropdown.id);

  // 当前 listbox 项集合：init 建壳与 rebuildCustomSelectOptions 都经
  // refreshOptionNodes 重建（重读 select.options），下面的键盘漫游、选中态与
  // 显示派生一律走本数组，故换整批选项后无需重建壳。
  let optionNodes: HTMLLIElement[] = [];

  select.parentElement!.insertBefore(wrapper, select);
  wrapper.appendChild(select);
  // 隐藏用内联样式：内联样式不进选择器特异性比较（只有宿主 !important 能压过），
  // 无需再跟宿主里 100%×32px 的原生 select 规则打特异性战争——旧的 1px 视觉隐藏靠
  // 提权补偿规则续命，CSS 拆分时丢一次就把原生 select 盖回 trigger 上。
  // display:none 天然退出无障碍树与 Tab 序，tabIndex / aria-hidden 由此冗余；
  // select 仍是值源，collect* 系列按 id 读 .value，不受影响。
  select.style.display = "none";
  wrapper.appendChild(trigger);
  wrapper.appendChild(dropdown);
  customSelectDismissal.observeDropdown(dropdown);

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

  // 显示是「原生 select 现值」的投影：文本与选中态都从写入后的实际 select.value
  // 派生（同值多选项取首个，与原生写值的选中规则一致），chooseOption 与外部
  // setCustomSelectValue 共用此路径。值不在选项里时镜像原生——写未知值时原生已
  // 把实际值变为 ""，这里随之无选中项、文本按 init 同款回落首项，不另造兜底。
  const syncDisplayFromValue = (): void => {
    const option = optionNodes.find((o) => o.dataset.value === select.value);
    if (option) {
      valueSpan.textContent = option.textContent || "";
      markSelected(option);
    } else {
      valueSpan.textContent = optionNodes[0]?.textContent || "";
      optionNodes.forEach((o) => {
        o.dataset.selected = "false";
        o.setAttribute("aria-selected", "false");
      });
    }
    // aria-label 路径的名字跟着值重算（label 路径由 aria-labelledby 自动重算）
    syncLabelBasedName();
  };
  // 槽位声明（setCustomSelectSlots 的壳内存储）：整批替换、重复调用幂等。默认空声明 =
  // 现状（选项行直接铺在弹层本体下，浮层里没有别的节点）。节点本身的生命周期归调用方。
  let slots: CustomSelectSlots = {};
  // trigger 插位当前就位的那一枚（换声明时摘旧的，见 applySlots）
  let placedTriggerExtra: HTMLElement | null = null;

  const shouldEnableSearch = (): boolean =>
    options.searchable !== undefined
      ? options.searchable
      : select.options.length >= CUSTOM_SELECT_SEARCH_THRESHOLD;

  const closeList = (refocusTrigger: boolean): void => {
    dropdown.hidden = true;
    setExpanded(false);
    searchableList.reset();
    if (!refocusTrigger) return;
    trigger.focus();
    // 归焦可能失败：trigger 被禁用时接不住焦点（原生行为），焦点会留在刚被隐藏的
    // <li> 上——那是「焦点在看不见的元素里」的陷阱。此时显式 blur，焦点落回 body，
    // 与「控件不可用」的语义一致（列表已收起、无可见焦点目标）。
    if (document.activeElement instanceof HTMLElement && dropdown.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  };

  const chooseOption = (option: HTMLElement): void => {
    const value = option.dataset.value;
    if (value === undefined) return;
    setCustomSelectValue(select, value);
    closeList(true);
    select.dispatchEvent(new Event("change", { bubbles: true }));
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
    // 收拢列表并把焦点交还 trigger（不 preventDefault）：焦点还在已隐藏的 li 上时
    // 会掉回 body，默认 Tab 就会从 body 重新起算（跳到文档第一个控件）而不是续行
    onTab: () => closeList(true),
    isDisabled: () => trigger.disabled,
    preferSelectedOnSearchEnter: true,
    fallbackToSelectedOnRove: true,
    enableHomeEnd: true,
    enableSpaceSelect: true
  });

  // 把声明里的槽位就位（幂等，不摘任何调用方的节点）：
  //   1. extras 按声明顺序常驻弹层本体（不在场则装回——调用方因此不必自己搬卡片）；
  //   2. triggerExtra 放值区之后、箭头之前，并把它接上 trigger 的 aria-describedby；
  //   3. 组件自己产出的选项行与搜索框/空态项搬到 optionsHost（省略 = 弹层本体）。
  // 全程只动组件自己的 <li> 与声明里的那一枚节点，不触碰调用方的子树：声明进来的节点
  // 在换项前后始终留在文档里，浮层内的滚动位置（滚动盒挂在这样的子树里）因此不会被
  // 销毁——这是组件自身的不变式，不再由消费方快照/恢复。
  const applySlots = (): void => {
    (slots.extras ?? []).forEach((extra) => {
      if (extra.parentElement !== dropdown) dropdown.appendChild(extra);
    });
    const triggerExtra = slots.triggerExtra ?? null;
    if (placedTriggerExtra && placedTriggerExtra !== triggerExtra) {
      // 撤下上一枚：只在 aria-describedby 仍指向它时清，不覆盖调用方自己的描述关系
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

  // 重读原生 select.options，重建 listbox 项，再按写入后的实际值重派生显示
  // （「显示 = 现值」不变式对换选项集同样成立）。这是 init 与 rebuildCustomSelectOptions
  // 唯一的项集入口，也是槽位就位的唯一时机（声明换了落点，下一次重铺即按新声明铺）。
  // 换项实现**不是** dropdown.replaceChildren()：那些 <li> 是组件自己的，浮层里的别的
  // 节点归调用方——只摘自己产出的项，声明进来的槽位节点原样留在场上（连带它们的滚动位置）。
  const refreshOptionNodes = (): HTMLLIElement[] => {
    optionNodes.forEach((node) => node.remove());
    optionNodes = Array.from(select.options).map((option) => buildOptionNode(option));
    applySlots();
    syncDisplayFromValue();
    return optionNodes;
  };

  // 建壳即铺一次项集；此时列表收起，不动焦点。
  refreshOptionNodes();

  // 禁用/忙碌状态写到壳（setCustomSelectState 的壳内实现）：省略的键保持现态，
  // 故 { busy: true } 不会顺手把 disabled 复位、反之亦然（二者相互独立）。
  // 顺序有意：先置 trigger.disabled 再收拢列表。若焦点正落在将被移除的 <li> 上，
  // closeList(true) 的 trigger.focus() 此刻会失败——disabled 的按钮在浏览器里接不住
  // 焦点（原生行为，非本组件的缺陷），焦点落到 body；这正是「控件不可用」该有的落点，
  // 故不为它绕路。列表本身必须收（不可用的控件不该把浮层留在场上）。
  const applyState = (next: CustomSelectState): void => {
    if (next.disabled !== undefined) {
      trigger.disabled = next.disabled;
      select.disabled = next.disabled;
      if (next.disabled) closeList(true);
    }
    if (next.busy !== undefined) {
      trigger.setAttribute("aria-busy", next.busy ? "true" : "false");
    }
  };

  // 壳内操作登记（组件内部唯一登记点）：setCustomSelectValue / rebuildCustomSelectOptions /
  // setCustomSelectState / setCustomSelectSlots 都从这里取壳内部件，「壳不重建」由四者
  // 共用同一批 optionNodes / trigger / dropdown 保证。
  shellOps.set(select, {
    rebuild: refreshOptionNodes,
    syncDisplay: syncDisplayFromValue,
    state: applyState,
    slots: (next) => {
      slots = next;
      applySlots();
    }
  });

  // 展开时收掉同族其它下拉
  const openList = (): void => {
    if (trigger.disabled) return; // 禁用是真守卫：键盘/程序化 click 都不展开（指针事件挡不住这两条）
    closeAllCustomSelects(dropdown);
    dropdown.hidden = false;
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
    if (trigger.disabled) return; // 禁用早退（原生在真浏览器里就不派发，jsdom 会派发）
    if (dropdown.hidden) {
      openList();
    } else {
      closeList(true);
    }
  });

  trigger.addEventListener("keydown", (e) => {
    if (trigger.disabled) return; // 同上：disabled 的 trigger 不响应开合键
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openList();
    }
  });

  dropdown.addEventListener("click", (e) => {
    const option = (e.target as HTMLElement).closest<HTMLElement>(".custom-select-option");
    if (!option) return;
    e.stopPropagation();
    chooseOption(option);
  });
}
