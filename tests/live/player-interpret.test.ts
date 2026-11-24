// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  createInterpretSubtitleOverlay,
  resolveInterpretSubtitleLines,
  syncPlayerInterpretQuickActionState,
  type InterpretSubtitleMenuChoice,
  type InterpretSubtitleMenuDeps
} from "../../extension/live/player-interpret.js";
import type { LiveInterpretTargetLang } from "../../extension/live/interpret-subtitle-preferences.js";

let playerHost: HTMLElement;

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  playerHost = document.createElement("div");
  playerHost.className = "bpx-player-container";
  document.body.appendChild(playerHost);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("同声传译字幕分行", () => {
  it("自动模式按原文主要文字类别与目标语言决定行数，拉丁目标始终双语", () => {
    expect(resolveInterpretSubtitleLines("Hello world", "zh", "auto")).toEqual({
      showOriginal: true,
      showTranslation: true
    });
    expect(resolveInterpretSubtitleLines("你好，世界", "zh", "auto")).toEqual({
      showOriginal: false,
      showTranslation: true
    });
    expect(resolveInterpretSubtitleLines("こんにちは", "en", "auto")).toEqual({
      showOriginal: true,
      showTranslation: true
    });
    expect(resolveInterpretSubtitleLines("你好", "en", "auto")).toEqual({
      showOriginal: true,
      showTranslation: true
    });

    ([
      ["こんにちは", "ja"],
      ["안녕하세요", "ko"],
      ["Привет", "ru"],
      ["Γειά σου", "el"]
    ] as const).forEach(([text, target]) => {
      expect(resolveInterpretSubtitleLines(text, target, "auto")).toEqual({
        showOriginal: false,
        showTranslation: true
      });
    });

    expect(resolveInterpretSubtitleLines("Hello", "ru", "auto").showOriginal).toBe(true);
    expect(resolveInterpretSubtitleLines("Привет", "el", "auto").showOriginal).toBe(true);
    expect(resolveInterpretSubtitleLines("日本語字幕です", "ja", "auto")).toEqual({
      showOriginal: false,
      showTranslation: true
    });
  });

  it("仅译文始终一行，双语始终两行", () => {
    ([
      ["你好", "zh"],
      ["Hello", "en"]
    ] as const).forEach(([text, target]) => {
      expect(resolveInterpretSubtitleLines(text, target, "translation")).toEqual({
        showOriginal: false,
        showTranslation: true
      });
      expect(resolveInterpretSubtitleLines(text, target, "bilingual")).toEqual({
        showOriginal: true,
        showTranslation: true
      });
    });
  });
});

function createOverlay(
  displayMode: "auto" | "translation" | "bilingual" = "auto",
  targetLang: LiveInterpretTargetLang = "zh"
) {
  return createInterpretSubtitleOverlay({
    getPlayerHost: () => playerHost,
    getTargetLang: () => targetLang,
    getDisplayMode: () => displayMode
  });
}

