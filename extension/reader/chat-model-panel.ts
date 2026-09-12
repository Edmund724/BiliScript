// reader/chat-model-panel.ts — 模型 chip 与「模型 + 思考档位」面板的渲染
// （发送框重构新增）：chip 是隐藏 <select>（值源，providers 渲染选项、change
// 持久化链不变）的展示层；面板列表从 select 的 optgroup/option 派生，点击
// 选项 = 写 select.value 并派生 change（既有持久化/提示重判链原样复用，
// 不新开写路径）。面板的开合/互斥/外点/Esc 收口在 reader/chat-popovers.ts，
// 本模块只渲染，不持有开合状态。
//
// chip 内模型名与档位是两个独立 span：溢出截断只由 CSS 施加在模型名 span，
// 档位与 chevron 恒完整（model-select-width 只决定 chip 整体宽度，不参与截断）。
//
// 依赖方向（无环）：共享状态（../chat/chat-state 的 aiThinkingLevel）与
// chat/model-select-width 直接 import；DOM 元素与面板关闭回调（惰性互引
// popovers 实例，组装点以箭头函数接线）经工厂 deps 注入。本模块不 import
// 组合根与 popovers。
import { chatSessionState } from "../chat/chat-state.js";
import { updateModelSelectWidth } from "../chat/model-select-width.js";
import { escapeHtml } from "../shared/string-utils.js";

export interface CreateReaderChatModelPanelDeps {
  modelSelect: HTMLSelectElement;
  chip: HTMLButtonElement;
  chipModel: HTMLElement;
  chipLevel: HTMLElement;
  panelList: HTMLElement;
  // 惰性互引（组装点以箭头函数接线，回调执行时 popovers 实例已存在）
  hidePanel: () => void;
}

export interface ReaderChatModelPanel {
  renderChip: () => void;
  renderPanel: () => void;
}

const THINKING_LEVEL_LABELS: Record<string, string> = {
  off: "Off",
  low: "Low",
  high: "High"
};

export function createReaderChatModelPanel(deps: CreateReaderChatModelPanelDeps): ReaderChatModelPanel {
  const { modelSelect, chip, chipModel, chipLevel, panelList } = deps;

  // chip 文案 = 选中模型名 + 当前思考档位（截图形态「DeepSeek V4.1 Flash High」）。
  // 未配置平台（select 禁用）时 chip 同步禁用，只给占位文案（档位无意义）。
  // 模型名与档位分写两个 span：CSS 只对模型名 span 做溢出截断，档位恒完整。
  function renderChip(): void {
    if (modelSelect.disabled) {
      chipModel.textContent = "未配置平台";
      chipLevel.textContent = "";
      chip.disabled = true;
      updateModelSelectWidth({ chip, chipModel, chipLevel });
      return;
    }
    const option = modelSelect.options[modelSelect.selectedIndex];
    chipModel.textContent = String(option?.textContent || "").trim() || "未配置平台";
    chipLevel.textContent = THINKING_LEVEL_LABELS[chatSessionState.aiThinkingLevel] || "Off";
    chip.disabled = false;
    updateModelSelectWidth({ chip, chipModel, chipLevel });
  }

  // 面板列表：按 select optgroup 分组渲染（平台名 = 组标题），当前选中项打勾。
  // 值源不变：点选项 = 写 value + 派生 change（组合根的 change 监听负责持久化、
  // 宽度重算与提示重判），随后关面板。
  function renderPanel(): void {
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

  return { renderChip, renderPanel };
}
