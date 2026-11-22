import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSettingsPanelBus, type BusMessage, type BusResponder } from "../helpers/settings-panel-bus.js";

function installMessageBus(overrides: Record<string, BusResponder> = {}): BusMessage[] {
  return installSettingsPanelBus<BusMessage>({ ...overrides }).sent;
}

async function mountPanel() {
  document.body.innerHTML = '<div id="biliscript-reading-settings-host"></div>';
  const panel = await import("../../extension/ui/settings-panel.js");
  panel.renderReaderSettingsPanel();
  return document.getElementById("biliscript-reading-settings-host")!;
}

async function waitForCustomSelect(host: HTMLElement, selectId: string): Promise<HTMLSelectElement> {
  let select: HTMLSelectElement | null = null;
  await vi.waitFor(() => {
    select = host.querySelector<HTMLSelectElement>(`#${selectId}`);
    expect(select?.dataset.customSelectInitialized, `#${selectId} 的自定义下拉壳未挂载`).toBe("1");
  });
  return select!;
}

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

    expect(options.map((option) => option.textContent)).toEqual(["SRT", "TXT", "VTT", "VTT（仅副轨）"]);

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
    expect(document.activeElement).toBe(options[0]);

    keydown(options[0], "ArrowDown");
    expect(document.activeElement).toBe(options[1]);

    keydown(options[1], "Enter");
    expect(select.value).toBe("txt");
    expect(changeEvents).toHaveLength(1);
    expect(changeEvents[0].bubbles).toBe(true);
    expect(dropdown.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(trigger.textContent).toContain("TXT");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(options[0].getAttribute("aria-selected")).toBe("false");
  });

  it("展开节点已脱离文档时不拦截后续点击，只清理残留监听", async () => {
    document.body.innerHTML = '<select id="trackSelect"><option value="ai-zh">中文</option></select>';
    const select = document.getElementById("trackSelect") as HTMLSelectElement;
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    initCustomSelect(select);
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    wrapper.querySelector<HTMLButtonElement>(".custom-select-trigger")!.click();
    expect(wrapper.querySelector<HTMLElement>(".custom-select-dropdown")!.hidden).toBe(false);
    wrapper.remove();

    const target = document.createElement("button");
    document.body.appendChild(target);
    const targetClick = vi.fn();
    target.addEventListener("click", targetClick);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);

    expect(targetClick).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });
});

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

