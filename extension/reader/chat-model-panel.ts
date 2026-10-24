// reader/chat-model-panel.ts — 模型 chip 与「模型 + 思考强度」面板的渲染
// （发送框重构新增）：chip 是隐藏 <select>（值源，providers 渲染选项、change
// 持久化链不变）的展示层；面板列表从 select 的 optgroup/option 派生，点击
// 选项 = 写 select.value 并派生 change（既有持久化/提示重判链原样复用，
// 不新开写路径）。面板的开合/互斥/外点/Esc 收口在 reader/chat-popovers.ts，
// 本模块只渲染，不持有开合状态。
//
// chip 内「平台名·模型名」与档位是两个独立 span：溢出截断只由 CSS 施加在
// 模型名 span，档位与 chevron 恒完整（model-select-width 只决定 chip 整体宽度，
// 不参与截断）。
//
// 面板结构：上部分组模型列表（滚动，点选模型写值源并立即关面板）；底部固定区
// 内联「思考强度 <当前值> + 右上角 ↻ 重置键（Default 不干预档）」与胶囊滑轨
// （真实档位数 ≥ 2，含 Off/On 开关型与多档型）/ 单档胶囊（真实档位数 = 1）/
// 仅标题行（真实档位数 = 0，ADR-0015 零档行照旧显示）。调整思考强度或点 ↻ 重置
// 只更新档位并保持面板打开。
// 条目、显示名与底部提示行（工单 03 的「关不掉」/ 05 号票的 clamp 说明）都由
// chat/thinking-picker 的 thinkingViewOf 从一次解析给出（开关型模型收成 Off/On），
// 本模块只负责画出来与交互接线，不自己推导档位、也不自己写提示文案与显隐。
//
// 依赖方向（无环）：共享状态（../chat/chat-state 的 aiThinkingLevel）与
// chat/model-select-width、chat/thinking-picker 的标签表直接 import；DOM 元素与
// 面板关闭 / 档位落盘回调（惰性互引 popovers 与 providers，组装点以箭头函数接线）
// 经工厂 deps 注入。本模块不 import 组合根与 popovers。
import { chatSessionState } from "../chat/chat-state.js";
import { measureModelPanelWidth, updateModelSelectWidth } from "../chat/model-select-width.js";
import { thinkingLevelValueLabel, type ThinkingPickerEntry, type ThinkingView } from "../chat/thinking-picker.js";
import { escapeHtml } from "../shared/string-utils.js";
// 档位出口入参的声明面（未归一的外部值；词表叶，纯类型引入、无运行时依赖边）。
import type { ThinkingLevelInput } from "../ai/thinking-levels.js";

// 拖拽时的刻度磁吸半径（归一化档位间距的 10%，与 dsh-reasoning-slider 同口径）。
const SNAP_THRESHOLD = 0.1;
// 最高档（档位数 ≥ 3 的最右端）触发时的脉冲增亮时长（ms）。
const ULTRA_BURST_MS = 420;
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}


export interface CreateReaderChatModelPanelDeps {
  modelSelect: HTMLSelectElement;
  chip: HTMLButtonElement;
  chipModel: HTMLElement;
  chipLevel: HTMLElement;
  panelList: HTMLElement;
  // 面板根（定位/宽度写在它身上：宽度 = 打开时按 chip 可见宽的快照）
  panel: HTMLElement;
  // 思考档位交互容器（承载右上角 Default ↻ 按钮与胶囊滑轨/单档胶囊）
  thinkingToggle: HTMLElement;
  // 底部固定区的思考强度区块根与它的当前值 span
  thinkingRow: HTMLElement;
  thinkingRowValue: HTMLElement;
  // 提示行（工单 03 的「关不掉」/ 05 号票的 clamp 说明，模板默认 hidden）：由本模块按
  // 视图值写文案与显隐——组合根不再持有该元素、也不再知道「谁先画、谁后画」。
  // **可选（不传或传 null 即「没有提示行」）**：没有该元素时本模块静默跳过提示行，
  // 档位与 chip 的渲染不受影响（面板其余消费方无需感知本字段）。
  thinkingHint?: HTMLElement | null;
  // 惰性互引（组装点以箭头函数接线，回调执行时实例已存在）
  hidePanel: () => void;
  // 档位落盘出口（组合根接 providers 的 setThinkingLevel + 视图重判）：入参是**未归一的
  // 外部值**——本模块传的是档位条目的 dataset 值（DOM 来的脏值也可能到，宽容面见
  // ai/thinking-levels.ts 的 ThinkingLevelInput），归一化在下游落盘入口做一次。
  pickLevel: (level: ThinkingLevelInput) => void;
}

