// tests/reader/chat-model-panel.test.ts
// createReaderChatModelPanel（模型 chip + 「模型 + 思考强度」面板渲染，发送框
// 重构新增）行为契约：chip 是隐藏 <select>（值源）的展示层；面板列表按 optgroup
// 分组派生，点选项 = 写 select.value + 派生 change（组合根的 change 监听负责
// 持久化——本文件只断「值源被写 + change 被派生」两件事实）。
//
// 面板底部固定区内联「思考强度 <当前值> + 右上角 ↻ 重置键（Default 不干预档）」与
// 胶囊滑轨（真实档位数 ≥ 2）/ 单档胶囊（真实档位数 = 1）/ 仅标题行（真实档位数 = 0）。
// 本文件覆盖：
//
// - renderChip：文案 = 平台名·选中模型名 + 思考档位显示名（档位条派生过就用它的
//   显示名——开关型模型是 On；未派生时回落标签表）；optgroup label 缺失时只显示
//   模型名；select 禁用（未配置平台）→ chip 同步禁用并回落占位文案；集合站的
//   org 前缀（`deepseek-ai/`）只在显示层剥掉（chip 与弹层条目同口径，2026-10-06），
//   option 文本与值源照旧完整；
// - renderPanel：按 optgroup 分组渲染、当前选中项 is-selected + ✓、点击选项写
//   值源并派生 change 后关面板；点当前已选项不改值但仍关面板；
// - renderPanel 的面板宽度：打开时按 chip 可见宽快照写内联宽（打开期间档位/模型
//   变化不重算，重开才更新）；
// - renderThinkingPicker：**整份视图值一次画完**——首项 Default 渲染为右上角 ↻ 重置键，
//   真实档位按数量分三态（≥2 档胶囊滑轨、=1 档单档胶囊、0 档仅保留标题行）；
//   标题行右侧 = 视图显示名；chip 的档位 span 同步；底部提示行按 `view.hint` 写文案与显隐；
//   调整思考档位（点刻度 / 拖拽 / 滚轮 / 方向键 / 点 ↻）调 `pickLevel` 但**不关面板**；
//   所有非零档填充带 `.is-sparkle`（流动星点），仅档位数 ≥ 3 且处于最高档时加 `.is-max`（紫色渐变）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { ThinkingView } from "../../extension/chat/thinking-picker.js";

let createReaderChatModelPanel: typeof import("../../extension/reader/chat-model-panel.js").createReaderChatModelPanel;
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
let chatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").chatSessionStateForTests;
let thinkingPickerEntries: typeof import("../../extension/chat/thinking-picker.js").thinkingPickerEntries;

