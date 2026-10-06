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
    // 有真 label：名字仍走 aria-labelledby，未被 aria-label 分支改写（逐字不变）
    expect(trigger.getAttribute("aria-label")).toBeNull();
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

    // 名字 = 「字段名 + 当前值」：只念「中文，按钮」等于丢了「这是哪个设置」
    expect(trigger.getAttribute("aria-labelledby")).toBeNull(); // 无字段 label：走 aria-label 路径
    expect(trigger.getAttribute("aria-label")).toBe("字幕语言 中文");
    // dropdown 仍是纯字段名（既有口径不变）
    expect(dropdown.getAttribute("aria-label")).toBe("字幕语言");

    // 名字随值重算
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

// 外部写值的收口（ADR-0007 修订）：组件此前只在选项被点时同步显示，外部直接写
// select.value 不回流 trigger——真机现象是 Modal 预设切到 DeepSeek（协议默认
// Anthropic），协议下拉的 trigger 仍写着「OpenAI Chat Completions」。修法是组件
// 导出 setCustomSelectValue 作为外部写值唯一入口，与 chooseOption 共用同一条
// 「写值 + 同步显示」路径，「显示 = 现值」由此成为组件内部不变式。
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
    // 可访问名 = 字段标签 + 当前值：值文本更新后名字自动重算
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

    // 原生语义：赋不存在的值后实际 value 为 ""、selectedIndex 为 -1
    expect(select.value).toBe("");
    expect(select.selectedIndex).toBe(-1);
    // 显示从写入后的实际值派生（与 init 同款：无选中项时文本回落首项、无选中态）
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("SRT");
    expect(options.every((option) => option.getAttribute("aria-selected") === "false")).toBe(true);
  });
});

// 哨兵选项（10 号票第 3 条）：选轨控件的空态 / 转写中态靠消费者塞一条哨兵项
// （旧实现 `<option value="">暂无字幕</option>` 同款）表达，组件必须能显示它、
// 选中态正确、setCustomSelectValue(select, "") 命中它。消费侧由 08 号票落地。
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

// 选项集在初始化之后变化（10 号票第 5 条 / 08 号票的硬前置）：initCustomSelect
// 把 select.options 快照一次，dataset.customSelectInitialized 又让重复 init 直接
// return——选轨控件每轮抓取/转写收尾都要换整批选项，故需要 rebuildCustomSelectOptions：
// 重读 select.options、重建 listbox 项、按写入后的实际值重派生显示，
// **壳（trigger 元素 / id / aria-* 关系 / 焦点）一律不重建**。
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

    select.value = "ai-en"; // 等价水合：外部已写值
    select.innerHTML =
      '<option value="ai-zh">中文</option><option value="ai-en">English</option><option value="ai-ar">العربية</option>';
    // innerHTML 重建后原生选中态回到首项，故按「写入后的实际值」重派生——这里显式再写一次
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

    // 原生语义：旧值只在 innerHTML 重建后失效，浏览器的实际 value 是「重建后的选中项」
    expect(select.value).toBe("ai-ja");
    expect(trigger.querySelector(".custom-select-value")!.textContent).toBe("日本語");
  });

  it("重建后没有任何 option 匹配现值（现值空）：无选中项、文本按同款回落首项、不抛错", async () => {
    const { select, trigger, options } = await mountInitialized();
    const { rebuildCustomSelectOptions } = await import("../../extension/ui/custom-select.js");

    // 原生没有「有选项但全不选中」的形态（去掉 selected 属性后浏览器仍按序选中首项），
    // 唯一能落到 else 分支的是「现值空 + 无匹配项」——按原生写值语义造这个态。
    select.innerHTML = '<option value="ai-ja">日本語</option><option value="ai-ar">العربية</option>';
    expect(select.value).toBe("ai-ja");
    Array.from(select.options).forEach((option) => option.removeAttribute("selected"));
    select.value = "";
    expect(select.value).toBe(""); // 无 value="" 的项 → 实际值确为 ""

    rebuildCustomSelectOptions(select);

    expect(options()).toHaveLength(2); // 项集照旧重建（不是被跳过）
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

    // 同一批节点（不是「等价的新节点」）
    expect(select.closest(".custom-select-wrapper")).toBe(wrapper);
    expect(wrapper.querySelector(".custom-select-trigger")).toBe(trigger);
    expect(wrapper.querySelector(".custom-select-dropdown")).toBe(dropdown);
    expect(trigger.querySelector(".custom-select-value")).not.toBeNull();
    // id 与 ARIA 关系逐项不变
    expect(select.id).toBe(selectIdBefore);
    expect(trigger.id).toBe(triggerIdBefore);
    expect(dropdown.id).toBe(dropdownIdBefore);
    expect(trigger.getAttribute("aria-labelledby")).toBe(labelledbyBefore);
    expect(trigger.getAttribute("aria-controls")).toBe(controlsBefore);
    expect(document.querySelector("label[for]")!.getAttribute("for")).toBe(labelForBefore);
    expect(labelledbyText(trigger)).toBe("字幕语言 中文");
    // 消费者写在 trigger 上的状态不被换选项抹掉
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

    expect(dropdown.hidden).toBe(false); // 打开态不因换项集被收起
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const rebuilt = options();
    expect(rebuilt[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(rebuilt[1]);
  });
});

