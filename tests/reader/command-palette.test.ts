import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { state, clipState, transitionReaderShell } from "../../extension/core/state.js";
import {
  chatSessionStateForTests,
  resetChatSessionStateForTests
} from "../../extension/chat/chat-state.js";
import {
  captureLiveClipSignature,
  clearSessionNoteRecords,
  recordSessionNoteReply,
  resolveCurrentClipContextKey
} from "../../extension/notes/session-note-state.js";
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
const mockRunVideoNotePrompt = vi.fn(async () => true);

vi.mock("../../extension/reader/lazy-chat-tab.js", () => ({
  isReaderChatTabLoaded: () => false,
  ensureReaderChatTab: vi.fn(async () => ({
    runVideoNotePrompt: mockRunVideoNotePrompt
  }))
}));

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
    resetChatSessionStateForTests();
    clearSessionNoteRecords();
    closeCommandPalette();
    mockJump.mockClear();
    mockActivateTab.mockClear();
    mockUiCommand.mockClear();
    mockSendRuntime.mockReset();
    mockSendRuntime.mockResolvedValue({ ok: true });
    mockRunVideoNotePrompt.mockClear();
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

  it("命令面板包含「生成视频笔记」命令，执行后切至 AI 对话并按当前预设生成笔记", async () => {
    const matched = resolveCommandPaletteItems("生成视频笔记");
    expect(matched.some((item) => item.id === "note-generate")).toBe(true);

    openCommandPalette();
    const dialog = document.getElementById("biliscript-command-palette") as HTMLDialogElement;
    const input = dialog.querySelector<HTMLInputElement>(".biliscript-cmd-input")!;
    input.value = "生成视频笔记";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => expect(mockRunVideoNotePrompt).toHaveBeenCalledTimes(1));
    expect(mockActivateTab).toHaveBeenCalledWith("chat", { consumeIntent: false });
  });

  it("note-download 与 note-obsidian 通过 dispatchNoteExport 携带会话笔记、时间戳深链、关键帧与下载子目录", async () => {
    const clip = state.clip as unknown as {
      site: "bilibili" | "youtube";
      title: string;
      bvid: string;
      cid: string;
      currentUrl: string;
      currentClipSignature: string;
    };
    clip.site = "bilibili";
    clip.title = "命令面板导出测试";
    clip.bvid = "BV1cmdexp001";
    clip.cid = "556677";
    clip.currentUrl = "https://www.bilibili.com/video/BV1cmdexp001/?p=2";
    clip.currentClipSignature = "BV1cmdexp001|556677";

    recordSessionNoteReply({
      clipSignature: captureLiveClipSignature(),
      contextKey: resolveCurrentClipContextKey(),
      markdown: "<think>内部思考</think>\n核心流程见 [02:20]。\n\n{{frame:02:20 | 核心流程}}",
      capturedFrames: [{ seconds: 140, dataUrl: "data:image/jpeg;base64,AQIDBA==" }],
      isVideoNote: true
    });

    const downloadMessages: Array<{ type: string; subdir?: string; markdown?: string }> = [];
    mockSendRuntime.mockImplementation(async (raw: unknown) => {
      const msg = raw as { type: string; subdir?: string; markdown?: string };
      if (msg.type === "get-settings") {
        return {
          ok: true,
          settings: {
            ...DEFAULT_SETTINGS,
            noteExportTarget: "obsidian",
            noteDownloadSubdir: "CmdNotes",
            obsidianVaultName: "CmdVault",
            obsidianFolder: "Videos",
            noteIncludeKeyframes: false
          }
        };
      }
      if (msg.type === "download-note-artifact") {
        downloadMessages.push(msg);
        return { ok: true, downloadId: 91 };
      }
      return { ok: true };
    });

    const clickedHrefs: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedHrefs.push(this.href);
      });
    const clipboardWriteText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboardWriteText },
      configurable: true
    });

    try {
      const copyItem = resolveCommandPaletteItems("复制模板笔记").find((item) => item.id === "note-copy")!;
      const copyNotice = await copyItem.run();
      expect(copyNotice).toBe("已复制模板笔记");
      expect(clipboardWriteText).toHaveBeenCalledTimes(1);
      expect(clipboardWriteText.mock.calls[0][0]).toContain("核心流程见 [02:20]。");
      expect(clipboardWriteText.mock.calls[0][0]).not.toContain("内部思考");

      const downloadItem = resolveCommandPaletteItems("下载 Markdown").find((item) => item.id === "note-download")!;
      const downloadNotice = await downloadItem.run();
      expect(downloadNotice).toBe("已导出 Markdown 文件");
      expect(downloadMessages).toHaveLength(1);
      expect(downloadMessages[0].subdir).toBe("CmdNotes");
      expect(downloadMessages[0].markdown).not.toContain("内部思考");
      expect(downloadMessages[0].markdown).toContain(
        "[02:20](https://www.bilibili.com/video/BV1cmdexp001/?p=2&t=140)"
      );
      expect(downloadMessages[0].markdown).toContain(
        "*▲ [02:20](https://www.bilibili.com/video/BV1cmdexp001/?p=2&t=140) 核心流程*"
      );

      const obsidianItem = resolveCommandPaletteItems("Obsidian").find((item) => item.id === "note-obsidian")!;
      const obsidianNotice = await obsidianItem.run();
      expect(obsidianNotice).toBe("已唤起 Obsidian 写入笔记");
      expect(clickedHrefs).toHaveLength(1);
      expect(clickedHrefs[0]).toContain("obsidian://new?vault=CmdVault");
      const decodedContent = decodeURIComponent(clickedHrefs[0].split("content=")[1] || "");
      expect(decodedContent).not.toContain("内部思考");
      expect(decodedContent).toContain(
        "[02:20](https://www.bilibili.com/video/BV1cmdexp001/?p=2&t=140)"
      );
      expect(decodedContent).toContain(
        "*▲ [02:20](https://www.bilibili.com/video/BV1cmdexp001/?p=2&t=140) 核心流程*"
      );

      clearSessionNoteRecords();
      chatSessionStateForTests.currentContextKey = resolveCurrentClipContextKey();
      chatSessionStateForTests.chatHistory = [
        { role: "assistant", content: "历史对话自动兜底 [02:20]。" }
      ];
      const fallbackDownloadNotice = await downloadItem.run();
      expect(fallbackDownloadNotice).toBe("已导出 Markdown 文件");
      expect(downloadMessages).toHaveLength(2);
      expect(downloadMessages[1].markdown).toContain(
        "历史对话自动兜底 [02:20](https://www.bilibili.com/video/BV1cmdexp001/?p=2&t=140)。"
      );
    } finally {
      clickSpy.mockRestore();
    }
  });
});
