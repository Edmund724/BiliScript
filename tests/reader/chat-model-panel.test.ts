// tests/reader/chat-model-panel.test.ts
// createReaderChatModelPanel（模型 chip + 「模型 + 思考强度」面板渲染，发送框
// 重构新增）行为契约：chip 是隐藏 <select>（值源）的展示层；面板列表按 optgroup
// 分组派生，点选项 = 写 select.value + 派生 change（组合根的 change 监听负责
// 持久化——本文件只断「值源被写 + change 被派生」两件事实）。
//
// 2026-10-05 用户裁定（票据 chat-thinking-submenu）起，面板底部是二级菜单：
// 模型页 + 档位页（换页），底部固定区一行「思考强度 <当前值> ›」。本文件覆盖：
//
// - renderChip：文案 = 平台名·选中模型名 + 思考档位显示名（档位条派生过就用它的
//   显示名——开关型模型是 On；未派生时回落标签表）；optgroup label 缺失时只显示
//   模型名；select 禁用（未配置平台）→ chip 同步禁用并回落占位文案；集合站的
//   org 前缀（`deepseek-ai/`）只在显示层剥掉（chip 与弹层条目同口径，2026-10-06），
//   option 文本与值源照旧完整；
// - renderPanel：按 optgroup 分组渲染、当前选中项 is-selected + ✓、点击选项写
//   值源并派生 change 后关面板；点当前已选项不改值但仍关面板；打开即回到模型页；
// - renderPanel 的面板宽度：打开时按 chip 可见宽快照写内联宽（打开期间档位/模型
//   变化不重算，重开才更新）；
// - renderThinkingPicker：**整份视图值一次画完**（2026-10 深化：hint 从组合根移入本模块）
//   ——档位条目现渲（顺序 / 显示名 / is-active + aria-current + data-effective /
//   data-writes / 只有实发档带 ✓）；一级行右侧 = 视图显示名；chip 的档位 span 同步；
//   底部提示行按 `view.hint` 写文案与显隐（null = 隐藏且清空；不注入提示行元素时静默跳过）；
//   点 writesPreference 的项 → pickLevel(level) + 关面板；点「已经是自己偏好」的那一项 →
//   不重写偏好（05 号票「偏好不迁移」）+ 关面板；勾住的那一项在偏好 ≠ 实发时**也写偏好**
//   （2026-10-05 裁定 B：勾 = 实发档，点它即接受本次 clamp）；
// - 换页：点一级行 → 档位页可见 + 模型列表隐藏 + 一级行隐藏（aria-expanded=true）；
//   点返回行 → 回来。
//
// hint 的显隐/接线由此处（真实 DOM 直测）守护：显隐条件本身（何时为 null）是
// chat/thinking-picker 的纯函数口径，已由 tests/chat/thinking-picker.test.ts 锁定；本文件
// 钉的是「视图值 → 提示行 DOM」这一段接线。

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
  const thinkingPage = document.createElement("div");
  const thinkingBack = document.createElement("button");
  const thinkingToggle = document.createElement("div");
  const thinkingRow = document.createElement("button");
  const thinkingRowValue = document.createElement("span");
  thinkingRow.append(thinkingRowValue);
  // 提示行与一级行同处底部固定区（模板 chat-template.ts 的 .chat-model-panel-foot 同构）。
  const panelFoot = document.createElement("div");
  const thinkingHint = document.createElement("div");
  thinkingHint.hidden = true;
  panelFoot.append(thinkingRow, thinkingHint);
  panel.append(panelList, thinkingPage, panelFoot);
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
    thinkingPage,
    thinkingBack,
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
    thinkingPage,
    thinkingBack,
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

  it("每次打开都从模型页开始（换页状态不留到下一次）", () => {
    const { panelList, thinkingPage, thinkingRow, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(view({ label: "Low", entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high"], switchOnly: false, requestedLevel: "low", effectiveLevel: null }) }));
    modelPanel.renderPanel();
    click(thinkingRow);
    expect(thinkingPage.hidden).toBe(false);

    modelPanel.renderPanel();

    expect(panelList.hidden).toBe(false);
    expect(thinkingPage.hidden).toBe(true);
    expect(thinkingRow.hidden).toBe(false);
    expect(thinkingRow.getAttribute("aria-expanded")).toBe("false");
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

    // 档位点击走 refreshThinkingUi → renderThinkingPicker（内部重渲 chip，chip 自身宽度变了），
    // 但面板未重开 → 宽度快照不动。
    visibleWidth = 300;
    modelPanel.renderThinkingPicker(view({ label: "High", entries: [] }));
    expect(panel.style.width).toBe("252px");

    // 重开（再次 renderPanel）才取新值
    modelPanel.renderPanel();
    expect(panel.style.width).toBe("300px");
  });
});

describe("renderThinkingPicker（2026-10 用户裁定：二级菜单的档位页条目）", () => {
  const FOUR_LEVELS = { availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "high", effectiveLevel: "high" } as const;

  it("逐条现渲：顺序 = 条目顺序，只有实发档带 is-active + aria-current + ✓", () => {
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
      // 点击判据与打勾分开：偏好落在 high → 只有 high 那一项不写偏好。
      expect(btn.dataset.writes, btn.dataset.level).toBe(effective ? "false" : "true");
      expect(btn.querySelector(".chat-thinking-check") !== null, btn.dataset.level).toBe(effective);
    }
    expect(thinkingRowValue.textContent).toBe("High");
    expect(thinkingRow.hidden).toBe(false);
  });

  it("点非选中项：pickLevel(该档) + 关面板", () => {
    const { thinkingToggle, hidePanel, pickLevel, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(view({ label: "High", entries: thinkingPickerEntries({ ...FOUR_LEVELS, availableLevels: [...FOUR_LEVELS.availableLevels] }) }));

    click(buttons(thinkingToggle)[2]);

    expect(pickLevel).toHaveBeenCalledWith("low");
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  // 05 号票「偏好保留不迁移」：开关型的 On 是 canonical high，偏好停在别的非 off 档
  // 时重写会把偏好悄悄搬走——已经是自己偏好的那一项只关面板，不写偏好。
  it("点已经是自己偏好的那一项：不重写偏好（pickLevel 不调用），仍关面板", () => {
    const { thinkingToggle, hidePanel, pickLevel, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(view({ label: "High", entries: thinkingPickerEntries({ ...FOUR_LEVELS, availableLevels: [...FOUR_LEVELS.availableLevels] }) }));

    click(buttons(thinkingToggle)[3]);

    expect(pickLevel).not.toHaveBeenCalled();
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  // 2026-10-05 裁定 B（口径 ⑤）：勾 = 实发档。偏好 ≠ 实发时勾住的那一项点下去**写偏好**
  // （用户显式接受本次 clamp），不再是「已选中 → 只关面板」。
  it("点勾住的实发档而偏好 ≠ 实发：写偏好 + 关面板（裁定 B 的新契约）", () => {
    const { thinkingToggle, hidePanel, pickLevel, modelPanel } = makeHarness();
    // off 关不掉的格：偏好 off、A' = {high,max} → 实发 high 带勾，偏好 off 在列表里没有对应项。
    modelPanel.renderThinkingPicker(
      view({
        label: "High",
        entries: thinkingPickerEntries({ availableLevels: ["high", "max"], switchOnly: false, requestedLevel: "off", effectiveLevel: "high" })
      })
    );

    const checked = buttons(thinkingToggle).find((btn) => btn.classList.contains("is-active"));
    expect(checked?.dataset.level).toBe("high");
    click(checked as HTMLButtonElement);

    expect(pickLevel).toHaveBeenCalledWith("high");
    expect(hidePanel).toHaveBeenCalledTimes(1);
  });

  // 2026-10-05：`Default` 是恒在的首项后，「条目 ≤1 就隐藏整行」的旧规则退休——唯一只剩
  // 一项的情形是「只有 Default」（模型没有可表达的强度档），用户裁定那一格也要能主动选。
  it("一级行不再按条目数隐藏：只剩 Default 一项也显示（破例 = 能主动选）", () => {
    const { thinkingRow, modelPanel } = makeHarness();

    modelPanel.renderThinkingPicker(view({ label: "Default", entries: thinkingPickerEntries({ availableLevels: [], switchOnly: false, requestedLevel: "default", effectiveLevel: "default" }) }));
    expect(thinkingRow.hidden).toBe(false);

    modelPanel.renderThinkingPicker(view({ label: "High", entries: thinkingPickerEntries({ ...FOUR_LEVELS, availableLevels: [...FOUR_LEVELS.availableLevels] }) }));
    expect(thinkingRow.hidden).toBe(false);
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

  it("hint 有文案：显示并写进提示行；同一次调用里档位、一级行与 chip 一起落定", () => {
    const { thinkingHint, thinkingToggle, thinkingRowValue, chipLevel, modelPanel } = makeHarness();

    // 注入时是模板默认 hidden（工单 03：激活前壳静默空态），面板不主动显示——渲染才写显隐。
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
    // 「整份视图一个入口」的机械证据：一次调用把四件事都画了（不再由调用点分两次画）。
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
    // 兼容面：别的消费方（或模板没有提示行）不认识该字段时，面板的其余渲染不受影响。
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

describe("换页（点一级行进档位页 / 点返回行回模型页）", () => {
  function openedHarness() {
    const harness = makeHarness();
    harness.modelPanel.renderThinkingPicker(
      view({
        label: "High",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "high", effectiveLevel: null })
      })
    );
    harness.modelPanel.renderPanel();
    return harness;
  }

  it("点一级行：档位页可见、模型列表隐藏、一级行隐藏且 aria-expanded=true", () => {
    const { panelList, thinkingPage, thinkingRow, modelPanel } = openedHarness();
    expect(thinkingPage.hidden).toBe(true);

    click(thinkingRow);

    expect(thinkingPage.hidden).toBe(false);
    expect(panelList.hidden).toBe(true);
    expect(thinkingRow.hidden).toBe(true);
    expect(thinkingRow.getAttribute("aria-expanded")).toBe("true");
    void modelPanel;
  });

  it("点返回行：回模型页（列表重现、一级行重现、档位页隐藏）", () => {
    const { panelList, thinkingPage, thinkingRow, thinkingBack } = openedHarness();
    click(thinkingRow);

    click(thinkingBack);

    expect(panelList.hidden).toBe(false);
    expect(thinkingPage.hidden).toBe(true);
    expect(thinkingRow.hidden).toBe(false);
    expect(thinkingRow.getAttribute("aria-expanded")).toBe("false");
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