describe("custom-select 无障碍接线", () => {
  it("隐藏的原生 select 退出 Tab 序与无障碍树，值源不变", async () => {
    installMessageBus();
    const host = await mountPanel();
    const select = await waitForCustomSelect(host, "downloadFormat");
    const options = Array.from(
      select.closest<HTMLElement>(".custom-select-wrapper")!.querySelectorAll<HTMLElement>(".custom-select-option")
    );

    expect(select.style.display).toBe("none");
    expect(select.getAttribute("tabindex")).toBeNull();
    expect(select.getAttribute("aria-hidden")).toBeNull();

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

    expect(labelledbyText(trigger)).toBe("下载格式 SRT");
    expect(trigger.getAttribute("aria-label")).toBeNull();
    expect(labelledbyText(dropdown)).toBe("下载格式");
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

  it("无字段 label 但有 aria-label：用它作字段名拼 trigger 的名字（阅读面板选轨形态）", async () => {
    document.body.innerHTML =
      '<select id="subtitleTrackSelect" aria-label="字幕语言">' +
      '<option value="ai-zh" selected>中文</option>' +
      '<option value="ai-en">English</option>' +
      "</select>";
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    initCustomSelect(document.getElementById("subtitleTrackSelect") as HTMLSelectElement);
    const wrapper = document.querySelector<HTMLElement>(".custom-select-wrapper")!;
    const trigger = wrapper.querySelector<HTMLElement>(".custom-select-trigger")!;
    const dropdown = wrapper.querySelector<HTMLElement>(".custom-select-dropdown")!;
    const options = Array.from(dropdown.querySelectorAll<HTMLElement>(".custom-select-option"));

    expect(trigger.getAttribute("aria-labelledby")).toBeNull();
    expect(trigger.getAttribute("aria-label")).toBe("字幕语言 中文");
    expect(dropdown.getAttribute("aria-label")).toBe("字幕语言");

    fireClick(options[1]);
    expect(trigger.getAttribute("aria-label")).toBe("字幕语言 English");
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

    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    options[0].dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(dropdown.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });
});

describe("custom-select 外部写值收口（setCustomSelectValue）", () => {
  const bareMarkup =
    '<label for="downloadFormat">下载格式</label>' +
    '<select id="downloadFormat"><option value="srt">SRT</option><option value="txt">TXT</option></select>';

  async function mountBareSelect() {
    document.body.innerHTML = bareMarkup;
    const select = document.getElementById("downloadFormat") as HTMLSelectElement;
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    initCustomSelect(select);
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    return {
      select,
      trigger: wrapper.querySelector<HTMLElement>(".custom-select-trigger")!,
      options: Array.from(wrapper.querySelectorAll<HTMLElement>(".custom-select-option"))
    };
  }

  it("init 后写值：trigger 文本、可访问名与选中态跟随现值", async () => {
    const { setCustomSelectValue } = await import("../../extension/ui/custom-select.js");
    const { select, trigger, options } = await mountBareSelect();
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("SRT");

    setCustomSelectValue(select, "txt");

    expect(select.value).toBe("txt");
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("TXT");
    expect(labelledbyText(trigger)).toBe("下载格式 TXT");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    expect(options[0].getAttribute("aria-selected")).toBe("false");
    expect(options[1].dataset.selected).toBe("true");
    expect(options[0].dataset.selected).toBe("false");
  });

  it("不派发 change：外部写值不是用户改选（水合不得触发即时保存）", async () => {
    const { setCustomSelectValue } = await import("../../extension/ui/custom-select.js");
    const { select } = await mountBareSelect();
    let changes = 0;
    select.addEventListener("change", () => {
      changes += 1;
    });

    setCustomSelectValue(select, "txt");

    expect(select.value).toBe("txt");
    expect(changes).toBe(0);
  });

  it("未初始化的 select：只写值不建壳，init 时按现值派生显示", async () => {
    document.body.innerHTML = bareMarkup;
    const select = document.getElementById("downloadFormat") as HTMLSelectElement;
    const { initCustomSelect, setCustomSelectValue } = await import("../../extension/ui/custom-select.js");

    setCustomSelectValue(select, "txt");

    expect(select.value).toBe("txt");
    expect(select.closest(".custom-select-wrapper"), "未初始化时不应越界建壳").toBeNull();

    initCustomSelect(select);
    const trigger = select
      .closest<HTMLElement>(".custom-select-wrapper")!
      .querySelector<HTMLElement>(".custom-select-trigger")!;
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("TXT");
  });

  it("写未知 value 镜像原生：写入后实际值为空，显示从实际值派生且不抛错", async () => {
    const { setCustomSelectValue } = await import("../../extension/ui/custom-select.js");
    const { select, trigger, options } = await mountBareSelect();

    expect(() => setCustomSelectValue(select, "nope")).not.toThrow();

    expect(select.value).toBe("");
    expect(select.selectedIndex).toBe(-1);
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("SRT");
    expect(options.every((option) => option.getAttribute("aria-selected") === "false")).toBe(true);
  });
});

describe("哨兵选项（空态 / 转写态的载体，10 号票）", () => {
  const sentinelMarkup = '<select id="trackSelect" aria-label="字幕语言"><option value="">暂无字幕</option></select>';

  it("只含哨兵项时：值区显示哨兵文字、aria-selected 正确、可访问名按现值拼装", async () => {
    document.body.innerHTML = sentinelMarkup;
    const select = document.getElementById("trackSelect") as HTMLSelectElement;
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    initCustomSelect(select);
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    const trigger = wrapper.querySelector<HTMLElement>(".custom-select-trigger")!;
    const options = Array.from(wrapper.querySelectorAll<HTMLElement>(".custom-select-option"));

    expect(options.map((option) => option.textContent)).toEqual(["暂无字幕"]);
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("暂无字幕");
    expect(options[0].dataset.value).toBe("");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(trigger.getAttribute("aria-label")).toBe("字幕语言 暂无字幕");
  });

  it("哨兵项不是首项时：setCustomSelectValue(select, \"\") 命中它（不误落首项）", async () => {
    document.body.innerHTML =
      '<select id="trackSelect" aria-label="字幕语言">' +
      '<option value="ai-zh" selected>中文</option>' +
      '<option value="ai-en">English</option>' +
      '<option value="">暂无字幕</option>' +
      "</select>";
    const select = document.getElementById("trackSelect") as HTMLSelectElement;
    const { initCustomSelect, setCustomSelectValue } = await import("../../extension/ui/custom-select.js");
    initCustomSelect(select);
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    const trigger = wrapper.querySelector<HTMLElement>(".custom-select-trigger")!;
    const options = Array.from(wrapper.querySelectorAll<HTMLElement>(".custom-select-option"));

    setCustomSelectValue(select, "");

    expect(select.value).toBe("");
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("暂无字幕");
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
    expect(trigger.getAttribute("aria-label")).toBe("字幕语言 暂无字幕");
  });
});

describe("选项集变更（rebuildCustomSelectOptions，10 号票）", () => {
  const baseMarkup =
    '<label for="trackSelect">字幕语言</label>' +
    '<select id="trackSelect">' +
    '<option value="ai-zh" selected>中文</option>' +
    '<option value="ai-en">English</option>' +
    "</select>";

  async function mountInitialized() {
    document.body.innerHTML = baseMarkup;
    const select = document.getElementById("trackSelect") as HTMLSelectElement;
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    initCustomSelect(select);
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    return {
      select,
      wrapper,
      trigger: wrapper.querySelector<HTMLButtonElement>(".custom-select-trigger")!,
      dropdown: wrapper.querySelector<HTMLElement>(".custom-select-dropdown")!,
      options: () => Array.from(wrapper.querySelectorAll<HTMLElement>(".custom-select-option"))
    };
  }

  it("扩容：重读 options 后 listbox 项与 trigger 显示跟随现值，旧项不残留", async () => {
    const { select, trigger, options } = await mountInitialized();
    const { rebuildCustomSelectOptions } = await import("../../extension/ui/custom-select.js");

    select.innerHTML =
      '<option value="ai-zh" selected>中文</option><option value="ai-en">English</option>' +
      '<option value="ai-ja">日本語</option><option value="ai-ar">العربية</option>' +
      '<option value="ai-id">Bahasa Indonesia</option>';
    rebuildCustomSelectOptions(select);

    expect(options().map((option) => option.textContent)).toEqual(["中文", "English", "日本語", "العربية", "Bahasa Indonesia"]);
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("中文");
    expect(options().map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false", "false"]);
  });

  it("缩容：只剩一条哨兵项时仍正确显示且被标为选中", async () => {
    const { select, trigger, options } = await mountInitialized();
    const { rebuildCustomSelectOptions } = await import("../../extension/ui/custom-select.js");

    select.innerHTML = '<option value="">暂无字幕</option>';
    rebuildCustomSelectOptions(select);

    expect(options().map((option) => option.textContent)).toEqual(["暂无字幕"]);
    expect(select.value).toBe("");
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("暂无字幕");
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
  });

  it("换整批选项：按写入后的实际值重派生显示（现值存活则跟随，不回落首项）", async () => {
    const { select, trigger, options } = await mountInitialized();
    const { rebuildCustomSelectOptions } = await import("../../extension/ui/custom-select.js");

    select.value = "ai-en";
    select.innerHTML =
      '<option value="ai-zh">中文</option><option value="ai-en">English</option><option value="ai-ar">العربية</option>';
    select.value = "ai-en";
    rebuildCustomSelectOptions(select);

    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("English");
    expect(options()[1].getAttribute("aria-selected")).toBe("true");
  });

  it("现值不在新选项集里：镜像原生（实际值为空 → 文本回落首项、无选中项），不抛错", async () => {
    const { select, trigger, options } = await mountInitialized();
    const { rebuildCustomSelectOptions } = await import("../../extension/ui/custom-select.js");

    select.innerHTML = '<option value="ai-ja">日本語</option>';
    rebuildCustomSelectOptions(select);

    expect(select.value).toBe("ai-ja");
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("日本語");
  });

  it("重建后没有任何 option 匹配现值（现值空）：无选中项、文本按同款回落首项、不抛错", async () => {
    const { select, trigger, options } = await mountInitialized();
    const { rebuildCustomSelectOptions } = await import("../../extension/ui/custom-select.js");

    select.innerHTML = '<option value="ai-ja">日本語</option><option value="ai-ar">العربية</option>';
    expect(select.value).toBe("ai-ja");
    Array.from(select.options).forEach((option) => option.removeAttribute("selected"));
    select.value = "";
    expect(select.value).toBe("");

    rebuildCustomSelectOptions(select);

    expect(options()).toHaveLength(2);
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("日本語");
    expect(options().map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "false"]);
  });

  it("壳不重建：trigger / dropdown 元素与 id、aria 关系、label 的 for 全部原样，焦点不动", async () => {
    const { select, wrapper, trigger, dropdown } = await mountInitialized();
    const { rebuildCustomSelectOptions } = await import("../../extension/ui/custom-select.js");
    const selectIdBefore = select.id;
    const triggerIdBefore = trigger.id;
    const dropdownIdBefore = dropdown.id;
    const labelledbyBefore = trigger.getAttribute("aria-labelledby");
    const controlsBefore = trigger.getAttribute("aria-controls");
    const labelForBefore = document.querySelector("label[for]")!.getAttribute("for");

    trigger.focus();
    trigger.disabled = true;
    trigger.setAttribute("aria-busy", "true");

    select.innerHTML = '<option value="ai-zh" selected>中文</option><option value="ai-ja">日本語</option>';
    rebuildCustomSelectOptions(select);

    expect(select.closest(".custom-select-wrapper")).toBe(wrapper);
    expect(wrapper.querySelector(".custom-select-trigger")).toBe(trigger);
    expect(wrapper.querySelector(".custom-select-dropdown")).toBe(dropdown);
    expect(trigger.querySelector(".custom-select-value")).not.toBeNull();
    expect(select.id).toBe(selectIdBefore);
    expect(trigger.id).toBe(triggerIdBefore);
    expect(dropdown.id).toBe(dropdownIdBefore);
    expect(trigger.getAttribute("aria-labelledby")).toBe(labelledbyBefore);
    expect(trigger.getAttribute("aria-controls")).toBe(controlsBefore);
    expect(document.querySelector("label[for]")!.getAttribute("for")).toBe(labelForBefore);
    expect(labelledbyText(trigger)).toBe("字幕语言 中文");
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(trigger);
  });

  it("重复调用幂等：项集与显示稳定，且不派发 change（换选项不是用户改选）", async () => {
    const { select, trigger, options } = await mountInitialized();
    const { rebuildCustomSelectOptions } = await import("../../extension/ui/custom-select.js");
    const changes: Event[] = [];
    select.addEventListener("change", (event) => changes.push(event));
    select.innerHTML = '<option value="ai-zh" selected>中文</option><option value="ai-ar">العربية</option>';

    rebuildCustomSelectOptions(select);
    const first = options();
    rebuildCustomSelectOptions(select);
    rebuildCustomSelectOptions(select);
    const third = options();

    expect(third.map((option) => option.textContent)).toEqual(["中文", "العربية"]);
    expect(third.length).toBe(first.length);
    expect(third.map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("中文");
    expect(changes).toHaveLength(0);
  });

  it("未初始化时调用不抛、不建壳（退化为 no-op，不替调用方凭空建壳）", async () => {
    document.body.innerHTML = baseMarkup;
    const select = document.getElementById("trackSelect") as HTMLSelectElement;
    const { rebuildCustomSelectOptions } = await import("../../extension/ui/custom-select.js");

    expect(() => rebuildCustomSelectOptions(select)).not.toThrow();
    expect(select.closest(".custom-select-wrapper")).toBeNull();
    expect(select.parentElement).toBe(document.body);
  });

  it("列表展开时换选项：浮层保持打开，焦点按现值重认一项", async () => {
    const { select, trigger, dropdown, options } = await mountInitialized();
    const { rebuildCustomSelectOptions } = await import("../../extension/ui/custom-select.js");

    fireClick(trigger);
    expect(dropdown.hidden).toBe(false);
    expect(document.activeElement).toBe(options()[0]);

    select.value = "ai-ja";
    select.innerHTML =
      '<option value="ai-zh">中文</option><option value="ai-ja">日本語</option><option value="ai-en">English</option>';
    select.value = "ai-ja";
    rebuildCustomSelectOptions(select);

    expect(dropdown.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const rebuilt = options();
    expect(rebuilt[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(rebuilt[1]);
  });
});

describe("组件状态（setCustomSelectState，10 号票第 6 条）", () => {
  const markup =
    '<label for="trackSelect">字幕语言</label>' +
    '<select id="trackSelect"><option value="ai-zh" selected>中文</option><option value="ai-en">English</option></select>';

  async function mount() {
    document.body.innerHTML = markup;
    const select = document.getElementById("trackSelect") as HTMLSelectElement;
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    initCustomSelect(select);
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    return {
      select,
      trigger: wrapper.querySelector<HTMLButtonElement>(".custom-select-trigger")!,
      dropdown: wrapper.querySelector<HTMLElement>(".custom-select-dropdown")!,
      options: () => Array.from(wrapper.querySelectorAll<HTMLElement>(".custom-select-option"))
    };
  }

  it("disabled 写到 trigger 且同步原生 select，不动 select.value", async () => {
    const { select, trigger } = await mount();
    const { setCustomSelectState } = await import("../../extension/ui/custom-select.js");

    setCustomSelectState(select, { disabled: true });

    expect(trigger.disabled).toBe(true);
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("ai-zh");
  });

  it("busy 写 aria-busy；两者可同时置，复位各自独立（省略的键保持现态）", async () => {
    const { select, trigger } = await mount();
    const { setCustomSelectState } = await import("../../extension/ui/custom-select.js");

    setCustomSelectState(select, { disabled: true, busy: true });
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("true");

    setCustomSelectState(select, { busy: false });
    expect(trigger.disabled).toBe(true);
    expect(select.disabled).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("false");

    setCustomSelectState(select, { busy: true });
    setCustomSelectState(select, { disabled: false });
    expect(trigger.disabled).toBe(false);
    expect(select.disabled).toBe(false);
    expect(trigger.getAttribute("aria-busy")).toBe("true");
  });

  it("只置 busy 从不触碰 disabled（未置过时保持原生默认 false）", async () => {
    const { select, trigger } = await mount();
    const { setCustomSelectState } = await import("../../extension/ui/custom-select.js");

    setCustomSelectState(select, { busy: true });

    expect(trigger.disabled).toBe(false);
    expect(select.disabled).toBe(false);
    expect(trigger.getAttribute("aria-busy")).toBe("true");
  });

  it("禁用时点击不展开列表（真守卫；jsdom 对 disabled 仍派发 click）", async () => {
    const { select, trigger, dropdown } = await mount();
    const { setCustomSelectState } = await import("../../extension/ui/custom-select.js");
    setCustomSelectState(select, { disabled: true });

    fireClick(trigger);

    expect(dropdown.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("禁用时开合键与选项漫游都不生效", async () => {
    const { select, trigger, dropdown, options } = await mount();
    const { setCustomSelectState } = await import("../../extension/ui/custom-select.js");
    setCustomSelectState(select, { disabled: true });

    for (const key of ["Enter", " ", "ArrowDown", "ArrowUp"]) keydown(trigger, key);
    expect(dropdown.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    dropdown.hidden = false;
    keydown(options()[1], "Enter");
    expect(select.value).toBe("ai-zh");
  });

  it("打开态中被禁用：收拢列表且焦点离开已收起的选项（只置 busy 不收拢）", async () => {
    const { select, trigger, dropdown, options } = await mount();
    const { setCustomSelectState } = await import("../../extension/ui/custom-select.js");
    fireClick(trigger);
    expect(dropdown.hidden).toBe(false);
    expect(document.activeElement).toBe(options()[0]);

    setCustomSelectState(select, { busy: true });
    expect(dropdown.hidden).toBe(false);
    expect(document.activeElement).toBe(options()[0]);

    setCustomSelectState(select, { disabled: true });

    expect(dropdown.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(options().includes(document.activeElement as HTMLElement)).toBe(false);
  });

  it("复位后交互恢复：又能展开列表", async () => {
    const { select, trigger, dropdown } = await mount();
    const { setCustomSelectState } = await import("../../extension/ui/custom-select.js");
    setCustomSelectState(select, { disabled: true, busy: true });

    setCustomSelectState(select, { disabled: false, busy: false });
    fireClick(trigger);

    expect(dropdown.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-busy")).toBe("false");
  });

  it("状态在 rebuildCustomSelectOptions 后存活（换选项不抹状态）", async () => {
    const { select, trigger } = await mount();
    const { setCustomSelectState, rebuildCustomSelectOptions } = await import("../../extension/ui/custom-select.js");

    setCustomSelectState(select, { disabled: true, busy: true });
    select.innerHTML = '<option value="ai-zh" selected>中文</option><option value="ai-ja">日本語</option>';
    rebuildCustomSelectOptions(select);

    expect(trigger.disabled).toBe(true);
    expect(select.disabled).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("中文");
    expect(labelledbyText(trigger)).toBe("字幕语言 中文");
  });

  it("未初始化时调用不抛、不建壳、不写 select.disabled（与 rebuild 同口径的 no-op）", async () => {
    document.body.innerHTML = markup;
    const select = document.getElementById("trackSelect") as HTMLSelectElement;
    const { setCustomSelectState } = await import("../../extension/ui/custom-select.js");

    expect(() => setCustomSelectState(select, { disabled: true, busy: true })).not.toThrow();

    expect(select.closest(".custom-select-wrapper")).toBeNull();
    expect(select.disabled).toBe(false);
    expect(select.hasAttribute("aria-busy")).toBe(false);
  });
});

describe("浮层槽位（setCustomSelectSlots，第四条外部入口）", () => {
  const markup =
    '<label for="trackSelect">字幕语言</label>' +
    '<select id="trackSelect"><option value="ai-zh" selected>中文</option><option value="ai-en">English</option></select>';

  async function mount() {
    document.body.innerHTML = markup;
    const select = document.getElementById("trackSelect") as HTMLSelectElement;
    const mod = await import("../../extension/ui/custom-select.js");
    mod.initCustomSelect(select);
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    return {
      mod,
      select,
      wrapper,
      trigger: wrapper.querySelector<HTMLButtonElement>(".custom-select-trigger")!,
      dropdown: wrapper.querySelector<HTMLElement>(".custom-select-dropdown")!,
      arrow: wrapper.querySelector<HTMLElement>(".custom-select-arrow")!,
      options: () => Array.from(wrapper.querySelectorAll<HTMLElement>(".custom-select-option"))
    };
  }

  it("不声明槽位 = 现状：选项行是浮层本体的直接子节点（其余调用点零变化）", async () => {
    const { dropdown, options } = await mount();

    const rows = options();
    expect(rows.map((option) => option.textContent)).toEqual(["中文", "English"]);
    rows.forEach((row) => expect(row.parentElement).toBe(dropdown));
  });

  it("声明槽位：选项行落到 optionsHost、extras 常驻浮层本体、triggerExtra 落在值区与箭头之间", async () => {
    const { mod, select, trigger, dropdown, arrow, options } = await mount();
    const extra = document.createElement("li");
    extra.className = "test-popover";
    const host = document.createElement("ul");
    host.className = "test-list";
    extra.appendChild(host);
    const badge = document.createElement("span");
    badge.id = "test-badge";
    badge.textContent = "双语";

    mod.setCustomSelectSlots(select, { extras: [extra], optionsHost: host, triggerExtra: badge });

    expect(dropdown.contains(extra)).toBe(true);
    expect(options().map((option) => option.textContent)).toEqual(["中文", "English"]);
    options().forEach((option) => expect(option.parentElement).toBe(host));
    expect(trigger.children[0].className).toBe("custom-select-value");
    expect(trigger.children[1]).toBe(badge);
    expect(trigger.children[2]).toBe(arrow);
    expect(trigger.getAttribute("aria-describedby")).toBe("test-badge");
  });

  it("重铺不摘槽位：槽位节点全程不脱离浮层（真机上等于 scrollTop 不归零），选项行换新", async () => {
    const { mod, select, trigger, dropdown, options } = await mount();
    const extra = document.createElement("li");
    const host = document.createElement("ul");
    const scroller = document.createElement("div");
    extra.append(host, scroller);
    const badge = document.createElement("span");
    badge.className = "test-badge";
    badge.id = "test-badge";
    mod.setCustomSelectSlots(select, { extras: [extra], optionsHost: host, triggerExtra: badge });
    scroller.scrollTop = 24;

    const observer = new MutationObserver(() => {});
    observer.observe(dropdown, { childList: true });

    select.innerHTML = '<option value="ai-zh" selected>中文</option><option value="ai-ja">日本語</option>';
    mod.rebuildCustomSelectOptions(select);

    const removed = observer.takeRecords().flatMap((record) => [...record.removedNodes]);
    observer.disconnect();
    expect(removed, "槽位节点在重铺期间脱离了浮层（真机上是 scrollTop 归零）").not.toContain(extra);
    expect(dropdown.contains(extra)).toBe(true);
    expect(scroller.scrollTop).toBe(24);
    expect(options().map((option) => option.textContent)).toEqual(["中文", "日本語"]);
    options().forEach((option) => expect(option.parentElement).toBe(host));
    expect(trigger.contains(badge)).toBe(true);
    expect(trigger.querySelectorAll(".test-badge")).toHaveLength(1);
    expect(trigger.getAttribute("aria-describedby")).toBe("test-badge");
  });

  it("撤下 triggerExtra：插位节点摘掉，它接的 aria-describedby 一并清掉", async () => {
    const { mod, select, trigger } = await mount();
    const badge = document.createElement("span");
    badge.id = "test-badge";
    mod.setCustomSelectSlots(select, { triggerExtra: badge });
    expect(trigger.contains(badge)).toBe(true);

    mod.setCustomSelectSlots(select, {});

    expect(trigger.contains(badge)).toBe(false);
    expect(badge.parentElement).toBeNull();
    expect(trigger.getAttribute("aria-describedby")).toBeNull();
  });

  it("未初始化时调用不抛、不建壳（与另三条入口同口径的 no-op）", async () => {
    document.body.innerHTML = markup;
    const select = document.getElementById("trackSelect") as HTMLSelectElement;
    const { setCustomSelectSlots } = await import("../../extension/ui/custom-select.js");
    const extra = document.createElement("li");

    expect(() => setCustomSelectSlots(select, { extras: [extra] })).not.toThrow();

    expect(select.closest(".custom-select-wrapper")).toBeNull();
    expect(extra.parentElement).toBeNull();
  });
});

describe("组件表随组件挂载（extension/entry/styles/custom-select.css）", () => {
  it("导入组件模块即挂组件表 link，不依赖设置抽屉的装载时机", async () => {
    document.head.innerHTML = "";

    await import("../../extension/ui/custom-select.js");

    const link = document.head.querySelector<HTMLLinkElement>(
      'link[rel="stylesheet"][href$="entry/styles/custom-select.css"]'
    );
    expect(link, "组件表 link 未挂").not.toBeNull();
    expect(document.head.querySelector('link[href$="reader-settings-rows.css"]')).toBeNull();
    expect(document.head.querySelector('link[href$="reader-settings-shell.css"]')).toBeNull();
    expect(document.head.querySelector('link[href$="reader-settings-providers.css"]')).toBeNull();
  });
});

describe("外点收起控制器：不覆写 DOM hidden 自有属性（Firefox Xray 兼容）", () => {
  it("初始化后 dropdown 不带自有 hidden 描述符，外部改写 hidden 后由 MutationObserver 接管外点关闭", async () => {
    document.body.innerHTML = '<div><select id="xraySelect"><option value="a">A</option><option value="b">B</option></select></div>';
    const { initCustomSelect } = await import("../../extension/ui/custom-select.js");
    const select = document.getElementById("xraySelect") as HTMLSelectElement;
    initCustomSelect(select);
    const dropdown = select.closest(".custom-select-wrapper")!.querySelector<HTMLElement>(".custom-select-dropdown")!;

    expect(Object.getOwnPropertyDescriptor(dropdown, "hidden")).toBeUndefined();

    dropdown.hidden = false;
    await Promise.resolve();

    fireClick(document.body);
    expect(dropdown.hidden).toBe(true);
  });
});

describe("内嵌模式（initCustomSelect inline: true）", () => {
  it("初始化即常显且不参与外点收起、closeAll 或禁用隐藏，并支持跨列键盘切换", async () => {
    document.body.innerHTML =
      '<div>' +
      '<select id="outerSelect"><option value="zh" selected>中文</option><option value="en">English</option></select>' +
      '</div>';
    const outerSelect = document.getElementById("outerSelect") as HTMLSelectElement;
    const mod = await import("../../extension/ui/custom-select.js");
    mod.initCustomSelect(outerSelect);

    const extra = document.createElement("li");
    const mainList = document.createElement("ul");
    mainList.className = "custom-select-list";
    const innerHost = document.createElement("div");
    const innerSelect = document.createElement("select");
    innerSelect.innerHTML = '<option value="en" selected>English</option><option value="ja">日本語</option>';
    innerHost.appendChild(innerSelect);
    extra.append(mainList, innerHost);

    mod.initCustomSelect(innerSelect, "custom-select-wrapper custom-inline-picker", { inline: true });
    mod.setCustomSelectSlots(outerSelect, { extras: [extra], optionsHost: mainList });

    const outerWrapper = outerSelect.closest<HTMLElement>(".custom-select-wrapper")!;
    const outerTrigger = outerWrapper.querySelector<HTMLButtonElement>(".custom-select-trigger")!;
    const outerDropdown = outerWrapper.querySelector<HTMLElement>(".custom-select-dropdown")!;
    const innerWrapper = innerSelect.closest<HTMLElement>(".custom-select-wrapper")!;
    const innerDropdown = innerWrapper.querySelector<HTMLElement>(".custom-select-dropdown")!;
    const innerOptions = Array.from(innerDropdown.querySelectorAll<HTMLElement>(".custom-select-option"));

    expect(innerDropdown.hidden).toBe(false);
    expect(innerDropdown.dataset.inline).toBe("true");

    const outsideBtn = document.createElement("button");
    document.body.appendChild(outsideBtn);
    const outsideClick = vi.fn();
    outsideBtn.addEventListener("click", outsideClick);
    fireClick(outsideBtn);
    expect(outsideClick).toHaveBeenCalledTimes(1);
    expect(innerDropdown.hidden).toBe(false);

    mod.closeAllCustomSelects();
    expect(innerDropdown.hidden).toBe(false);

    fireClick(outerTrigger);
    expect(outerDropdown.hidden).toBe(false);
    expect(innerDropdown.hidden).toBe(false);

    const outerOptions = Array.from(mainList.querySelectorAll<HTMLElement>(".custom-select-option"));
    expect(document.activeElement).toBe(outerOptions[0]);
    keydown(outerOptions[0], "ArrowRight");
    expect(document.activeElement).toBe(innerOptions[0]);

    fireClick(innerOptions[1]);
    expect(innerSelect.value).toBe("ja");
    expect(innerDropdown.hidden).toBe(false);

    mod.setCustomSelectState(innerSelect, { disabled: true, busy: true });
    expect(innerDropdown.hidden).toBe(false);
    fireClick(innerOptions[0]);
    expect(innerSelect.value).toBe("ja");
  });
});
