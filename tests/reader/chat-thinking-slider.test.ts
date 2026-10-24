// tests/reader/chat-thinking-slider.test.ts
// 05 号票：思考强度滑轨内嵌比例精修契约测试。
// 验证滑轨改为无内描边的 24px 高 surface-2 胶囊凹槽，滑块缩减为 20×20px（top: 2px，留 2px 间距），
// range 两端留 12px 呼吸间距，fill 与 preview 几何采用 + 12px 匹配 left: -12px。

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

describe("05: 思考强度滑轨样式与几何契约", () => {
  it("CSS 契约：滑轨 24px、surface-2 底轨、无内描边、20×20px 滑块与 12px 呼吸间距", () => {
    const css = readCss(CHAT_CSS_PATH);

    // 1. .chat-thinking-track 高度设为 24px
    const trackBody = getRuleBody(css, ".biliscript-reading-chat .chat-thinking-track");
    expect(trackBody).toMatch(/height:\s*24px/);

    // 2. .chat-thinking-range 边距收缩为 12px
    const rangeBody = getRuleBody(css, ".biliscript-reading-chat .chat-thinking-range");
    expect(rangeBody).toMatch(/left:\s*12px/);
    expect(rangeBody).toMatch(/right:\s*12px/);
    expect(rangeBody).toMatch(/top:\s*0/);
    expect(rangeBody).toMatch(/bottom:\s*0/);

    // 3. .chat-thinking-rail 几何与表面材质
    const railBody = getRuleBody(css, ".biliscript-reading-chat .chat-thinking-rail");
    expect(railBody).toMatch(/left:\s*-12px/);
    expect(railBody).toMatch(/right:\s*-12px/);
    expect(railBody).toMatch(/top:\s*0/);
    expect(railBody).toMatch(/height:\s*24px/);
    expect(railBody).toMatch(/border-radius:\s*999px/);
    expect(railBody).toMatch(/background:\s*var\(--biliscript-reader-surface-2\)/);
    expect(railBody).toMatch(/box-shadow:\s*none/);

    // 焦点环保持
    const focusBody = getRuleBody(css, ".biliscript-reading-chat .chat-thinking-track:focus-visible .chat-thinking-rail");
    expect(focusBody).toContain("var(--biliscript-reader-accent)");

    // 4. .chat-thinking-fill 几何
    const fillBody = getRuleBody(css, ".biliscript-reading-chat .chat-thinking-fill");
    expect(fillBody).toMatch(/left:\s*-12px/);
    expect(fillBody).toMatch(/top:\s*0/);
    expect(fillBody).toMatch(/height:\s*24px/);

    // 5. .chat-thinking-tick 刻度圆点垂直居中对齐
    const tickBody = getRuleBody(css, ".biliscript-reading-chat .chat-thinking-tick");
    expect(tickBody).toMatch(/top:\s*0/);
    expect(tickBody).toMatch(/height:\s*24px/);
    expect(tickBody).toMatch(/width:\s*24px/);
    expect(tickBody).toMatch(/margin-left:\s*-12px/);

    // 6. .chat-thinking-thumb 尺寸缩减为 20×20px（border-box 含 1px 描边），top: 2px，margin-left: -10px，轻软阴影
    const thumbBody = getRuleBody(css, ".biliscript-reading-chat .chat-thinking-thumb");
    expect(thumbBody).toMatch(/box-sizing:\s*border-box/);
    expect(thumbBody).toMatch(/width:\s*20px/);
    expect(thumbBody).toMatch(/height:\s*20px/);
    expect(thumbBody).toMatch(/top:\s*2px/);
    expect(thumbBody).toMatch(/margin-left:\s*-10px/);
    expect(thumbBody).toMatch(/box-shadow:\s*0 1px 3px rgba\(0,\s*0,\s*0,\s*0\.15\)/);
  });
});

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

    // 4 档位：off, low, high, max (n=4, 档位间隔 100/3 %)
    // 1. off 档 (index=0)：thumb 隐藏，fill 宽度为 0px
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

    // 2. low 档 (index=1)：pct = 100/3%
    modelPanel.renderThinkingPicker(
      view({
        label: "Low",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "low", effectiveLevel: "low" })
      })
    );
    expect(thumb.hidden).toBe(false);
    expect(thumb.style.left).toMatch(/^33\.3333.*%$/);
    expect(fill.style.width).toMatch(/^calc\(33\.3333.*% \+ 12px\)$/);

    // 3. max 档 (index=3)：pct = 100%
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

    // 拖动到 100px (1/3 处，对应 low，index=1)
    track.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, button: 0 }));
    track.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100 }));

    expect(thumb.style.left).toMatch(/^33\.3333.*%$/);
    expect(fill.style.width).toMatch(/^calc\(33\.3333.*% \+ 12px\)$/);
    expect(thinkingRowValue.textContent).toBe("Low");

    // 释放并完成选档
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

    // 1. pointerdown：建立缓存
    track.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, button: 0 }));
    const downQueries = rectQueries;
    expect(downQueries).toBeGreaterThan(0);

    // 2. 连续 5 次 pointermove：不增加 getBoundingClientRect 调用
    for (let x = 10; x <= 50; x += 10) {
      track.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: x }));
    }
    expect(rectQueries - downQueries).toBe(0);

    // 3. 拖拽中触发 window resize：缓存主动刷新
    const beforeResizeQueries = rectQueries;
    window.dispatchEvent(new Event("resize"));
    expect(rectQueries).toBeGreaterThan(beforeResizeQueries);

    // 4. 释放结束拖拽
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

    // 从 Off (0%) 切到 Low (33.3333%)
    modelPanel.renderThinkingPicker(
      view({
        label: "Low",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "low", effectiveLevel: "low" })
      })
    );

    // 响应式终点依然由 left 百分比决定
    expect(thumb.style.left).toMatch(/^33\.3333.*%$/);
    // 位移动画由 transform 驱动
    expect(thumb.style.transition).toContain("transform");
    expect(thumb.style.transform).toBe("translateX(0)");

    // 动画完成（transitionend）后清除 transform，不留过期像素终点
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

    // 瞬间到位，无 transform 动画挂载
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

    // 1. 切向 Max (100% = 300px)
    modelPanel.renderThinkingPicker(
      view({
        label: "Max",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "max", effectiveLevel: "max" })
      })
    );
    expect(thumb.style.left).toBe("100%");

    // 2. 假设动画进行到中间位置（模拟 visual matrix 或 inline translateX）
    // 视觉位置在 150px (300px + (-150px) = 150px)
    thumb.style.transform = "matrix(1, 0, 0, 1, -150, 0)";

    // 3. 快速反向切向 Low (33.3333% = 100px)
    modelPanel.renderThinkingPicker(
      view({
        label: "Low",
        entries: thinkingPickerEntries({ availableLevels: ["off", "low", "high", "max"], switchOnly: false, requestedLevel: "low", effectiveLevel: "low" })
      })
    );

    expect(thumb.style.left).toMatch(/^33\.3333.*%$/);
    // deltaX = currentVisualX(150) - newTargetX(100) = +50px
    // 起播阶段 transform 设为 translateX(50px) 然后过渡到 translateX(0)
    expect(thumb.style.transition).toContain("transform");
    expect(thumb.style.transform).toBe("translateX(0)");

    // 动画结束清理
    thumb.dispatchEvent(new Event("transitionend"));
    expect(thumb.style.transform).toBe("");
  });

});
