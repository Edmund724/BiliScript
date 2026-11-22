import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const mocks = vi.hoisted(() => ({
  openLiveSettings: vi.fn(async () => {}),
  openAppearanceSettings: vi.fn(async () => {}),
  openNoteExportSettings: vi.fn(async () => {}),
  renderReaderSettingsPanel: vi.fn(async () => {})
}));

vi.mock("../../extension/ui/settings-panel.js", () => ({
  openLiveSettings: mocks.openLiveSettings,
  openAppearanceSettings: mocks.openAppearanceSettings,
  openNoteExportSettings: mocks.openNoteExportSettings,
  renderReaderSettingsPanel: mocks.renderReaderSettingsPanel
}));

describe("ui-renderer：open-settings 目标页分发与错误日志留痕", () => {
  beforeEach(() => {
    resetModuleState();
    document.body.innerHTML = "";
    mocks.openLiveSettings.mockReset().mockResolvedValue(undefined);
    mocks.openAppearanceSettings.mockReset().mockResolvedValue(undefined);
    mocks.openNoteExportSettings.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("统一分发 live / gemini-key / appearance / note-export 目标设置页", async () => {
    const { registerDebugGate } = await import("../../extension/shared/logging.js");
    registerDebugGate(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await import("../../extension/ui/ui-renderer.js");
    const readerBus = await import("../../extension/reader/reader-bus.js");

    readerBus.requestUiCommand("open-settings", { target: "live" });
    await vi.waitFor(() => {
      expect(mocks.openLiveSettings).toHaveBeenCalledWith("live");
    });

    readerBus.requestUiCommand("open-settings", { target: "gemini-key" });
    await vi.waitFor(() => {
      expect(mocks.openLiveSettings).toHaveBeenCalledWith("gemini-key");
    });

    readerBus.requestUiCommand("open-settings", { target: "appearance" });
    await vi.waitFor(() => {
      expect(mocks.openAppearanceSettings).toHaveBeenCalledTimes(1);
    });

    readerBus.requestUiCommand("open-settings", { target: "note-export" });
    await vi.waitFor(() => {
      expect(mocks.openNoteExportSettings).toHaveBeenCalledTimes(1);
    });
    expect(warnSpy.mock.calls).toEqual([]);
  });

  it("目标设置页打开失败时通过 logWarn 记录错误而非静默吞掉", async () => {
    const { registerDebugGate } = await import("../../extension/shared/logging.js");
    registerDebugGate(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const targetError = new Error("open appearance failed");
    mocks.openAppearanceSettings.mockRejectedValueOnce(targetError);

    await import("../../extension/ui/ui-renderer.js");
    const readerBus = await import("../../extension/reader/reader-bus.js");
    readerBus.requestUiCommand("open-settings", { target: "appearance" });

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith("[BILISCRIPT] open settings target failed", {
        target: "appearance",
        error: targetError
      });
    });
  });
});
