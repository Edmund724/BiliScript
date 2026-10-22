// 设置变更测试：主题（明暗）与外观色板
// 通过 hydrateReaderStateFromSettings 与 updateReaderPreferences 驱动，
// 校验 data-attribute 在阅读视图、documentElement、body 三处的应用。
//（script-only-ui：排版档位机制退役，字号/字距/行距/面板宽度不再可调，
// 相关字段与 data-attribute 一并移除；三开关退役后章节/字幕可见性设置项
// 与 data-attribute 也随之删除。排版设置剩明暗 theme 与色板 palette 两轴，
// 两轴正交：header 按钮只动明暗，设置抽屉色板选择只动色板。）

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { TestState, ChromeRuntimeStub } from "./reader-test-env.js";

let state: TestState;
let presentation: typeof import("../../extension/reader/presentation.js");
let lifecycle: typeof import("../../extension/reader/index.js");
let initEssentials: typeof import("../../extension/reader/init-essentials.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let presenter: typeof import("../../extension/reader/reader-bus.js");
let chromeStub: ChromeRuntimeStub;

async function loadReaderModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  presenter = await import("../../extension/reader/reader-bus.js");
  presentation = await import("../../extension/reader/presentation.js");
  initEssentials = await import("../../extension/reader/init-essentials.js");
  lifecycle = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  chromeStub = globalThis.chrome as unknown as ChromeRuntimeStub;
  // 模拟 content.js 的能力槽接线：reader 域经 reader-bus 持久化设置，底层仍是
  // chrome.runtime.sendMessage（tests/setup.ts 的 stub）；设置回读走
  // core/runtime 的 getSettings。
  presenter.registerContentCapabilities({
    persistSettings: () => {
      chromeStub.runtime.sendMessage(
        { type: "save-settings", settings: state.settings },
        () => {}
      );
    }
  });
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadReaderModules();
  mountReaderSkeleton(ids);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("设置变更与 data-attribute", () => {
  it("hydrateReaderStateFromSettings：应用主题设置（明暗 + 色板两轴）", () => {
    presentation.hydrateReaderStateFromSettings({
      readerTheme: "dark",
      readerThemeUserSet: true,
      readerPalette: "editorial"
    });

    expect(state.reader.readingTheme).toBe("dark");
    expect(state.reader.readingPalette).toBe("editorial");
  });

  it("hydrateReaderStateFromSettings：色板缺失/非法时归一回落 flyme（两条水合分支同口径）", () => {
    // 未手动选过主题的分支（readerThemeUserSet 缺省）
    presentation.hydrateReaderStateFromSettings({ readerPalette: "neon" });
    expect(state.reader.readingPalette).toBe("flyme");
    presentation.hydrateReaderStateFromSettings({});
    expect(state.reader.readingPalette).toBe("flyme");

    // 手动选过主题的分支
    presentation.hydrateReaderStateFromSettings({
      readerTheme: "dark",
      readerThemeUserSet: true,
      readerPalette: 1
    } as unknown as Partial<typeof state.settings>);
    expect(state.reader.readingPalette).toBe("flyme");
  });

  it("hydrateReaderStateFromSettings：未手动选过主题时按系统深浅定初始主题", () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    presentation.hydrateReaderStateFromSettings({ readerTheme: "light" });
    expect(state.reader.readingTheme).toBe("dark");

    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
    presentation.hydrateReaderStateFromSettings({ readerTheme: "light" });
    expect(state.reader.readingTheme).toBe("light");

    window.matchMedia = original;
  });

  it("hydrateReaderStateFromSettings：手动选过主题则不再跟随系统偏好", () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    presentation.hydrateReaderStateFromSettings({
      readerTheme: "light",
      readerThemeUserSet: true
    });
    expect(state.reader.readingTheme).toBe("light");

    window.matchMedia = original;
  });

  it("applyReadingViewPresentation：在视图/html/body 三处写 theme data-attribute", () => {
    // 纸色档已退役：存量 "paper" 经 normalizeReaderTheme 静默归一为 light。
    presentation.hydrateReaderStateFromSettings({
      readerTheme: "paper",
      readerThemeUserSet: true
    });
    presentation.applyReadingViewPresentation();

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    const htmlEl = document.documentElement;
    const bodyEl = document.body;

    expect(readingView.dataset.theme).toBe("light");
    expect(htmlEl.dataset.biliscriptReaderTheme).toBe("light");
    expect(bodyEl.dataset.biliscriptReaderTheme).toBe("light");
  });

  it("applyReadingViewPresentation：在视图/html/body 三处写 palette data-attribute", () => {
    presentation.hydrateReaderStateFromSettings({
      readerTheme: "dark",
      readerThemeUserSet: true,
      readerPalette: "editorial"
    });
    presentation.applyReadingViewPresentation();

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    const htmlEl = document.documentElement;
    const bodyEl = document.body;

    expect(readingView.dataset.palette).toBe("editorial");
    expect(htmlEl.dataset.biliscriptReaderPalette).toBe("editorial");
    expect(bodyEl.dataset.biliscriptReaderPalette).toBe("editorial");

    // 存量非法色板经水合归一回落 flyme，apply 落位 flyme
    presentation.hydrateReaderStateFromSettings({
      readerTheme: "dark",
      readerThemeUserSet: true,
      readerPalette: "neon"
    } as unknown as Partial<typeof state.settings>);
    presentation.applyReadingViewPresentation();
    expect(readingView.dataset.palette).toBe("flyme");
    expect(htmlEl.dataset.biliscriptReaderPalette).toBe("flyme");
    expect(bodyEl.dataset.biliscriptReaderPalette).toBe("flyme");
  });

  it("applyReadingViewPresentation：默认开启光晕不落 data-chat-input-glow=\"0\"，显式关停落 0", () => {
    state.setSettings({ ...(state.settings || {}), chatInputGlow: true } as typeof state.settings);
    presentation.applyReadingViewPresentation();
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    expect(readingView.dataset.chatInputGlow).toBeUndefined();

    state.setSettings({ ...(state.settings || {}), chatInputGlow: false } as typeof state.settings);
    presentation.applyReadingViewPresentation();
    expect(readingView.dataset.chatInputGlow).toBe("0");
  });

  it("applyReadingViewPresentation：header 主题按钮图标/文案随主题刷新", () => {
    const themeButton = document.createElement("button");
    themeButton.id = ids.readingThemeSelect;
    document.body.appendChild(themeButton);

    presentation.hydrateReaderStateFromSettings({ readerTheme: "dark", readerThemeUserSet: true });
    presentation.applyReadingViewPresentation();
    expect(themeButton.title).toBe("主题：深色");
    expect(themeButton.getAttribute("aria-label")).toBe("主题：深色");
    const darkIconHtml = themeButton.innerHTML;

    presentation.hydrateReaderStateFromSettings({ readerTheme: "light", readerThemeUserSet: true });
    presentation.applyReadingViewPresentation();
    expect(themeButton.title).toBe("主题：浅色");
    expect(themeButton.getAttribute("aria-label")).toBe("主题：浅色");
    expect(themeButton.innerHTML).not.toBe(darkIconHtml);
  });

  it("updateReaderPreferences：变更主题并持久化到 chrome.runtime", () => {
    lifecycle.updateReaderPreferences({ readerTheme: "dark" }, { persist: true });

    expect(state.reader.readingTheme).toBe("dark");

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    expect(readingView.dataset.theme).toBe("dark");

    expect(chromeStub.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "save-settings" }),
      expect.any(Function)
    );
  });

  it("updateReaderPreferences：非法主题被归一化", () => {
    lifecycle.updateReaderPreferences(
      { readerTheme: "neon" },
      { persist: false }
    );

    expect(state.reader.readingTheme).toBe("light");
  });

  it("settings 变更监听：chrome.storage.onChanged 触发时刷新设置", async () => {
    // bindSettingsWatcher 在 chrome.storage.onChanged 存在时绑定
    initEssentials.bindSettingsWatcher();
    expect(state.ui.settingsWatcherBound).toBe(true);
    expect(chromeStub.storage.onChanged.addListener).toHaveBeenCalled();
  });

  it("header 主题按钮：点击按 light ↔ dark 两态切换，文案随档更新", async () => {
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    const themeButton = document.createElement("button");
    themeButton.id = ids.readingThemeSelect;
    readingView.appendChild(themeButton);
    // bindUiEvents 对关闭按钮同样直接 byId（阅读骨架不含，与 sync.test 同款补齐）
    const closeBtn = document.createElement("button");
    closeBtn.id = ids.readingCloseBtn;
    readingView.appendChild(closeBtn);

    const uiRenderer = await import("../../extension/ui/ui-renderer.js");
    uiRenderer.bindUiEvents();

    expect(state.reader.readingTheme).toBe("light");

    themeButton.click();
    await vi.waitFor(() => {
      expect(state.reader.readingTheme).toBe("dark");
    });
    expect(themeButton.title).toBe("主题：深色");
    expect(themeButton.getAttribute("aria-label")).toBe("主题：深色");
    const darkIcon = themeButton.innerHTML;

    themeButton.click();
    await vi.waitFor(() => {
      expect(state.reader.readingTheme).toBe("light");
    });
    expect(themeButton.title).toBe("主题：浅色");
    expect(themeButton.getAttribute("aria-label")).toBe("主题：浅色");

    // 两态各用一枚图标：回到浅色不复用月亮图标
    expect(themeButton.innerHTML).not.toBe(darkIcon);
  });

  it("header 主题按钮：切换明暗保持当前色板不变（色板与明暗正交）", async () => {
    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    const themeButton = document.createElement("button");
    themeButton.id = ids.readingThemeSelect;
    readingView.appendChild(themeButton);
    const closeBtn = document.createElement("button");
    closeBtn.id = ids.readingCloseBtn;
    readingView.appendChild(closeBtn);

    presentation.hydrateReaderStateFromSettings({
      readerTheme: "light",
      readerThemeUserSet: true,
      readerPalette: "editorial"
    });
    presentation.applyReadingViewPresentation();
    expect(readingView.dataset.palette).toBe("editorial");

    const uiRenderer = await import("../../extension/ui/ui-renderer.js");
    uiRenderer.bindUiEvents();

    themeButton.click();
    await vi.waitFor(() => {
      expect(state.reader.readingTheme).toBe("dark");
    });
    // 明暗已切、色板不动：三处 palette 属性保持 editorial
    expect(readingView.dataset.palette).toBe("editorial");
    expect(document.documentElement.dataset.biliscriptReaderPalette).toBe("editorial");
    expect(document.body.dataset.biliscriptReaderPalette).toBe("editorial");
    // 明暗照常落位
    expect(readingView.dataset.theme).toBe("dark");
  });

  it("settings 变更后：storage.onChanged 回调应用新主题", async () => {
    initEssentials.bindSettingsWatcher();
    const listener = chromeStub.storage.onChanged.addListener.mock.calls[0][0];

    // 让 getSettings 返回指定设置（init-essentials.js 内部经 runtime.getSettings -> chrome.runtime.sendMessage）
    chromeStub.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message?.type === "get-settings") {
        callback?.({
          ok: true,
          settings: {
            readerTheme: "dark",
            readerThemeUserSet: true
          }
        });
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    });

    // 候选03：设置变更只在阅读视图打开时才应用呈现层。
    state.reader.setViewOpen(true);

    listener(
      { readerTheme: { newValue: "dark" } },
      "sync"
    );
    await vi.waitFor(() => {
      expect(state.reader.readingTheme).toBe("dark");
    });

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    await vi.waitFor(() => {
      expect(readingView.dataset.theme).toBe("dark");
    });
  });

  it("settings 变更后：双语两键（表内 settings 档）同样被主 watcher 收敛", async () => {
    initEssentials.bindSettingsWatcher();
    const listener = chromeStub.storage.onChanged.addListener.mock.calls[0][0];

    chromeStub.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message?.type === "get-settings") {
        callback?.({ ok: true, settings: { bilingualSubtitles: true, secondarySubtitleLang: "ja-JP" } });
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    });

    listener({ bilingualSubtitles: { oldValue: false, newValue: true } }, "sync");

    await vi.waitFor(() => {
      expect(state.settings.bilingualSubtitles).toBe(true);
      expect(state.settings.secondarySubtitleLang).toBe("ja-JP");
    });
  });

  it("settings 变更后：readerPalette 跨标签页修改同步到三处 palette 属性", async () => {
    initEssentials.bindSettingsWatcher();
    const listener = chromeStub.storage.onChanged.addListener.mock.calls[0][0];

    chromeStub.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message?.type === "get-settings") {
        callback?.({
          ok: true,
          settings: {
            readerTheme: "light",
            readerThemeUserSet: true,
            readerPalette: "editorial"
          }
        });
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    });

    state.reader.setViewOpen(true);

    listener({ readerPalette: { newValue: "editorial" } }, "sync");

    const readingView = document.getElementById(ids.readingView) as HTMLElement;
    await vi.waitFor(() => {
      expect(state.reader.readingPalette).toBe("editorial");
      expect(readingView.dataset.palette).toBe("editorial");
      expect(document.documentElement.dataset.biliscriptReaderPalette).toBe("editorial");
      expect(document.body.dataset.biliscriptReaderPalette).toBe("editorial");
    });
    // 明暗不被色板存储变更带动（正交）
    expect(state.reader.readingTheme).toBe("light");
  });
});

