// reader/chat-popovers.ts — 对话 tab 历史整页、模型面板与更多操作菜单的开合、
// 互斥与文档级外点关闭（任一打开先关其余层，Esc 全关，外点全关）。
import { ids } from "./state.js";

export interface CreateReaderChatPopoversDeps {
  historyPopover: HTMLElement;
  modelPanel: HTMLElement;
  historyBtn: HTMLElement;
  modelChipBtn: HTMLElement;
  moreBtn?: HTMLElement | null;
  moreMenu?: HTMLElement | null;
  renderHistoryList: () => void;
  renderModelPanel: () => void;
}

export interface ReaderChatPopovers {
  toggleHistoryPopover: (event?: Event) => void;
  hideHistoryPopover: () => void;
  toggleModelPanel: (event?: Event) => void;
  hideModelPanel: () => void;
  toggleMoreMenu: (event?: Event) => void;
  hideMoreMenu: () => void;
  handleDocumentClick: (event: MouseEvent) => void;
  handleEscapeKey: (event: KeyboardEvent) => void;
}

export function createReaderChatPopovers(deps: CreateReaderChatPopoversDeps): ReaderChatPopovers {
  const { historyPopover, modelPanel, moreBtn, moreMenu } = deps;

  // 互斥基准：任一打开前先关其他层（同一时刻至多一层开着）。
  function hideOthers(except: HTMLElement): void {
    for (const popover of [historyPopover, modelPanel, moreMenu]) {
      if (!popover || popover === except) {
        continue;
      }
      if (popover === modelPanel) {
        setModelPanelHidden(true);
      } else if (popover === moreMenu) {
        setMoreMenuHidden(true);
      } else {
        popover.hidden = true;
      }
    }
  }

  // 模型面板开合同步 chip 箭头与展开语义；主动关闭时把焦点还给 chip，外点与互斥不抢焦点。
  function setModelPanelHidden(hidden: boolean, restoreFocus = false): void {
    const wasOpen = !modelPanel.hidden;
    modelPanel.hidden = hidden;
    deps.modelChipBtn.classList.toggle("is-open", !hidden);
    deps.modelChipBtn.setAttribute("aria-haspopup", "true");
    deps.modelChipBtn.setAttribute("aria-controls", modelPanel.id);
    deps.modelChipBtn.setAttribute("aria-expanded", String(!hidden));
    if (hidden && wasOpen && restoreFocus) {
      deps.modelChipBtn.focus({ preventScroll: true });
    }
  }

  function setMoreMenuHidden(hidden: boolean): void {
    if (moreMenu) {
      moreMenu.hidden = hidden;
    }
    if (moreBtn) {
      moreBtn.setAttribute("aria-expanded", String(!hidden));
      moreBtn.classList.toggle("is-active", !hidden);
    }
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
    setModelPanelHidden(!willShow, !willShow);
    if (willShow) {
      deps.renderModelPanel();
    }
  }

  function hideModelPanel(): void {
    setModelPanelHidden(true, true);
  }

  function toggleMoreMenu(event?: Event): void {
    event?.stopPropagation();
    if (!moreMenu) {
      return;
    }
    hideOthers(moreMenu);
    const willShow = moreMenu.hidden;
    setMoreMenuHidden(!willShow);
  }

  function hideMoreMenu(): void {
    setMoreMenuHidden(true);
  }

  // 外点关闭
  function handleDocumentClick(event: MouseEvent): void {
    const isMoreOpen = Boolean(moreMenu && !moreMenu.hidden);
    if (historyPopover.hidden && modelPanel.hidden && !isMoreOpen) {
      return;
    }
    if (!(event.target instanceof Element)) {
      hideHistoryPopover();
      setModelPanelHidden(true);
      hideMoreMenu();
      return;
    }
    if (event.target.closest(`#${ids.readingChatHistoryPopover}`) || event.target.closest(`#${ids.readingChatHistoryBtn}`)) {
      return;
    }
    if (event.target.closest(`#${ids.readingChatModelPanel}`) || event.target.closest(`#${ids.readingChatModelChip}`)) {
      return;
    }
    if (event.target.closest(`#${ids.readingChatMoreMenu}`) || event.target.closest(`#${ids.readingChatMoreBtn}`)) {
      return;
    }
    hideHistoryPopover();
    setModelPanelHidden(true);
    hideMoreMenu();
  }

  // Esc 全关
  function handleEscapeKey(event: KeyboardEvent): void {
    if (event.key !== "Escape") {
      return;
    }
    hideHistoryPopover();
    hideModelPanel();
    hideMoreMenu();
  }

  return {
    toggleHistoryPopover,
    hideHistoryPopover,
    toggleModelPanel,
    hideModelPanel,
    toggleMoreMenu,
    hideMoreMenu,
    handleDocumentClick,
    handleEscapeKey
  };
}
