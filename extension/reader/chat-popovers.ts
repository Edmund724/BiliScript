// reader/chat-popovers.ts — 对话 tab 历史整页与模型面板的开合、互斥与
// 文档级外点关闭（PR5 自 extension/pages/sidepanel-popovers.ts 重建；发送框重构
// 起模型 + 思考档位面板并入本协调器：任一打开先关另一个，Esc 全关，外点全关）。
// 2026-09 用户决议：历史对话由「输入卡上方的弹层」改为「盖住对话内容区的整页」
//（模板见 chat-template.ts、接管样式见 reader-chat.css），本模块的开合判定
// 一字未改——history 仍是 hidden 单源，只是非 hidden 时由 CSS 兄弟选择器把
// 对话内容整体让位，浮层几何只剩模型面板一份。
//
// 两处换壳（盘点报告 §1.1 popovers 判定行 + 风险 6 决议，历史定案）：
//   1. 外点关闭的 id 选择器换 reader 的 readingChat* id（原 #sp* 硬编码）；
//   2. handleDocumentClick 不再自挂 document 监听——经 reader/chat-tab-bridge.ts
//      的注册槽并入 ui-renderer 的单一文档级委托（防双监听互踩）。本模块只暴露
//      handleDocumentClick 供组合根注册（组合根负责注册/摘除时机）；Esc 关闭经
//      handleEscapeKey 由组合根的 window keydown 监听调用（同一注册/摘除时机）。
import { ids } from "./state.js";

export interface CreateReaderChatPopoversDeps {
  historyPopover: HTMLElement;
  modelPanel: HTMLElement;
  historyBtn: HTMLElement;
  modelChipBtn: HTMLElement;
  renderHistoryList: () => void;
  renderModelPanel: () => void;
}

export interface ReaderChatPopovers {
  toggleHistoryPopover: (event?: Event) => void;
  hideHistoryPopover: () => void;
  toggleModelPanel: (event?: Event) => void;
  hideModelPanel: () => void;
  handleDocumentClick: (event: MouseEvent) => void;
  handleEscapeKey: (event: KeyboardEvent) => void;
}

export function createReaderChatPopovers(deps: CreateReaderChatPopoversDeps): ReaderChatPopovers {
  const { historyPopover, modelPanel } = deps;

  // 互斥基准：任一打开前先关另一个（同一时刻至多一层开着）。
  // 模型面板的 hidden 统一经 setModelPanelHidden 写（同步 chip 箭头方向）。
  function hideOthers(except: HTMLElement): void {
    for (const popover of [historyPopover, modelPanel]) {
      if (popover === except) {
        continue;
      }
      if (popover === modelPanel) {
        setModelPanelHidden(true);
      } else {
        popover.hidden = true;
      }
    }
  }

  // 模型面板开合同步 chip 箭头方向：面板在 chip 上方弹出，开 = chevron 朝上
  //（.is-open），关 = 朝下。toggle/互斥/外点/Esc/hidePanel 全部路径经此写。
  function setModelPanelHidden(hidden: boolean): void {
    modelPanel.hidden = hidden;
    deps.modelChipBtn.classList.toggle("is-open", !hidden);
  }

  function toggleHistoryPopover(event?: Event): void {
    event?.stopPropagation();
    hideOthers(historyPopover);
    const willShow = historyPopover.hidden;
    historyPopover.hidden = !willShow;
    if (willShow) {
      deps.renderHistoryList();
    }
  }

  function hideHistoryPopover(): void {
    historyPopover.hidden = true;
  }

  function toggleModelPanel(event?: Event): void {
    event?.stopPropagation();
    hideOthers(modelPanel);
    const willShow = modelPanel.hidden;
    setModelPanelHidden(!willShow);
    if (willShow) {
      deps.renderModelPanel();
    }
  }

  function hideModelPanel(): void {
    setModelPanelHidden(true);
  }

  // 外点关闭（由组合根经 chat-tab-bridge 注册进 ui-renderer 的单一文档级委托）：
  // 判定分支与 sidepanel 孪生逐字一致，仅 id 选择器换 readingChat* 前缀。
  function handleDocumentClick(event: MouseEvent): void {
    if (historyPopover.hidden && modelPanel.hidden) {
      return;
    }
    if (!(event.target instanceof Element)) {
      hideHistoryPopover();
      hideModelPanel();
      return;
    }
    if (event.target.closest(`#${ids.readingChatHistoryPopover}`) || event.target.closest(`#${ids.readingChatHistoryBtn}`)) {
      return;
    }
    if (event.target.closest(`#${ids.readingChatModelPanel}`) || event.target.closest(`#${ids.readingChatModelChip}`)) {
      return;
    }
    hideHistoryPopover();
    hideModelPanel();
  }

  // Esc 全关（发送框重构新增；组合根的 window keydown 监听调用）。
  function handleEscapeKey(event: KeyboardEvent): void {
    if (event.key !== "Escape") {
      return;
    }
    hideHistoryPopover();
    hideModelPanel();
  }

  return {
    toggleHistoryPopover,
    hideHistoryPopover,
    toggleModelPanel,
    hideModelPanel,
    handleDocumentClick,
    handleEscapeKey
  };
}
