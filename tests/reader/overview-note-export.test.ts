import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createDetachedRealm } from "../helpers/detached-realm.js";
import { DEFAULT_SETTINGS, type KnownSettings } from "../../extension/core/defaults.js";
import { state } from "../../extension/core/state.js";
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
  bindCapturedFramesToMessage,
  clearTurnCapturedFrameCache
} from "../../extension/notes/turn-frame-cache.js";
import {
  buildOverviewExportButtonHtml,
  onReadingOverviewClick,
  renderReadingOverview
} from "../../extension/reader/overview-ui.js";
import { ids } from "../../extension/reader/state.js";
import {
  resetActiveReaderHost,
  setActiveReaderHost
} from "../../extension/shared/active-host.js";

const READY_SNAPSHOT = {
  phase: "ready" as const,
  analysis: {
    summary: "这是一段全片简介。",
    chapters: [{ title: "第一章", from: 12, to: 60, summary: "开场要点" }],
    quotes: [{ content: "核心观点金句", from: 45 }],
    failedRanges: [],
    summaryFailed: false
  },
  aiChapters: false,
  progressText: "",
  errorText: "",
  stripText: "",
  generatedFor: "BV1test000000|1"
};

function stubChromeRuntime(
  settingsPatch: Partial<KnownSettings> = {},
  onDownload?: (msg: { type: string; markdown?: string; fileName?: string; subdir?: string }) => unknown
) {
  const sendMessage = vi.fn(
    (
      msg: { type: string; markdown?: string; fileName?: string; subdir?: string },
      callback?: (res: unknown) => void
    ) => {
      if (msg.type === "get-settings") {
        callback?.({
          ok: true,
          settings: {
            ...DEFAULT_SETTINGS,
            noteExportTarget: "download",
            noteDownloadSubdir: "OverviewNotes",
            noteIncludeKeyframes: false,
            ...settingsPatch
          }
        });
        return;
      }
      if (msg.type === "download-note-artifact") {
        const res = onDownload ? onDownload(msg) : { ok: true, downloadId: 11 };
        callback?.(res);
        return;
      }
      callback?.({ ok: true });
    }
  );
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage,
      lastError: null
    }
  });
  return sendMessage;
}

beforeEach(() => {
  resetModuleState();
  resetChatSessionStateForTests();
  clearSessionNoteRecords();
  clearTurnCapturedFrameCache();
  document.body.innerHTML = `${buildOverviewExportButtonHtml()}<div id="${ids.readingOverviewBody}"></div>`;
  state.clip.setBvid("BV1test000000");
  state.clip.setCid("1");
  state.clip.setTitle("测试视频");
  state.clip.setCurrentUrl("https://www.bilibili.com/video/BV1test000000/");
  state.clip.setCurrentClipSignature("BV1test000000|1|zh-CN");
  state.clip.setSubtitleBody([{ from: 45, to: 50, content: "核心观点字幕" }]);
});

