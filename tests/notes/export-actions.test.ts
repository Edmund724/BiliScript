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

    const dlRes = await exportActions.dispatchNoteExport({ target: "download" });
    expect(dlRes.ok).toBe(true);
    expect(dlRes.target).toBe("download");
    expect(dlRes.method).toBe("blob-download");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:detached-note");
    expect(detachedAppendSpy).toHaveBeenCalledTimes(1);
    expect(openerAppendSpy).not.toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalledTimes(1);

    const obRes = await exportActions.dispatchNoteExport({ target: "obsidian" });
    expect(obRes.ok).toBe(true);
    expect(obRes.target).toBe("obsidian");
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

    downloadResponse = { ok: false, fallbackRequired: false, error: "磁盘写入失败" };
    const realErrorRes = await exportActions.dispatchNoteExport({
      aiNoteMarkdown: "真实下载错误不应静默回退 [01:35]。",
      autoTrigger: true
    });
    expect(realErrorRes.ok).toBe(false);
    expect(realErrorRes.target).toBe("download");
    expect(realErrorRes.method).toBe("background-download");
    expect(realErrorRes.error).toBe("磁盘写入失败");
    expect(realErrorRes.usedBlobFallback).toBeUndefined();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);

    downloadResponse = { ok: false };
    const defaultErrorRes = await exportActions.dispatchNoteExport({
      aiNoteMarkdown: "无 fallbackRequired 默认报错 [01:35]。",
      autoTrigger: true
    });
    expect(defaultErrorRes.ok).toBe(false);
    expect(defaultErrorRes.target).toBe("download");
    expect(defaultErrorRes.method).toBe("background-download");
    expect(defaultErrorRes.error).toBe("下载失败");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("dispatchNoteExport 支持 options.target 显式覆盖默认导出目标", async () => {
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
    clip.title = "显式目标覆盖测试";
    clip.bvid = "BV1override1";
    clip.currentUrl = "https://www.bilibili.com/video/BV1override1/";
    clip.subtitleBody = [{ from: 15, to: 20, content: "内容" }];

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn((msg: { type: string }, callback?: (res: unknown) => void) => {
          if (msg.type === "get-settings") {
            callback?.({
              ok: true,
              settings: {
                ...DEFAULT_SETTINGS,
                noteExportTarget: "download",
                obsidianVaultName: "VaultA",
                obsidianFolder: "Inbox",
                noteDownloadSubdir: "SubNotes"
              }
            });
            return;
          }
          if (msg.type === "download-note-artifact") {
            callback?.({ ok: true, downloadId: 77 });
            return;
          }
          callback?.({ ok: true });
        }),
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

    const obRes = await exportActions.dispatchNoteExport({
      target: "obsidian",
      aiNoteMarkdown: "切到 Obsidian [00:15]"
    });
    expect(obRes.ok).toBe(true);
    expect(obRes.target).toBe("obsidian");
    expect(obRes.method).toBe("obsidian");
    expect(clickedHrefs[0]).toContain("obsidian://new?vault=VaultA");

    const dlRes = await exportActions.dispatchNoteExport({
      target: "download",
      aiNoteMarkdown: "切到下载 [00:15]"
    });
    expect(dlRes.ok).toBe(true);
    expect(dlRes.target).toBe("download");
    expect(dlRes.method).toBe("background-download");
    expect(dlRes.downloadId).toBe(77);
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
    expect(sentTypes.filter((type) => type !== "subtitle-cache")).toEqual(["get-settings"]);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:direct-note");
  });

  it("dispatchNoteExport 默认接入 resolveNoteKeyframes 并在含 Base64 关键帧长文时完整写入 Obsidian 剪贴板", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const coreState = await import("../../extension/core/state.js");
    const { DEFAULT_SETTINGS } = await import("../../extension/core/defaults.js");
    const {
      clearTurnCapturedFrameCache,
      setLatestCapturedFrames
    } = await import("../../extension/notes/turn-frame-cache.js");
    const exportActions = await import("../../extension/notes/export-actions.js");
    clearTurnCapturedFrameCache();

    const clip = coreState.state.clip as unknown as {
      site: "bilibili" | "youtube";
      title: string;
      bvid: string;
      cid: string;
      currentUrl: string;
      subtitleBody: Array<{ from: number; to: number; content: string }>;
    };
    clip.site = "bilibili";
    clip.title = "关键帧单文件导出测试";
    clip.bvid = "BV1kfexport1";
    clip.cid = "889900";
    clip.currentUrl = "https://www.bilibili.com/video/BV1kfexport1/?p=3";
    clip.subtitleBody = [{ from: 195, to: 200, content: "核心架构" }];

    let includeKeyframesSetting = true;
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn((msg: { type: string }, callback?: (res: unknown) => void) => {
          callback?.(
            msg.type === "get-settings"
              ? {
                  ok: true,
                  settings: {
                    ...DEFAULT_SETTINGS,
                    noteExportTarget: "obsidian",
                    obsidianVaultName: "Vault",
                    obsidianFolder: "VideoNotes",
                    noteIncludeKeyframes: includeKeyframesSetting
                  }
                }
              : { ok: true }
          );
        }),
        lastError: null
      }
    });

    const largeBase64 = "A".repeat(7200);
    const createImageBitmapMock = vi.fn(async () => ({
      width: 1280,
      height: 720,
      close: vi.fn()
    }));
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);

    const drawImage = vi.fn();
    const toDataURL = vi.fn(() => `data:image/webp;base64,${largeBase64}`);
    const canvasProto = (
      realm.win as unknown as { HTMLCanvasElement: typeof HTMLCanvasElement }
    ).HTMLCanvasElement.prototype;
    vi.spyOn(canvasProto, "getContext").mockImplementation(
      (() => ({ drawImage })) as unknown as typeof canvasProto.getContext
    );
    vi.spyOn(canvasProto, "toDataURL").mockImplementation(toDataURL);

    const clickedHrefs: string[] = [];
    vi.spyOn(
      (realm.win as unknown as { HTMLAnchorElement: typeof HTMLAnchorElement }).HTMLAnchorElement.prototype,
      "click"
    ).mockImplementation(function (this: HTMLAnchorElement) {
      clickedHrefs.push(this.href);
    });
    activeHost.setActiveReaderHost(realm.doc, realm.win);

    setLatestCapturedFrames([
      { seconds: 196, dataUrl: "data:image/jpeg;base64,AQIDBA==" }
    ]);

    const res = await exportActions.dispatchNoteExport({
      aiNoteMarkdown: "参见 [03:15]。\n\n{{frame:03:15 | [核心] 架构图}}"
    });

    expect(res.ok).toBe(true);
    expect(res.target).toBe("obsidian");
    expect(res.method).toBe("obsidian-clipboard");
    expect(res.usedClipboardFallback).toBe(true);
    expect(clickedHrefs[0]).toContain("obsidian://new?vault=Vault");
    expect(clickedHrefs[0]).toContain("clipboard=true");
    expect(realm.clipboardWriteText).toHaveBeenCalledTimes(1);
    const writtenMarkdown = realm.clipboardWriteText.mock.calls[0][0] as string;
    expect(writtenMarkdown).toContain(`![03:15 核心 架构图](data:image/webp;base64,${largeBase64})`);
    expect(writtenMarkdown).toContain(
      "*▲ [03:15](https://www.bilibili.com/video/BV1kfexport1/?p=3&t=195) [核心] 架构图*"
    );
    expect(writtenMarkdown).toContain(
      "参见 [03:15](https://www.bilibili.com/video/BV1kfexport1/?p=3&t=195)。"
    );
    expect(writtenMarkdown).not.toContain("](https://www.bilibili.com/video/BV1kfexport1/?p=3&t=195)(");

    includeKeyframesSetting = false;
    createImageBitmapMock.mockClear();
    const disabledRes = await exportActions.dispatchNoteExport({
      aiNoteMarkdown: "{{frame:03:15 | 关闭开关降级}}"
    });

    expect(disabledRes.ok).toBe(true);
    expect(createImageBitmapMock).not.toHaveBeenCalled();
    expect(disabledRes.markdown).not.toContain("data:image/");
    expect(disabledRes.markdown).toContain(
      "*▲ [03:15](https://www.bilibili.com/video/BV1kfexport1/?p=3&t=195) 关闭开关降级*"
    );
    clearTurnCapturedFrameCache();
  });

  it("自动解析活跃视频的会话笔记与对话历史兜底，并支持显式覆盖与关闭自动注入", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const coreState = await import("../../extension/core/state.js");
    const { DEFAULT_SETTINGS } = await import("../../extension/core/defaults.js");
    const {
      chatSessionStateForTests,
      resetChatSessionStateForTests
    } = await import("../../extension/chat/chat-state.js");
    const {
      captureLiveClipSignature,
      clearSessionNoteRecords,
      recordSessionNoteReply,
      resolveCurrentClipContextKey
    } = await import("../../extension/notes/session-note-state.js");
    const {
      bindCapturedFramesToMessage,
      clearTurnCapturedFrameCache
    } = await import("../../extension/notes/turn-frame-cache.js");
    const exportActions = await import("../../extension/notes/export-actions.js");
    resetChatSessionStateForTests();
    clearSessionNoteRecords();
    clearTurnCapturedFrameCache();

    const clip = coreState.state.clip as unknown as {
      site: "bilibili" | "youtube";
      title: string;
      bvid: string;
      cid: string;
      currentUrl: string;
      currentClipSignature: string;
      subtitleBody: Array<{ from: number; to: number; content: string }>;
    };
    clip.site = "bilibili";
    clip.title = "活跃笔记自动解析测试";
    clip.bvid = "BV1autonote1";
    clip.cid = "334455";
    clip.currentUrl = "https://www.bilibili.com/video/BV1autonote1/";
    clip.currentClipSignature = "BV1autonote1|334455";
    clip.subtitleBody = [{ from: 30, to: 35, content: "字幕正文" }];

    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn((msg: { type: string }, callback?: (res: unknown) => void) => {
          callback?.(
            msg.type === "get-settings"
              ? {
                  ok: true,
                  settings: {
                    ...DEFAULT_SETTINGS,
                    noteExportTarget: "download",
                    noteDownloadSubdir: ""
                  }
                }
              : { ok: true }
          );
        }),
        lastError: null
      }
    });

    (realm.win as unknown as { URL: unknown }).URL = {
      createObjectURL: vi.fn(() => "blob:auto-note"),
      revokeObjectURL: vi.fn()
    };
    vi.spyOn(
      (realm.win as unknown as { HTMLAnchorElement: typeof HTMLAnchorElement }).HTMLAnchorElement.prototype,
      "click"
    ).mockImplementation(() => {});
    activeHost.setActiveReaderHost(realm.doc, realm.win);

    const sessionFrames = [{ seconds: 30, dataUrl: "data:image/webp;base64,SESS" }];
    recordSessionNoteReply({
      clipSignature: captureLiveClipSignature(),
      contextKey: resolveCurrentClipContextKey(),
      markdown: "## 普通回复",
      capturedFrames: [],
      isVideoNote: false
    });
    recordSessionNoteReply({
      clipSignature: captureLiveClipSignature(),
      contextKey: resolveCurrentClipContextKey(),
      markdown: "<think>隐藏</think>\n## 会话视频笔记\n- 重点 [00:30]",
      capturedFrames: sessionFrames,
      isVideoNote: true
    });

    const seenFrames: unknown[] = [];
    const resolveKeyframes = vi.fn(async (md: string, ctx: { capturedFrames?: readonly unknown[] }) => {
      seenFrames.push(ctx.capturedFrames);
      return md;
    });

    const autoExport = await exportActions.dispatchNoteExport({ resolveKeyframes });
    expect(autoExport.ok).toBe(true);
    expect(autoExport.markdown).toContain("## 会话视频笔记");
    expect(autoExport.markdown).not.toContain("## 普通回复");
    expect(autoExport.markdown).not.toContain("隐藏");
    expect(seenFrames[0]).toEqual(sessionFrames);

    expect(await exportActions.copyCurrentVideoNote()).toBe(true);
    expect(realm.clipboardWriteText.mock.calls[0][0]).toContain("## 会话视频笔记");

    const explicitOverride = await exportActions.dispatchNoteExport({
      aiNoteMarkdown: "## 显式覆盖内容",
      resolveKeyframes
    });
    expect(explicitOverride.ok).toBe(true);
    expect(explicitOverride.markdown).toContain("## 显式覆盖内容");
    expect(explicitOverride.markdown).not.toContain("## 会话视频笔记");

    const explicitEmpty = await exportActions.dispatchNoteExport({
      aiNoteMarkdown: "",
      resolveKeyframes
    });
    expect(explicitEmpty.ok).toBe(true);
    expect(explicitEmpty.markdown).not.toContain("## 会话视频笔记");

    const optedOut = await exportActions.dispatchNoteExport({
      useActiveSessionNote: false,
      resolveKeyframes
    });
    expect(optedOut.ok).toBe(true);
    expect(optedOut.markdown).not.toContain("## 会话视频笔记");

    expect(await exportActions.copyCurrentVideoNote({ useActiveSessionNote: false })).toBe(true);
    expect(realm.clipboardWriteText.mock.calls[1][0]).not.toContain("## 会话视频笔记");

    clearSessionNoteRecords();
    const historyMsg = { role: "assistant" as const, content: "## 历史对话兜底笔记 [00:30]" };
    const stoppedMsg = { role: "assistant" as const, content: "## 被中止回复", stopped: true };
    const historyFrames = [{ seconds: 32, dataUrl: "data:image/jpeg;base64,HIST" }];
    bindCapturedFramesToMessage(historyMsg, historyFrames);
    chatSessionStateForTests.currentContextKey = resolveCurrentClipContextKey();
    chatSessionStateForTests.chatHistory = [historyMsg, stoppedMsg];

    const historyExport = await exportActions.dispatchNoteExport({ resolveKeyframes });
    expect(historyExport.ok).toBe(true);
    expect(historyExport.markdown).toContain("## 历史对话兜底笔记");
    expect(historyExport.markdown).not.toContain("## 被中止回复");
    expect(seenFrames.at(-1)).toEqual(historyFrames);

    expect(await exportActions.copyCurrentVideoNote()).toBe(true);
    expect(realm.clipboardWriteText.mock.calls[2][0]).toContain("## 历史对话兜底笔记");

    chatSessionStateForTests.currentContextKey = "video:BV1otherClip|999";
    const crossClipExport = await exportActions.dispatchNoteExport({ resolveKeyframes });
    expect(crossClipExport.ok).toBe(true);
    expect(crossClipExport.markdown).not.toContain("## 历史对话兜底笔记");
  });
});
