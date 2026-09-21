// tests/reader/chat-popovers.test.ts
// createReaderChatPopovers（对话 tab 预设/历史/模型面板三个弹层的开合互斥 +
// 文档级外点关闭 + Esc 关闭）行为契约。PR5 自 tests/sidepanel/sidepanel-popovers.test.ts
// 随重建迁移：判定断言保真；外点关闭的 id 选择器换 reader 的 readingChat* id，且
// handleDocumentClick 不再自挂 document 监听——经 chat-tab-bridge 并入
// ui-renderer 的单一文档级委托（见 chat-tab 组合根测试的外点单委托用例）。
// 发送框重构起新增第三个弹层（模型 + 思考档位面板）：开合与互斥入口
// toggleModelPanel/hideModelPanel，Esc 全关走 handleEscapeKey（组合根的 window
// keydown 监听调用）。
//
// 覆盖：
// - togglePresetPopover：开（刷新预设列表 + 清输入 + focus）、关历史与模型面板、
//   再 toggle 关、stopPropagation；
// - toggleHistoryPopover：开（刷新历史列表）、关预设与模型面板、再 toggle 关；
// - toggleModelPanel：开（刷新面板列表）、关预设与历史、再 toggle 关；
// - handleDocumentClick：三个都关时 no-op；点击弹层/触发按钮内部不关；点击外部
//   全关；非 Element target 全关；
// - handleEscapeKey：Escape 全关，其余键 no-op。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let createReaderChatPopovers;
let ids;

beforeEach(async () => {
  resetModuleState();
  const module = await import("../../extension/reader/chat-popovers.js");
  createReaderChatPopovers = module.createReaderChatPopovers;
  ids = (await import("../../extension/reader/state.js")).ids;
});

function makeHarness() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const presetPopover = document.createElement("div");
  presetPopover.id = ids.readingChatPresetPopover;
  const historyPopover = document.createElement("div");
  historyPopover.id = ids.readingChatHistoryPopover;
  const modelPanel = document.createElement("div");
  modelPanel.id = ids.readingChatModelPanel;
  const presetBtn = document.createElement("button");
  presetBtn.id = ids.readingChatPresetBtn;
  const historyBtn = document.createElement("button");
  historyBtn.id = ids.readingChatHistoryBtn;
  const modelChipBtn = document.createElement("button");
  modelChipBtn.id = ids.readingChatModelChip;
  const presetInput = document.createElement("input");
  container.append(presetPopover, historyPopover, modelPanel, presetBtn, historyBtn, modelChipBtn, presetInput);
  const deps = {
    presetPopover,
    historyPopover,
    modelPanel,
    presetBtn,
    historyBtn,
    modelChipBtn,
    presetInput,
    renderPresetPrompts: vi.fn(),
    renderHistoryList: vi.fn(),
    renderModelPanel: vi.fn()
  };
  const popovers = createReaderChatPopovers(deps);
  // 初始态：三个弹层可见（hidden=false），toggle 后才隐藏（与迁移前判定一致：
  // willShow = popover.hidden）
  presetPopover.hidden = false;
  historyPopover.hidden = false;
  modelPanel.hidden = false;
  return { deps, popovers, presetPopover, historyPopover, modelPanel, presetBtn, historyBtn, modelChipBtn, presetInput };
}

describe("togglePresetPopover", () => {
  it("开预设 popover：刷新预设列表 + 清输入 + focus，并关历史与模型面板", () => {
    const { popovers, deps, presetPopover, historyPopover, modelPanel, presetInput } = makeHarness();
    historyPopover.hidden = true;
    modelPanel.hidden = true;
    presetPopover.hidden = true;

    popovers.togglePresetPopover();

    expect(presetPopover.hidden).toBe(false);
    expect(historyPopover.hidden).toBe(true);
    expect(modelPanel.hidden).toBe(true);
    expect(deps.renderPresetPrompts).toHaveBeenCalledTimes(1);
    expect(presetInput.value).toBe("");
    expect(document.activeElement).toBe(presetInput);
  });

  it("可见时再 toggle：关闭（不重复刷新）", () => {
    const { popovers, deps, presetPopover } = makeHarness();

    popovers.togglePresetPopover();

    expect(presetPopover.hidden).toBe(true);
    expect(deps.renderPresetPrompts).not.toHaveBeenCalled();
  });

  it("事件对象被 stopPropagation（不冒泡触发文档级关闭）", () => {
    const { popovers } = makeHarness();
    const event = new MouseEvent("click", { bubbles: true });
    const stopSpy = vi.spyOn(event, "stopPropagation");

    popovers.togglePresetPopover(event);

    expect(stopSpy).toHaveBeenCalled();
  });
});

