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
// 2026-10 用户裁定（票据 chat-thinking-submenu，二级菜单）：面板分两页——
// 模型页（分组模型列表）与档位页（顶部返回行 + 档位条目）。底部固定区是一行
// 「思考强度 <当前值> ›」，点它换页到档位页；档位条目点中即写偏好并关面板。
// 条目与显示名由 chat/thinking-picker 的 thinkingViewOf 从一次解析给出（开关型模型收成
// Off/On），本模块只负责画出来与翻页，不自己推导档位。
//
// 依赖方向（无环）：共享状态（../chat/chat-state 的 aiThinkingLevel）与
// chat/model-select-width、chat/thinking-picker 的标签表直接 import；DOM 元素与
// 面板关闭 / 档位落盘回调（惰性互引 popovers 与 providers，组装点以箭头函数接线）
// 经工厂 deps 注入。本模块不 import 组合根与 popovers。
import { chatSessionState } from "../chat/chat-state.js";
import { measureModelPanelWidth, updateModelSelectWidth } from "../chat/model-select-width.js";
import { thinkingLevelValueLabel, type ThinkingView } from "../chat/thinking-picker.js";
import { escapeHtml } from "../shared/string-utils.js";
// 档位出口入参的声明面（未归一的外部值；词表叶，纯类型引入、无运行时依赖边）。
import type { ThinkingLevelInput } from "../ai/thinking-levels.js";

export interface CreateReaderChatModelPanelDeps {
  modelSelect: HTMLSelectElement;
  chip: HTMLButtonElement;
  chipModel: HTMLElement;
  chipLevel: HTMLElement;
  panelList: HTMLElement;
  // 面板根（定位/宽度写在它身上：宽度 = 打开时按 chip 可见宽的快照）
  panel: HTMLElement;
  // 档位页（换页的第二页：顶部返回行 + 档位条目容器）
  thinkingPage: HTMLElement;
  thinkingBack: HTMLElement;
  thinkingToggle: HTMLElement;
  // 底部固定区的一级行（「思考强度 <当前值> ›」）与它的当前值 span
  thinkingRow: HTMLButtonElement;
  thinkingRowValue: HTMLElement;
  // 惰性互引（组装点以箭头函数接线，回调执行时实例已存在）
  hidePanel: () => void;
  // 档位落盘出口（组合根接 providers 的 setThinkingLevel + chip/提示重判）：入参是**未归一的
  // 外部值**——本模块传的是档位条目的 dataset 值（DOM 来的脏值也可能到，宽容面见
  // ai/thinking-levels.ts 的 ThinkingLevelInput），归一化在下游落盘入口做一次。
  pickLevel: (level: ThinkingLevelInput) => void;
}

// 档位条的渲染输入 = 视图值的渲染子集（显示名 + 条目；提示文案由组合根画，本模块看不到）。
// 由 chat/thinking-picker 的 ThinkingView 派生（候选 6：调用点整份传视图值，不再手工投影），
// 本模块不重算。
export type ThinkingPickerView = Pick<ThinkingView, "label" | "entries">;

export interface ReaderChatModelPanel {
  renderChip: () => void;
  renderPanel: () => void;
  renderThinkingPicker: (view: ThinkingPickerView) => void;
}

