// tests/ui/custom-select-search.test.ts
// ui/custom-select.ts 搜索过滤功能测试

import { beforeEach, describe, expect, it } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  CUSTOM_SELECT_SEARCH_THRESHOLD,
  initCustomSelect,
  rebuildCustomSelectOptions
} from "../../extension/ui/custom-select.js";

function createSelect(options: string[], id = "testSelect"): HTMLSelectElement {
  const select = document.createElement("select");
  select.id = id;
  options.forEach((opt, idx) => {
    const o = document.createElement("option");
    o.value = `val_${idx}`;
    o.textContent = opt;
    select.appendChild(o);
  });
  document.body.appendChild(select);
  return select;
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

describe("custom-select 搜索功能（阈值与显式配置）", () => {
  it("选项数 < 8 时默认不渲染搜索框", () => {
    const select = createSelect(["Alpha", "Beta", "Gamma"]);
    initCustomSelect(select);
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    const searchInput = wrapper.querySelector(".custom-select-search-input");
    expect(searchInput).toBeNull();
  });

  it("选项数 >= 8 时默认自动渲染搜索框与空态提示", () => {
    const select = createSelect([
      "DeepSeek",
      "Qwen",
      "GLM",
      "Kimi",
      "MiniMax",
      "Mimo",
      "Opencode Go",
      "OpenRouter",
      "Gemini"
    ]);
    expect(select.options.length).toBeGreaterThanOrEqual(CUSTOM_SELECT_SEARCH_THRESHOLD);
    initCustomSelect(select);
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    const searchInput = wrapper.querySelector<HTMLInputElement>(".custom-select-search-input");
    const emptyItem = wrapper.querySelector<HTMLElement>(".custom-select-empty");

    expect(searchInput).not.toBeNull();
    expect(emptyItem).not.toBeNull();
    expect(emptyItem!.hidden).toBe(true);
  });

  it("显式 searchable: false 时即使选项 >= 8 也不渲染搜索框", () => {
    const select = createSelect([
      "Opt1", "Opt2", "Opt3", "Opt4", "Opt5", "Opt6", "Opt7", "Opt8", "Opt9"
    ]);
    initCustomSelect(select, "custom-select-wrapper", { searchable: false });
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    expect(wrapper.querySelector(".custom-select-search-input")).toBeNull();
  });

  it("显式 searchable: true 时即使选项 < 8 也强制渲染搜索框", () => {
    const select = createSelect(["Opt1", "Opt2", "Opt3"]);
    initCustomSelect(select, "custom-select-wrapper", { searchable: true });
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    expect(wrapper.querySelector(".custom-select-search-input")).not.toBeNull();
  });
});

describe("custom-select 搜索交互与键盘漫游", () => {
  it("展开时焦点自动落入搜索框，输入关键字过滤选项（大小写不敏感子串匹配）", () => {
    const select = createSelect([
      "DeepSeek",
      "Qwen",
      "GLM",
      "Kimi",
      "MiniMax",
      "Mimo",
      "Opencode Go",
      "OpenRouter"
    ]);
    initCustomSelect(select);
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    const trigger = wrapper.querySelector<HTMLElement>(".custom-select-trigger")!;
    const dropdown = wrapper.querySelector<HTMLElement>(".custom-select-dropdown")!;
    const searchInput = wrapper.querySelector<HTMLInputElement>(".custom-select-search-input")!;
    const options = Array.from(wrapper.querySelectorAll<HTMLElement>(".custom-select-option"));

    // 点击展开
    trigger.click();
    expect(dropdown.hidden).toBe(false);
    expect(document.activeElement).toBe(searchInput);

    // 过滤 "open"
    searchInput.value = "open";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));

    const visible = options.filter((o) => !o.hidden);
    expect(visible.map((o) => o.textContent)).toEqual(["Opencode Go", "OpenRouter"]);

    const hidden = options.filter((o) => o.hidden);
    expect(hidden).toHaveLength(6);
  });

  it("无匹配项时显示「无匹配选项」提示", () => {
    const select = createSelect([
      "DeepSeek", "Qwen", "GLM", "Kimi", "MiniMax", "Mimo", "Opencode Go", "OpenRouter"
    ]);
    initCustomSelect(select);
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    const trigger = wrapper.querySelector<HTMLElement>(".custom-select-trigger")!;
    const searchInput = wrapper.querySelector<HTMLInputElement>(".custom-select-search-input")!;
    const emptyItem = wrapper.querySelector<HTMLElement>(".custom-select-empty")!;

    trigger.click();
    searchInput.value = "nonexistent_query";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(emptyItem.hidden).toBe(false);
    expect(emptyItem.textContent).toBe("无匹配选项");
  });

  it("搜索框按 ArrowDown 聚焦首个可见项，首项按 ArrowUp 回到搜索框", () => {
    const select = createSelect([
      "DeepSeek", "Qwen", "GLM", "Kimi", "MiniMax", "Mimo", "Opencode Go", "OpenRouter"
    ]);
    initCustomSelect(select);
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    const trigger = wrapper.querySelector<HTMLElement>(".custom-select-trigger")!;
    const searchInput = wrapper.querySelector<HTMLInputElement>(".custom-select-search-input")!;
    const options = Array.from(wrapper.querySelectorAll<HTMLElement>(".custom-select-option"));

    trigger.click();
    expect(document.activeElement).toBe(searchInput);

    // 过滤出 "kimi"
    searchInput.value = "kimi";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    const kimiOption = options.find((o) => o.textContent === "Kimi")!;

    // ArrowDown 聚焦可见项
    searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(kimiOption);

    // ArrowUp 回退到搜索框
    kimiOption.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(searchInput);
  });

  it("搜索框按 Enter 选中第一个匹配条目并关闭浮层", () => {
    const select = createSelect([
      "DeepSeek", "Qwen", "GLM", "Kimi", "MiniMax", "Mimo", "Opencode Go", "OpenRouter"
    ]);
    let changeFired = false;
    select.addEventListener("change", () => {
      changeFired = true;
    });

    initCustomSelect(select);
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    const trigger = wrapper.querySelector<HTMLElement>(".custom-select-trigger")!;
    const dropdown = wrapper.querySelector<HTMLElement>(".custom-select-dropdown")!;
    const searchInput = wrapper.querySelector<HTMLInputElement>(".custom-select-search-input")!;

    trigger.click();
    searchInput.value = "deep";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));

    searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(select.value).toBe("val_0");
    expect(changeFired).toBe(true);
    expect(dropdown.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("搜索框按 Escape 关闭浮层，重置搜索词与选项显隐", () => {
    const select = createSelect([
      "DeepSeek", "Qwen", "GLM", "Kimi", "MiniMax", "Mimo", "Opencode Go", "OpenRouter"
    ]);
    initCustomSelect(select);
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    const trigger = wrapper.querySelector<HTMLElement>(".custom-select-trigger")!;
    const dropdown = wrapper.querySelector<HTMLElement>(".custom-select-dropdown")!;
    const searchInput = wrapper.querySelector<HTMLInputElement>(".custom-select-search-input")!;
    const options = Array.from(wrapper.querySelectorAll<HTMLElement>(".custom-select-option"));

    trigger.click();
    searchInput.value = "min";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(options.filter((o) => !o.hidden)).toHaveLength(1);

    searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dropdown.hidden).toBe(true);
    expect(searchInput.value).toBe("");
    expect(options.every((o) => !o.hidden)).toBe(true);
  });

  it("rebuildCustomSelectOptions 动态更新选项数后能够自动增删搜索框", () => {
    const select = createSelect(["Opt1", "Opt2"]);
    initCustomSelect(select);
    const wrapper = select.closest<HTMLElement>(".custom-select-wrapper")!;
    expect(wrapper.querySelector(".custom-select-search-input")).toBeNull();

    // 动态扩充选项至 9 项
    for (let i = 3; i <= 9; i++) {
      const opt = document.createElement("option");
      opt.value = `val_${i}`;
      opt.textContent = `Opt${i}`;
      select.appendChild(opt);
    }
    rebuildCustomSelectOptions(select);
    expect(wrapper.querySelector(".custom-select-search-input")).not.toBeNull();
  });
});
