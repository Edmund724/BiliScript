// tests/reader/chat-popovers.test.ts
// createReaderChatPopovers（对话 tab 历史/模型面板两个弹层的开合互斥 +
// 文档级外点关闭 + Esc 关闭）行为契约。PR5 自 tests/sidepanel/sidepanel-popovers.test.ts
// 随重建迁移：判定断言保真；外点关闭的 id 选择器换 reader 的 readingChat* id，且
// handleDocumentClick 不再自挂 document 监听——经 chat-tab-bridge 并入
// ui-renderer 的单一文档级委托（见 chat-tab 组合根测试的外点单委托用例）。
// 发送框重构起新增第二个弹层（模型 + 思考档位面板）：开合与互斥入口
// toggleModelPanel/hideModelPanel，Esc 全关走 handleEscapeKey（组合根的 window
// keydown 监听调用）。
//
// 覆盖：
// - toggleHistoryPopover：开（刷新历史列表）、关模型面板、再 toggle 关、
//   stopPropagation；
// - toggleModelPanel：开（刷新面板列表）、关历史、再 toggle 关；
// - handleDocumentClick：两个都关时 no-op；点击弹层/触发按钮内部不关；点击外部
//   全关；非 Element target 全关；
// - handleEscapeKey：Escape 全关，其余键 no-op。

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
  const modelPanel = document.createElement("div");
  modelPanel.id = ids.readingChatModelPanel;
  const historyBtn = document.createElement("button");
  historyBtn.id = ids.readingChatHistoryBtn;
  const modelChipBtn = document.createElement("button");
  modelChipBtn.id = ids.readingChatModelChip;
  container.append(historyPopover, modelPanel, historyBtn, modelChipBtn);
  const deps = {
    historyPopover,
    modelPanel,
    historyBtn,
    modelChipBtn,
    renderHistoryList: vi.fn(),
    renderModelPanel: vi.fn()
  };
  const popovers = createReaderChatPopovers(deps);
  // 初始态：两个弹层可见（hidden=false），toggle 后才隐藏（与迁移前判定一致：
  // willShow = popover.hidden）
  historyPopover.hidden = false;
  modelPanel.hidden = false;
  return { deps, popovers, historyPopover, modelPanel, historyBtn, modelChipBtn };
}

describe("toggleHistoryPopover", () => {
  it("开历史 popover：刷新历史列表，并关模型面板", () => {
    const { popovers, deps, historyPopover, modelPanel } = makeHarness();
    historyPopover.hidden = true;
    modelPanel.hidden = true;

    popovers.toggleHistoryPopover();

    expect(historyPopover.hidden).toBe(false);
    expect(modelPanel.hidden).toBe(true);
    expect(deps.renderHistoryList).toHaveBeenCalledTimes(1);
  });

  it("可见时再 toggle：关闭", () => {
    const { popovers, historyPopover } = makeHarness();

    popovers.toggleHistoryPopover();

    expect(historyPopover.hidden).toBe(true);
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

  it("点击外部：两个弹层都关闭", () => {
    const { popovers, historyPopover, modelPanel } = makeHarness();
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    popovers.handleDocumentClick({ target: outside } as unknown as MouseEvent);

    expect(historyPopover.hidden).toBe(true);
    expect(modelPanel.hidden).toBe(true);
  });

  it("非 Element target（如 document/text node）：全关", () => {
    const { popovers, historyPopover, modelPanel } = makeHarness();

    popovers.handleDocumentClick({ target: document } as unknown as MouseEvent);

    expect(historyPopover.hidden).toBe(true);
    expect(modelPanel.hidden).toBe(true);
  });
});

describe("handleEscapeKey（Esc 全关）", () => {
  it("Escape：两个弹层都关闭", () => {
    const { popovers, historyPopover, modelPanel } = makeHarness();

    popovers.handleEscapeKey(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(historyPopover.hidden).toBe(true);
    expect(modelPanel.hidden).toBe(true);
  });

  it("非 Escape 键：no-op", () => {
    const { popovers, historyPopover, modelPanel } = makeHarness();

    popovers.handleEscapeKey(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(historyPopover.hidden).toBe(false);
    expect(modelPanel.hidden).toBe(false);
  });
});
