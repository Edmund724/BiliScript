// 自定义下拉组件（ADR-0007：设置页下拉统一到本组件）。原生 select 仍是值源
// 与表单收集链，组件只做展示与交互壳；listbox 键盘与 ARIA 语义在组件内自持：
// trigger 上 Enter/Space 展开，↑/↓ 在选项间漫游（首尾不循环），Home/End 跳首尾，
// Enter/Space 选中并关闭，Esc 关闭归焦 trigger，Tab 关闭并正常离开。
//
// 组件表随组件走（2026-10 从 reader-settings-{rows,shell,providers}.css 抽出）：
// 模块求值即挂 link，设置抽屉与阅读面板两侧都不再依赖 settings-panel chunk 的装载
// 时机（settings-panel.ts 顶挂载同款先例）。
import { ensureCustomSelectStyles } from "../shared/style-injector.js";

ensureCustomSelectStyles();

let customSelectSeq = 0;

// 已初始化 select 的壳内部操作（initCustomSelect 建壳时登记）：
// - rebuild：重读原生选项、重建 listbox 项、按现值重派生显示（rebuildCustomSelectOptions 的壳内实现）。
// - syncDisplay：仅按现值重派生显示（setCustomSelectValue 外部写值入口消费）。
// - state：禁用/忙碌状态写到壳（setCustomSelectState 的壳内实现）。
// 未初始化的 select 查不到，三条路径都退化为「空操作 / 裸写原生 select」。
const shellOps = new WeakMap<
  HTMLSelectElement,
  { rebuild: () => void; syncDisplay: () => void; state: (next: CustomSelectState) => void }
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
// 是程序化写值，派发会被即时保存监听（readerThemeFamily 的 change 即落盘）误判成
// 用户改选；change 只属于用户选中。未初始化的 select 只写值：initCustomSelect
// 随后按现值派生显示，故「先写值后初始化」与「先初始化后写值」同一条路径。
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
  ops.rebuild();
  if (!hadListFocus || !dropdown) return;
  // 按现值重认一项（值不在新集合里则回落首项，与 openList 同口径）：整批 <li> 已换新，
  // 旧焦点节点已脱离文档。逐项比对而不是选择器插值，免去 CSS.escape 依赖与转义坑。
  const options = Array.from(dropdown.querySelectorAll<HTMLElement>(".custom-select-option"));
  (options.find((option) => option.dataset.value === select.value) ?? options[0])?.focus();
}

// 关闭全部下拉并同步 aria-expanded（外点关闭委托与组件内切换共用，避免
// hidden 复位了 aria 没复位）
export function closeAllCustomSelects(except?: HTMLElement): void {
  document.querySelectorAll<HTMLElement>(".custom-select-dropdown").forEach((dropdown) => {
    if (dropdown === except) return;
    dropdown.hidden = true;
    dropdown.closest(".custom-select-wrapper")?.querySelector<HTMLButtonElement>(".custom-select-trigger")?.setAttribute("aria-expanded", "false");
  });
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

export function initCustomSelect(select: HTMLSelectElement, wrapperClass = "custom-select-wrapper"): void {
  if (select.dataset.customSelectInitialized === "1") return;
  select.dataset.customSelectInitialized = "1";

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
  // 重读原生 select.options，重建 listbox 项，再按写入后的实际值重派生显示
  // （「显示 = 现值」不变式对换选项集同样成立）。这是 init 与 rebuildCustomSelectOptions
  // 唯一的项集入口。
  const refreshOptionNodes = (): void => {
    dropdown.replaceChildren();
    optionNodes = Array.from(select.options).map((option) => {
      const li = buildOptionNode(option);
      dropdown.appendChild(li);
      return li;
    });
    syncDisplayFromValue();
  };

  // 建壳即铺一次项集（替代旧的 init 内联 forEach）；此时列表收起，不动焦点。
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
  // setCustomSelectState 都从这里取壳内部件，「壳不重建」由三者共用同一批
  // optionNodes / trigger / dropdown 保证。
  shellOps.set(select, { rebuild: refreshOptionNodes, syncDisplay: syncDisplayFromValue, state: applyState });

  // 展开时收掉同族其它下拉（外点关闭委托只管 click，键盘路径在此自持）
  const openList = (): void => {
    if (trigger.disabled) return; // 禁用是真守卫：键盘/程序化 click 都不展开（指针事件挡不住这两条）
    closeAllCustomSelects(dropdown);
    dropdown.hidden = false;
    setExpanded(true);
    (optionNodes.find((o) => o.dataset.selected === "true") || optionNodes[0])?.focus();
  };

  const closeList = (refocusTrigger: boolean): void => {
    dropdown.hidden = true;
    setExpanded(false);
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

  dropdown.addEventListener("keydown", (e) => {
    if (trigger.disabled) return; // 禁用时列表不该在场上；万一在，漫游/选中也一律挡住
    const active = document.activeElement;
    const current = active instanceof HTMLLIElement && optionNodes.includes(active)
      ? optionNodes.indexOf(active)
      : optionNodes.findIndex((o) => o.dataset.selected === "true");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown"
        ? optionNodes[Math.min(optionNodes.length - 1, current + 1)]
        : optionNodes[Math.max(0, current - 1)];
      next?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      optionNodes[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      optionNodes[optionNodes.length - 1]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const option = optionNodes[current];
      if (option) chooseOption(option);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeList(true);
    } else if (e.key === "Tab") {
      // 收拢列表并把焦点交还 trigger（不 preventDefault）：焦点还在已隐藏的 li 上时
      // 会掉回 body，默认 Tab 就会从 body 重新起算（跳到文档第一个控件）而不是续行
      closeList(true);
    }
  });

  dropdown.addEventListener("click", (e) => {
    const option = (e.target as HTMLElement).closest<HTMLElement>(".custom-select-option");
    if (!option) return;
    e.stopPropagation();
    chooseOption(option);
  });
}
