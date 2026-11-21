import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { ThinkingView } from "../../extension/chat/thinking-picker.js";

const ROOT = process.cwd();
const CHAT_CSS_PATH = "extension/entry/styles/reader-chat.css";

function readCss(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function getRuleBody(css: string, selector: string): string {
  const text = stripComments(css);
  const rules = text.match(/[^{}]+\{[^}]*\}/g) || [];
  const matched = rules
    .map((rule) => {
      const [head, body] = rule.split("{");
      return { head: head.trim(), body: body.trim() };
    })
    .filter((rule) => rule.head.split(",").map((s) => s.trim()).includes(selector));

  expect(matched.length, `应找到选择器 ${selector} 对应的规则`).toBeGreaterThan(0);
  return matched.map((r) => r.body).join("\n");
}

describe("05: 思考强度滑轨运行时几何与交互契约", () => {
  let createReaderChatModelPanel: typeof import("../../extension/reader/chat-model-panel.js").createReaderChatModelPanel;
  let thinkingPickerEntries: typeof import("../../extension/chat/thinking-picker.js").thinkingPickerEntries;

  beforeEach(async () => {
    resetModuleState();
    createReaderChatModelPanel = (await import("../../extension/reader/chat-model-panel.js")).createReaderChatModelPanel;
    thinkingPickerEntries = (await import("../../extension/chat/thinking-picker.js")).thinkingPickerEntries;
    document.body.innerHTML = "";
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia;
  });

  const SEP = String.fromCharCode(1);

  function makeSelect() {
    const select = document.createElement("select");
    select.innerHTML =
      '<optgroup label="测试平台">' +
      `<option value="p1${SEP}m1" selected>m1</option>` +
      "</optgroup>";
    document.body.appendChild(select);
    return select;
  }

  function view(over: Pick<ThinkingView, "label" | "entries"> & Partial<ThinkingView>): ThinkingView {
    return { hint: null, ...over };
  }

  function makeHarness() {
    const select = makeSelect();
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
      thinkingHint,
      hidePanel,
      openSettings: vi.fn(),
      pickLevel
    });
    return {
      select,
      thinkingToggle,
      thinkingRow,
      thinkingRowValue,
      pickLevel,
      modelPanel
    };
  }

  it("renderThinkingPicker: fill 宽度计算采用 calc(pct% + 12px)，thumb 水平百分比与隐藏状态匹配", () => {
    const { thinkingToggle, modelPanel } = makeHarness();

    modelPanel.renderThinkingPicker(
      view({
        label: "Off",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "off", effectiveLevel: "off" })
      })
    );
    const fill = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-fill")!;
    const thumb = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-thumb")!;
    expect(thumb.hidden).toBe(false);
    expect(thumb.style.left).toBe("0%");
    expect(fill.style.width).toBe("0px");

    modelPanel.renderThinkingPicker(
      view({
        label: "Low",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "low", effectiveLevel: "low" })
      })
    );
    expect(thumb.hidden).toBe(false);
    expect(thumb.style.left).toMatch(/^33\.3333.*%$/);
    expect(fill.style.width).toMatch(/^calc\(33\.3333.*% \+ 12px\)$/);

    modelPanel.renderThinkingPicker(
      view({
        label: "Max",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "max", effectiveLevel: "max" })
      })
    );
    expect(thumb.hidden).toBe(false);
    expect(thumb.style.left).toBe("100%");
    expect(fill.style.width).toBe("calc(100% + 12px)");
  });

  it("指针拖拽 previewAt: 实时预览采用 calc(pct% + 12px) 几何并保持吸附与选档", () => {
    const { thinkingToggle, thinkingRowValue, pickLevel, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(
      view({
        label: "Off",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "off", effectiveLevel: "off" })
      })
    );

    const track = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-track")!;
    const range = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-range")!;
    const fill = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-fill")!;
    const thumb = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-thumb")!;
    range.getBoundingClientRect = () => ({ left: 0, width: 300 } as DOMRect);

    track.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, button: 0 }));
    track.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100 }));

    expect(thumb.style.left).toMatch(/^33\.3333.*%$/);
    expect(fill.style.width).toMatch(/^calc\(33\.3333.*% \+ 12px\)$/);
    expect(thinkingRowValue.textContent).toBe("Low");

    track.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 100 }));
    expect(pickLevel).toHaveBeenCalledWith("low");
  });
  it("CSS 契约：滑块不声明 transition: left 与常驻 will-change，避免主线程位移重排", () => {
    const css = readCss(CHAT_CSS_PATH);
    const thumbBody = getRuleBody(css, ".biliscript-reading-chat .chat-thinking-thumb");
    expect(thumbBody).not.toMatch(/transition:\s*left/);
    expect(thumbBody).not.toMatch(/will-change/);
  });

  it("拖拽周期缓存 range 矩形，pointermove 不重复查询布局，拖拽中 resize 自动刷新几何", () => {
    const { thinkingToggle, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(
      view({
        label: "Off",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "off", effectiveLevel: "off" })
      })
    );

    const track = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-track")!;
    const range = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-range")!;
    let rectQueries = 0;
    range.getBoundingClientRect = () => {
      rectQueries++;
      return { left: 0, width: 300 } as DOMRect;
    };

    track.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, button: 0 }));
    const downQueries = rectQueries;
    expect(downQueries).toBeGreaterThan(0);

    for (let x = 10; x <= 50; x += 10) {
      track.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: x }));
    }
    expect(rectQueries - downQueries).toBe(0);

    const beforeResizeQueries = rectQueries;
    window.dispatchEvent(new Event("resize"));
    expect(rectQueries).toBeGreaterThan(beforeResizeQueries);

    track.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 50 }));
  });

  it("滑块位移动画通过 transform 表达且最终归零，响应式布局决定百分比终点，无过期像素终点", () => {
    const { thinkingToggle, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(
      view({
        label: "Off",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "off", effectiveLevel: "off" })
      })
    );

    const range = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-range")!;
    const thumb = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-thumb")!;
    range.getBoundingClientRect = () => ({ left: 0, width: 300 } as DOMRect);

    modelPanel.renderThinkingPicker(
      view({
        label: "Low",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "low", effectiveLevel: "low" })
      })
    );

    expect(thumb.style.left).toMatch(/^33\.3333.*%$/);
    expect(thumb.style.transition).toContain("transform");
    expect(thumb.style.transform).toBe("translateX(0)");

    thumb.dispatchEvent(new Event("transitionend"));
    expect(thumb.style.transform).toBe("");
    expect(thumb.style.transition).toBe("");
  });

  it("减少动态（prefers-reduced-motion）下位移动画关停，直接吸附响应式百分比位置", () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia;

    const { thinkingToggle, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(
      view({
        label: "Off",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "off", effectiveLevel: "off" })
      })
    );

    const range = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-range")!;
    const thumb = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-thumb")!;
    range.getBoundingClientRect = () => ({ left: 0, width: 300 } as DOMRect);

    modelPanel.renderThinkingPicker(
      view({
        label: "High",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "high", effectiveLevel: "high" })
      })
    );

    expect(thumb.style.left).toMatch(/^66\.6666.*%$/);
    expect(thumb.style.transition).toBe("");
    expect(thumb.style.transform).toBe("");
  });
  it("快速反向：动画途中连续反向切档，基于当前位移计算差值平滑续接", () => {
    const { thinkingToggle, modelPanel } = makeHarness();
    modelPanel.renderThinkingPicker(
      view({
        label: "Off",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "off", effectiveLevel: "off" })
      })
    );

    const range = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-range")!;
    const thumb = thinkingToggle.querySelector<HTMLElement>(".chat-thinking-thumb")!;
    range.getBoundingClientRect = () => ({ left: 0, width: 300 } as DOMRect);

    modelPanel.renderThinkingPicker(
      view({
        label: "Max",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "max", effectiveLevel: "max" })
      })
    );
    expect(thumb.style.left).toBe("100%");

    thumb.style.transform = "matrix(1, 0, 0, 1, -150, 0)";

    modelPanel.renderThinkingPicker(
      view({
        label: "Low",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "low", effectiveLevel: "low" })
      })
    );

    expect(thumb.style.left).toMatch(/^33\.3333.*%$/);
    expect(thumb.style.transition).toContain("transform");
    expect(thumb.style.transform).toBe("translateX(0)");

    thumb.dispatchEvent(new Event("transitionend"));
    expect(thumb.style.transform).toBe("");
  });

});