// 面板对外的渲染入口：模型列表（renderPanel）/ chip（renderChip）各自成件，思考档位的
// 显示面**只有一个入口** renderThinkingPicker——它收 chat/thinking-picker 的整份视图值
//（显示名 + 条目 + 提示文案）一次画完：标题行当前值、↻ 重置键与滑轨/单档胶囊、chip 的
// 档位 span 与底部提示行都出自同一次解析（调用点不再只传子集、不再自己写提示行、也不再有
//「先画 chip 再重画」这类调用顺序知识）。
export interface ReaderChatModelPanel {
  // chip 的独立重渲入口：档位刷新（renderThinkingPicker）内部用它写档位 span（显示名由
  // 那次解析写入）。2026-10 深化后**组合根不再直调它**——chip 的渲染路径收敛为
  // refreshThinkingUi → renderThinkingPicker 一条（一次刷新/一次点击只渲一遍）；出口保留
  // 供面板自身与直测使用。
  renderChip: () => void;
  renderPanel: () => void;
  renderThinkingPicker: (view: ThinkingView) => void;
}

export function createReaderChatModelPanel(deps: CreateReaderChatModelPanelDeps): ReaderChatModelPanel {
  const {
    modelSelect,
    chip,
    chipModel,
    chipLevel,
    panelList,
    panel,
    thinkingToggle,
    thinkingRow,
    thinkingRowValue,
    // 缺省 = 没有提示行（模板可没有该元素）：渲染时静默跳过，其余字段照画。
    thinkingHint = null
  } = deps;

  // 显示名（chip 的档位 span 与思考强度行右侧共用）。由 renderThinkingPicker 写入；
  // 还没渲染过（面板从未刷新）时为 null，renderChip 回落标签表。
  let chipLevelLabel: string | null = null;
  // 当前已挂载的档位结构签名（同一模型切档时复用 DOM 节点：保持 CSS 过渡动画连续、
  // 保持焦点不丢失，且点击事件冒泡到 document 时 target 仍在 panel 内不被误判为外点）。
  let renderedStructureKey = "";
  let currentTierEntries: ThinkingPickerEntry[] = [];
  let currentActiveIndex = -1;
  let lastThumbPct: number | null = null;
  let isDraggingThumb = false;
  let thumbTransitionCleanup: (() => void) | null = null;
  // 最高档脉冲状态（420ms 增亮窗口）。
  let wasAtMax = false;
  let isBursting = false;
  let burstTimer: ReturnType<typeof setTimeout> | null = null;

  function syncUltraBurst(nextAtMax: boolean): void {
    if (nextAtMax && !wasAtMax) {
      isBursting = true;
      if (burstTimer !== null) {
        clearTimeout(burstTimer);
      }
      burstTimer = setTimeout(() => {
        burstTimer = null;
        isBursting = false;
        thinkingToggle.querySelector(".chat-thinking-track")?.classList.remove("is-ultra-burst");
      }, ULTRA_BURST_MS);
    } else if (!nextAtMax) {
      if (burstTimer !== null) {
        clearTimeout(burstTimer);
        burstTimer = null;
      }
      isBursting = false;
    }
    wasAtMax = nextAtMax;
  }

  // 模型名显示口径（2026-10-06 用户报障）：集合站（ModelScope / OpenRouter 等）回的
  // 模型 id 带组织命名空间前缀（`deepseek-ai/DeepSeek-V4.1-Flash`），chip 与弹层列表
  // 只显示最后一段裸名。**只碰显示层**——option 文本与复合值（值源）照旧完整，
  // 请求体里的模型 id 因此也不变；无斜杠与尾斜杠（`org/`）原样返回（与
  // ai/thinking-profiles.ts 的 stripOrgPrefix 同口径，那份是思考兜底匹配用，不共用）。
  function displayModelName(model: string): string {
    const slash = model.lastIndexOf("/");
    if (slash < 0 || slash === model.length - 1) {
      return model;
    }
    return model.slice(slash + 1);
  }

  // chip 文案 = 平台名·选中模型名 + 当前思考档位（截图形态「ModelScope·DeepSeek
  // V4.1 Flash High」）。平台名取选中 option 所属 optgroup 的 label（与面板分组
  // 标题同源），中点「·」分隔；optgroup 缺失/label 空则只显示模型名。
  // 未配置平台（select 禁用）时 chip 同步禁用，只给占位文案（档位无意义）。
  // 平台名·模型名与档位分写两个 span：CSS 只对模型名 span 做溢出截断，档位恒完整。
  function renderChip(): void {
    if (modelSelect.disabled) {
      chipModel.textContent = "未配置平台";
      chipLevel.textContent = "";
      chip.disabled = true;
      updateModelSelectWidth({ chip, chipModel, chipLevel });
      return;
    }
    const option = modelSelect.options[modelSelect.selectedIndex];
    const platform = String(option?.closest("optgroup")?.getAttribute("label") || "").trim();
    const modelName = displayModelName(String(option?.textContent || "").trim() || "未配置平台");
    chipModel.textContent = platform ? `${platform}·${modelName}` : modelName;
    // 显示名优先用档位条派生的那一个（开关型模型是 On）——菜单里写 On、chip 写 High
    // 是自相矛盾的（用户裁定）；未派生过时回落标签表。
    chipLevel.textContent = chipLevelLabel ?? thinkingLevelValueLabel(chatSessionState.aiThinkingLevel);
    chip.disabled = false;
    updateModelSelectWidth({ chip, chipModel, chipLevel });
  }

  // 面板列表：按 select optgroup 分组渲染（平台名 = 组标题），当前选中项打勾。
  // 值源不变：点选项 = 写 value + 派生 change（组合根的 change 监听负责持久化、
  // 宽度重算与提示重判），随后关面板。
  //
  // 宽度：打开时按 chip 可见宽快照写内联（[240, 320] 夹取见 chat/model-select-width
  // 的 measureModelPanelWidth）——面板从 chip 上方呼出、宽度与「模型名显示区域」
  // 同宽；打开期间不重算，故点档位改 chip 文案时面板宽度不抖，重开才更新。
  function renderPanel(): void {
    panel.style.width = `${measureModelPanelWidth({ chip, chipModel, chipLevel })}px`;
    panelList.hidden = false;
    if (modelSelect.disabled) {
      panelList.innerHTML = '<span class="chat-model-empty">未配置平台</span>';
      thinkingRow.hidden = true;
      return;
    }
    thinkingRow.hidden = false;
    const current = modelSelect.value;
    const parts: string[] = [];
    for (const group of Array.from(modelSelect.querySelectorAll("optgroup"))) {
      parts.push(`<div class="chat-model-group">${escapeHtml(group.label)}</div>`);
      for (const option of Array.from(group.querySelectorAll("option"))) {
        const value = option.getAttribute("value") || "";
        const isSelected = value === current;
        parts.push(
          `<button type="button" class="chat-model-option${isSelected ? " is-selected" : ""}" data-value="${escapeHtml(value)}">` +
            `<span class="chat-model-option-name">${escapeHtml(displayModelName(option.textContent || ""))}</span>` +
            (isSelected ? '<span class="chat-model-check" aria-hidden="true">✓</span>' : "") +
            "</button>"
        );
      }
    }
    panelList.innerHTML = parts.join("");
    panelList.querySelectorAll<HTMLButtonElement>(".chat-model-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.getAttribute("data-value") || "";
        if (value && value !== modelSelect.value) {
          modelSelect.value = value;
          modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
        }
        deps.hidePanel();
      });
    });
  }

  function commitButton(btn: HTMLElement | null | undefined): void {
    if (!btn) {
      return;
    }
    if (btn.dataset.writes === "true") {
      deps.pickLevel(btn.dataset.level || "off");
    }
  }

  // 内联思考强度区 + 面板底部提示行：一次画完整份视图值——条目来自调用方派生好的显示条目
  //（首项 Default 渲染为右上角 ↻ 重置键，其余真实档位按数量渲染为胶囊滑轨 / 单档胶囊 / 空轨），
  // 提示文案与显隐也来自同一次解析（`hint === null` = 不显示提示行，文案清空）。
  // ADR-0015：`Default`（不干预）是恒在的首项，即便真实档位为空（A' = ∅）也照旧显示思考强度行。
  // 2026-10-05 裁定 B：选中态 `is-active` / `aria-current` 由 `entry.effective`（**实发档**）决定；
  // **点击判据是另一个字段** `entry.writesPreference`——偏好 ≠ 实发时点实发档也写偏好（用户显式
  // 接受本次 clamp），只有「已经是偏好落在的那一项」才不重复写。调整思考档位不关闭面板。
  function renderThinkingPicker(view: ThinkingView): void {
    const entries = view.entries;
    chipLevelLabel = view.label;
    thinkingRowValue.textContent = view.label;
    thinkingRow.hidden = modelSelect.disabled;

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
              `<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">` +
              `<path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path>` +
              `<path d="M3 3v5h5"></path>` +
              `</svg>` +
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
                `<button type="button" class="chat-thinking-btn chat-thinking-tick"` +
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

        thinkingToggle.innerHTML = parts.join("");
        bindThinkingControls();
      }

      // 同步所有档位按钮的生效态与点击判据属性（DOM 节点原地更新，不销毁重建）。
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

    // 显示名可能刚变（开关型的 On/Off、换模型的档位词）→ chip 的档位 span 同步重渲。
    renderChip();
    // 提示行（工单 03 / 05 号票）：文案与显隐都取这次解析的视图值，写在 chip 之后（与
    // 改造前组合根「档位区先落、提示行随后」的时序一致）。元素缺失时整块跳过。
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
    if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
      const computed = window.getComputedStyle(thumb).transform;
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

    thumb.style.transition = "transform 0.18s cubic-bezier(0.2, 0.9, 0.25, 1)";
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

    track.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== undefined) {
        return;
      }
      dragging = true;
      isDraggingThumb = true;
      track.classList.add("is-dragging");
      refreshRangeRect();
      window.addEventListener("resize", onDragWindowResize);
      if (typeof ResizeObserver !== "undefined") {
        dragObserver = new ResizeObserver(() => {
          if (dragging) {
            refreshRangeRect();
          }
        });
        dragObserver.observe(range);
      }
      const pos = posFromClientX(e.clientX);
      if (pos === null) {
        finishDrag(false);
        return;
      }
      if (typeof track.setPointerCapture === "function" && e.pointerId !== undefined) {
        try {
          track.setPointerCapture(e.pointerId);
        } catch {
          // jsdom 或未激活 pointer 时忽略
        }
      }
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
      window.removeEventListener("resize", onDragWindowResize);
      if (dragObserver) {
        dragObserver.disconnect();
        dragObserver = null;
      }
      cachedRangeRect = null;
      track!.classList.remove("is-dragging");
      if (!commit) {
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

    track.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        if (e.deltaY === 0) {
          return;
        }
        e.preventDefault();
        const n = currentTierEntries.length;
        const step = e.deltaY < 0 ? 1 : -1;
        const nextIdx = currentActiveIndex < 0 ? 0 : Math.max(0, Math.min(n - 1, currentActiveIndex + step));
        commitButton(tickButtons[nextIdx]);
      },
      { passive: false }
    );

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

  return { renderChip, renderPanel, renderThinkingPicker };
}