beforeEach(async () => {
  resetModuleState();
  chatSessionState = (await import("../../extension/chat/chat-state.js")).chatSessionState;
  chatSessionStateForTests = (await import("../../extension/chat/chat-state.js")).chatSessionStateForTests;
  createReaderChatModelPanel = (await import("../../extension/reader/chat-model-panel.js")).createReaderChatModelPanel;
  thinkingPickerEntries = (await import("../../extension/chat/thinking-picker.js")).thinkingPickerEntries;
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

// 视图值工厂（面板的思考档位入口收**整份** ThinkingView）：hint 缺省 null = 无提示行。
function view(over: Pick<ThinkingView, "label" | "entries"> & Partial<ThinkingView>): ThinkingView {
  return { hint: null, ...over };
}

// 提示行注入面（2026-10 深化）：hintMode 覆盖三种现实——
//   element = 注入模板里的提示行元素（生产形态）；
//   null    = 消费方明确没有提示行；
//   omitted = 消费方根本不认识这个字段（旧消费方 / 别的宿主）。
type HintMode = "element" | "null" | "omitted";

function makeHarness(select = makeSelect(), hintMode: HintMode = "element") {
  const chip = document.createElement("button");
  const chipModel = document.createElement("span");
  const chipLevel = document.createElement("span");
  chip.append(chipModel, chipLevel);
  const panelList = document.createElement("div");
  const panel = document.createElement("div");
  const thinkingToggle = document.createElement("div");
  const thinkingRow = document.createElement("div");
  const thinkingRowValue = document.createElement("span");
  thinkingRow.append(thinkingRowValue, thinkingToggle);
  // 提示行与思考强度区同处底部固定区（模板 chat-template.ts 的 .chat-model-panel-foot 同构）。
  const panelFoot = document.createElement("div");
  const thinkingHint = document.createElement("div");
  thinkingHint.hidden = true;
  panelFoot.append(thinkingRow, thinkingHint);
  panel.append(panelList, panelFoot);
  document.body.append(chip, panel);
  const hidePanel = vi.fn();
  const pickLevel = vi.fn();
  const modelPanel = createReaderChatModelPanel({
    modelSelect: select,
    chip,
    chipModel,
    chipLevel,
    panelList,
    panel,
    thinkingToggle,
    thinkingRow,
    thinkingRowValue,
    ...(hintMode === "element" ? { thinkingHint } : hintMode === "null" ? { thinkingHint: null } : {}),
    hidePanel,
    pickLevel
  });
  return {
    select,
    chip,
    chipModel,
    chipLevel,
    panelList,
    panel,
    thinkingToggle,
    thinkingRow,
    thinkingRowValue,
    thinkingHint: hintMode === "element" ? thinkingHint : null,
    hidePanel,
    pickLevel,
    modelPanel
  };
}

function click(node: HTMLElement): void {
  node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function buttons(toggle: HTMLElement): HTMLButtonElement[] {
  return [...toggle.querySelectorAll<HTMLButtonElement>(".chat-thinking-btn")];
}

function renderedLevels(toggle: HTMLElement): string[] {
  return buttons(toggle).map((btn) => btn.dataset.level || "");
}

function renderedLabels(toggle: HTMLElement): string[] {
  return buttons(toggle).map((btn) => (btn.querySelector(".chat-thinking-btn-label") as HTMLElement).textContent || "");
}

describe("renderChip", () => {
  it("模型名带平台名前缀（中点分隔）与档位分写两个 span（默认 off → Off）", () => {
    chatSessionStateForTests.aiThinkingLevel = "off";
    const { chip, chipModel, chipLevel, modelPanel } = makeHarness();

    modelPanel.renderChip();

    expect(chipModel.textContent).toBe("平台一·m1b");
    expect(chipLevel.textContent).toBe("Off");
    expect(chip.disabled).toBe(false);
  });

  it("选中项不在 optgroup 内：只显示模型名，不拼前缀", () => {
    const select = document.createElement("select");
    select.innerHTML = '<option value="solo" selected>solo-model</option>';
    const { chipModel, modelPanel } = makeHarness(select);

    modelPanel.renderChip();

    expect(chipModel.textContent).toBe("solo-model");
  });

  it("档位 span 随 chatSessionState.aiThinkingLevel（high → High），模型名不动", () => {
    chatSessionStateForTests.aiThinkingLevel = "high";
    const { chipModel, chipLevel, modelPanel } = makeHarness();

    modelPanel.renderChip();

    expect(chipModel.textContent).toBe("平台一·m1b");
    expect(chipLevel.textContent).toBe("High");
  });

  // 05 号票：档位词表扩到上游 7 档，标签表同步（口径 = 表内统一构词：首字母大写、
  // 其余小写；2026-10-05 用户裁定 xhigh → Xhigh，不写 XHigh）。未渲染过档位条时
  // chip 回落标签表。
  it("7 档标签表：off/minimal/low/medium/high/xhigh/max → Off/Minimal/Low/Medium/High/Xhigh/Max", () => {
    const expected: Array<[string, string]> = [
      ["off", "Off"],
      ["minimal", "Minimal"],
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["xhigh", "Xhigh"],
      ["max", "Max"]
    ];
    for (const [level, label] of expected) {
      chatSessionStateForTests.aiThinkingLevel = level as never;
      const { chipLevel, modelPanel } = makeHarness();
      modelPanel.renderChip();
      expect(chipLevel.textContent, level).toBe(label);
    }
  });

  // 2026-10-05 用户裁定：菜单里写 On、chip 写 High 是自相矛盾的——chip 的档位
  // span 优先用档位条派生的显示名（开关型模型即 On）。2026-10 深化后 chip 不再由调用点
  // 单独重渲：这一次 renderThinkingPicker 内部就把它画了（一次解析只渲一遍 chip）。
  it("档位条派生过显示名：chip 用它（开关型模型显示 On，即便偏好是别的非 off 档）", () => {
    chatSessionStateForTests.aiThinkingLevel = "low";
    const { chipLevel, thinkingToggle, modelPanel } = makeHarness();

    modelPanel.renderThinkingPicker(
      view({
        label: "On",
        entries: thinkingPickerEntries({
          availableLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
          switchOnly: true,
          requestedLevel: "low",
          effectiveLevel: null
        })
      })
    );

    expect(renderedLabels(thinkingToggle)).toEqual(["Default", "Off", "On"]);
    expect(chipLevel.textContent).toBe("On");
  });

  it("select 禁用（未配置平台）：chip 同步禁用，模型名回落占位、档位清空", () => {
    const select = document.createElement("select");
    select.disabled = true;
    const { chip, chipModel, chipLevel, modelPanel } = makeHarness(select);

    modelPanel.renderChip();

    expect(chipModel.textContent).toBe("未配置平台");
    expect(chipLevel.textContent).toBe("");
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
    click(target);

    expect(select.value).toBe(`p2${SEP}m2`);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  it("点击当前已选项：不改值但仍关面板", () => {
    const { select, panelList, hidePanel, modelPanel } = makeHarness();

    modelPanel.renderPanel();
    const current = panelList.querySelector<HTMLButtonElement>(`.chat-model-option[data-value="p1${SEP}m1b"]`) as HTMLButtonElement;
    click(current);

    expect(select.value).toBe(`p1${SEP}m1b`);
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  it("select 禁用（未配置平台）：列表渲染空态文案，思考强度行隐藏", () => {
    const select = document.createElement("select");
    select.disabled = true;
    const { panelList, thinkingRow, modelPanel } = makeHarness(select);

    modelPanel.renderPanel();

    expect(panelList.querySelector(".chat-model-empty")).not.toBe(null);
    expect(panelList.querySelectorAll(".chat-model-option")).toHaveLength(0);
    expect(thinkingRow.hidden).toBe(true);
  });
});

describe("renderPanel 的面板宽度（打开时快照）", () => {
  it("打开时按 chip 可见宽写面板内联宽", () => {
    const { chip, panel, modelPanel } = makeHarness();
    chip.getBoundingClientRect = () => ({ width: 252 } as DOMRect);

    modelPanel.renderPanel();

    expect(panel.style.width).toBe("252px");
  });

  it("打开期间 chip 宽度变化不重算（再次 renderPanel 才更新）", () => {
    const { chip, panel, modelPanel } = makeHarness();
    let visibleWidth = 252;
    chip.getBoundingClientRect = () => ({ width: visibleWidth } as DOMRect);

    modelPanel.renderPanel();
    expect(panel.style.width).toBe("252px");

    // 档位切换走 refreshThinkingUi → renderThinkingPicker（内部重渲 chip，chip 自身宽度变了），
    // 但面板未重开 → 宽度快照不动。
    visibleWidth = 300;
    modelPanel.renderThinkingPicker(view({ label: "High", entries: [] }));
    expect(panel.style.width).toBe("252px");

    // 重开（再次 renderPanel）才取新值
    modelPanel.renderPanel();
    expect(panel.style.width).toBe("300px");
  });
});

describe("renderThinkingPicker（内联思考强度滑块与 Default ↻ 重置键）", () => {
  const FOUR_LEVELS = { availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "high", effectiveLevel: "high" } as const;

  it("逐条现渲：首项为 ↻ 重置键（Default），其余为滑轨刻度，只有实发档带 is-active + aria-current", () => {
    const { thinkingToggle, thinkingRowValue, thinkingRow, modelPanel } = makeHarness();

    modelPanel.renderThinkingPicker(
      view({
        label: "High",
        entries: thinkingPickerEntries({ ...FOUR_LEVELS, availableLevels: [...FOUR_LEVELS.availableLevels] })
      })
    );

    expect(renderedLevels(thinkingToggle)).toEqual(["default", "off", "low", "high", "max"]);
    expect(renderedLabels(thinkingToggle)).toEqual(["Default", "Off", "Low", "High", "Max"]);
    for (const btn of buttons(thinkingToggle)) {
      const effective = btn.dataset.level === "high";
      expect(btn.classList.contains("is-active"), btn.dataset.level).toBe(effective);
      expect(btn.getAttribute("aria-current"), btn.dataset.level).toBe(effective ? "true" : "false");
      expect(btn.dataset.effective, btn.dataset.level).toBe(effective ? "true" : "false");
      // 点击判据与生效态分开：偏好落在 high → 只有 high 那一项不写偏好。
      expect(btn.dataset.writes, btn.dataset.level).toBe(effective ? "false" : "true");
    }
    const track = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-track");
    const thumb = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-thumb");
    expect(track).not.toBe(null);
    expect(track?.classList.contains("is-sparkle")).toBe(true);
    expect(track?.classList.contains("is-max")).toBe(false);
    expect(thumb?.hidden).toBe(false);
    expect(thinkingRowValue.textContent).toBe("High");
    expect(thinkingRow.hidden).toBe(false);
  });

  it("点非选中项：pickLevel(该档)，面板保持打开（hidePanel 不调用）", () => {
    const { thinkingToggle, hidePanel, pickLevel, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(view({ label: "High", entries: thinkingPickerEntries({ ...FOUR_LEVELS, availableLevels: [...FOUR_LEVELS.availableLevels] }) }));

    click(buttons(thinkingToggle)[2]);

    expect(pickLevel).toHaveBeenCalledWith("low");
    expect(hidePanel).not.toHaveBeenCalled();
  });

  // 05 号票「偏好保留不迁移」：已经是自己偏好的那一项不重写偏好。
  it("点已经是自己偏好的那一项：不重写偏好（pickLevel 不调用），面板保持打开", () => {
    const { thinkingToggle, hidePanel, pickLevel, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(view({ label: "High", entries: thinkingPickerEntries({ ...FOUR_LEVELS, availableLevels: [...FOUR_LEVELS.availableLevels] }) }));

    click(buttons(thinkingToggle)[3]);

    expect(pickLevel).not.toHaveBeenCalled();
    expect(hidePanel).not.toHaveBeenCalled();
  });

  // 2026-10-05 裁定 B（口径 ⑤）：偏好 ≠ 实发时点实发档写偏好（用户显式接受本次 clamp）。
  it("点生效的实发档而偏好 ≠ 实发：写偏好 + 面板保持打开", () => {
    const { thinkingToggle, hidePanel, pickLevel, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(
      view({
        label: "High",
        entries: thinkingPickerEntries({ availableLevels: ["high", "max"], switchOnly: false, requestedLevel: "off", effectiveLevel: "high" })
      })
    );

    const active = buttons(thinkingToggle).find((btn) => btn.classList.contains("is-active"));
    expect(active?.dataset.level).toBe("high");
    click(active as HTMLButtonElement);

    expect(pickLevel).toHaveBeenCalledWith("high");
    expect(hidePanel).not.toHaveBeenCalled();
  });

  it("三态分支：Default 隐藏滑块圆点；单档渲染胶囊 pill；零档行只剩 Default ↻ 且不渲染滑轨", () => {
    const { thinkingToggle, thinkingRow, modelPanel } = makeHarness();

    // 1. 多档且实发为 Default：滑轨在场，但白色滑块 hidden、填充为 0。
    modelPanel.renderThinkingPicker(
      view({
        label: "Default",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "default", effectiveLevel: "default" })
      })
    );
    expect(thinkingToggle.querySelector(".chat-thinking-track")).not.toBe(null);
    expect(thinkingToggle.querySelector<HTMLElement>(".chat-thinking-thumb")?.hidden).toBe(true);
    expect(thinkingToggle.querySelector<HTMLElement>(".chat-thinking-fill")?.style.width).toBe("0px");

    // 2. 单档（仅 1 个真实档位，无 off）：渲染 .chat-thinking-single 胶囊而非滑轨。
    modelPanel.renderThinkingPicker(
      view({
        label: "On",
        entries: thinkingPickerEntries({ availableLevels: ["high"], switchOnly: false, requestedLevel: "high", effectiveLevel: "high" })
      })
    );
    expect(thinkingToggle.querySelector(".chat-thinking-single")).not.toBe(null);
    expect(thinkingToggle.querySelector(".chat-thinking-track")).toBe(null);
    expect(renderedLabels(thinkingToggle)).toEqual(["Default", "On"]);

    // 3. 零档行（A' = ∅）：只渲染 Default ↻ 按钮，无滑轨无单档行，但思考强度行照旧显示（ADR-0015）。
    modelPanel.renderThinkingPicker(
      view({
        label: "Default",
        entries: thinkingPickerEntries({ availableLevels: [], switchOnly: false, requestedLevel: "default", effectiveLevel: "default" })
      })
    );
    expect(thinkingRow.hidden).toBe(false);
    expect(renderedLevels(thinkingToggle)).toEqual(["default"]);
    expect(thinkingToggle.querySelector(".chat-thinking-track")).toBe(null);
    expect(thinkingToggle.querySelector(".chat-thinking-single")).toBe(null);
  });

  it("星点与最高档渐变：所有非零档（index > 0）带 is-sparkle，仅档位数 ≥ 3 的最右端带 is-max", () => {
    const { thinkingToggle, modelPanel } = makeHarness();

    // 2 档开关型（Off / On）选中 On（index=1）：带星点 is-sparkle，不带紫色渐变 is-max。
    modelPanel.renderThinkingPicker(
      view({
        label: "On",
        entries: thinkingPickerEntries({ availableLevels: ["off", "high"], switchOnly: true, requestedLevel: "high", effectiveLevel: "high" })
      })
    );
    let track = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-track")!;
    expect(track.classList.contains("is-sparkle")).toBe(true);
    expect(track.classList.contains("is-max")).toBe(false);

    // 4 档选中最高档 Max（index=3，n=4 ≥ 3）：同时带 is-sparkle、is-max 与脉冲 is-ultra-burst。
    modelPanel.renderThinkingPicker(
      view({
        label: "Max",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "max", effectiveLevel: "max" })
      })
    );
    track = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-track")!;
    expect(track.classList.contains("is-sparkle")).toBe(true);
    expect(track.classList.contains("is-max")).toBe(true);
    expect(track.classList.contains("is-ultra-burst")).toBe(true);
  });

  it("滑轨支持指针拖拽（实时预览 + 磁吸释放落盘）、滚轮步进与键盘方向键步进", () => {
    const { thinkingToggle, thinkingRowValue, pickLevel, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(
      view({
        label: "Off",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "off", effectiveLevel: "off" })
      })
    );

    const track = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-track")!;
    const range = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-range")!;
    range.getBoundingClientRect = () => ({ left: 0, width: 300 } as DOMRect);

    // 1. 指针按下并拖到 2/3 处（对应 high，index=2）：实时预览标题行文案，释放后调 pickLevel("high")。
    track.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, button: 0 }));
    track.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 200 }));
    expect(thinkingRowValue.textContent).toBe("High");
    track.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 200 }));
    expect(pickLevel).toHaveBeenLastCalledWith("high");

    // 2. 滚轮向上（deltaY < 0）：从当前实发 off（index=0）步进到 low（index=1）。
    pickLevel.mockClear();
    track.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 }));
    expect(pickLevel).toHaveBeenCalledWith("low");

    // 3. 键盘 ArrowRight：从当前实发 off（index=0）步进到 low（index=1）。
    pickLevel.mockClear();
    track.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }));
    expect(pickLevel).toHaveBeenCalledWith("low");
  });

  it("空条目：一个按钮都不渲染（fail-closed，面板只剩提示行）", () => {
    const { thinkingToggle, modelPanel } = makeHarness();

    modelPanel.renderThinkingPicker(view({ label: "Off", entries: [] }));

    expect(buttons(thinkingToggle)).toEqual([]);
  });
});

