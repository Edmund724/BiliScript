import { beforeEach, describe, expect, it, vi } from "vitest";
import { installSettingsPanelBus, type BusResponder } from "../helpers/settings-panel-bus.js";
import { resetSettingsPanelState } from "../helpers/reset-settings-panel-state.js";
import {
  openShortcutsSettings,
  renderReaderSettingsPanel
} from "../../extension/ui/settings-panel.js";
import { state, transitionReaderShell } from "../../extension/core/state.js";
import {
  isShortcutRecordingActive,
  setShortcutRecordingActive
} from "../../extension/shared/shortcuts.js";
import { resolveCommandPaletteItems } from "../../extension/reader/command-palette.js";
import { ensureUiReady } from "../../extension/ui/ui-renderer.js";

const mockReader = {
  toggleCommandPalette: vi.fn(),
  updateReaderPreferences: vi.fn(),
  renderReaderPanels: vi.fn(),
  triggerReaderOverviewGeneration: vi.fn()
};

vi.mock("../../extension/ui/reader-gate.js", () => ({
  withReader: (_label: string | null, fn: (reader: typeof mockReader) => void) => {
    fn(mockReader);
  }
}));

beforeEach(() => {
  resetSettingsPanelState();
  setShortcutRecordingActive(false);
  mockReader.toggleCommandPalette.mockClear();
  mockReader.updateReaderPreferences.mockClear();
  mockReader.renderReaderPanels.mockClear();
  mockReader.triggerReaderOverviewGeneration.mockClear();
});

async function mountSettingsHost(overrides: Record<string, BusResponder> = {}): Promise<{
  host: HTMLElement;
  savedPayloads: Array<Record<string, unknown>>;
}> {
  const savedPayloads: Array<Record<string, unknown>> = [];
  document.body.innerHTML = `
    <div id="biliscript-reading-view">
      <section id="biliscript-reading-settings-panel">
        <section class="biliscript-reading-settings-group biliscript-reading-settings-extension">
          <div id="biliscript-reading-settings-host"></div>
        </section>
      </section>
    </div>
  `;
  installSettingsPanelBus({
    "save-settings": (message: unknown) => {
      const payload = ((message as { settings?: Record<string, unknown> })?.settings || {}) as Record<string, unknown>;
      savedPayloads.push(payload);
      return { ok: true };
    },
    ...overrides
  });
  await renderReaderSettingsPanel();
  const host = document.getElementById("biliscript-reading-settings-host")!;
  return { host, savedPayloads };
}

