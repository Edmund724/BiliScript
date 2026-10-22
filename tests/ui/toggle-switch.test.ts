// ui/toggle-switch.test.ts — 设置抽屉自绘开关（ADR-0019）的结构与手势测试。
//
// 覆盖：模板壳结构契约（input 与 track 相邻兄弟次序 = CSS 配色选择器契约）、
// init 幂等与值源语义（原生 input 不被替换/隐藏方式不是 display:none）、
// 弹簧动画的退化口径（prefers-reduced-motion 下瞬时吸附）、拖拽三态（过半
// 翻转 + 派发 change / 未过半回弹不派发 / 拖拽松手后 click 被抑制）、以及
// 设置面板集成（5 个开关都被接线、水合后滑块吸附现值）。
//
// 真弹簧的过冲回弹与跟手手感是 RAF 时序行为，jsdom 锁的是退化口径与决策
// 逻辑；真机手感走 browser-harness 目检。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus } from "../helpers/settings-panel-bus.js";
import { buildSettingsHtml } from "../../extension/ui/settings-panel-html.js";
import { initToggleSwitch, syncToggleSwitch } from "../../extension/ui/toggle-switch.js";

// 6 个持久布尔开关的 id（与 SETTINGS_PANEL_DOM_IDS 中布尔键一致；
// allowPaidSearchProviders = 付费平台准入，GLOSSARY「付费平台」）
const TOGGLE_IDS = [
  "asrAutoFallback",
  "allowPaidSearchProviders",
  "enablePlayerAiQuickAction",
  "customPanelWidthEnabled",
  "autoOpenReader",
  "includeDateInFilename",
  "includeTimestampInBody",
  "enableDebugLogs",
  "chatInputGlow"
] as const;

function mountToggle(checked = false): { root: HTMLElement; input: HTMLInputElement; track: HTMLElement; thumb: HTMLElement; text: HTMLElement } {
  document.body.innerHTML = `
    <div class="biliscript-set-check biliscript-toggle-row">
      <span class="biliscript-toggle-text">测试开关</span>
      <label class="biliscript-toggle-switch">
        <input id="testToggle" type="checkbox" class="biliscript-toggle-input"${checked ? " checked" : ""} />
        <span class="biliscript-toggle-track" aria-hidden="true"><span class="biliscript-toggle-thumb"></span></span>
      </label>
    </div>`;
  const root = document.querySelector<HTMLElement>(".biliscript-toggle-row")!;
  const input = root.querySelector<HTMLInputElement>("input")!;
  const track = root.querySelector<HTMLElement>(".biliscript-toggle-track")!;
  const thumb = root.querySelector<HTMLElement>(".biliscript-toggle-thumb")!;
  const text = root.querySelector<HTMLElement>(".biliscript-toggle-text")!;
  return { root, input, track, thumb, text };
}

// jsdom 无 PointerEvent 构造器也能跑的合成指针事件（事件类型 + clientX/pointerId）
function pointerEvent(type: string, clientX: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: clientX });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

