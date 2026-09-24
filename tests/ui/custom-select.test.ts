// tests/ui/custom-select.test.ts
// ui/custom-select.ts（ADR-0007：设置页下拉统一到本组件）最小行为测试
//（settings-ui-coherence/04）。笔记导出删除后段落位置下拉随之退役，落点改为
// 仍在场的 #downloadFormat（导出区下载格式，settings-panel 的 initCustomSelect
// 消费点）——组件本身保留，键盘语义断言原样搬迁。
//
// listbox 键盘语义：trigger Enter 展开 → ↓ 漫游 → Enter 选中——原生 select.value
// 写回且派生一次 bubbling change（收集链零改的根基），aria-expanded /
// aria-selected / 焦点归位同步断言。驱动真实模块，挂载与消息总线沿用
// settings-panel-save.test.ts 同款（renderReaderSettingsPanel 唯一公开入口 +
// 按 type 分发的 sendMessage stub + fireClick 单发点击）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

type BusMessage = { type: string } & Record<string, unknown>;
type BusResponder = (message: BusMessage) => unknown;

function installMessageBus(overrides: Record<string, BusResponder> = {}) {
  const responders: Record<string, BusResponder> = {
    "get-settings": () => ({ ok: true, settings: {} }),
    "ai-presets-list": () => ({ ok: false }),
    "asr-presets-list": () => ({ ok: false }),
    "ai-providers-list": () => ({ ok: true, providers: [] }),
    "asr-providers-list": () => ({ ok: true, providers: [] }),
    "save-settings": () => ({ ok: true }),
    ...overrides
  };
  const sent: BusMessage[] = [];
  chrome.runtime.sendMessage = vi.fn((message: unknown, callback?: (response?: unknown) => void) => {
    const typed = message as BusMessage;
    sent.push(typed);
    const respond = responders[typed.type];
    callback?.(respond ? respond(typed) : { ok: true });
    return undefined;
  }) as unknown as typeof chrome.runtime.sendMessage;
  return sent;
}

async function mountPanel() {
  document.body.innerHTML = '<div id="biliscript-reading-settings-host"></div>';
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  return document.getElementById("biliscript-reading-settings-host")!;
}

// 自定义下拉的挂载点在 loadSettings（fire-and-forget）末端，按初始化标记等待，
// 比等异步消息更贴真实就绪时刻。
async function waitForCustomSelect(host: HTMLElement, selectId: string): Promise<HTMLSelectElement> {
  let select: HTMLSelectElement | null = null;
  await vi.waitFor(() => {
    select = host.querySelector<HTMLSelectElement>(`#${selectId}`);
    expect(select?.dataset.customSelectInitialized, `#${selectId} 的自定义下拉壳未挂载`).toBe("1");
  });
  return select!;
}

// 单发 click（settings-panel-save.test.ts 同款：jsdom 原生 click 已派发事件，
// 手动补派发会双触发）
function fireClick(node: Element) {
  node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function keydown(node: Element, key: string) {
  node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

beforeEach(() => {
  resetModuleState();
});

describe("custom-select 键盘语义（settings-ui-coherence/04）", () => {
  it("trigger Enter 展开 → ↓ 漫游 → Enter 选中：select.value 写回并派生一次 bubbling change", async () => {
    installMessageBus();
    const host = await mountPanel();
    const select = await waitForCustomSelect(host, "downloadFormat");
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    const trigger = wrapper.querySelector<HTMLElement>(".custom-select-trigger")!;
    const dropdown = wrapper.querySelector<HTMLElement>(".custom-select-dropdown")!;
    const options = Array.from(dropdown.querySelectorAll<HTMLElement>(".custom-select-option"));

    expect(options.map((option) => option.textContent)).toEqual(["SRT", "TXT"]);

    // ARIA 接线：trigger ↔ listbox 关联、角色与选中态
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.getAttribute("aria-controls")).toBe(dropdown.id);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dropdown.getAttribute("role")).toBe("listbox");
    expect(options.every((o) => o.getAttribute("role") === "option" && o.tabIndex === -1)).toBe(true);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[1].getAttribute("aria-selected")).toBe("false");

    const changeEvents: Event[] = [];
    select.addEventListener("change", (e) => changeEvents.push(e));

    trigger.focus();
    fireClick(trigger);
    expect(dropdown.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(options[0]); // 焦点给当前选中项

    keydown(options[0], "ArrowDown");
    expect(document.activeElement).toBe(options[1]); // 漫游不移出列表

    keydown(options[1], "Enter");
    expect(select.value).toBe("txt");
    expect(changeEvents).toHaveLength(1);
    expect(changeEvents[0].bubbles).toBe(true);
    expect(dropdown.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger); // 焦点归位
    expect(trigger.textContent).toContain("TXT");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(options[0].getAttribute("aria-selected")).toBe("false");
  });
});
