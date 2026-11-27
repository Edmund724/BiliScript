import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createDetachedRealm } from "../helpers/detached-realm.js";
import type { DispatchNoteExportResult } from "../../extension/notes/export-actions.js";

const dispatchNoteExportMock = vi.fn<
  (options?: { aiNoteMarkdown?: string; capturedFrames?: unknown[] }) => Promise<DispatchNoteExportResult>
>();

vi.mock("../../extension/notes/export-actions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/notes/export-actions.js")>();
  return {
    ...actual,
    dispatchNoteExport: (...args: Parameters<typeof actual.dispatchNoteExport>) =>
      dispatchNoteExportMock(...(args as [any]))
  };
});

let buildOverviewExportButtonHtml: typeof import("../../extension/reader/overview-ui.js").buildOverviewExportButtonHtml;
let renderReadingOverview: typeof import("../../extension/reader/overview-ui.js").renderReadingOverview;
let onReadingOverviewClick: typeof import("../../extension/reader/overview-ui.js").onReadingOverviewClick;
let state: typeof import("../../extension/core/state.js").state;
let ids: typeof import("../../extension/reader/state.js").ids;
let resetActiveReaderHost: typeof import("../../extension/shared/active-host.js").resetActiveReaderHost;
let setActiveReaderHost: typeof import("../../extension/shared/active-host.js").setActiveReaderHost;
let clearSessionNoteRecords: typeof import("../../extension/notes/session-note-state.js").clearSessionNoteRecords;
let recordSessionNoteReply: typeof import("../../extension/notes/session-note-state.js").recordSessionNoteReply;
let captureLiveClipSignature: typeof import("../../extension/notes/auto-export-controller.js").captureLiveClipSignature;

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

beforeEach(async () => {
  resetModuleState();
  ({ state } = await import("../../extension/core/state.js"));
  ({ ids } = await import("../../extension/reader/state.js"));
  ({ resetActiveReaderHost, setActiveReaderHost } = await import("../../extension/shared/active-host.js"));
  ({ clearSessionNoteRecords, recordSessionNoteReply } = await import("../../extension/notes/session-note-state.js"));
  ({ captureLiveClipSignature } = await import("../../extension/notes/auto-export-controller.js"));
  ({ buildOverviewExportButtonHtml, renderReadingOverview, onReadingOverviewClick } = await import("../../extension/reader/overview-ui.js"));
  clearSessionNoteRecords();
  dispatchNoteExportMock.mockReset();
  dispatchNoteExportMock.mockResolvedValue({
    ok: true,
    target: "download",
    method: "blob-download",
    fileName: "测试视频.md"
  });
  document.body.innerHTML = `${buildOverviewExportButtonHtml()}<div id="${ids.readingOverviewBody}"></div>`;
  state.clip.setBvid("BV1test000000");
  state.clip.setCid("1");
  state.clip.setTitle("测试视频");
  state.clip.setCurrentClipSignature("BV1test000000|1|zh-CN");
});

afterEach(() => {
  resetActiveReaderHost();
  clearSessionNoteRecords();
  document.body.innerHTML = "";
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

  it("无活跃对话视频笔记时直接调用 dispatchNoteExport()，并展示图标回执与防重入锁", async () => {
    let resolveExport!: (res: DispatchNoteExportResult) => void;
    dispatchNoteExportMock.mockImplementationOnce(
      () =>
        new Promise<DispatchNoteExportResult>((resolve) => {
          resolveExport = resolve;
        })
    );

    renderReadingOverview(READY_SNAPSHOT);
    const exportBtn = document.getElementById(ids.readingOverviewExportBtn) as HTMLButtonElement;

    onReadingOverviewClick({ target: exportBtn } as unknown as MouseEvent);
    onReadingOverviewClick({ target: exportBtn } as unknown as MouseEvent);

    expect(dispatchNoteExportMock).toHaveBeenCalledTimes(1);
    expect(dispatchNoteExportMock).toHaveBeenCalledWith(undefined);
    expect(exportBtn.disabled).toBe(true);
    expect(exportBtn.classList.contains("is-loading")).toBe(true);

    resolveExport({ ok: true, target: "download", fileName: "测试视频.md" });
    await vi.waitFor(() => expect(exportBtn.classList.contains("is-copied")).toBe(true));
    expect(exportBtn.getAttribute("aria-label")).toBe("已导出笔记");
    expect(exportBtn.title).toBe("已导出笔记");
    expect(exportBtn.disabled).toBe(false);
  });

  it("存在当前视频已生成的 AI 视频笔记时自动合并 aiNoteMarkdown 与 capturedFrames", async () => {
    const frames = [{ seconds: 45, dataUrl: "data:image/webp;base64,AAAA" }];
    recordSessionNoteReply({
      clipSignature: captureLiveClipSignature(),
      contextKey: "video:BV1test000000|1",
      markdown: "## 普通对话回复",
      capturedFrames: [],
      isVideoNote: false
    });
    recordSessionNoteReply({
      clipSignature: captureLiveClipSignature(),
      contextKey: "video:BV1test000000|1",
      markdown: "## 结构化视频笔记\n- 要点 [00:45]",
      capturedFrames: frames,
      isVideoNote: true
    });

    renderReadingOverview(READY_SNAPSHOT);
    const exportBtn = document.getElementById(ids.readingOverviewExportBtn) as HTMLButtonElement;

    onReadingOverviewClick({ target: exportBtn } as unknown as MouseEvent);
    await vi.waitFor(() => expect(dispatchNoteExportMock).toHaveBeenCalledTimes(1));

    expect(dispatchNoteExportMock).toHaveBeenCalledWith({
      aiNoteMarkdown: "## 结构化视频笔记\n- 要点 [00:45]",
      capturedFrames: frames
    });
  });

  it("独立窗口跨文档 Realm 下可正常渲染并触发导出笔记", async () => {
    const realm = createDetachedRealm();
    try {
      setActiveReaderHost(realm.doc, realm.win);
      realm.doc.body.innerHTML = `${buildOverviewExportButtonHtml()}<div id="${ids.readingOverviewBody}"></div>`;
      dispatchNoteExportMock.mockResolvedValueOnce({
        ok: true,
        target: "obsidian",
        method: "obsidian"
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
    } finally {
      resetActiveReaderHost();
      realm.close();
    }
  });
});
