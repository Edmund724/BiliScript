// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createDetachedRealm, type DetachedRealm } from "../helpers/detached-realm.js";

let realm: DetachedRealm | null = null;

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

afterEach(() => {
  realm?.close();
  realm = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("notes/export-actions 与 subtitle/ui 独立窗口导出路由", () => {
  it("独立窗口聚焦时，笔记复制/下载与 Obsidian URI 触发走活跃宿主文档与窗口", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const coreState = await import("../../extension/core/state.js");
    const exportActions = await import("../../extension/notes/export-actions.js");

    const clip = coreState.state.clip as unknown as {
      title: string;
      bvid: string;
      currentUrl: string;
      subtitleBody: Array<{ from: number; to: number; content: string }>;
    };
    clip.title = "测试视频";
    clip.bvid = "BV1detached";
    clip.currentUrl = "https://www.bilibili.com/video/BV1detached";
    clip.subtitleBody = [{ from: 0, to: 5, content: "第一句字幕" }];

    const openerClipboard = vi.fn().mockRejectedValue(new Error("Document is not focused"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: openerClipboard },
      configurable: true,
    });

    const createObjectURL = vi.fn(() => "blob:detached-note");
    const revokeObjectURL = vi.fn();
    (realm.win as unknown as { URL: unknown }).URL = { createObjectURL, revokeObjectURL };
    const detachedAppendSpy = vi.spyOn(realm.doc.body, "appendChild");
    const openerAppendSpy = vi.spyOn(document.body, "appendChild");
    const clickSpy = vi.spyOn((realm.win as unknown as { HTMLAnchorElement: typeof HTMLAnchorElement }).HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    activeHost.setActiveReaderHost(realm.doc, realm.win);

    expect(await exportActions.copyCurrentVideoNote()).toBe(true);
    expect(realm.clipboardWriteText).toHaveBeenCalledTimes(1);
    expect(openerClipboard).not.toHaveBeenCalled();

    expect(await exportActions.downloadCurrentVideoNote()).toBe(true);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:detached-note");
    expect(detachedAppendSpy).toHaveBeenCalledTimes(1);
    expect(openerAppendSpy).not.toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalledTimes(1);

    const obRes = await exportActions.openCurrentVideoInObsidian();
    expect(obRes.ok).toBe(true);
    expect(detachedAppendSpy).toHaveBeenCalledTimes(2);
    expect(openerAppendSpy).not.toHaveBeenCalled();
  });

  it("独立窗口聚焦时，字幕复制与下载走活跃宿主剪贴板与文档", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const coreState = await import("../../extension/core/state.js");
    const subtitleUi = await import("../../extension/subtitle/ui.js");

    const clip = coreState.state.clip as unknown as {
      title: string;
      bvid: string;
      selectedSubtitleLang: string;
      subtitleBody: Array<{ from: number; to: number; content: string }>;
    };
    clip.title = "字幕导出测试";
    clip.bvid = "BV1detached";
    clip.selectedSubtitleLang = "zh-CN";
    clip.subtitleBody = [{ from: 1, to: 3, content: "你好世界" }];

    const createObjectURL = vi.fn(() => "blob:detached-sub");
    const revokeObjectURL = vi.fn();
    (realm.win as unknown as { URL: unknown }).URL = { createObjectURL, revokeObjectURL };
    const detachedAppendSpy = vi.spyOn(realm.doc.body, "appendChild");
    const openerAppendSpy = vi.spyOn(document.body, "appendChild");
    vi.spyOn((realm.win as unknown as { HTMLAnchorElement: typeof HTMLAnchorElement }).HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    activeHost.setActiveReaderHost(realm.doc, realm.win);

    expect(await subtitleUi.copySubtitleTranscript()).toBe(true);
    expect(realm.clipboardWriteText).toHaveBeenCalledTimes(1);

    expect(await subtitleUi.downloadSubtitle({ format: "srt" })).toBe(true);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:detached-sub");
    expect(detachedAppendSpy).toHaveBeenCalledTimes(1);
    expect(openerAppendSpy).not.toHaveBeenCalled();
  });
});

describe("notes/export-actions dispatchNoteExport 统一导出路由器", () => {
  it("obsidian 模式下剥离 think 块、执行关键帧钩子、重写深链并支持超长剪贴板回退", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const coreState = await import("../../extension/core/state.js");
    const { DEFAULT_SETTINGS } = await import("../../extension/core/defaults.js");
    const exportActions = await import("../../extension/notes/export-actions.js");

    const clip = coreState.state.clip as unknown as {
      site: "bilibili" | "youtube";
      title: string;
      bvid: string;
      cid: string;
      currentUrl: string;
      subtitleBody: Array<{ from: number; to: number; content: string }>;
    };
    clip.site = "bilibili";
    clip.title = "Obsidian 路由测试";
    clip.bvid = "BV1obroute01";
    clip.cid = "778899";
    clip.currentUrl = "https://www.bilibili.com/video/BV1obroute01/?p=2";
    clip.subtitleBody = [{ from: 10, to: 15, content: "内容" }];

    const sendMessage = vi.fn((msg: { type: string }, callback?: (res: unknown) => void) => {
      if (msg.type === "get-settings") {
        callback?.({
          ok: true,
          settings: {
            ...DEFAULT_SETTINGS,
            noteExportTarget: "obsidian",
            obsidianVaultName: "Notes",
            obsidianFolder: "Videos",
            noteIncludeKeyframes: true
          }
        });
        return;
      }
      callback?.({ ok: true });
    });
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
        lastError: null
      }
    });

    const clickedHrefs: string[] = [];
    vi.spyOn(
      (realm.win as unknown as { HTMLAnchorElement: typeof HTMLAnchorElement }).HTMLAnchorElement.prototype,
      "click"
    ).mockImplementation(function (this: HTMLAnchorElement) {
      clickedHrefs.push(this.href);
    });
    activeHost.setActiveReaderHost(realm.doc, realm.win);

    const resolveKeyframes = vi.fn(async (md: string) =>
      md.replace("{{frame:02:25 | 架构图}}", "![02:25 架构图](data:image/webp;base64,AAA)")
    );

    const res = await exportActions.dispatchNoteExport({
      aiNoteMarkdown: "<think>内部推理</think>\n核心结论见 [02:25]。\n\n{{frame:02:25 | 架构图}}",
      resolveKeyframes
    });

    expect(res.ok).toBe(true);
    expect(res.target).toBe("obsidian");
    expect(res.method).toBe("obsidian");
    expect(res.usedClipboardFallback).toBe(false);
    expect(resolveKeyframes).toHaveBeenCalledTimes(1);
    expect(res.markdown).not.toContain("内部推理");
    expect(res.markdown).toContain("![02:25 架构图](data:image/webp;base64,AAA)");
    expect(res.markdown).toContain("[02:25](https://www.bilibili.com/video/BV1obroute01/?p=2&t=145)");
    expect(clickedHrefs[0]).toContain("obsidian://new?vault=Notes");

    const longRes = await exportActions.dispatchNoteExport({
      aiNoteMarkdown: "超长视频笔记段落。".repeat(600)
    });
    expect(longRes.ok).toBe(true);
    expect(longRes.method).toBe("obsidian-clipboard");
    expect(longRes.usedClipboardFallback).toBe(true);
    expect(realm.clipboardWriteText).toHaveBeenCalledTimes(1);
    expect(clickedHrefs[1]).toContain("clipboard=true");
  });

  it("download 模式携带子目录或 autoTrigger 时优先走后台 download-note-artifact，未授权时无缝回退活跃宿主 Blob 下载", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const coreState = await import("../../extension/core/state.js");
    const { DEFAULT_SETTINGS } = await import("../../extension/core/defaults.js");
    const exportActions = await import("../../extension/notes/export-actions.js");

    const clip = coreState.state.clip as unknown as {
      site: "bilibili" | "youtube";
      title: string;
      bvid: string;
      currentUrl: string;
      subtitleBody: Array<{ from: number; to: number; content: string }>;
    };
    clip.site = "youtube";
    clip.title = "YouTube 落盘测试";
    clip.bvid = "_a-B1234567";
    clip.currentUrl = "https://www.youtube.com/watch?v=_a-B1234567";
    clip.subtitleBody = [{ from: 95, to: 100, content: "hello" }];

    let downloadResponse: Record<string, unknown> = { ok: true, downloadId: 42 };
    const sentMessages: Array<{ type: string; subdir?: string; markdown?: string; fileName?: string }> = [];
    const sendMessage = vi.fn(
      (
        msg: { type: string; subdir?: string; markdown?: string; fileName?: string },
        callback?: (res: unknown) => void
      ) => {
        sentMessages.push(msg);
        if (msg.type === "get-settings") {
          callback?.({
            ok: true,
            settings: {
              ...DEFAULT_SETTINGS,
              noteExportTarget: "download",
              noteDownloadSubdir: "BiliScript/Notes"
            }
          });
          return;
        }
        if (msg.type === "download-note-artifact") {
          callback?.(downloadResponse);
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

    const createObjectURL = vi.fn(() => "blob:detached-fallback");
    const revokeObjectURL = vi.fn();
    (realm.win as unknown as { URL: unknown }).URL = { createObjectURL, revokeObjectURL };
    const detachedAppendSpy = vi.spyOn(realm.doc.body, "appendChild");
    const openerAppendSpy = vi.spyOn(document.body, "appendChild");
    const clickSpy = vi
      .spyOn(
        (realm.win as unknown as { HTMLAnchorElement: typeof HTMLAnchorElement }).HTMLAnchorElement.prototype,
        "click"
      )
      .mockImplementation(() => {});
    activeHost.setActiveReaderHost(realm.doc, realm.win);

    const bgOk = await exportActions.dispatchNoteExport({
      aiNoteMarkdown: "要点在 [01:35]。",
      autoTrigger: true
    });
    expect(bgOk.ok).toBe(true);
    expect(bgOk.target).toBe("download");
    expect(bgOk.method).toBe("background-download");
    expect(bgOk.downloadId).toBe(42);
    const dlMsg = sentMessages.find((m) => m.type === "download-note-artifact");
    expect(dlMsg?.subdir).toBe("BiliScript/Notes");
    expect(dlMsg?.markdown).toContain("[01:35](https://www.youtube.com/watch?v=_a-B1234567&t=95s)");
    expect(createObjectURL).not.toHaveBeenCalled();

    downloadResponse = { ok: false, fallbackRequired: true, error: "downloads permission not granted" };
    const fallbackRes = await exportActions.dispatchNoteExport({
      aiNoteMarkdown: "权限未授予回退 [01:35]。",
      autoTrigger: true
    });
    expect(fallbackRes.ok).toBe(true);
    expect(fallbackRes.target).toBe("download");
    expect(fallbackRes.method).toBe("blob-download");
    expect(fallbackRes.usedBlobFallback).toBe(true);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:detached-fallback");
    expect(detachedAppendSpy).toHaveBeenCalledTimes(1);
    expect(openerAppendSpy).not.toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("download 模式无子目录且非 autoTrigger 时直接走活跃宿主 Blob 下载不调用后台通道", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const coreState = await import("../../extension/core/state.js");
    const { DEFAULT_SETTINGS } = await import("../../extension/core/defaults.js");
    const exportActions = await import("../../extension/notes/export-actions.js");

    const clip = coreState.state.clip as unknown as {
      site: "bilibili" | "youtube";
      title: string;
      bvid: string;
      currentUrl: string;
      subtitleBody: Array<{ from: number; to: number; content: string }>;
    };
    clip.site = "bilibili";
    clip.title = "零权限直下测试";
    clip.bvid = "BV1direct001";
    clip.currentUrl = "https://www.bilibili.com/video/BV1direct001/";
    clip.subtitleBody = [{ from: 12, to: 16, content: "字幕" }];

    const sentTypes: string[] = [];
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn((msg: { type: string }, callback?: (res: unknown) => void) => {
          sentTypes.push(msg.type);
          if (msg.type === "get-settings") {
            callback?.({
              ok: true,
              settings: {
                ...DEFAULT_SETTINGS,
                noteExportTarget: "download",
                noteDownloadSubdir: ""
              }
            });
            return;
          }
          callback?.({ ok: true });
        }),
        lastError: null
      }
    });

    const createObjectURL = vi.fn(() => "blob:direct-note");
    const revokeObjectURL = vi.fn();
    (realm.win as unknown as { URL: unknown }).URL = { createObjectURL, revokeObjectURL };
    vi.spyOn(
      (realm.win as unknown as { HTMLAnchorElement: typeof HTMLAnchorElement }).HTMLAnchorElement.prototype,
      "click"
    ).mockImplementation(() => {});
    activeHost.setActiveReaderHost(realm.doc, realm.win);

    const directRes = await exportActions.dispatchNoteExport({
      aiNoteMarkdown: "直接下载 [00:12]。"
    });
    expect(directRes.ok).toBe(true);
    expect(directRes.method).toBe("blob-download");
    expect(directRes.usedBlobFallback).toBe(false);
    expect(sentTypes).toEqual(["get-settings"]);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:direct-note");
  });
});