describe("同声传译字幕浮层", () => {
  it("原文与译文快照即时覆盖，原文在上译文在下", () => {
    const overlay = createOverlay("bilingual");
    overlay.setSubtitle("Hello", "你");

    const root = overlay.getElement()!;
    const original = root.querySelector<HTMLElement>(".biliscript-interpret-subtitle-original")!;
    const translation = root.querySelector<HTMLElement>(".biliscript-interpret-subtitle-translation")!;
    expect(root.hidden).toBe(false);
    expect(playerHost.contains(root)).toBe(true);
    expect(original.textContent).toBe("Hello");
    expect(translation.textContent).toBe("你");
    expect(original.compareDocumentPosition(translation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    overlay.setSubtitle("Hello world", "你好，世界");
    expect(root.querySelectorAll(".biliscript-interpret-subtitle-original")).toHaveLength(1);
    expect(root.querySelectorAll(".biliscript-interpret-subtitle-translation")).toHaveLength(1);
    expect(original.textContent).toBe("Hello world");
    expect(translation.textContent).toBe("你好，世界");
    overlay.dispose();
  });

  it("不同显示模式下的显隐行为（仅译文 / 双语 / 自动）", () => {
    const overlayTranslationOnly = createOverlay("translation", "zh");
    overlayTranslationOnly.setSubtitle("Hello", "你好");
    const root1 = overlayTranslationOnly.getElement()!;
    const original1 = root1.querySelector<HTMLElement>(".biliscript-interpret-subtitle-original")!;
    const translation1 = root1.querySelector<HTMLElement>(".biliscript-interpret-subtitle-translation")!;
    expect(original1.hidden).toBe(true);
    expect(translation1.hidden).toBe(false);
    expect(translation1.textContent).toBe("你好");
    overlayTranslationOnly.dispose();

    const overlayBilingual = createOverlay("bilingual", "zh");
    overlayBilingual.setSubtitle("Hello", "你好");
    const root2 = overlayBilingual.getElement()!;
    const original2 = root2.querySelector<HTMLElement>(".biliscript-interpret-subtitle-original")!;
    const translation2 = root2.querySelector<HTMLElement>(".biliscript-interpret-subtitle-translation")!;
    expect(original2.hidden).toBe(false);
    expect(translation2.hidden).toBe(false);
    overlayBilingual.dispose();
  });

  it("clear 立即清空当前字幕浮层并隐藏", () => {
    const overlay = createOverlay("bilingual");
    overlay.setSubtitle("旧原文", "旧译文");
    const root = overlay.getElement()!;
    expect(root.hidden).toBe(false);

    overlay.clear();
    expect(root.hidden).toBe(true);
    expect(root.textContent).toBe("");

    overlay.setSubtitle("新原文", "新译文");
    expect(root.hidden).toBe(false);
    expect(root.textContent).toBe("新原文新译文");
    overlay.dispose();
  });

  it("clearForSeek 立即清空当前字幕浮层", () => {
    const overlay = createOverlay("bilingual");
    overlay.setSubtitle("seek 前原文", "seek 前译文");
    const root = overlay.getElement()!;

    overlay.clearForSeek();
    expect(root.hidden).toBe(true);

    overlay.setSubtitle("seek 后原文", "seek 后译文");
    expect(root.hidden).toBe(false);
    expect(root.textContent).toBe("seek 后原文seek 后译文");
    overlay.dispose();
  });

  it("轻量状态提示独立显示，支持自动定时隐藏", () => {
    vi.useFakeTimers();
    const overlay = createOverlay();
    overlay.showNotice("处理中...", 1000);

    let notice = playerHost.querySelector<HTMLElement>(".biliscript-interpret-notice");
    expect(notice?.textContent).toBe("处理中...");
    expect(notice?.getAttribute("role")).toBe("status");

    vi.advanceTimersByTime(1000);
    expect(playerHost.querySelector(".biliscript-interpret-notice")).toBeNull();

    overlay.showNotice("实时翻译已关闭", 0);
    notice = playerHost.querySelector<HTMLElement>(".biliscript-interpret-notice");
    expect(notice?.textContent).toBe("实时翻译已关闭");
    overlay.dispose();
    expect(playerHost.querySelector(".biliscript-interpret-notice")).toBeNull();
  });

  it("dispose 清理 DOM 节点与状态", () => {
    const overlay = createOverlay("bilingual");
    overlay.setSubtitle("原文", "译文");
    expect(playerHost.querySelector(".biliscript-interpret-subtitle-overlay")).not.toBeNull();

    overlay.dispose();
    expect(playerHost.querySelector(".biliscript-interpret-subtitle-overlay")).toBeNull();
    expect(overlay.getElement()).toBeNull();
  });
});

function createMenuDeps(overrides: {
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
      if (choice.kind === "translation" || choice.kind === "bilingual") {
        prefs.targetLang = choice.targetLang;
        prefs.displayMode = choice.kind;
      } else if (choice.kind === "native-bilingual") {
        prefs.displayMode = "bilingual";
      }
    }
  };
  return { deps, choices };
}

describe("player-interpret: 仿原生字幕菜单与控制栏联动", () => {
  async function openMenu(deps: InterpretSubtitleMenuDeps) {
    const { openInterpretSubtitleMenu } = await import("../../extension/live/player-interpret.js");
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    await openInterpretSubtitleMenu(anchor, deps);
    return document.getElementById("biliscript-interpret-menu") as HTMLElement;
  }

  it("会话关闭时渲染关闭高亮 + 14 个带 AI 徽标的语言行 + 双语开关", async () => {
    const { deps, choices } = createMenuDeps();
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
    expect(document.getElementById("biliscript-interpret-menu")).not.toBeNull();
  });

  it("仅译文模式：当前目标语言行高亮，关闭行不高亮", async () => {
    const { deps } = createMenuDeps({ sessionState: "connected", targetLang: "ja", displayMode: "translation" });
    const menu = await openMenu(deps);

    expect(menu.querySelector('[data-action="off"]')?.classList.contains("is-selected")).toBe(false);
    expect(menu.querySelector('[data-lang="ja"]')?.classList.contains("is-selected")).toBe(true);
    expect(menu.querySelector('[data-lang="zh"]')?.classList.contains("is-selected")).toBe(false);
  });

  it("双语模式：开关打开并渲染主/副字幕双列，副字幕固定原文", async () => {
    const { deps, choices } = createMenuDeps({ sessionState: "connected", targetLang: "en", displayMode: "bilingual" });
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
    const { deps, choices } = createMenuDeps({ sessionState: "connected", targetLang: "zh", displayMode: "auto" });
    const menu = await openMenu(deps);

    expect(menu.querySelector(".biliscript-interpret-menu-switch")?.classList.contains("is-on")).toBe(true);
    expect(menu.querySelector(".biliscript-interpret-menu-grid")).not.toBeNull();

    (menu.querySelector(".biliscript-interpret-menu-switch") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(choices).toEqual([{ kind: "translation", targetLang: "zh" }]));
    const rerendered = document.getElementById("biliscript-interpret-menu") as HTMLElement;
    await vi.waitFor(() => expect(rerendered.querySelector(".biliscript-interpret-menu-langs")).not.toBeNull());
    expect(rerendered.querySelector(".biliscript-interpret-menu-switch")?.classList.contains("is-on")).toBe(false);
  });

  it("点击关闭行向宿主请求停止会话", async () => {
    const { deps, choices } = createMenuDeps({ sessionState: "connected", targetLang: "zh", displayMode: "translation" });
    const menu = await openMenu(deps);

    (menu.querySelector('[data-action="off"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(choices).toEqual([{ kind: "off" }]);
  });

  it("外部指针与 Escape 关闭菜单", async () => {
    const { deps } = createMenuDeps();
    await openMenu(deps);

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.getElementById("biliscript-interpret-menu")).toBeNull();

    const menu = await openMenu(deps);
    expect(menu).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.getElementById("biliscript-interpret-menu")).toBeNull();
  });

  it("双语态右列原文为静态非交互节点，Escape 复位 aria-expanded 并回焦触发按钮", async () => {
    const anchor = document.createElement("div");
    const trigger = document.createElement("button");
    trigger.id = "biliscript-player-interpret-quick-action";
    trigger.setAttribute("aria-expanded", "false");
    anchor.appendChild(trigger);
    document.body.appendChild(anchor);

    const { openInterpretSubtitleMenu } = await import("../../extension/live/player-interpret.js");
    const { deps } = createMenuDeps({ sessionState: "connected", targetLang: "zh", displayMode: "bilingual" });
    await openInterpretSubtitleMenu(anchor, deps);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const original = anchor.querySelector(".biliscript-interpret-menu-grid-col:last-child .biliscript-interpret-menu-item");
    expect(original?.tagName).toBe("DIV");
    expect(original?.classList.contains("is-static")).toBe(true);
    expect(original?.getAttribute("aria-current")).toBe("true");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.getElementById("biliscript-interpret-menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("菜单内点击不触发外部关闭", async () => {
    const { deps } = createMenuDeps();
    const menu = await openMenu(deps);

    menu.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.getElementById("biliscript-interpret-menu")).not.toBeNull();
  });

  it("控制栏同传按钮同步显隐、连接状态与配置不可用原因", () => {
    const wrap = document.createElement("div");
    wrap.id = "biliscript-player-interpret-quick-action-wrap";
    const button = document.createElement("button");
    button.id = "biliscript-player-interpret-quick-action";
    wrap.appendChild(button);
    document.body.appendChild(wrap);
    let interpretState = "idle";
    let availability = { ok: false, error: "未配置 MOSS-LIVE 密钥" };
    const controller = {
      getState: () => interpretState,
      getAvailability: () => availability
    } as any;

    syncPlayerInterpretQuickActionState(controller, false);
    expect(wrap.hidden).toBe(true);
    expect(button.hidden).toBe(true);

    syncPlayerInterpretQuickActionState(controller, true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-description")).toBe(availability.error);
    expect(button.title).toBe(availability.error);
    expect(button.getAttribute("aria-label")).toBe("字幕");

    availability = { ok: true } as any;
    interpretState = "idle";
    syncPlayerInterpretQuickActionState(controller, true);
    expect(button.title).toBe("字幕");
    expect(button.getAttribute("aria-label")).toBe("字幕");

    interpretState = "connecting";
    syncPlayerInterpretQuickActionState(controller, true);
    expect(button.getAttribute("aria-disabled")).toBe("false");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.classList.contains("is-connecting")).toBe(true);

    interpretState = "connected";
    syncPlayerInterpretQuickActionState(controller, true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("关闭实时翻译");
    expect(button.classList.contains("is-active")).toBe(true);
  });

  it("控制栏同传按钮跟随真实 CC 字幕状态且 togglePlayerInterpretMenu 可开关菜单", async () => {
    const interpret = await import("../../extension/live/player-interpret.js");
    const { state } = await import("../../extension/core/state.js");
    const { notifyReaderPresenter } = await import("../../extension/reader/reader-bus.js");
    const wrap = document.createElement("div");
    wrap.id = "biliscript-player-interpret-quick-action-wrap";
    const button = document.createElement("button");
    button.id = "biliscript-player-interpret-quick-action";
    wrap.appendChild(button);
    document.body.appendChild(wrap);

    state.clip.setSubtitleFetchState("loading");
    interpret.syncPlayerInterpretQuickAction();
    expect(button.hidden).toBe(true);

    state.clip.setSubtitleFetchState("empty");
    notifyReaderPresenter({ kind: "subtitle-ready" });
    expect(button.hidden).toBe(false);
    expect(wrap.hidden).toBe(false);

    await interpret.togglePlayerInterpretMenu(wrap);
    expect(document.getElementById("biliscript-interpret-menu")).not.toBeNull();

    state.clip.setSubtitles([{ id: "cc-1", lan: "zh-CN", subtitleUrl: "https://example.com/cc.json" }]);
    state.clip.setSubtitleFetchState("ready");
    notifyReaderPresenter({ kind: "subtitle-ready" });
    expect(button.hidden).toBe(false);
    expect(wrap.hidden).toBe(false);
    expect(button.textContent).toBe("双语");
    expect(button.getAttribute("aria-label")).toBe("双语字幕");
    expect(playerHost.hasAttribute("data-biliscript-subtitle-takeover")).toBe(false);
    interpret.closeInterpretSubtitleMenu();

    state.clip.setSubtitles([{ id: "asr-1", lan: "asr-zh", subtitleUrl: "" }]);
    notifyReaderPresenter({ kind: "subtitle-ready" });
    expect(button.hidden).toBe(false);
    expect(button.textContent).toBe("字幕");

    window.dispatchEvent(new Event("pagehide"));
  });
});
