// tests/reader/chat-model-panel.test.ts
// createReaderChatModelPanel（模型 chip + 「模型 + 思考档位」面板渲染，发送框
// 重构新增）行为契约：chip 是隐藏 <select>（值源）的展示层；面板列表按 optgroup
// 分组派生，点选项 = 写 select.value + 派生 change（组合根的 change 监听负责
// 持久化——本文件只断「值源被写 + change 被派生」两件事实）。
//
// 覆盖：
// - renderChip：文案 = 选中模型名 + 思考档位标签（off/low/high → Off/Low/High）；
//   select 禁用（未配置平台）→ chip 同步禁用并回落占位文案；
// - renderPanel：按 optgroup 分组渲染、当前选中项 is-selected + ✓、点击选项写
//   值源并派生 change 后关面板；点当前已选项不改值但仍关面板。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let createReaderChatModelPanel: typeof import("../../extension/reader/chat-model-panel.js").createReaderChatModelPanel;
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;

beforeEach(async () => {
  resetModuleState();
  chatSessionState = (await import("../../extension/chat/chat-state.js")).chatSessionState;
  createReaderChatModelPanel = (await import("../../extension/reader/chat-model-panel.js")).createReaderChatModelPanel;
  document.body.innerHTML = "";
});

// multi-model-catalog 复合值分隔符（「平台 id\u0001模型 id」）。
const SEP = String.fromCharCode(1);

// 值源 select：两个平台分组（p1 两个模型 / p2 一个模型），选中 p1 的 m1b。
function makeSelect() {
  const select = document.createElement("select");
  select.innerHTML =
    '<optgroup label="平台一">' +
    `<option value="p1${SEP}m1a">m1a</option>` +
    `<option value="p1${SEP}m1b" selected>m1b</option>` +
    "</optgroup>" +
    '<optgroup label="平台二">' +
    `<option value="p2${SEP}m2">m2</option>` +
    "</optgroup>";
  document.body.appendChild(select);
  return select;
}

function makeHarness(select = makeSelect()) {
  const chip = document.createElement("button");
  const chipLabel = document.createElement("span");
  chip.appendChild(chipLabel);
  const panelList = document.createElement("div");
  const inputBar = document.createElement("div");
  document.body.append(chip, panelList, inputBar);
  const hidePanel = vi.fn();
  const modelPanel = createReaderChatModelPanel({ modelSelect: select, chip, chipLabel, panelList, inputBar, hidePanel });
  return { select, chip, chipLabel, panelList, inputBar, hidePanel, modelPanel };
}

describe("renderChip", () => {
  it("文案 = 选中模型名 + 当前思考档位标签（默认 off → Off）", () => {
    chatSessionState.aiThinkingLevel = "off";
    const { chip, chipLabel, modelPanel } = makeHarness();

    modelPanel.renderChip();

    expect(chipLabel.textContent).toBe("m1b Off");
    expect(chip.disabled).toBe(false);
  });

  it("档位标签随 chatSessionState.aiThinkingLevel（high → High）", () => {
    chatSessionState.aiThinkingLevel = "high";
    const { chipLabel, modelPanel } = makeHarness();

    modelPanel.renderChip();

    expect(chipLabel.textContent).toBe("m1b High");
  });

  it("select 禁用（未配置平台）：chip 同步禁用并回落占位文案", () => {
    const select = document.createElement("select");
    select.disabled = true;
    const { chip, chipLabel, modelPanel } = makeHarness(select);

    modelPanel.renderChip();

    expect(chipLabel.textContent).toBe("未配置平台");
    expect(chip.disabled).toBe(true);
  });
});

describe("renderPanel", () => {
  it("按 optgroup 分组渲染，当前选中项 is-selected 且带 ✓", () => {
    const { panelList, modelPanel } = makeHarness();

    modelPanel.renderPanel();

    const groups = panelList.querySelectorAll(".chat-model-group");
    expect([...groups].map((node) => node.textContent)).toEqual(["平台一", "平台二"]);
    const options = panelList.querySelectorAll(".chat-model-option");
    expect(options).toHaveLength(3);
    const selected = panelList.querySelectorAll(".chat-model-option.is-selected");
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute("data-value")).toBe(`p1${SEP}m1b`);
    expect(selected[0].querySelector(".chat-model-check")).not.toBe(null);
  });

  it("点击选项：写值源 + 派生 change + 关面板", () => {
    const { select, panelList, hidePanel, modelPanel } = makeHarness();
    const onChange = vi.fn();
    select.addEventListener("change", onChange);

    modelPanel.renderPanel();
    const target = panelList.querySelector<HTMLButtonElement>(`.chat-model-option[data-value="p2${SEP}m2"]`) as HTMLButtonElement;
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(select.value).toBe(`p2${SEP}m2`);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  it("点击当前已选项：不改值但仍关面板", () => {
    const { select, panelList, hidePanel, modelPanel } = makeHarness();

    modelPanel.renderPanel();
    const current = panelList.querySelector<HTMLButtonElement>(`.chat-model-option[data-value="p1${SEP}m1b"]`) as HTMLButtonElement;
    current.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(select.value).toBe(`p1${SEP}m1b`);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  it("select 禁用（未配置平台）：列表渲染空态文案", () => {
    const select = document.createElement("select");
    select.disabled = true;
    const { panelList, modelPanel } = makeHarness(select);

    modelPanel.renderPanel();

    expect(panelList.querySelector(".chat-model-empty")).not.toBe(null);
    expect(panelList.querySelectorAll(".chat-model-option")).toHaveLength(0);
  });
});
