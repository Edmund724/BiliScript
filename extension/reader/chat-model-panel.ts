// reader/chat-model-panel.ts — 模型 chip 与「模型 + 思考档位」面板的渲染
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
// 06 号票：面板底部的档位 chip 不再固定三档——renderThinkingChips 按该模型可用集
// （resolveThinkingAdjustment().availableLevels，与请求落线同源）显示/隐藏模板里的
// 7 个静态按钮；本模块不改 chip 的视觉与交互。
//
// 依赖方向（无环）：共享状态（../chat/chat-state 的 aiThinkingLevel）与
// chat/model-select-width 直接 import；DOM 元素与面板关闭回调（惰性互引
// popovers 实例，组装点以箭头函数接线）经工厂 deps 注入。本模块不 import
// 组合根与 popovers。
import { chatSessionState } from "../chat/chat-state.js";
import { measureModelPanelWidth, updateModelSelectWidth } from "../chat/model-select-width.js";
import type { ThinkingLevel } from "../ai/thinking-levels.js";
import { escapeHtml } from "../shared/string-utils.js";

export interface CreateReaderChatModelPanelDeps {
  modelSelect: HTMLSelectElement;
  chip: HTMLButtonElement;
  chipModel: HTMLElement;
  chipLevel: HTMLElement;
  panelList: HTMLElement;
  // 面板根（定位/宽度写在它身上：宽度 = 打开时按 chip 可见宽的快照）
  panel: HTMLElement;
  // 思考档位 chip 容器（模板里的 7 个静态按钮的父级；可用集渲染改它的子按钮）
  thinkingToggle: HTMLElement;
  // 惰性互引（组装点以箭头函数接线，回调执行时 popovers 实例已存在）
  hidePanel: () => void;
}

export interface ReaderChatModelPanel {
  renderChip: () => void;
  renderPanel: () => void;
  renderThinkingChips: (availableLevels: readonly ThinkingLevel[]) => void;
}

// 档位标签表（05 号票：上游词表 7 档）。口径与既有 Off/Low/High 一致——首字母
// 大写、档位词照上游写法（xhigh → XHigh）；未登记档位（脏存储值）回落 Off。
// 06 号票起导出：模板里 7 个静态按钮的文案与 06 号票的 chip 集合工件同源（避免
// 「标签」出现第三份字面量）。
export const THINKING_LEVEL_LABELS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max"
};

export function createReaderChatModelPanel(deps: CreateReaderChatModelPanelDeps): ReaderChatModelPanel {
  const { modelSelect, chip, chipModel, chipLevel, panelList, panel, thinkingToggle } = deps;

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
    chipLevel.textContent = THINKING_LEVEL_LABELS[chatSessionState.aiThinkingLevel] || "Off";
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
    if (modelSelect.disabled) {
      panelList.innerHTML = '<span class="chat-model-empty">未配置平台</span>';
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

  // 档位 chip 集合（06 号票）：按该模型**实际可用的档位**渲染——只显示存在的档位，
  // 不置灰（被 05 号票 clamp 掉的选择由 chat-tab.ts 的说明文本呈现，不做成禁用 chip）；
  // 空可用集（如 minimax-m3：关不掉思考、也没有已登记档位）→ 一个 chip 都不显示。
  // 可用集是调用方从 resolveThinkingAdjustment（与请求落线同一次解析）取来的，本模块
  // 不自己推导档位，只决定「哪些出现 + 叫什么」：文案与模板同源，避免两处标签漂移。
  function renderThinkingChips(availableLevels: readonly ThinkingLevel[]): void {
    const available = new Set<string>(availableLevels);
    thinkingToggle.querySelectorAll<HTMLElement>(".chat-thinking-btn").forEach((btn) => {
      const level = btn.dataset.level || "";
      btn.textContent = THINKING_LEVEL_LABELS[level] || level;
      btn.hidden = !available.has(level);
    });
  }

  return { renderChip, renderPanel, renderThinkingChips };
}