function fireClick(node: Element): void {
  node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

// matchMedia 打成 reduced-motion：弹簧退化为瞬时吸附，断言无需等 RAF。
function stubReducedMotion(): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  // 缺省非 reduced-motion（jsdom 无 matchMedia 实现）；个别用例再打成 true。
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

describe("模板壳结构契约", () => {
  it("所有开关行都有 text/input/track/thumb，input 与 track 相邻兄弟", () => {
    const host = document.createElement("div");
    host.innerHTML = buildSettingsHtml();
    const rows = host.querySelectorAll<HTMLElement>(".biliscript-toggle-row");

    expect(rows).toHaveLength(TOGGLE_IDS.length);
    rows.forEach((row) => {
      const input = row.querySelector<HTMLInputElement>("input.biliscript-toggle-input");
      const track = row.querySelector<HTMLElement>(".biliscript-toggle-track");
      const thumb = row.querySelector<HTMLElement>(".biliscript-toggle-thumb");
      const text = row.querySelector<HTMLElement>(".biliscript-toggle-text");
      expect(input, "行内必须有原生 input").toBeTruthy();
      expect(track, "行内必须有轨道").toBeTruthy();
      expect(thumb, "轨道内必须有滑块").toBeTruthy();
      expect(thumb!.parentElement).toBe(track);
      expect(text?.textContent?.trim(), "文字列非空").toBeTruthy();
      expect(row.querySelector(".biliscript-toggle-switch"), "开关本体外壳").toBeTruthy();
      // CSS :checked ~ .biliscript-toggle-track 与 JS nextElementSibling 双契约
      expect(input!.nextElementSibling).toBe(track);
      expect(input!.checked).toBe(false);
    });
    rows.forEach((row) => {
      expect(TOGGLE_IDS).toContain(row.querySelector("input")!.id as (typeof TOGGLE_IDS)[number]);
    });
  });
});

describe("initToggleSwitch：接线与值源语义", () => {
  it("幂等：重复 init 不重建 DOM、不重复登记", () => {
    const { input, track } = mountToggle();
    initToggleSwitch(input);
    const trackRef = track;
    initToggleSwitch(input);
    expect(input.dataset.toggleSwitchInitialized).toBe("1");
    expect(input.nextElementSibling).toBe(trackRef);
  });

  it("壳结构不符（input 后无轨道）时不接线也不抛错", () => {
    document.body.innerHTML = '<label><input id="lonely" type="checkbox" /></label>';
    const input = document.getElementById("lonely") as HTMLInputElement;
    expect(() => initToggleSwitch(input)).not.toThrow();
    expect(input.dataset.toggleSwitchInitialized).toBeUndefined();
    expect(() => syncToggleSwitch(input)).not.toThrow();
  });

  it("原生 input 留在原位：不内联 display:none（键盘/读屏可用性靠它）", () => {
    const { input } = mountToggle();
    initToggleSwitch(input);
    expect(input.isConnected).toBe(true);
    expect(input.style.display).not.toBe("none");
    expect(input.type).toBe("checkbox");
  });

  it("初始化时按现值摆滑块（reduced-motion 下同步到位）", () => {
    stubReducedMotion();
    const { input, thumb } = mountToggle(true);
    initToggleSwitch(input);
    expect(thumb.style.transform).toBe("translateX(16px)");
  });

  it("syncToggleSwitch：外部写 .checked 后视觉吸附现值，且不派发 change", () => {
    stubReducedMotion();
    const { input, thumb } = mountToggle();
    initToggleSwitch(input);
    const onChange = vi.fn();
    input.addEventListener("change", onChange);

    input.checked = true;
    syncToggleSwitch(input);
    expect(thumb.style.transform).toBe("translateX(16px)");
    expect(onChange).not.toHaveBeenCalled();

    input.checked = false;
    syncToggleSwitch(input);
    expect(thumb.style.transform).toBe("none");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("点击与键盘路径：change 驱动弹簧", () => {
  it("点击左侧描述文字不触发切换，仅点击开关本体切换", () => {
    stubReducedMotion();
    const { input, text, track } = mountToggle();
    initToggleSwitch(input);
    const onChange = vi.fn();
    input.addEventListener("change", onChange);

    fireClick(text);
    expect(input.checked).toBe(false);
    expect(onChange).not.toHaveBeenCalled();

    fireClick(track);
    expect(input.checked).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("reduced-motion：change 事件把滑块瞬时吸到对应侧", () => {
    stubReducedMotion();
    const { input, thumb } = mountToggle();
    initToggleSwitch(input);

    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(thumb.style.transform).toBe("translateX(16px)");

    input.checked = false;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(thumb.style.transform).toBe("none");
  });

  it("普通模式：change 后经 RAF 弹簧最终到位", async () => {
    const { input, thumb } = mountToggle();
    initToggleSwitch(input);

    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(thumb.style.transform).toBe("translateX(16px)");
    });
  });
});

describe("拖拽：位置过半 + 松手速度决定吸附侧", () => {
  it("拖过中线松手：翻转 checked 并派发一次 change", () => {
    stubReducedMotion();
    const { input, track } = mountToggle();
    initToggleSwitch(input);
    const onChange = vi.fn();
    input.addEventListener("change", onChange);

    track.dispatchEvent(pointerEvent("pointerdown", 0));
    track.dispatchEvent(pointerEvent("pointermove", 12));
    track.dispatchEvent(pointerEvent("pointerup", 12));

    expect(input.checked).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("从开拖回关侧（未过中线）松手：翻转 checked 并派发一次 change", () => {
    stubReducedMotion();
    const { input, track, thumb } = mountToggle(true);
    initToggleSwitch(input);
    const onChange = vi.fn();
    input.addEventListener("change", onChange);

    track.dispatchEvent(pointerEvent("pointerdown", 16));
    track.dispatchEvent(pointerEvent("pointermove", 4));
    track.dispatchEvent(pointerEvent("pointerup", 4));

    expect(input.checked).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(thumb.style.transform).toBe("none");
  });

  it("拖拽松手后到达的 click 被抑制：不再二次翻转", () => {
    stubReducedMotion();
    const { input, track } = mountToggle();
    initToggleSwitch(input);

    track.dispatchEvent(pointerEvent("pointerdown", 0));
    track.dispatchEvent(pointerEvent("pointermove", 12));
    track.dispatchEvent(pointerEvent("pointerup", 12));
    expect(input.checked).toBe(true);

    fireClick(track);
    expect(input.checked).toBe(true);
  });

  it("点击（位移不过阈值）组件不插手：不翻转 checked", () => {
    stubReducedMotion();
    const { input, track } = mountToggle();
    initToggleSwitch(input);

    track.dispatchEvent(pointerEvent("pointerdown", 8));
    track.dispatchEvent(pointerEvent("pointerup", 9));

    expect(input.checked).toBe(false);
  });
});

describe("设置面板集成：接线与水合", () => {
  it("renderReaderSettingsPanel 后 5 个开关全部被 init，水合滑块吸附现值", async () => {
    stubReducedMotion();
    document.body.innerHTML = '<div id="biliscript-reading-settings-host"></div>';
    const host = document.getElementById("biliscript-reading-settings-host")!;
    const sent: { type: string }[] = [];
    installSettingsPanelBus({
      "get-settings": () => ({ ok: true, settings: { includeDateInFilename: true, asrAutoFallback: true } })
    });
    // 记录装载链收尾（asr-providers-list 发出即水合跑完）
    const origSendMessage = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = ((message: { type: string }, callback?: (response?: unknown) => void) => {
      sent.push({ type: message.type });
      return origSendMessage(message, callback);
    }) as typeof chrome.runtime.sendMessage;

    const panel = await import("../../extension/ui/settings-panel.js");
    panel.renderReaderSettingsPanel();
    await vi.waitFor(() => {
      expect(sent.some((m) => m.type === "asr-providers-list")).toBe(true);
    });

    TOGGLE_IDS.forEach((id) => {
      const input = host.querySelector<HTMLInputElement>(`#${id}`)!;
      expect(input.dataset.toggleSwitchInitialized, `${id} 已被 initToggleSwitch 接线`).toBe("1");
    });
    // 水合值：includeDateInFilename / asrAutoFallback 缺省 true → 滑块在开侧
    const onThumb = host.querySelector<HTMLElement>("#includeDateInFilename ~ .biliscript-toggle-track .biliscript-toggle-thumb")!;
    expect(onThumb.style.transform).toBe("translateX(16px)");
    const offThumb = host.querySelector<HTMLElement>("#enableDebugLogs ~ .biliscript-toggle-track .biliscript-toggle-thumb")!;
    expect(offThumb.style.transform).toBe("none");
  });
});