// 2026-10 深化（hint 从组合根移入面板）：提示行的文案与显隐由**面板**按视图值写，
// 组合根不再持有该元素、也不再知道调用顺序。显隐条件本身（何时 view.hint = null）是
// chat/thinking-picker 的纯函数口径，由 tests/chat/thinking-picker.test.ts 锁定；本组
// 用例钉的是「整份视图 → 提示行 DOM」的接线（真实 DOM 直测）。
describe("renderThinkingPicker 的底部提示行（工单 03 / 05 号票：文案与显隐接线）", () => {
  const HINT_UNAVAILABLE = "当前模型没办法关掉思考";

  it("hint 有文案：显示并写进提示行；同一次调用里档位、思考强度行与 chip 一起落定", () => {
    const { thinkingHint, thinkingToggle, thinkingRowValue, chipLevel, modelPanel } = makeHarness();

    expect(thinkingHint?.hidden).toBe(true);

    modelPanel.renderThinkingPicker(
      view({
        label: "High",
        entries: thinkingPickerEntries({ availableLevels: ["high", "max"], switchOnly: false, requestedLevel: "off", effectiveLevel: "high" }),
        hint: "当前模型不支持在本次请求中关闭思考，已使用最小思考档位"
      })
    );

    expect(thinkingHint).not.toBe(null);
    expect(thinkingHint?.hidden).toBe(false);
    expect(thinkingHint?.textContent).toBe("当前模型不支持在本次请求中关闭思考，已使用最小思考档位");
    expect(renderedLevels(thinkingToggle)).toEqual(["default", "high", "max"]);
    expect(thinkingRowValue.textContent).toBe("High");
    expect(chipLevel.textContent).toBe("High");
  });

  it("hint = null：隐藏并清空上一次的文案（每次解析都重写，不留残影）", () => {
    const { thinkingHint, modelPanel } = makeHarness();
    const entries = thinkingPickerEntries({ availableLevels: ["off", "low", "high"], switchOnly: false, requestedLevel: "off", effectiveLevel: "off" });

    modelPanel.renderThinkingPicker(view({ label: "Off", entries, hint: HINT_UNAVAILABLE }));
    expect(thinkingHint?.hidden).toBe(false);

    modelPanel.renderThinkingPicker(view({ label: "Off", entries }));

    expect(thinkingHint?.hidden).toBe(true);
    expect(thinkingHint?.textContent).toBe("");
  });

  it("不注入提示行元素（缺省字段）或明确传 null：档位与 chip 照画，不抛", () => {
    for (const hintMode of ["omitted", "null"] as const) {
      const { thinkingHint, thinkingToggle, thinkingRowValue, chipLevel, modelPanel } = makeHarness(makeSelect(), hintMode);

      expect(thinkingHint, hintMode).toBe(null);
      expect(() =>
        modelPanel.renderThinkingPicker(
          view({
            label: "Medium",
            entries: thinkingPickerEntries({ availableLevels: ["off", "medium"], switchOnly: false, requestedLevel: "medium", effectiveLevel: "medium" }),
            hint: HINT_UNAVAILABLE
          })
        )
      ).not.toThrow();

      expect(renderedLevels(thinkingToggle), hintMode).toEqual(["default", "off", "medium"]);
      expect(thinkingRowValue.textContent, hintMode).toBe("Medium");
      expect(chipLevel.textContent, hintMode).toBe("Medium");
    }
  });
});

