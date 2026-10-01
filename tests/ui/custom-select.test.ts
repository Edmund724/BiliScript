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

// aria-labelledby 的名字拼接：浏览器把引用节点的文本按空格连起来
// （逐节点 trim）。jsdom 无平台无障碍树，只能按同一口径自行拼。
function labelledbyText(node: Element): string {
  const ids = (node.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
  expect(ids.length, `${node.className} 缺 aria-labelledby`).toBeGreaterThan(0);
  return ids
    .map((id) => {
      const target = document.getElementById(id);
      expect(target, `aria-labelledby 引用的 #${id} 不存在`).not.toBeNull();
      return target!.textContent!.trim();
    })
    .join(" ");
}

// ADR-0007 重开条件（读屏念得出当前值与角色、纯键盘能改值）的结构核验：
// jsdom 既无无障碍树也无 Tab 序，故核验被读屏与 Tab 序消费的那几项结构——
// 隐藏 select 是否退出、名字是否带字段标签、Tab 离开时焦点是否交还 trigger。
describe("custom-select 无障碍接线（ADR-0007 重开条件的结构核验）", () => {
  it("隐藏的原生 select 退出 Tab 序与无障碍树，值源不变", async () => {
    installMessageBus();
    const host = await mountPanel();
    const select = await waitForCustomSelect(host, "downloadFormat");
    const options = Array.from(
      select.closest<HTMLElement>(".custom-select-wrapper")!.querySelectorAll<HTMLElement>(".custom-select-option")
    );

    // display:none 让 select 天然退出无障碍树与 Tab 序，无需再摘 Tab 序、加 aria-hidden；
    // 隐藏走内联样式，宿主里那些原生 select 外观规则的优先级压不回它
    expect(select.style.display).toBe("none");
    expect(select.getAttribute("tabindex")).toBeNull();
    expect(select.getAttribute("aria-hidden")).toBeNull();

    // 值源与收集链零改：组件写回原生 select
    fireClick(options[1]);
    expect(select.value).toBe("txt");
  });

  it("trigger / listbox 的可访问名 = 字段标签 + 当前值，随值重算", async () => {
    installMessageBus();
    const host = await mountPanel();
    const select = await waitForCustomSelect(host, "downloadFormat");
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    const trigger = wrapper.querySelector<HTMLElement>(".custom-select-trigger")!;
    const dropdown = wrapper.querySelector<HTMLElement>(".custom-select-dropdown")!;
    const options = Array.from(dropdown.querySelectorAll<HTMLElement>(".custom-select-option"));

    // 只念当前值（"SRT，按钮"）等于丢了「这是哪个设置」；字段名必须进名字
    expect(labelledbyText(trigger)).toBe("下载格式 SRT");
    expect(labelledbyText(dropdown)).toBe("下载格式");
    // 标签的 for 也得指向用户碰得到的控件：不然点标签把焦点送进已 display:none 隐藏的 select
    const fieldLabel = document.getElementById(trigger.getAttribute("aria-labelledby")!.split(" ")[0])!;
    expect(fieldLabel.tagName).toBe("LABEL");
    expect(fieldLabel.getAttribute("for")).toBe(trigger.id);

    fireClick(options[1]);
    expect(labelledbyText(trigger)).toBe("下载格式 TXT");
  });

  it("label 没有 for 时按同级前置 label 认名（Modal 预设/协议下拉的形态）", async () => {
    document.body.innerHTML =
      '<label class="provider-editor-label">协议</label>' +
      '<select id="protocolSelect"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select>';
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    initCustomSelect(document.getElementById("protocolSelect") as HTMLSelectElement);
    const trigger = document.querySelector<HTMLElement>(".custom-select-trigger")!;
    expect(labelledbyText(trigger)).toBe("协议 OpenAI");
  });

  it("Tab 从展开列表离开：收拢列表、焦点交还 trigger、不吞默认动作", async () => {
    installMessageBus();
    const host = await mountPanel();
    const select = await waitForCustomSelect(host, "downloadFormat");
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    const trigger = wrapper.querySelector<HTMLElement>(".custom-select-trigger")!;
    const dropdown = wrapper.querySelector<HTMLElement>(".custom-select-dropdown")!;
    const options = Array.from(dropdown.querySelectorAll<HTMLElement>(".custom-select-option"));

    trigger.focus();
    fireClick(trigger);
    expect(document.activeElement).toBe(options[0]);

    // 焦点在 li 上时收拢列表会让焦点掉回 body，默认 Tab 会从 body 重新起算
    // （跳到文档第一个控件）；必须先把焦点交还 trigger，再放行默认动作
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    options[0].dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(dropdown.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });
});
