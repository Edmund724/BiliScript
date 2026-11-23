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