// 2026-10-06 用户报障（截图 `ModelScope·deepseek-ai/DeepSeek-V4.1-…`）：集合站
// （ModelScope / OpenRouter 等）回的模型 id 带组织命名空间前缀，chip 与弹层列表
// 只显示最后一段裸名。**只碰显示层**：option 文本与 value（复合值）照旧完整，
// 点选落盘值因此不变（剥前缀渗进值源 = 换错模型，本组用例专门钉住）。
describe("模型名显示：集合站的 org 前缀只在显示层剥掉", () => {
  // select 形状与 providers.renderModelSelect 的产物同构：平台 optgroup +
  // 完整 id 做选项文本、`平台 id\u0001模型 id` 复合值做 value。
  function makeNamespacedSelect(): HTMLSelectElement {
    const select = document.createElement("select");
    select.innerHTML =
      '<optgroup label="ModelScope">' +
      `<option value="modelscope${SEP}deepseek-ai/DeepSeek-V4.1-Flash" selected>deepseek-ai/DeepSeek-V4.1-Flash</option>` +
      `<option value="modelscope${SEP}Qwen/Qwen3-32B">Qwen/Qwen3-32B</option>` +
      "</optgroup>" +
      '<optgroup label="硅基流动">' +
      `<option value="siliconflow${SEP}glm-4.6">glm-4.6</option>` +
      `<option value="siliconflow${SEP}org/">org/</option>` +
      "</optgroup>";
    document.body.appendChild(select);
    return select;
  }

  function optionNames(panelList: HTMLElement): string[] {
    return [...panelList.querySelectorAll<HTMLElement>(".chat-model-option-name")].map(
      (node) => node.textContent || ""
    );
  }

  it("chip：命名空间 id 只显示裸名（平台名·裸名，不再带 org/）", () => {
    const { chipModel, modelPanel } = makeHarness(makeNamespacedSelect());

    modelPanel.renderChip();

    expect(chipModel.textContent).toBe("ModelScope·DeepSeek-V4.1-Flash");
  });

  it("chip：无斜杠裸名与尾斜杠 id 原样显示（不误伤、不剥成空串）", () => {
    const select = makeNamespacedSelect();
    const { chipModel, modelPanel } = makeHarness(select);

    select.value = `siliconflow${SEP}glm-4.6`;
    modelPanel.renderChip();
    expect(chipModel.textContent).toBe("硅基流动·glm-4.6");

    select.value = `siliconflow${SEP}org/`;
    modelPanel.renderChip();
    expect(chipModel.textContent).toBe("硅基流动·org/");
  });

  it("弹层列表条目同样剥前缀，data-value 仍是完整复合值", () => {
    const { panelList, modelPanel } = makeHarness(makeNamespacedSelect());

    modelPanel.renderPanel();

    expect(optionNames(panelList)).toEqual(["DeepSeek-V4.1-Flash", "Qwen3-32B", "glm-4.6", "org/"]);
    expect(
      [...panelList.querySelectorAll(".chat-model-option")].map((btn) => btn.getAttribute("data-value"))
    ).toEqual([
      `modelscope${SEP}deepseek-ai/DeepSeek-V4.1-Flash`,
      `modelscope${SEP}Qwen/Qwen3-32B`,
      `siliconflow${SEP}glm-4.6`,
      `siliconflow${SEP}org/`
    ]);
  });

  it("点被剥名的条目：值源写完整复合值（剥前缀不渗进落盘值）", () => {
    const select = makeNamespacedSelect();
    const { panelList, modelPanel } = makeHarness(select);
    modelPanel.renderPanel();

    const qwen = panelList.querySelector<HTMLButtonElement>(
      `.chat-model-option[data-value="modelscope${SEP}Qwen/Qwen3-32B"]`
    ) as HTMLButtonElement;
    click(qwen);

    expect(select.value).toBe(`modelscope${SEP}Qwen/Qwen3-32B`);
  });
});
