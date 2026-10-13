// tests/reader/chat-suggestions-slot.test.ts
// createChatSuggestionsSlot（对话 tab 建议区属主）行为契约：节点建立 / 写入 / 摘除 /
// 在场判定，以及消息区清场（节点脱开文档）后由 render 补挂新节点。
//
// 不挂阅读壳：容器与 id 都是本文件造的替身——属主只认 deps.messages 与 deps.id，
// chip 点击经 deps.onPick 交回调用方。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let createChatSuggestionsSlot: typeof import("../../extension/reader/chat-suggestions-slot.js").createChatSuggestionsSlot;

// 与生产同形的挂点：一个容器 + 一个 id 由 deps 定的建议区节点。
const SLOT_ID = "test-reading-chat-suggestions";

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const onPick = vi.fn();
  const slot = createChatSuggestionsSlot({ messages: container, id: SLOT_ID, onPick });
  const node = () => container.querySelector<HTMLElement>(".chat-suggestions");
  const chipTexts = () => [...container.querySelectorAll(".chat-chip")].map((btn) => btn.textContent || "");
  return { container, slot, onPick, node, chipTexts };
}

function clickOnce(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  createChatSuggestionsSlot = (await import("../../extension/reader/chat-suggestions-slot.js")).createChatSuggestionsSlot;
});

describe("建议区属主：render / clear / isPresent 三态", () => {
  it("未建立时不在场；render 建节点：class 与 id 由属主写，容器只提供挂点", () => {
    const { container, slot, node } = mount();

    expect(slot.isPresent()).toBe(false);
    expect(node()).toBe(null);

    slot.render(["问题一", "问题二"]);

    expect(slot.isPresent()).toBe(true);
    expect(node()).not.toBe(null);
    expect(node()!.id).toBe(SLOT_ID);
    expect(node()!.parentElement).toBe(container);
  });

  it("写入：欢迎区（✦ 图标 + 引导语）与 chips 按清单落 DOM；重复 render 只留最后一次清单", () => {
    const { container, slot, chipTexts } = mount();

    slot.render(["问题一", "问题二"]);

    expect(container.querySelector(".chat-hero")).not.toBe(null);
    expect(container.querySelector(".chat-hero-icon svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".chat-hero-title")?.textContent).toBe("围绕这期视频，问点什么");
    expect(chipTexts()).toEqual(["问题一", "问题二"]);

    slot.render(["新问题"]);

    expect(chipTexts()).toEqual(["新问题"]);
    expect(container.querySelectorAll(".chat-suggestions")).toHaveLength(1);
  });

  it("chip 点击：把该 chip 的文案交回 onPick（按钮与接线都在属主里）", () => {
    const { container, slot, onPick } = mount();
    slot.render(["问题一", "问题二"]);

    clickOnce(container.querySelectorAll(".chat-chip")[1]);

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("问题二");
  });

  it("不可用态：render([]) 保留空壳、不落欢迎区", () => {
    const { container, slot, node } = mount();

    slot.render([]);

    expect(slot.isPresent()).toBe(true);
    expect(node()).not.toBe(null);
    expect(node()!.innerHTML).toBe("");
    expect(container.querySelector(".chat-hero")).toBe(null);
  });

  it("摘除：clear 移除节点并忘掉引用；再次 render 重新建立", () => {
    const { container, slot, node, chipTexts } = mount();
    slot.render(["问题一"]);

    slot.clear();

    expect(slot.isPresent()).toBe(false);
    expect(node()).toBe(null);

    slot.render(["问题二"]);
    expect(slot.isPresent()).toBe(true);
    expect(chipTexts()).toEqual(["问题二"]);
  });

  it("清场后重建：容器被清空（节点脱开文档）后 render 补挂新节点，旧节点不复活", () => {
    const { container, slot, node } = mount();
    slot.render(["问题一"]);
    const before = node();

    // 消息区清场（innerHTML 重建）：节点脱出文档，属主手里的引用还在
    container.innerHTML = "";

    expect(slot.isPresent()).toBe(false);
    slot.render([]);
    const after = node();
    expect(after).not.toBe(null);
    expect(after).not.toBe(before);
    expect(after!.parentElement).toBe(container);
    expect(slot.isPresent()).toBe(true);
  });

  it("chip 文案走 escapeHtml：清单里的 HTML 落成文本，点击交回的仍是原文", () => {
    const { container, slot, onPick } = mount();

    slot.render(["<b>整段</b>问什么"]);

    const chip = container.querySelector(".chat-chip") as HTMLElement;
    expect(chip.textContent).toBe("<b>整段</b>问什么");
    expect(chip.querySelector("b")).toBe(null);

    clickOnce(chip);
    expect(onPick).toHaveBeenCalledWith("<b>整段</b>问什么");
  });
});