afterEach(() => {
  resetActiveReaderHost();
  resetChatSessionStateForTests();
  clearSessionNoteRecords();
  clearTurnCapturedFrameCache();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("概览 Tab 导出笔记图标与文末重新生成入口", () => {
  it("ready 与 partial 状态显示 Tab 导出图标，文末重新生成触发 retry，非就绪态隐藏导出图标", () => {
    const retry = vi.fn();
    renderReadingOverview({ ...READY_SNAPSHOT, phase: "generating", analysis: null });
    const exportBtn = document.getElementById(ids.readingOverviewExportBtn) as HTMLButtonElement;
    expect(exportBtn.hidden).toBe(true);

    renderReadingOverview(READY_SNAPSHOT);

    const body = document.getElementById(ids.readingOverviewBody)!;
    const refreshBtn = body.querySelector<HTMLButtonElement>(".biliscript-reading-ov-footer [data-overview-action='refresh']")!;
    expect(refreshBtn).not.toBeNull();
    expect(refreshBtn.textContent).toContain("重新生成概览");
    expect(body.querySelector("[data-overview-action='export-note']")).toBeNull();
    expect(exportBtn.hidden).toBe(false);

    onReadingOverviewClick({ target: refreshBtn } as unknown as MouseEvent, {
      retry,
      cancel: vi.fn(),
      setup: vi.fn(),
      openTranscribeSettings: vi.fn()
    });
    expect(retry).toHaveBeenCalledTimes(1);

    renderReadingOverview({
      ...READY_SNAPSHOT,
      phase: "partial",
      analysis: {
        ...READY_SNAPSHOT.analysis,
        failedRanges: [{ from: 60, to: 120 }]
      }
    });
    expect(body.querySelector("[data-overview-action='retry-failed']")).not.toBeNull();
    expect(body.querySelector("[data-overview-action='export-note']")).toBeNull();
    expect(body.querySelector(".biliscript-reading-ov-footer")).toBeNull();
    expect(exportBtn.hidden).toBe(false);
  });

  it("点击导出图标展示防重入锁、导出执行与成功图标回执", async () => {
    let finishDownload!: (res: unknown) => void;
    const downloadPayloads: Array<{ markdown?: string; fileName?: string }> = [];
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn(
          (
            msg: { type: string; markdown?: string; fileName?: string },
            callback?: (res: unknown) => void
          ) => {
            if (msg.type === "get-settings") {
              callback?.({
                ok: true,
                settings: {
                  ...DEFAULT_SETTINGS,
                  noteExportTarget: "download",
                  noteDownloadSubdir: "OverviewNotes"
                }
              });
              return;
            }
            if (msg.type === "download-note-artifact") {
              downloadPayloads.push(msg);
              finishDownload = (res) => callback?.(res);
              return;
            }
            callback?.({ ok: true });
          }
        ),
        lastError: null
      }
    });

    renderReadingOverview(READY_SNAPSHOT);
    const exportBtn = document.getElementById(ids.readingOverviewExportBtn) as HTMLButtonElement;

    onReadingOverviewClick({ target: exportBtn } as unknown as MouseEvent);
    onReadingOverviewClick({ target: exportBtn } as unknown as MouseEvent);

    await vi.waitFor(() => expect(downloadPayloads).toHaveLength(1));
    expect(exportBtn.disabled).toBe(true);
    expect(exportBtn.classList.contains("is-loading")).toBe(true);

    finishDownload({ ok: true, downloadId: 19 });
    await vi.waitFor(() => expect(exportBtn.classList.contains("is-copied")).toBe(true));
    expect(exportBtn.getAttribute("aria-label")).toBe("已导出笔记");
    expect(exportBtn.title).toBe("已导出笔记");
    expect(exportBtn.disabled).toBe(false);
    expect(downloadPayloads[0].fileName).toMatch(/测试视频\.md$/);
  });

  it("存在活跃视频笔记或当前视频对话历史时，经由导出边界自动合入笔记正文与关键帧", async () => {
    const downloadPayloads: Array<{ markdown?: string }> = [];
    stubChromeRuntime(
      { noteExportTarget: "download", noteDownloadSubdir: "OverviewNotes", noteIncludeKeyframes: false },
      (msg) => {
        downloadPayloads.push(msg);
        return { ok: true, downloadId: 21 };
      }
    );

    const frames = [{ seconds: 45, dataUrl: "data:image/webp;base64,AAAA" }];
    recordSessionNoteReply({
      clipSignature: captureLiveClipSignature(),
      contextKey: resolveCurrentClipContextKey(),
      markdown: "## 普通对话回复",
      capturedFrames: [],
      isVideoNote: false
    });
    recordSessionNoteReply({
      clipSignature: captureLiveClipSignature(),
      contextKey: resolveCurrentClipContextKey(),
      markdown: "## 结构化视频笔记\n- 要点 [00:45]\n\n{{frame:00:45 | 核心画面}}",
      capturedFrames: frames,
      isVideoNote: true
    });

    renderReadingOverview(READY_SNAPSHOT);
    const exportBtn = document.getElementById(ids.readingOverviewExportBtn) as HTMLButtonElement;

    onReadingOverviewClick({ target: exportBtn } as unknown as MouseEvent);
    await vi.waitFor(() => expect(downloadPayloads).toHaveLength(1));
    expect(downloadPayloads[0].markdown).toContain("## 结构化视频笔记");
    expect(downloadPayloads[0].markdown).not.toContain("## 普通对话回复");
    expect(downloadPayloads[0].markdown).toContain(
      "[00:45](https://www.bilibili.com/video/BV1test000000/?t=45)"
    );
    expect(downloadPayloads[0].markdown).toContain(
      "*▲ [00:45](https://www.bilibili.com/video/BV1test000000/?t=45) 核心画面*"
    );

    await vi.waitFor(() => expect(exportBtn.disabled).toBe(false));

    clearSessionNoteRecords();
    const assistantMsg = { role: "assistant" as const, content: "## 对话历史笔记兜底 [00:45]" };
    bindCapturedFramesToMessage(assistantMsg, frames);
    chatSessionStateForTests.currentContextKey = resolveCurrentClipContextKey();
    chatSessionStateForTests.chatHistory = [assistantMsg];

    onReadingOverviewClick({ target: exportBtn } as unknown as MouseEvent);
    await vi.waitFor(() => expect(downloadPayloads).toHaveLength(2));
    expect(downloadPayloads[1].markdown).toContain("## 对话历史笔记兜底");
  });

  it("独立窗口跨文档 Realm 下可正常渲染并触发 Obsidian 导出笔记", async () => {
    const realm = createDetachedRealm();
    try {
      setActiveReaderHost(realm.doc, realm.win);
      realm.doc.body.innerHTML = `${buildOverviewExportButtonHtml()}<div id="${ids.readingOverviewBody}"></div>`;
      stubChromeRuntime({
        noteExportTarget: "obsidian",
        obsidianVaultName: "DetachedVault",
        obsidianFolder: "Videos"
      });
      const clickedHrefs: string[] = [];
      vi.spyOn(
        (realm.win as unknown as { HTMLAnchorElement: typeof HTMLAnchorElement }).HTMLAnchorElement.prototype,
        "click"
      ).mockImplementation(function (this: HTMLAnchorElement) {
        clickedHrefs.push(this.href);
      });

      renderReadingOverview(READY_SNAPSHOT);
      const exportBtn = realm.doc.getElementById(ids.readingOverviewExportBtn) as HTMLButtonElement;
      expect(exportBtn).not.toBeNull();
      expect(exportBtn.hidden).toBe(false);
      expect(exportBtn.ownerDocument).toBe(realm.doc);

      onReadingOverviewClick({ target: exportBtn } as unknown as MouseEvent);
      await vi.waitFor(() => expect(exportBtn.classList.contains("is-copied")).toBe(true));
      expect(exportBtn.getAttribute("aria-label")).toBe("已唤起 Obsidian");
      expect(exportBtn.title).toBe("已唤起 Obsidian");
      expect(clickedHrefs).toHaveLength(1);
      expect(clickedHrefs[0]).toContain("obsidian://new?vault=DetachedVault");
    } finally {
      resetActiveReaderHost();
      realm.close();
    }
  });
});
