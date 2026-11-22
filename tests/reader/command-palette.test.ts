import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { state, clipState, transitionReaderShell } from "../../extension/core/state.js";
import {
  closeCommandPalette,
  isCommandPaletteOpen,
  openCommandPalette,
  parseTimestampQuery,
  resolveCommandPaletteItems,
  scoreFuzzyMatch
} from "../../extension/reader/command-palette.js";
import { ids } from "../../extension/reader/state.js";

const mockJump = vi.fn((..._args: unknown[]) => {});
const mockActivateTab = vi.fn(async (..._args: unknown[]) => {});
const mockUiCommand = vi.fn((..._args: unknown[]) => {});
const mockSendRuntime = vi.fn(async (..._args: unknown[]) => ({ ok: true }));

vi.mock("../../extension/reader/sync.js", () => ({
  jumpReadingTarget: (...args: unknown[]) => mockJump(...args)
}));

vi.mock("../../extension/reader/script-tab-activation.js", () => ({
  activateScriptTab: (...args: unknown[]) => mockActivateTab(...args)
}));

vi.mock("../../extension/reader/reader-bus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/reader/reader-bus.js")>();
  return {
    ...actual,
    requestUiCommand: (...args: unknown[]) => mockUiCommand(...args)
  };
});

vi.mock("../../extension/shared/messaging.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/shared/messaging.js")>();
  return {
    ...actual,
    sendRuntimeMessage: (...args: unknown[]) => mockSendRuntime(...args)
  };
});

describe("command-palette 纯函数：模糊匹配与时间戳解析", () => {
  it("parseTimestampQuery 支持 MM:SS / HH:MM:SS / Ns 格式并拒绝非法值", () => {
    expect(parseTimestampQuery("3:15")).toBe(195);
    expect(parseTimestampQuery("01:02:03")).toBe(3723);
    expect(parseTimestampQuery("95s")).toBe(95);
    expect(parseTimestampQuery("2:75")).toBeNull();
    expect(parseTimestampQuery("hello")).toBeNull();
  });

  it("scoreFuzzyMatch 连续子串高于子序列且大小写不敏感", () => {
    const direct = scoreFuzzyMatch("obs", "写入 Obsidian 笔记");
    const subseq = scoreFuzzyMatch("odn", "写入 Obsidian 笔记");
    const miss = scoreFuzzyMatch("xyz", "写入 Obsidian 笔记");
    expect(direct).toBeGreaterThan(subseq);
    expect(subseq).toBeGreaterThan(0);
    expect(miss).toBe(0);
  });
});

describe("command-palette 交互与高频动作", () => {
  beforeEach(() => {
    resetModuleState();
    closeCommandPalette();
    mockJump.mockClear();
    mockActivateTab.mockClear();
    mockUiCommand.mockClear();
    mockSendRuntime.mockClear();
    document.body.innerHTML = `<section id="${ids.readingView}"></section>`;
    transitionReaderShell("open");
    clipState.setSubtitleBody([
      { from: 10, to: 15, content: "开场介绍项目背景" },
      { from: 140, to: 148, content: "演示 Obsidian 模板导出工作流" }
    ]);
    clipState.setChapters([{ title: "核心演示", from: 120 }]);
  });

  it("打开命令面板渲染分组菜单与紧凑 <kbd> 提示，支持上下键移动与 Esc 关闭", () => {
    openCommandPalette();
    expect(isCommandPaletteOpen()).toBe(true);

    const dialog = document.getElementById("biliscript-command-palette") as HTMLDialogElement;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelectorAll(".biliscript-cmd-kbd").length).toBeGreaterThan(0);

    const input = dialog.querySelector<HTMLInputElement>(".biliscript-cmd-input")!;
    const items = dialog.querySelectorAll<HTMLButtonElement>(".biliscript-cmd-item");
    expect(items[0].classList.contains("is-active")).toBe(true);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(items[1].classList.contains("is-active")).toBe(true);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(items[0].classList.contains("is-active")).toBe(true);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isCommandPaletteOpen()).toBe(false);
  });

  it("输入时间戳或字幕关键词可直接跳转指定字幕，输入设置可打开设置", async () => {
    openCommandPalette();
    const dialog = document.getElementById("biliscript-command-palette") as HTMLDialogElement;
    const input = dialog.querySelector<HTMLInputElement>(".biliscript-cmd-input")!;

    input.value = "02:20";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => expect(mockJump).toHaveBeenCalledWith(140));
    expect(mockActivateTab).toHaveBeenCalledWith("subtitle", { consumeIntent: false });
    expect(isCommandPaletteOpen()).toBe(false);

    openCommandPalette();
    input.value = "高强度";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const highItems = resolveCommandPaletteItems("高强度");
    expect(highItems.some((item) => item.id === "thinking-high")).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => {
      expect(mockSendRuntime).toHaveBeenCalledWith({
        type: "save-settings",
        settings: { aiThinkingLevel: "high" }
      });
    });

    closeCommandPalette();
    openCommandPalette();
    input.value = "打开设置";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => {
      expect(mockUiCommand).toHaveBeenCalledWith("open-settings");
    });
  });
});
