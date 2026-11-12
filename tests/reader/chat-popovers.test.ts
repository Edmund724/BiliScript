// tests/reader/chat-popovers.test.ts
// createReaderChatPopovers：历史内容模式、模型面板与显示设置菜单的
// 开合互斥、逐层外点/Esc 结算及焦点恢复行为契约。文档级外点经 reader-bus
// 转发槽并入 ui-renderer 的单一文档级委托。
//
// 覆盖：
// - toggleHistoryPopover：刷新历史列表、关模型面板、同步 aria-expanded、
//   打开聚焦返回键，关闭聚焦历史入口；
// - toggleModelPanel：开（刷新面板列表）、关历史、再 toggle 关；
// - handleDocumentClick：只结算最上层；点击弹层/触发按钮内部不关；
// - handleEscapeKey：Escape 逐层关闭，确认框打开时不穿透，其余键 no-op。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let createReaderChatPopovers: typeof import("../../extension/reader/chat-popovers.js").createReaderChatPopovers;
let ids: typeof import("../../extension/reader/state.js").ids;

beforeEach(async () => {
  resetModuleState();
  const module = await import("../../extension/reader/chat-popovers.js");
  createReaderChatPopovers = module.createReaderChatPopovers;
  ids = (await import("../../extension/reader/state.js")).ids;
});

function makeHarness() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const historyPopover = document.createElement("div");
  historyPopover.id = ids.readingChatHistoryPopover;
  const historyBackBtn = document.createElement("button");
  historyBackBtn.id = ids.readingChatHistoryBackBtn;
  historyPopover.appendChild(historyBackBtn);
  const conversationInput = document.createElement("textarea");
  conversationInput.id = ids.readingChatInput;
  const modelPanel = document.createElement("div");
  modelPanel.id = ids.readingChatModelPanel;
  const historyBtn = document.createElement("button");
  historyBtn.id = ids.readingChatHistoryBtn;
  const modelChipBtn = document.createElement("button");
  modelChipBtn.id = ids.readingChatModelChip;
  const moreBtn = document.createElement("button");
  moreBtn.id = ids.readingChatMoreBtn;
  const moreMenu = document.createElement("div");
  moreMenu.id = ids.readingChatMoreMenu;
  container.append(historyPopover, modelPanel, historyBtn, modelChipBtn, moreBtn, moreMenu, conversationInput);
  const deps = {
    historyPopover,
    modelPanel,
    historyBtn,
    modelChipBtn,
    historyBackBtn,
    conversationInput,
    moreBtn,
    moreMenu,
    renderHistoryList: vi.fn(),
    renderModelPanel: vi.fn()
  };
  const popovers = createReaderChatPopovers(deps);
  historyPopover.hidden = false;
  modelPanel.hidden = false;
  moreMenu.hidden = false;
  return { deps, popovers, historyPopover, modelPanel, historyBtn, modelChipBtn, historyBackBtn, conversationInput, moreBtn, moreMenu };
}

