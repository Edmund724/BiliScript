// tests/ui/model-picker-search.test.ts
// ui/model-picker.ts 搜索过滤功能测试

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { wireModelPicker, buildModelPickerField, createModelCombobox, type ModelComboboxClasses } from "../../extension/ui/model-picker.js";
import type { ProviderRowElement } from "../../extension/ui/provider-row.js";

// Mock requestProviderOriginsViaBackground to succeed immediately
vi.mock("../../extension/core/host-permissions.js", () => ({
  requestProviderOriginsViaBackground: vi.fn().mockResolvedValue({ ok: true })
}));

function createRow(): ProviderRowElement {
  const row = document.createElement("div") as unknown as ProviderRowElement;
  row.className = "test-provider-row";
  row.dataset.providerId = "test-provider";
  row.innerHTML = `
    <input class="test-base-url" value="https://api.example.com/v1" />
    <input class="test-api-key" value="sk-test" />
    <div class="test-status" hidden></div>
    ${buildModelPickerField({
      inputClass: "test-model-input",
      placeholder: "请选择或输入模型",
      value: "default-model"
    })}
  `;
  document.body.appendChild(row);
  return row;
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

describe("model-picker 搜索过滤功能", () => {
  it("拉取模型数 < 8 时不渲染搜索框", async () => {
    const row = createRow();
    const fetchModels = vi.fn().mockResolvedValue({
      ok: true,
      models: ["model-a", "model-b", "model-c"]
    });

    wireModelPicker(row, {
      inputClass: "test-model-input",
      baseUrlClass: "test-base-url",
      apiKeyClass: "test-api-key",
      statusClass: "test-status",
      showStatus: vi.fn(),
      fetchModels
    });

    const toggle = row.querySelector<HTMLButtonElement>(".ai-provider-model-toggle")!;
    toggle.click();

    // 等待异步拉取完成
    await vi.waitFor(() => {
      const options = row.querySelectorAll(".ai-provider-model-option");
      expect(options.length).toBe(3);
    });

    expect(row.querySelector(".ai-provider-model-search-input")).toBeNull();
  });

  it("拉取模型数 >= 8 时渲染吸顶搜索框并支持大小写不敏感过滤", async () => {
    const row = createRow();
    const modelList = [
      "deepseek-chat",
      "deepseek-reasoner",
      "gpt-4o",
      "gpt-4o-mini",
      "claude-3-5-sonnet",
      "claude-3-haiku",
      "qwen-plus",
      "qwen-turbo"
    ];
    const fetchModels = vi.fn().mockResolvedValue({
      ok: true,
      models: modelList
    });

    wireModelPicker(row, {
      inputClass: "test-model-input",
      baseUrlClass: "test-base-url",
      apiKeyClass: "test-api-key",
      statusClass: "test-status",
      showStatus: vi.fn(),
      fetchModels
    });

    const toggle = row.querySelector<HTMLButtonElement>(".ai-provider-model-toggle")!;
    toggle.click();

    let searchInput: HTMLInputElement | null = null;
    await vi.waitFor(() => {
      searchInput = row.querySelector<HTMLInputElement>(".ai-provider-model-search-input");
      expect(searchInput).not.toBeNull();
    });

    const options = Array.from(row.querySelectorAll<HTMLElement>(".ai-provider-model-option"));
    const count = row.querySelector<HTMLElement>(".ai-provider-model-count")!;
    expect(count.textContent).toBe("已加载 8 个模型");

    // 输入 "deep" 过滤
    searchInput!.value = "deep";
    searchInput!.dispatchEvent(new Event("input", { bubbles: true }));

    const visible = options.filter((o) => !o.hidden);
    expect(visible.map((o) => o.textContent)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(count.textContent).toBe("匹配 2 / 8 个模型");
  });

  it("无匹配项时显示「无匹配选项」", async () => {
    const row = createRow();
    const modelList = [
      "model-1", "model-2", "model-3", "model-4", "model-5", "model-6", "model-7", "model-8"
    ];
    wireModelPicker(row, {
      inputClass: "test-model-input",
      baseUrlClass: "test-base-url",
      apiKeyClass: "test-api-key",
      statusClass: "test-status",
      showStatus: vi.fn(),
      fetchModels: vi.fn().mockResolvedValue({ ok: true, models: modelList })
    });

    row.querySelector<HTMLButtonElement>(".ai-provider-model-toggle")!.click();

    await vi.waitFor(() => {
      expect(row.querySelector(".ai-provider-model-search-input")).not.toBeNull();
    });

    const searchInput = row.querySelector<HTMLInputElement>(".ai-provider-model-search-input")!;
    const emptyMsg = row.querySelector<HTMLElement>(".ai-provider-model-empty")!;
    expect(emptyMsg.hidden).toBe(true);

    searchInput.value = "unknown";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(emptyMsg.hidden).toBe(false);
    expect(emptyMsg.textContent).toBe("无匹配选项");
  });

  it("在搜索框按 Enter 直接选中首个匹配项并填入主输入框", async () => {
    const row = createRow();
    const modelList = [
      "deepseek-chat", "deepseek-reasoner", "gpt-4o", "gpt-4o-mini",
      "claude-3-5-sonnet", "claude-3-haiku", "qwen-plus", "qwen-turbo"
    ];
    wireModelPicker(row, {
      inputClass: "test-model-input",
      baseUrlClass: "test-base-url",
      apiKeyClass: "test-api-key",
      statusClass: "test-status",
      showStatus: vi.fn(),
      fetchModels: vi.fn().mockResolvedValue({ ok: true, models: modelList })
    });

    row.querySelector<HTMLButtonElement>(".ai-provider-model-toggle")!.click();

    let searchInput: HTMLInputElement | null = null;
    await vi.waitFor(() => {
      searchInput = row.querySelector<HTMLInputElement>(".ai-provider-model-search-input");
      expect(searchInput).not.toBeNull();
    });

    const modelInput = row.querySelector<HTMLInputElement>(".test-model-input")!;
    const dropdown = row.querySelector<HTMLElement>(".ai-provider-model-dropdown")!;

    searchInput!.value = "claude";
    searchInput!.dispatchEvent(new Event("input", { bubbles: true }));

    searchInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(modelInput.value).toBe("claude-3-5-sonnet");
    expect(dropdown.hidden).toBe(true);
  });

  describe("API Key 守卫拦截", () => {
    it("平台要求 Key 且无输入且无已存 Key 时拦截，下拉提示「请先填写 API Key」并不发起拉取", async () => {
      const row = createRow();
      row.querySelector<HTMLInputElement>(".test-api-key")!.value = "";
      const fetchModels = vi.fn();

      wireModelPicker(row, {
        inputClass: "test-model-input",
        baseUrlClass: "test-base-url",
        apiKeyClass: "test-api-key",
        statusClass: "test-status",
        showStatus: vi.fn(),
        fetchModels,
        isKeyRequired: () => true,
        hasSavedKey: () => false
      });

      row.querySelector<HTMLButtonElement>(".ai-provider-model-toggle")!.click();

      const dropdown = row.querySelector<HTMLElement>(".ai-provider-model-dropdown")!;
      expect(dropdown.hidden).toBe(false);
      expect(dropdown.querySelector(".ai-provider-model-message")?.textContent).toBe("请先填写 API Key");
      expect(fetchModels).not.toHaveBeenCalled();
    });

    it("平台无需 Key（如本地服务）时，即使 Key 为空也正常拉取", async () => {
      const row = createRow();
      row.querySelector<HTMLInputElement>(".test-api-key")!.value = "";
      const fetchModels = vi.fn().mockResolvedValue({ ok: true, models: ["local-model"] });

      wireModelPicker(row, {
        inputClass: "test-model-input",
        baseUrlClass: "test-base-url",
        apiKeyClass: "test-api-key",
        statusClass: "test-status",
        showStatus: vi.fn(),
        fetchModels,
        isKeyRequired: () => false,
        hasSavedKey: () => false
      });

      row.querySelector<HTMLButtonElement>(".ai-provider-model-toggle")!.click();

      await vi.waitFor(() => {
        expect(fetchModels).toHaveBeenCalled();
      });
    });

    it("已有已存 Key 时，输入框为空也正常放行拉取", async () => {
      const row = createRow();
      row.querySelector<HTMLInputElement>(".test-api-key")!.value = "";
      const fetchModels = vi.fn().mockResolvedValue({ ok: true, models: ["saved-model"] });

      wireModelPicker(row, {
        inputClass: "test-model-input",
        baseUrlClass: "test-base-url",
        apiKeyClass: "test-api-key",
        statusClass: "test-status",
        showStatus: vi.fn(),
        fetchModels,
        isKeyRequired: () => true,
        hasSavedKey: () => true
      });

      row.querySelector<HTMLButtonElement>(".ai-provider-model-toggle")!.click();

      await vi.waitFor(() => {
        expect(fetchModels).toHaveBeenCalled();
      });
    });
  });
});

describe("createModelCombobox：可搜索模型组合框", () => {
  const TEST_CLASSES: ModelComboboxClasses = {
    wrapperSelector: ".combo-wrapper",
    openDropdownSelector: ".combo-dropdown:not([hidden])",
    triggerSelector: ".combo-toggle",
    optionClass: "combo-option",
    searchItemClass: "combo-search-item",
    searchInputClass: "combo-search-input",
    emptyItemClass: "combo-message combo-empty",
    messageClass: "combo-message",
    errorMessageClass: "combo-message combo-error",
    loadingMessageClass: "combo-message combo-loading",
    countClass: "combo-count"
  };

  function createComboboxDom(initialValue = "") {
    const wrapper = document.createElement("div");
    wrapper.className = "combo-wrapper";
    wrapper.innerHTML = `
      <input class="combo-input" type="text" value="${initialValue}" />
      <button type="button" class="combo-toggle" aria-expanded="false">▼</button>
      <ul class="combo-dropdown" hidden></ul>
    `;
    document.body.appendChild(wrapper);
    return {
      wrapper,
      input: wrapper.querySelector<HTMLInputElement>(".combo-input")!,
      toggle: wrapper.querySelector<HTMLButtonElement>(".combo-toggle")!,
      dropdown: wrapper.querySelector<HTMLElement>(".combo-dropdown")!
    };
  }

  it("支持 ArrowDown 展开、ARIA 投影、Home/End/Arrow/Space 键控选中、外点与 Esc 归焦", () => {
    const { input, toggle, dropdown } = createComboboxDom("model-2");
    const onSelect = vi.fn();
    const combobox = createModelCombobox({
      input,
      toggle,
      dropdown,
      classes: TEST_CLASSES,
      emptyMessage: "暂无模型",
      focusInputOnSelect: true,
      onSelect
    });

    combobox.setOptions(["model-1", "model-2", "model-3"]);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    expect(combobox.isOpen()).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const options = Array.from(dropdown.querySelectorAll<HTMLLIElement>(".combo-option"));
    expect(options.map((el) => [el.getAttribute("role"), el.getAttribute("aria-selected")])).toEqual([
      ["option", "false"],
      ["option", "true"],
      ["option", "false"]
    ]);
    expect(document.activeElement).toBe(options[1]);

    // End 跳末项、Home 跳首项、Space 选中并归焦输入框
    dropdown.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(options[2]);
    dropdown.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(options[0]);
    dropdown.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));

    expect(input.value).toBe("model-1");
    expect(onSelect).toHaveBeenCalledWith("model-1");
    expect(combobox.isOpen()).toBe(false);
    expect(document.activeElement).toBe(input);

    // 再次展开后按 Esc 收起并归焦 toggle
    toggle.click();
    expect(combobox.isOpen()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(combobox.isOpen()).toBe(false);
    expect(document.activeElement).toBe(toggle);

    // 再次展开后点外部收起
    toggle.click();
    expect(combobox.isOpen()).toBe(true);
    document.body.click();
    expect(combobox.isOpen()).toBe(false);

    combobox.dispose();
  });

  it("支持搜索过滤计数、空态提示、renderMessage 与 dispose 彻底卸载观察器及监听", () => {
    const disconnectSpy = vi.spyOn(MutationObserver.prototype, "disconnect");
    const { input, toggle, dropdown } = createComboboxDom();
    const combobox = createModelCombobox({
      input,
      toggle,
      dropdown,
      classes: TEST_CLASSES,
      emptyMessage: "暂无推荐模型"
    });

    // 空列表展示空态消息
    combobox.open();
    expect(dropdown.querySelector(".combo-message")?.textContent).toBe("暂无推荐模型");

    // 加载 8+ 模型后自动启用搜索并实时更新计数
    combobox.setOptions(Array.from({ length: 10 }, (_, i) => `vendor/model-${i + 1}`));
    const searchInput = dropdown.querySelector<HTMLInputElement>(".combo-search-input")!;
    expect(searchInput).not.toBeNull();
    expect(dropdown.querySelector(".combo-count")?.textContent).toBe("已加载 10 个模型");

    searchInput.value = "model-10";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dropdown.querySelector(".combo-count")?.textContent).toBe("匹配 1 / 10 个模型");

    // Tab 从搜索框离开时收起下拉
    searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(combobox.isOpen()).toBe(false);

    // renderMessage 支持 error / loading 形态
    combobox.renderMessage("拉取失败", "error");
    expect(combobox.isOpen()).toBe(true);
    expect(dropdown.querySelector(".combo-error")?.textContent).toBe("拉取失败");

    // dispose 收起下拉、断开 MutationObserver 并移除节点监听
    combobox.dispose();
    expect(combobox.isOpen()).toBe(false);
    expect(disconnectSpy).toHaveBeenCalled();

    toggle.click();
    expect(combobox.isOpen()).toBe(false);
  });
});
