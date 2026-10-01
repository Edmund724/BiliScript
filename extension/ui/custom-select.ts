// 自定义下拉组件（ADR-0007：设置页下拉统一到本组件）。原生 select 仍是值源
// 与表单收集链，组件只做展示与交互壳；listbox 键盘与 ARIA 语义在组件内自持：
// trigger 上 Enter/Space 展开，↑/↓ 在选项间漫游（首尾不循环），Home/End 跳首尾，
// Enter/Space 选中并关闭，Esc 关闭归焦 trigger，Tab 关闭并正常离开。

let customSelectSeq = 0;

// 已初始化 select 的「按现值重派生显示」函数（initCustomSelect 建壳时登记）：
// 未初始化的 select 查不到，外部写值退化为裸写原生 select。
const displaySyncs = new WeakMap<HTMLSelectElement, () => void>();

// 外部写值的唯一入口（ADR-0007 修订）：与 chooseOption 共用同一条「写值 + 同步
// 显示」路径，「显示 = 现值」由此成为组件内部不变式。不 dispatch change——水合
// 是程序化写值，派发会被即时保存监听（readerThemeFamily 的 change 即落盘）误判成
// 用户改选；change 只属于用户选中。未初始化的 select 只写值：initCustomSelect
// 随后按现值派生显示，故「先写值后初始化」与「先初始化后写值」同一条路径。
export function setCustomSelectValue(select: HTMLSelectElement, value: string): void {
  select.value = value;
  displaySyncs.get(select)?.();
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

export function initCustomSelect(select: HTMLSelectElement, wrapperClass = "custom-select-wrapper"): void {
  if (select.dataset.customSelectInitialized === "1") return;
  select.dataset.customSelectInitialized = "1";

  const options = Array.from(select.options).map((o) => ({
    value: o.value,
    label: o.textContent || o.value,
    selected: o.selected
  }));

  const currentValue = select.value;

  const wrapper = document.createElement("div");
  wrapper.className = wrapperClass;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "custom-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  // 可访问名落在 trigger 上：隐藏 select 退出无障碍树后，label[for] 指向一个用户
  // 碰不到的控件，只念当前值（"SRT，按钮"）等于丢了「这是哪个设置」。名字由
  // 「字段标签 + 当前值」两个节点拼成，值改名字自动重算，无需在写回处同步。
  const fieldLabel = resolveFieldLabel(select);
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
  const currentOption = options.find((o) => o.value === currentValue) || options[0];
  valueSpan.textContent = currentOption?.label || "";

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
  const selectLabel = select.getAttribute("aria-label");
  if (fieldLabel) {
    dropdown.setAttribute("aria-labelledby", fieldLabel.id);
  } else if (selectLabel) {
    dropdown.setAttribute("aria-label", selectLabel);
  }
  trigger.setAttribute("aria-controls", dropdown.id);

  options.forEach((opt) => {
    const li = document.createElement("li");
    li.className = "custom-select-option";
    li.dataset.value = opt.value;
    li.textContent = opt.label;
    li.setAttribute("role", "option");
    li.tabIndex = -1;
    if (opt.selected) {
      li.dataset.selected = "true";
      li.setAttribute("aria-selected", "true");
    } else {
      li.dataset.selected = "false";
      li.setAttribute("aria-selected", "false");
    }
    dropdown.appendChild(li);
  });

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

  const optionNodes = Array.from(dropdown.querySelectorAll<HTMLElement>(".custom-select-option"));

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
      return;
    }
    valueSpan.textContent = optionNodes[0]?.textContent || "";
    optionNodes.forEach((o) => {
      o.dataset.selected = "false";
      o.setAttribute("aria-selected", "false");
    });
  };
  displaySyncs.set(select, syncDisplayFromValue);

  // 展开时收掉同族其它下拉（外点关闭委托只管 click，键盘路径在此自持）
  const openList = (): void => {
    closeAllCustomSelects(dropdown);
    dropdown.hidden = false;
    setExpanded(true);
    (optionNodes.find((o) => o.dataset.selected === "true") || optionNodes[0])?.focus();
  };

  const closeList = (refocusTrigger: boolean): void => {
    dropdown.hidden = true;
    setExpanded(false);
    if (refocusTrigger) trigger.focus();
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
    if (dropdown.hidden) {
      openList();
    } else {
      closeList(true);
    }
  });

  trigger.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openList();
    }
  });

  dropdown.addEventListener("keydown", (e) => {
    const active = document.activeElement;
    const current = active instanceof HTMLElement && optionNodes.includes(active)
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