describe("toggleHistoryPopover", () => {
  it("开历史：刷新列表、关模型面板、聚焦返回键并同步 aria-expanded", () => {
    const { popovers, deps, historyPopover, modelPanel, historyBtn, historyBackBtn } = makeHarness();
    historyPopover.hidden = true;
    modelPanel.hidden = true;

    popovers.toggleHistoryPopover();

    expect(historyPopover.hidden).toBe(false);
    expect(modelPanel.hidden).toBe(true);
    expect(deps.renderHistoryList).toHaveBeenCalledTimes(1);
    expect(historyBtn.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(historyBackBtn);
  });

  it("可见时再 toggle：关闭并把焦点还给历史入口", () => {
    const { popovers, historyPopover, historyBtn } = makeHarness();

    popovers.toggleHistoryPopover();

    expect(historyPopover.hidden).toBe(true);
    expect(historyBtn.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(historyBtn);
  });

  it("选定会话后的退出直接聚焦输入框", () => {
    const { popovers, historyPopover, conversationInput } = makeHarness();

    popovers.hideHistoryPopover({ focus: "input" });

    expect(historyPopover.hidden).toBe(true);
    expect(document.activeElement).toBe(conversationInput);
  });

  it("事件对象被 stopPropagation（不冒泡触发文档级关闭）", () => {
    const { popovers } = makeHarness();
    const event = new MouseEvent("click", { bubbles: true });
    const stopSpy = vi.spyOn(event, "stopPropagation");

    popovers.toggleHistoryPopover(event);

    expect(stopSpy).toHaveBeenCalled();
  });
});

describe("toggleModelPanel", () => {
  it("开模型面板：刷新面板列表，chip 箭头翻转（is-open），并关历史", () => {
    const { popovers, deps, historyPopover, modelPanel, modelChipBtn } = makeHarness();
    historyPopover.hidden = true;
    modelPanel.hidden = true;

    popovers.toggleModelPanel();

    expect(modelPanel.hidden).toBe(false);
    expect(historyPopover.hidden).toBe(true);
    expect(deps.renderModelPanel).toHaveBeenCalledTimes(1);
    expect(modelChipBtn.classList.contains("is-open")).toBe(true);
  });

  it("可见时再 toggle：关闭（不重复刷新），chip 箭头复位（is-open 移除）", () => {
    const { popovers, deps, modelPanel, modelChipBtn } = makeHarness();
    modelPanel.hidden = true;
    popovers.toggleModelPanel();

    popovers.toggleModelPanel();

    expect(modelPanel.hidden).toBe(true);
    expect(deps.renderModelPanel).toHaveBeenCalledTimes(1);
    expect(modelChipBtn.classList.contains("is-open")).toBe(false);
  });

  it("互斥：开历史 popover 关模型面板时，chip 箭头同步复位", () => {
    const { popovers, historyPopover, modelPanel, modelChipBtn } = makeHarness();
    historyPopover.hidden = true;
    modelPanel.hidden = true;
    popovers.toggleModelPanel();

    popovers.toggleHistoryPopover();

    expect(modelPanel.hidden).toBe(true);
    expect(modelChipBtn.classList.contains("is-open")).toBe(false);
  });
});

describe("handleDocumentClick（外点关闭，readingChat* id）", () => {
  it("两个弹层都隐藏时 no-op", () => {
    const { popovers, historyPopover, modelPanel } = makeHarness();
    historyPopover.hidden = true;
    modelPanel.hidden = true;
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    popovers.handleDocumentClick({ target: outside } as unknown as MouseEvent);

    expect(historyPopover.hidden).toBe(true);
    expect(modelPanel.hidden).toBe(true);
  });

  it("点击弹层内部 / 触发按钮：不关闭", () => {
    const { popovers, historyPopover, modelPanel, historyBtn, modelChipBtn } = makeHarness();
    const insideHistory = document.createElement("span");
    historyPopover.appendChild(insideHistory);
    const insideModel = document.createElement("span");
    modelPanel.appendChild(insideModel);

    popovers.handleDocumentClick({ target: insideHistory } as unknown as MouseEvent);
    expect(historyPopover.hidden).toBe(false);
    expect(modelPanel.hidden).toBe(false);

    popovers.handleDocumentClick({ target: historyBtn } as unknown as MouseEvent);
    expect(historyPopover.hidden).toBe(false);

    popovers.handleDocumentClick({ target: insideModel } as unknown as MouseEvent);
    expect(modelPanel.hidden).toBe(false);

    popovers.handleDocumentClick({ target: modelChipBtn } as unknown as MouseEvent);
    expect(modelPanel.hidden).toBe(false);
  });

  it("点击外部：只关闭最上层历史并归还焦点，下层不在同一事件结算", () => {
    const { popovers, historyPopover, modelPanel, moreMenu, historyBtn } = makeHarness();
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    popovers.handleDocumentClick({ target: outside } as unknown as MouseEvent);

    expect(historyPopover.hidden).toBe(true);
    expect(modelPanel.hidden).toBe(false);
    expect(moreMenu.hidden).toBe(false);
    expect(document.activeElement).toBe(historyBtn);
  });

  it("非 Element target 同样只关闭最上层", () => {
    const { popovers, historyPopover, modelPanel } = makeHarness();

    popovers.handleDocumentClick({ target: document } as unknown as MouseEvent);

    expect(historyPopover.hidden).toBe(true);
    expect(modelPanel.hidden).toBe(false);
  });
});

describe("handleEscapeKey（Esc 逐层结算）", () => {
  it("每次 Escape 只关闭当前最上层", () => {
    const { popovers, historyPopover, modelPanel, moreMenu } = makeHarness();

    popovers.handleEscapeKey(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(historyPopover.hidden).toBe(true);
    expect(modelPanel.hidden).toBe(false);
    expect(moreMenu.hidden).toBe(false);

    popovers.handleEscapeKey(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(modelPanel.hidden).toBe(true);
    expect(moreMenu.hidden).toBe(false);

    popovers.handleEscapeKey(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(moreMenu.hidden).toBe(true);
  });

  it("确认框的 Escape 不穿透到历史；确认结算后下一次才退出历史", async () => {
    document.body.innerHTML = `<div id="${ids.readingView}"><section id="${ids.readingSettingsPanel}"></section></div>`;
    const { popovers, historyPopover } = makeHarness();
    const handler = (event: KeyboardEvent) => popovers.handleEscapeKey(event);
    window.addEventListener("keydown", handler);
    try {
      const { confirmDialog } = await import("../../extension/ui/confirm-dialog.js");
      const pending = confirmDialog({ message: "确认清空" });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await expect(pending).resolves.toBe(false);
      expect(historyPopover.hidden).toBe(false);

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      expect(historyPopover.hidden).toBe(true);
    } finally {
      window.removeEventListener("keydown", handler);
    }
  });

  it("非 Escape 键：no-op", () => {
    const { popovers, historyPopover, modelPanel } = makeHarness();

    popovers.handleEscapeKey(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(historyPopover.hidden).toBe(false);
    expect(modelPanel.hidden).toBe(false);
  });
});

describe("toggleMoreMenu", () => {
  it("开更多菜单：关闭历史与模型面板", () => {
    const { popovers, historyPopover, modelPanel, moreMenu, moreBtn } = makeHarness();
    historyPopover.hidden = false;
    modelPanel.hidden = false;
    moreMenu.hidden = true;

    popovers.toggleMoreMenu();

    expect(moreMenu.hidden).toBe(false);
    expect(historyPopover.hidden).toBe(true);
    expect(modelPanel.hidden).toBe(true);
    expect(moreBtn.getAttribute("aria-expanded")).toBe("true");
    expect(moreBtn.classList.contains("is-active")).toBe(true);
  });

  it("可见时再 toggle：关闭", () => {
    const { popovers, moreMenu, moreBtn } = makeHarness();
    moreMenu.hidden = false;

    popovers.toggleMoreMenu();

    expect(moreMenu.hidden).toBe(true);
    expect(moreBtn.getAttribute("aria-expanded")).toBe("false");
    expect(moreBtn.classList.contains("is-active")).toBe(false);
  });
});