// 明暗一轴：readerTheme 只存明暗（light | dark），色板是另一根正交轴
//（readerPalette flyme | editorial，设置抽屉「外观」分区选择）。本 describe 守：
// 水合只落明暗（退役三值制值收敛 light）、apply 只写 data-theme、抽屉不渲染
// 主题族选择项、色板选择项随保存载荷落盘 readerPalette。
describe("主题：只剩明暗一轴", () => {
  it("hydrateReaderStateFromSettings：明暗落位，退役三值制值收敛 light", () => {
    presentation.hydrateReaderStateFromSettings({
      readerTheme: "dark",
      readerThemeUserSet: true
    } as unknown as Partial<typeof state.settings>);
    expect(state.reader.readingTheme).toBe("dark");

    presentation.hydrateReaderStateFromSettings({
      readerTheme: "flyme",
      readerThemeUserSet: true
    } as unknown as Partial<typeof state.settings>);
    expect(state.reader.readingTheme).toBe("light");
  });

  it("applyReadingViewPresentation：只写 data-theme，三处都不落 family 属性", () => {
    const readingView = document.getElementById(ids.readingView) as HTMLElement;

    presentation.applyReadingViewPresentation();
    expect(readingView.dataset.theme).toBeDefined();
    expect(readingView.dataset.family).toBeUndefined();
    expect(document.documentElement.dataset.biliscriptReaderFamily).toBeUndefined();
    expect(document.body.dataset.biliscriptReaderFamily).toBeUndefined();

    presentation.hydrateReaderStateFromSettings({
      readerTheme: "dark",
      readerThemeUserSet: true,
      readerThemeFamily: "bilibili"
    } as unknown as Partial<typeof state.settings>);
    presentation.applyReadingViewPresentation();
    // 明暗照常落位；存量 family 键被忽略，无属性落位
    expect(readingView.dataset.theme).toBe("dark");
    expect(readingView.dataset.family).toBeUndefined();
    expect(document.documentElement.dataset.biliscriptReaderFamily).toBeUndefined();
    expect(document.body.dataset.biliscriptReaderFamily).toBeUndefined();
  });

  it("updateReaderPreferences：切换明暗时 readerTheme 落 state.settings", () => {
    state.setSettings({ ...state.settings, readerTheme: "light" });
    lifecycle.updateReaderPreferences({ readerTheme: "dark" }, { persist: false });
    expect(state.settings.readerTheme).toBe("dark");
  });

  it("设置抽屉：外观分区提供色板选择项，保存载荷落盘归一后的 readerPalette", async () => {
    state.reader.setViewOpen(true);

    const sentTypes: string[] = [];
    let saveSettingsPayload: Record<string, unknown> | null = null;
    chromeStub.runtime.sendMessage.mockImplementation((message, callback) => {
      sentTypes.push(String(message?.type || ""));
      if (message?.type === "get-settings") {
        // 存量数据里仍可能残留已删除的 family 键：面板照常装载，不读它
        callback?.({
          ok: true,
          settings: {
            readerTheme: "light",
            readerThemeUserSet: true,
            readerThemeFamily: "bilibili",
            readerPalette: "editorial"
          }
        });
        return undefined;
      }
      if (message?.type === "save-settings") {
        saveSettingsPayload = message.settings as Record<string, unknown>;
        callback?.({ ok: true });
        return undefined;
      }
      if (message?.type === "ai-presets-list" || message?.type === "asr-presets-list") {
        callback?.({ ok: false });
        return undefined;
      }
      if (
        message?.type === "ai-providers-list" ||
        message?.type === "asr-providers-list" ||
        message?.type === "search-providers-list"
      ) {
        callback?.({ ok: true, providers: [] });
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    });

    const panel = await import("../../extension/ui/settings-panel.js");
    panel.renderReaderSettingsPanel();
    // 等面板装载链走完（末路 search-providers-list），避免与保存竞态
    await vi.waitFor(() => {
      expect(sentTypes).toContain("search-providers-list");
    });

    // 外观分区在场：色板下拉两档（flyme 默认 / editorial），装载显示存储值
    const groups = [...document.querySelectorAll<HTMLElement>(".biliscript-set-group")];
    const appearance = groups.find(
      (group) => group.querySelector(".biliscript-set-h")?.textContent?.startsWith("外观")
    );
    expect(appearance, "外观分区应存在").toBeTruthy();
    const paletteSelect = appearance!.querySelector<HTMLSelectElement>("#readerPalette")!;
    expect(paletteSelect).toBeTruthy();
    expect([...paletteSelect.options].map((option) => option.value)).toEqual([
      "flyme",
      "editorial"
    ]);
    expect(paletteSelect.value).toBe("editorial");

    // 改选 flyme 后即时保存：载荷带归一后的 readerPalette（无保存按钮）
    paletteSelect.value = "flyme";
    paletteSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.getElementById("biliscriptSettingsSaveBtn")).toBeNull();
    await vi.waitFor(() => {
      expect(saveSettingsPayload).not.toBeNull();
    });
    expect(saveSettingsPayload).toHaveProperty("readerPalette", "flyme");
    // 主题族早已退役：渲染与载荷都不复活
    expect(document.getElementById("readerThemeFamily")).toBeNull();
    expect(saveSettingsPayload).not.toHaveProperty("readerThemeFamily");
  });

  it("设置抽屉：色板存量值非法时装载归一回落 flyme", async () => {
    state.reader.setViewOpen(true);

    const sentTypes: string[] = [];
    chromeStub.runtime.sendMessage.mockImplementation((message, callback) => {
      sentTypes.push(String(message?.type || ""));
      if (message?.type === "get-settings") {
        callback?.({ ok: true, settings: { readerPalette: "neon" } });
        return undefined;
      }
      if (message?.type === "ai-presets-list" || message?.type === "asr-presets-list") {
        callback?.({ ok: false });
        return undefined;
      }
      if (
        message?.type === "ai-providers-list" ||
        message?.type === "asr-providers-list" ||
        message?.type === "search-providers-list"
      ) {
        callback?.({ ok: true, providers: [] });
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    });

    const panel = await import("../../extension/ui/settings-panel.js");
    panel.renderReaderSettingsPanel();
    await vi.waitFor(() => {
      expect(sentTypes).toContain("search-providers-list");
    });

    const paletteSelect = document.querySelector<HTMLSelectElement>("#readerPalette")!;
    expect(paletteSelect.value).toBe("flyme");
  });
  it("设置抽屉：文摘排版滑块与重置键渲染、滑动即时预览与重置恢复", async () => {
    state.reader.setViewOpen(true);

    const sentMessages: any[] = [];
    chromeStub.runtime.sendMessage.mockImplementation((message, callback) => {
      sentMessages.push(message);
      if (message?.type === "get-settings") {
        callback?.({
          ok: true,
          settings: {
            readerFontSizeScale: 110,
            chatLineHeight: 180,
            chatParagraphSpacing: 16
          }
        });
        return undefined;
      }
      if (
        message?.type === "ai-providers-list" ||
        message?.type === "asr-providers-list" ||
        message?.type === "search-providers-list"
      ) {
        callback?.({ ok: true, providers: [] });
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    });

    const panel = await import("../../extension/ui/settings-panel.js");
    panel.renderReaderSettingsPanel();
    await vi.waitFor(() => {
      expect(sentMessages.map((m: any) => m.type)).toContain("search-providers-list");
    });

    const fontSlider = document.getElementById("readerFontSizeScale") as HTMLInputElement;
    const fontBadge = document.getElementById("readerFontSizeScaleValue") as HTMLElement;
    const fontReset = document.getElementById("readerFontSizeScaleResetBtn") as HTMLButtonElement;

    const lineSlider = document.getElementById("chatLineHeight") as HTMLInputElement;
    const lineBadge = document.getElementById("chatLineHeightValue") as HTMLElement;
    const lineReset = document.getElementById("chatLineHeightResetBtn") as HTMLButtonElement;

    const paraSlider = document.getElementById("chatParagraphSpacing") as HTMLInputElement;
    const paraBadge = document.getElementById("chatParagraphSpacingValue") as HTMLElement;
    const paraReset = document.getElementById("chatParagraphSpacingResetBtn") as HTMLButtonElement;

    
    expect(fontSlider).toBeTruthy();
    expect(fontSlider.value).toBe("110");
    expect(fontBadge.textContent).toBe("110%");
    expect(fontReset.disabled).toBe(false);

    expect(lineSlider.value).toBe("180");
    expect(lineBadge.textContent).toBe("180%");
    expect(lineReset.disabled).toBe(false);

    expect(paraSlider.value).toBe("16");
    expect(paraBadge.textContent).toBe("16px");
    expect(paraReset.disabled).toBe(false);

    // 滑动触发 input：即时更新 badge 与 CSS 变量
    fontSlider.value = "120";
    fontSlider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(fontBadge.textContent).toBe("120%");
    expect(document.getElementById("biliscript-reading-view")?.style.getPropertyValue("--biliscript-reader-font-scale")).toBe("1.2");

    // 点击重置键：恢复到 100%，重置键置灰，CSS 变量同步恢复
    fontReset.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(fontSlider.value).toBe("100");
    expect(fontBadge.textContent).toBe("100%");
    expect(fontReset.disabled).toBe(true);
    expect(document.getElementById("biliscript-reading-view")?.style.getPropertyValue("--biliscript-reader-font-scale")).toBe("1");
    expect(sentMessages).toContainEqual({
      type: "save-settings",
      settings: { readerFontSizeScale: 100 }
    });

    // 文摘面板宽度滑块与重置键测试
    const widthSlider = document.getElementById("customPanelWidth") as HTMLInputElement;
    const widthBadge = document.getElementById("customPanelWidthValue") as HTMLElement;
    const widthReset = document.getElementById("customPanelWidthResetBtn") as HTMLButtonElement;
    expect(widthSlider).toBeTruthy();
    expect(widthSlider.value).toBe("520");
    expect(widthBadge.textContent).toBe("520px");
    expect(widthReset.disabled).toBe(true);

    widthSlider.value = "450";
    widthSlider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(widthBadge.textContent).toBe("450px");
    expect(widthReset.disabled).toBe(false);

    widthReset.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(widthSlider.value).toBe("520");
    expect(widthBadge.textContent).toBe("520px");
    expect(widthReset.disabled).toBe(true);
    expect(sentMessages).toContainEqual({
      type: "save-settings",
      settings: { customPanelWidth: 520 }
    });

    // 单轮搜索次数上限滑块与重置键测试（默认 5，最小 1，最大 20）
    const searchSlider = document.getElementById("webSearchMaxToolCalls") as HTMLInputElement;
    const searchBadge = document.getElementById("webSearchMaxToolCallsValue") as HTMLElement;
    const searchReset = document.getElementById("webSearchMaxToolCallsResetBtn") as HTMLButtonElement;
    expect(searchSlider).toBeTruthy();
    expect(searchSlider.type).toBe("range");
    expect(searchSlider.min).toBe("1");
    expect(searchSlider.max).toBe("20");
    expect(searchSlider.value).toBe("5");
    expect(searchBadge.textContent).toBe("5");
    expect(searchReset.disabled).toBe(true);

    searchSlider.value = "12";
    searchSlider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(searchBadge.textContent).toBe("12");
    expect(searchReset.disabled).toBe(false);

    searchReset.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(searchSlider.value).toBe("5");
    expect(searchBadge.textContent).toBe("5");
    expect(searchReset.disabled).toBe(true);
    expect(sentMessages).toContainEqual({
      type: "save-settings",
      settings: { webSearchMaxToolCalls: 5 }
    });
  });
});
