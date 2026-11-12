// 历史内容模式、模型面板与显示设置弹层共用 hidden 投影；同一事件只结算最上层。
import { ids } from "./state.js";

export type HistoryExitFocus = "trigger" | "input" | "none";

export interface CreateReaderChatPopoversDeps {
  historyPopover: HTMLElement;
  modelPanel: HTMLElement;
  historyBtn: HTMLElement;
  modelChipBtn: HTMLElement;
  historyBackBtn?: HTMLElement | null;
  conversationInput?: HTMLElement | null;
  // 历史入口在菜单内时，关闭后菜单按钮已不可聚焦，焦点改落到该元素（⋮ 触发键）。
  historyExitFocusEl?: HTMLElement | null;
  moreBtn?: HTMLElement | null;
  moreMenu?: HTMLElement | null;
  renderHistoryList: () => void;
  renderModelPanel: () => void;
}

export interface ReaderChatPopovers {
  toggleHistoryPopover: (event?: Event) => void;
  hideHistoryPopover: (options?: { focus?: HistoryExitFocus }) => void;
  toggleModelPanel: (event?: Event) => void;
  hideModelPanel: () => void;
  toggleMoreMenu: (event?: Event) => void;
  hideMoreMenu: () => void;
  handleDocumentClick: (event: MouseEvent) => void;
  handleEscapeKey: (event: KeyboardEvent) => void;
}

export function createReaderChatPopovers(deps: CreateReaderChatPopoversDeps): ReaderChatPopovers {
  const { historyPopover, modelPanel, moreBtn, moreMenu } = deps;

  function focusWithoutScroll(element: HTMLElement | null | undefined): void {
    element?.focus({ preventScroll: true });
  }

  function setHistoryHidden(hidden: boolean, focus: HistoryExitFocus = "none"): void {
    const wasOpen = !historyPopover.hidden;
    historyPopover.hidden = hidden;
    deps.historyBtn.setAttribute("aria-expanded", String(!hidden));
    if (!hidden) {
      focusWithoutScroll(deps.historyBackBtn);
    } else if (wasOpen && focus === "trigger") {
      focusWithoutScroll(deps.historyExitFocusEl ?? deps.historyBtn);
    } else if (wasOpen && focus === "input") {
      focusWithoutScroll(deps.conversationInput);
    }
  }

  function hideOthers(except: HTMLElement): void {
    if (historyPopover !== except) setHistoryHidden(true);
    if (modelPanel !== except) setModelPanelHidden(true);
    if (moreMenu && moreMenu !== except) setMoreMenuHidden(true);
  }

  // 模型面板开合同步 chip 箭头与展开语义；toggle/Esc 主动关闭时把焦点还给 chip，互斥与外点不抢焦点。
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
    if (moreMenu) moreMenu.hidden = hidden;
    if (moreBtn) {
      moreBtn.setAttribute("aria-expanded", String(!hidden));
      moreBtn.classList.toggle("is-active", !hidden);
    }
  }

  function toggleHistoryPopover(event?: Event): void {
    event?.stopPropagation();
    const willShow = historyPopover.hidden;
    hideOthers(historyPopover);
    setHistoryHidden(!willShow, willShow ? "none" : "trigger");
    if (willShow) deps.renderHistoryList();
  }

  function hideHistoryPopover({ focus = "trigger" }: { focus?: HistoryExitFocus } = {}): void {
    setHistoryHidden(true, focus);
  }

  function toggleModelPanel(event?: Event): void {
    event?.stopPropagation();
    hideOthers(modelPanel);
    const willShow = modelPanel.hidden;
    setModelPanelHidden(!willShow, !willShow);
    if (willShow) deps.renderModelPanel();
  }

  function hideModelPanel(): void {
    setModelPanelHidden(true, true);
  }

  function toggleMoreMenu(event?: Event): void {
    event?.stopPropagation();
    if (!moreMenu) return;
    hideOthers(moreMenu);
    setMoreMenuHidden(!moreMenu.hidden);
  }

  function hideMoreMenu(): void {
    setMoreMenuHidden(true);
  }

  function handleDocumentClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (!historyPopover.hidden) {
      if (target?.closest(`#${ids.readingChatHistoryPopover}, #${ids.readingChatHistoryBtn}`)) return;
      hideHistoryPopover();
      return;
    }
    if (!modelPanel.hidden) {
      if (target?.closest(`#${ids.readingChatModelPanel}, #${ids.readingChatModelChip}`)) return;
      setModelPanelHidden(true);
      return;
    }
    if (moreMenu && !moreMenu.hidden) {
      if (target?.closest(`#${ids.readingChatMoreMenu}, #${ids.readingChatMoreBtn}`)) return;
      hideMoreMenu();
    }
  }

  function handleEscapeKey(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    if (!historyPopover.hidden) {
      event.preventDefault();
      hideHistoryPopover();
      return;
    }
    if (!modelPanel.hidden) {
      event.preventDefault();
      hideModelPanel();
      return;
    }
    if (moreMenu && !moreMenu.hidden) {
      event.preventDefault();
      hideMoreMenu();
    }
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