// 组件状态入口（10 号票第 6 条 / 票 03 的状态机）：消费者不该 poke 组件内部的
// trigger，禁用与忙碌都由 setCustomSelectState 写。disabled 是**真守卫**（点击与
// 键盘都不得展开列表），busy 与 disabled 相互独立（03 号票切轨期间同时置两者）。
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
    expect(select.value).toBe("ai-zh"); // 值源语义不变：collect* 照读 .value
  });

  it("busy 写 aria-busy；两者可同时置，复位各自独立（省略的键保持现态）", async () => {
    const { select, trigger } = await mount();
    const { setCustomSelectState } = await import("../../extension/ui/custom-select.js");

    setCustomSelectState(select, { disabled: true, busy: true });
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("true");

    // 只动 busy：disabled 不被顺手复位
    setCustomSelectState(select, { busy: false });
    expect(trigger.disabled).toBe(true);
    expect(select.disabled).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("false");

    // 只动 disabled：busy 也不被顺手复位
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

    // 万一列表在场（例如消费者在打开后才发现要禁用），漫游/选中也一律挡住
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
    expect(dropdown.hidden).toBe(false); // busy 不是「不可用」，列表留在场上
    expect(document.activeElement).toBe(options()[0]);

    setCustomSelectState(select, { disabled: true });

    expect(dropdown.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // 焦点不能留在已收起的选项上。组件调的是 closeList(true)（归焦 trigger），但
    // disabled 的按钮在浏览器与 jsdom 里都接不住焦点（原生行为），故这里的判据是
    // 「已离开列表项」而不是「等于 trigger」——不为了满足断言去违反原生语义。
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
    // 可访问名也按现值重派生（「显示 = 现值」不变式在 rebuild 后同样成立）
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

// 组件表随组件走（2026-10：规则从设置三件套抽成 entry/styles/custom-select.css）：
// 设置抽屉与阅读面板两侧共用本组件，只看字幕、没开过设置抽屉时也必须有样式——
// 故组件模块求值即挂 link（settings-panel.ts 顶挂载同款先例），不再依赖
// settings-panel chunk 的装载时机。
describe("组件表随组件挂载（extension/entry/styles/custom-select.css）", () => {
  it("导入组件模块即挂组件表 link，不依赖设置抽屉的装载时机", async () => {
    document.head.innerHTML = "";

    await import("../../extension/ui/custom-select.js");

    const link = document.head.querySelector<HTMLLinkElement>(
      'link[rel="stylesheet"][href$="entry/styles/custom-select.css"]'
    );
    expect(link, "组件表 link 未挂").not.toBeNull();
    // 设置三件套不在场（未开设置抽屉的形态）
    expect(document.head.querySelector('link[href$="reader-settings-rows.css"]')).toBeNull();
    expect(document.head.querySelector('link[href$="reader-settings-shell.css"]')).toBeNull();
    expect(document.head.querySelector('link[href$="reader-settings-providers.css"]')).toBeNull();
  });
});
