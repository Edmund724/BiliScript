// 设置变更测试：主题
// 通过 hydrateReaderStateFromSettings 与 updateReaderPreferences 驱动，
// 校验 data-attribute 在阅读视图、documentElement、body 三处的应用。
//（script-only-ui：排版档位机制退役，字号/字距/行距/面板宽度不再可调，
// 相关字段与 data-attribute 一并移除；三开关退役后章节/字幕可见性设置项
// 与 data-attribute 也随之删除，设置只剩主题。）

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
  // 模拟 content.js 的接线：reader 域经 reader-bus seam 持久化/读取设置，
  // 底层仍是 chrome.runtime.sendMessage（tests/setup.ts 的 stub）。
  presenter.subscribeReaderSettingsPersist(() => {
    chromeStub.runtime.sendMessage(
      { type: "save-settings", settings: state.settings },
      () => {}
    );
  });
  presenter.subscribeReaderSettingsLoad(() =>
    new Promise<Record<string, unknown>>((resolve) => {
      chromeStub.runtime.sendMessage({ type: "get-settings" }, (resp: { ok: boolean; settings?: Record<string, unknown> }) => {
        resolve(resp?.ok ? { ...(resp.settings || {}) } : {});
      });
    })
  );
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
  it("hydrateReaderStateFromSettings：应用主题设置（三开关退役后只剩主题）", () => {
    presentation.hydrateReaderStateFromSettings({
      readerTheme: "dark",
      readerThemeUserSet: true
    });

    expect(state.reader.readingTheme).toBe("dark");
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
});

// 主题只剩明暗一轴（readerTheme light | dark）：色板恒 flyme，主题族设置与
// data-family 属性已删除。本 describe 守：水合只落明暗（退役三值制值收敛
// light）、apply 只写 data-theme、设置抽屉不再提供主题选择项。
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

  it("设置抽屉：不渲染主题选择项，保存载荷也不含 readerThemeFamily", async () => {
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
            readerThemeFamily: "bilibili"
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

    expect(document.getElementById("readerThemeFamily")).toBeNull();
    const groups = [...document.querySelectorAll<HTMLElement>(".biliscript-set-group")];
    expect(
      groups.some((group) => group.querySelector(".biliscript-set-h")?.textContent === "外观"),
      "外观分区应随主题选择项一并移除"
    ).toBe(false);

    const saveBtn = document.getElementById("biliscriptSettingsSaveBtn") as HTMLButtonElement;
    saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(saveSettingsPayload).not.toBeNull();
    });
    expect(saveSettingsPayload).not.toHaveProperty("readerThemeFamily");
  });
});