describe("toggleHistoryPopover", () => {
  it("开历史 popover：刷新历史列表，并关预设与模型面板", () => {
    const { popovers, deps, presetPopover, historyPopover, modelPanel } = makeHarness();
    historyPopover.hidden = true;
    presetPopover.hidden = true;
    modelPanel.hidden = true;

    popovers.toggleHistoryPopover();

    expect(historyPopover.hidden).toBe(false);
    expect(presetPopover.hidden).toBe(true);
    expect(modelPanel.hidden).toBe(true);
    expect(deps.renderHistoryList).toHaveBeenCalledTimes(1);
  });

  it("可见时再 toggle：关闭", () => {
    const { popovers, historyPopover } = makeHarness();

    popovers.toggleHistoryPopover();

    expect(historyPopover.hidden).toBe(true);
  });
});

describe("toggleModelPanel", () => {
  it("开模型面板：刷新面板列表，chip 箭头翻转（is-open），并关预设与历史", () => {
    const { popovers, deps, presetPopover, historyPopover, modelPanel, modelChipBtn } = makeHarness();
    historyPopover.hidden = true;
    presetPopover.hidden = true;
    modelPanel.hidden = true;

    popovers.toggleModelPanel();

    expect(modelPanel.hidden).toBe(false);
    expect(presetPopover.hidden).toBe(true);
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

  it("互斥：开预设 popover 关模型面板时，chip 箭头同步复位", () => {
    const { popovers, presetPopover, historyPopover, modelPanel, modelChipBtn } = makeHarness();
    historyPopover.hidden = true;
    presetPopover.hidden = true;
    modelPanel.hidden = true;
    popovers.toggleModelPanel();

    popovers.togglePresetPopover();

    expect(modelPanel.hidden).toBe(true);
    expect(modelChipBtn.classList.contains("is-open")).toBe(false);
  });
});

describe("handleDocumentClick（外点关闭，readingChat* id）", () => {
  it("三个弹层都隐藏时 no-op", () => {
    const { popovers, presetPopover, historyPopover, modelPanel } = makeHarness();
    presetPopover.hidden = true;
    historyPopover.hidden = true;
    modelPanel.hidden = true;
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    popovers.handleDocumentClick({ target: outside });

    expect(presetPopover.hidden).toBe(true);
    expect(historyPopover.hidden).toBe(true);
    expect(modelPanel.hidden).toBe(true);
  });

  it("点击弹层内部 / 触发按钮：不关闭", () => {
    const { popovers, presetPopover, historyPopover, modelPanel, presetBtn, historyBtn, modelChipBtn } = makeHarness();
    const insidePreset = document.createElement("span");
    presetPopover.appendChild(insidePreset);
    const insideHistory = document.createElement("span");
    historyPopover.appendChild(insideHistory);
    const insideModel = document.createElement("span");
    modelPanel.appendChild(insideModel);

    popovers.handleDocumentClick({ target: insidePreset });
    expect(presetPopover.hidden).toBe(false);
    expect(historyPopover.hidden).toBe(false);
    expect(modelPanel.hidden).toBe(false);

    popovers.handleDocumentClick({ target: presetBtn });
    expect(presetPopover.hidden).toBe(false);

    popovers.handleDocumentClick({ target: insideHistory });
    expect(historyPopover.hidden).toBe(false);

    popovers.handleDocumentClick({ target: historyBtn });
    expect(historyPopover.hidden).toBe(false);

    popovers.handleDocumentClick({ target: insideModel });
    expect(modelPanel.hidden).toBe(false);

    popovers.handleDocumentClick({ target: modelChipBtn });
    expect(modelPanel.hidden).toBe(false);
  });

  it("点击外部：三个弹层都关闭", () => {
    const { popovers, presetPopover, historyPopover, modelPanel } = makeHarness();
    const outside = document.createElement("div");
    document.body.appendChild(outside);

    popovers.handleDocumentClick({ target: outside });

    expect(presetPopover.hidden).toBe(true);
    expect(historyPopover.hidden).toBe(true);
    expect(modelPanel.hidden).toBe(true);
  });

  it("非 Element target（如 document/text node）：全关", () => {
    const { popovers, presetPopover, historyPopover, modelPanel } = makeHarness();

    popovers.handleDocumentClick({ target: document });

    expect(presetPopover.hidden).toBe(true);
    expect(historyPopover.hidden).toBe(true);
    expect(modelPanel.hidden).toBe(true);
  });
});

describe("handleEscapeKey（Esc 全关）", () => {
  it("Escape：三个弹层都关闭", () => {
    const { popovers, presetPopover, historyPopover, modelPanel } = makeHarness();

    popovers.handleEscapeKey(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(presetPopover.hidden).toBe(true);
    expect(historyPopover.hidden).toBe(true);
    expect(modelPanel.hidden).toBe(true);
  });

  it("非 Escape 键：no-op", () => {
    const { popovers, presetPopover, historyPopover, modelPanel } = makeHarness();

    popovers.handleEscapeKey(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(presetPopover.hidden).toBe(false);
    expect(historyPopover.hidden).toBe(false);
    expect(modelPanel.hidden).toBe(false);
  });
});