describe("设置页快捷键子页与录制交互", () => {
  it("渲染全部 11 项快捷键、支持录制保存、冲突拦截、非法单键拦截、清空与重置", async () => {
    const { host, savedPayloads } = await mountSettingsHost();
    const summary = host.querySelector<HTMLElement>("#shortcutsSettingsSummary")!;
    const status = host.querySelector<HTMLElement>("#biliscriptSettingsStatus")!;
    const resetAllBtn = host.querySelector<HTMLButtonElement>("#shortcutsResetAllBtn")!;
    const overviewHint = host.querySelector<HTMLElement>("#overviewShortcutHint")!;

    expect(summary.textContent?.trim()).toBe("");
    expect(resetAllBtn.hidden).toBe(true);
    expect(overviewHint.textContent).toContain("Alt+G");

    await openShortcutsSettings();
    const subpage = host.querySelector<HTMLElement>("#biliscriptSettingsSubpageShortcuts")!;
    expect(subpage.hidden).toBe(false);
    expect(subpage.querySelectorAll("[data-shortcut-record]")).toHaveLength(11);

    const openSettingsBtn = subpage.querySelector<HTMLButtonElement>('[data-shortcut-record="openSettings"]')!;
    expect(openSettingsBtn.dataset.empty).toBe("1");
    expect(openSettingsBtn.textContent?.trim()).toBe("未设置");

    openSettingsBtn.click();
    expect(openSettingsBtn.getAttribute("aria-pressed")).toBe("true");
    expect(openSettingsBtn.dataset.recording).toBe("1");
    expect(isShortcutRecordingActive()).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "o", code: "KeyO", bubbles: true, cancelable: true }));
    expect(status.textContent).toContain("Ctrl / Alt / ⌘");
    expect(isShortcutRecordingActive()).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "g", code: "KeyG", altKey: true, bubbles: true, cancelable: true }));
    expect(status.textContent).toContain("展开并生成视频概览");
    expect(isShortcutRecordingActive()).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    expect(isShortcutRecordingActive()).toBe(false);
    expect(subpage.hidden).toBe(false);
    expect(savedPayloads).toHaveLength(0);

    openSettingsBtn.click();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", code: "KeyS", altKey: true, shiftKey: true, bubbles: true, cancelable: true })
    );
    await vi.waitFor(() => expect(savedPayloads).toHaveLength(1));
    expect(savedPayloads[0]).toEqual({ shortcuts: { openSettings: "Alt+Shift+S" } });
    expect(summary.textContent?.trim()).toBe("已自定义 1 项");
    expect(resetAllBtn.hidden).toBe(false);
    expect(openSettingsBtn.querySelectorAll(".biliscript-shortcut-kbd").length).toBe(3);
    expect(openSettingsBtn.textContent).toBe("Alt+Shift+S");

    const overviewBtn = subpage.querySelector<HTMLButtonElement>('[data-shortcut-record="generateOverview"]')!;
    const overviewClearBtn = subpage.querySelector<HTMLButtonElement>('[data-shortcut-clear="generateOverview"]')!;
    expect(overviewClearBtn.hidden).toBe(false);
    overviewBtn.click();
    expect(overviewClearBtn.hidden).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(savedPayloads).toHaveLength(2));
    expect(savedPayloads[1]).toEqual({
      shortcuts: {
        generateOverview: "",
        openSettings: "Alt+Shift+S"
      }
    });
    expect(overviewHint.hidden).toBe(true);
    expect(summary.textContent?.trim()).toBe("已自定义 2 项");

    const openSettingsClearBtn = subpage.querySelector<HTMLButtonElement>('[data-shortcut-clear="openSettings"]')!;
    expect(openSettingsClearBtn.hidden).toBe(false);
    openSettingsClearBtn.click();
    await vi.waitFor(() => expect(savedPayloads).toHaveLength(3));
    expect(savedPayloads[2]).toEqual({ shortcuts: { generateOverview: "" } });

    const overviewResetBtn = subpage.querySelector<HTMLButtonElement>('[data-shortcut-reset="generateOverview"]')!;
    expect(overviewResetBtn.hidden).toBe(false);
    overviewResetBtn.click();
    await vi.waitFor(() => expect(savedPayloads).toHaveLength(4));
    expect(savedPayloads[3]).toEqual({ shortcuts: {} });
    expect(overviewHint.hidden).toBe(false);
    expect(resetAllBtn.hidden).toBe(true);
    expect(summary.textContent?.trim()).toBe("");
  });

  it("单项恢复默认遇到冲突时拦截，全部恢复默认一键清空全部覆写", async () => {
    const { host, savedPayloads } = await mountSettingsHost({
      "get-settings": () => ({
        ok: true,
        settings: {
          shortcuts: {
            toggleReader: "Alt+S",
            openSettings: "Alt+B"
          }
        }
      })
    });
    const status = host.querySelector<HTMLElement>("#biliscriptSettingsStatus")!;
    const resetAllBtn = host.querySelector<HTMLButtonElement>("#shortcutsResetAllBtn")!;
    await openShortcutsSettings();

    const subpage = host.querySelector<HTMLElement>("#biliscriptSettingsSubpageShortcuts")!;
    const toggleResetBtn = subpage.querySelector<HTMLButtonElement>('[data-shortcut-reset="toggleReader"]')!;
    toggleResetBtn.click();
    expect(status.textContent).toContain("打开或关闭设置");
    expect(savedPayloads).toHaveLength(0);

    resetAllBtn.click();
    await vi.waitFor(() => expect(savedPayloads).toHaveLength(1));
    expect(savedPayloads[0]).toEqual({ shortcuts: {} });
    expect(resetAllBtn.hidden).toBe(true);
  });
});

describe("自定义快捷键执行与命令面板徽标同步", () => {
  it("阅读器响应自定义命令面板与主题快捷键，录制期间不误触发，命令面板徽标同步更新", () => {
    ensureUiReady({ forceRecreate: true });
    transitionReaderShell("open");
    state.patchSettings({
      shortcuts: {
        commandPalette: "Alt+P",
        toggleTheme: "Alt+T",
        copyNote: "Alt+Shift+C"
      }
    });

    const paletteItems = resolveCommandPaletteItems("");
    const copyCmd = paletteItems.find((item) => item.id === "note-copy");
    const themeCmd = paletteItems.find((item) => item.id === "toggle-theme");
    expect(copyCmd?.kbd).toEqual(["Alt", "Shift", "C"]);
    expect(themeCmd?.kbd).toEqual(["Alt", "T"]);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(mockReader.toggleCommandPalette).not.toHaveBeenCalled();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "p", code: "KeyP", altKey: true, bubbles: true, cancelable: true }));
    expect(mockReader.toggleCommandPalette).toHaveBeenCalledTimes(1);

    setShortcutRecordingActive(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", code: "KeyT", altKey: true, bubbles: true, cancelable: true }));
    expect(mockReader.updateReaderPreferences).not.toHaveBeenCalled();

    setShortcutRecordingActive(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", code: "KeyT", altKey: true, bubbles: true, cancelable: true }));
    expect(mockReader.updateReaderPreferences).toHaveBeenCalledTimes(1);
  });
});