export function createReaderChatModelPanel(deps: CreateReaderChatModelPanelDeps): ReaderChatModelPanel {
  const {
    modelSelect,
    chip,
    chipModel,
    chipLevel,
    panelList,
    panel,
    thinkingPage,
    thinkingBack,
    thinkingToggle,
    thinkingRow,
    thinkingRowValue
  } = deps;

  // 档位显示名（chip 的档位 span 与一级行右侧共用）。由 renderThinkingPicker 写入；
  // 还没渲染过（面板从未刷新）时为 null，renderChip 回落标签表。
  let chipLevelLabel: string | null = null;
  // 当前是否停在档位页（换页状态；面板重开时归零）。
  let onLevelsPage = false;

  // 两页切换：模型页 / 档位页。一级行只在模型页出现。
  // 2026-10-05：`Default` 是恒在的首项后，「条目 ≤1 就隐藏整行」的旧规则退休（唯一只剩
  // 一项的情形是「只有 Default」，而那一格也要能主动选）。
  function showThinkingPage(levelsPage: boolean): void {
    onLevelsPage = levelsPage;
    panelList.hidden = levelsPage;
    thinkingPage.hidden = !levelsPage;
    thinkingRow.hidden = levelsPage;
    thinkingRow.setAttribute("aria-expanded", levelsPage ? "true" : "false");
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
    const modelName = String(option?.textContent || "").trim() || "未配置平台";
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
  // 每次打开都从模型页开始（换页状态不留到下一次）。
  function renderPanel(): void {
    panel.style.width = `${measureModelPanelWidth({ chip, chipModel, chipLevel })}px`;
    showThinkingPage(false);
    if (modelSelect.disabled) {
      panelList.innerHTML = '<span class="chat-model-empty">未配置平台</span>';
      thinkingRow.hidden = true;
      return;
    }
    const current = modelSelect.value;
    const parts: string[] = [];
    for (const group of Array.from(modelSelect.querySelectorAll("optgroup"))) {
      parts.push(`<div class="chat-model-group">${escapeHtml(group.label)}</div>`);
      for (const option of Array.from(group.querySelectorAll("option"))) {
        const value = option.getAttribute("value") || "";
        const isSelected = value === current;
        parts.push(
          `<button type="button" class="chat-model-option${isSelected ? " is-selected" : ""}" data-value="${escapeHtml(value)}">` +
            `<span class="chat-model-option-name">${escapeHtml(option.textContent || "")}</span>` +
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

  // 档位页（换页后的那一页）：条目来自调用方派生好的显示条目——本模块只画
  // 「叫什么 + 打不打勾」，不推导档位。一级行由 showThinkingPage 决定是否显示。
  // 2026-10-05：`Default`（不干预）是恒在的首项，所以「条目 ≤1 就隐藏整行」的旧规则退休——
  // 唯一只剩一项的情形就是「只有 Default」（模型没有可表达的强度档），而用户裁定那一格
  // **也要能主动选**（破例），因此这里只按是否在档位页决定隐藏。
  // 2026-10-05 裁定 B：勾 / `is-active` / ✓ 由 `entry.effective`（**实发档**）决定，
  // aria 用 aria-current（勾 = 「当前生效的那一项」，不承诺「激活即切换」）；**点击判据是
  // 另一个字段** `entry.writesPreference`——偏好 ≠ 实发时点勾住的那一项也写偏好（用户显式
  // 接受本次 clamp），只有「已经是偏好落在的那一项」才只关面板。两处分别读各自的字段。
  function renderThinkingPicker(view: ThinkingPickerView): void {
    const entries = view.entries;
    chipLevelLabel = view.label;
    thinkingRowValue.textContent = view.label;
    thinkingRow.hidden = onLevelsPage;
    thinkingToggle.innerHTML = entries
      .map(
        (entry) =>
          `<button type="button" class="chat-thinking-btn${entry.effective ? " is-active" : ""}"` +
          ` data-level="${escapeHtml(entry.level)}" data-effective="${entry.effective ? "true" : "false"}"` +
          ` data-writes="${entry.writesPreference ? "true" : "false"}"` +
          ` aria-current="${entry.effective ? "true" : "false"}">` +
          `<span class="chat-thinking-btn-label">${escapeHtml(entry.label)}</span>` +
          (entry.effective ? '<span class="chat-thinking-check" aria-hidden="true">✓</span>' : "") +
          "</button>"
      )
      .join("");
    thinkingToggle.querySelectorAll<HTMLButtonElement>(".chat-thinking-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.writes === "true") {
          deps.pickLevel(btn.dataset.level || "off");
        }
        deps.hidePanel();
      });
    });
    // 显示名可能刚变（开关型的 On/Off、换模型的档位词）→ chip 的档位 span 同步重渲。
    renderChip();
  }

  // 翻页（纯 DOM 状态，不经 popovers：换页不改变面板的开合）。
  thinkingRow.addEventListener("click", () => showThinkingPage(true));
  thinkingBack.addEventListener("click", () => showThinkingPage(false));

  return { renderChip, renderPanel, renderThinkingPicker };
}
