import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type {
  InterpretSubtitleMenuChoice,
  InterpretSubtitleMenuDeps
} from "../../extension/live/interpret-subtitle-menu.js";

function createDeps(overrides: {
  sessionState?: "idle" | "connecting" | "connected";
  targetLang?: string;
  displayMode?: string;
} = {}) {
  const choices: InterpretSubtitleMenuChoice[] = [];
  const prefs = {
    targetLang: overrides.targetLang ?? "zh",
    displayMode: overrides.displayMode ?? "translation"
  };
  const deps: InterpretSubtitleMenuDeps = {
    getSessionState: () => overrides.sessionState ?? "idle",
    getPreferences: async () => ({ ...prefs }),
    applyChoice: async (choice) => {
      choices.push(choice);
      if (choice.kind !== "off") {
        prefs.targetLang = choice.targetLang;
        prefs.displayMode = choice.kind;
      }
    }
  };
  return { deps, choices };
}

describe("interpret-subtitle-menu: 仿原生字幕菜单", () => {
  beforeEach(() => {
    resetModuleState();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  async function openMenu(deps: InterpretSubtitleMenuDeps) {
    const { openInterpretSubtitleMenu } = await import("../../extension/live/interpret-subtitle-menu.js");
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    await openInterpretSubtitleMenu(anchor, deps);
    return document.getElementById("biliscript-interpret-menu") as HTMLElement;
  }

  it("会话关闭时渲染关闭高亮 + 14 个带 AI 徽标的语言行 + 双语开关", async () => {
    const { deps, choices } = createDeps();
    const menu = await openMenu(deps);

    expect(menu.querySelector(".biliscript-interpret-menu-title")?.textContent).toBe("字幕");
    expect(menu.querySelector('[data-action="off"]')?.classList.contains("is-selected")).toBe(true);
    expect(menu.querySelectorAll(".biliscript-interpret-menu-langs [data-lang]")).toHaveLength(14);
    expect(menu.querySelectorAll(".biliscript-interpret-menu-ai")).toHaveLength(14);
    expect(menu.querySelector('[data-lang="zh"] .biliscript-interpret-menu-item-label')?.textContent).toBe("中文");
    expect(menu.querySelector(".biliscript-interpret-menu-grid")).toBeNull();
    expect(menu.querySelector(".biliscript-interpret-menu-switch")?.classList.contains("is-on")).toBe(false);

    (menu.querySelector('[data-lang="ko"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(choices).toEqual([{ kind: "translation", targetLang: "ko" }]);
    // 应用后菜单保持打开（供继续切换）
    expect(document.getElementById("biliscript-interpret-menu")).not.toBeNull();
  });

  it("仅译文模式：当前目标语言行高亮，关闭行不高亮", async () => {
    const { deps } = createDeps({ sessionState: "connected", targetLang: "ja", displayMode: "translation" });
    const menu = await openMenu(deps);

    expect(menu.querySelector('[data-action="off"]')?.classList.contains("is-selected")).toBe(false);
    expect(menu.querySelector('[data-lang="ja"]')?.classList.contains("is-selected")).toBe(true);
    expect(menu.querySelector('[data-lang="zh"]')?.classList.contains("is-selected")).toBe(false);
  });

  it("双语模式：开关打开并渲染主/副字幕双列，副字幕固定原文", async () => {
    const { deps, choices } = createDeps({ sessionState: "connected", targetLang: "en", displayMode: "bilingual" });
    const menu = await openMenu(deps);

    expect(menu.querySelector(".biliscript-interpret-menu-langs")).toBeNull();
    expect(menu.querySelector(".biliscript-interpret-menu-switch")?.classList.contains("is-on")).toBe(true);
    const titles = Array.from(menu.querySelectorAll(".biliscript-interpret-menu-grid-title")).map(
      (el) => el.textContent
    );
    expect(titles).toEqual(["主字幕", "副字幕"]);
    expect(menu.querySelector(".biliscript-interpret-menu-grid-col:last-child [data-lang]")).toBeNull();
    const original = menu.querySelector(".biliscript-interpret-menu-grid-col:last-child .biliscript-interpret-menu-item");
    expect(original?.textContent).toContain("原文");
    expect(original?.classList.contains("is-selected")).toBe(true);

    (menu.querySelector('.biliscript-interpret-menu-grid-col [data-lang="fr"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(choices).toEqual([{ kind: "bilingual", targetLang: "fr" }]);
  });

  it("自动模式按双语呈现；从双语关开关回落仅译文并保持当前语言", async () => {
    const { deps, choices } = createDeps({ sessionState: "connected", targetLang: "zh", displayMode: "auto" });
    const menu = await openMenu(deps);

    expect(menu.querySelector(".biliscript-interpret-menu-switch")?.classList.contains("is-on")).toBe(true);
    expect(menu.querySelector(".biliscript-interpret-menu-grid")).not.toBeNull();

    (menu.querySelector(".biliscript-interpret-menu-switch") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(choices).toEqual([{ kind: "translation", targetLang: "zh" }]));
    // 重渲染回落单列表
    const rerendered = document.getElementById("biliscript-interpret-menu") as HTMLElement;
    await vi.waitFor(() => expect(rerendered.querySelector(".biliscript-interpret-menu-langs")).not.toBeNull());
    expect(rerendered.querySelector(".biliscript-interpret-menu-switch")?.classList.contains("is-on")).toBe(false);
  });

  it("点击关闭行向宿主请求停止会话", async () => {
    const { deps, choices } = createDeps({ sessionState: "connected", targetLang: "zh", displayMode: "translation" });
    const menu = await openMenu(deps);

    (menu.querySelector('[data-action="off"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(choices).toEqual([{ kind: "off" }]);
  });

  it("外部指针与 Escape 关闭菜单", async () => {
    const { deps } = createDeps();
    await openMenu(deps);

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.getElementById("biliscript-interpret-menu")).toBeNull();

    const menu = await openMenu(deps);
    expect(menu).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.getElementById("biliscript-interpret-menu")).toBeNull();
  });

  it("菜单内点击不触发外部关闭", async () => {
    const { deps } = createDeps();
    const menu = await openMenu(deps);

    menu.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.getElementById("biliscript-interpret-menu")).not.toBeNull();
  });
});
