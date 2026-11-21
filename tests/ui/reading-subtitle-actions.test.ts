import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "../reader/reader-test-env.js";

let state: TestState;
let clipState: (typeof import("../../extension/core/state.js"))["clipState"];
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");

let clipboardWriteText: ReturnType<typeof vi.fn>;
let clickedAnchor: HTMLAnchorElement | null = null;
let originalCreateObjectURL: unknown;
let originalRevokeObjectURL: unknown;

async function loadModules() {
  setLocationUrl(READER_MODE_URL);
  const stateModule = await import("../../extension/core/state.js");
  state = stateModule.state as TestState;
  clipState = stateModule.clipState;
  ids = (await import("../../extension/reader/state.js")).ids;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
}

function dispatchClick(elementId: string) {
  (document.getElementById(elementId) as HTMLElement).dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true })
  );
}

function btn(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function seedSubtitleBody() {
  state.clip.subtitleBody = [
    { from: 0, to: 10, content: "第一句话" },
    { from: 10, to: 30, content: "第二句话" }
  ];
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadModules();
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
  seedSubtitleBody();

  clipboardWriteText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWriteText },
    configurable: true
  });
  clickedAnchor = null;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clickedAnchor = this;
  });
  originalCreateObjectURL = (URL as unknown as Record<string, unknown>).createObjectURL;
  originalRevokeObjectURL = (URL as unknown as Record<string, unknown>).revokeObjectURL;
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:mock-subtitle");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
});

afterEach(() => {
  (URL as unknown as Record<string, unknown>).createObjectURL = originalCreateObjectURL;
  (URL as unknown as Record<string, unknown>).revokeObjectURL = originalRevokeObjectURL;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("字幕 tab 复制 / 导出（真实绑定，经 ensureSummarizeChain）", () => {
  it("点击「复制」：剪贴板写入字幕纯文本（含时间戳），反馈「字幕已复制到剪贴板」", async () => {
    dispatchClick(ids.readingCopySubtitleBtn);

    await vi.waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(1));
    const copied = String(clipboardWriteText.mock.calls[0][0]);
    expect(copied).toContain("第一句话");
    expect(copied).toContain("第二句话");
    expect(copied).toContain("0:00");
    expect(copied).toContain("0:10");

    await vi.waitFor(() => expect(btn(ids.readingCopySubtitleBtn).classList.contains("is-copied")).toBe(true));
  });

  it("无字幕时复制：按钮就地提示复制失败，不写剪贴板", async () => {
    state.clip.subtitleBody = [];
    dispatchClick(ids.readingCopySubtitleBtn);

    await vi.waitFor(() => expect(btn(ids.readingCopySubtitleBtn).classList.contains("is-copy-failed")).toBe(true));
    expect(btn(ids.readingCopySubtitleBtn).getAttribute("aria-label")).toBe("复制失败");
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it("复制失败（剪贴板拒绝写入）：按钮就地提示复制失败", async () => {
    clipboardWriteText.mockRejectedValueOnce(new Error("denied"));
    dispatchClick(ids.readingCopySubtitleBtn);

    await vi.waitFor(() => expect(btn(ids.readingCopySubtitleBtn).classList.contains("is-copy-failed")).toBe(true));
    expect(btn(ids.readingCopySubtitleBtn).getAttribute("aria-label")).toBe("复制失败");
  });

  it("双语开：复制出的文本带副行（缩进两格、副行不带时间戳）", async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        lastError: null,
        getURL: (path: string) => `chrome-extension://test/${path}`,
        sendMessage: (msg: { type?: string }, cb?: (r: unknown) => void) => {
          const payload = msg?.type === "get-settings" ? { ok: true, settings: { bilingualSubtitles: true } } : { ok: true };
          if (typeof cb === "function") {
            cb(payload);
            return undefined;
          }
          return Promise.resolve(payload);
        }
      }
    });
    clipState.applySecondarySubtitle({
      id: "sub-en",
      url: "https://sub/en.json",
      body: [{ from: 0, to: 30, content: "English line" }]
    });

    dispatchClick(ids.readingCopySubtitleBtn);

    await vi.waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(1));
    const copied = String(clipboardWriteText.mock.calls[0][0]);
    expect(copied).toContain("第一句话\n  English line");
    expect(copied).toContain("第二句话\n  English line");
    const secondaryLines = copied.split("\n").filter((line) => line.startsWith("  "));
    expect(secondaryLines).toEqual(["  English line", "  English line"]);
    await vi.waitFor(() => expect(btn(ids.readingCopySubtitleBtn).classList.contains("is-copied")).toBe(true));
  });

  it("点击「导出」：按默认 srt 格式触发下载，按钮显示已导出", async () => {
    state.clip.uploadDate = "2026-11-15";
    dispatchClick(ids.readingExportSubtitleBtn);

    await vi.waitFor(() => expect(clickedAnchor).not.toBe(null));
    expect((clickedAnchor as HTMLAnchorElement | null)!.download.startsWith("2026-11-15-")).toBe(true);
    expect((clickedAnchor as HTMLAnchorElement | null)!.download.endsWith(".srt")).toBe(true);
    await vi.waitFor(() => expect(btn(ids.readingExportSubtitleBtn).getAttribute("aria-label")).toBe("已导出"));
  });

  it("导出文件名设置 includeDateInFilename=false 时不加日期前缀", async () => {
    state.clip.uploadDate = "2026-11-15";
    vi.stubGlobal("chrome", {
      runtime: {
        lastError: null,
        getURL: (path: string) => `chrome-extension://test/${path}`,
        sendMessage: (msg: { type?: string }, cb?: (r: unknown) => void) => {
          const payload = msg?.type === "get-settings" ? { ok: true, settings: { includeDateInFilename: false } } : { ok: true };
          if (typeof cb === "function") {
            cb(payload);
            return undefined;
          }
          return Promise.resolve(payload);
        }
      }
    });

    dispatchClick(ids.readingExportSubtitleBtn);
    await vi.waitFor(() => expect(clickedAnchor).not.toBe(null));
    expect((clickedAnchor as HTMLAnchorElement | null)!.download.startsWith("2026-11-15-")).toBe(false);
  });

  it("无字幕时导出：按钮就地提示导出失败，不触发下载", async () => {
    state.clip.subtitleBody = [];
    dispatchClick(ids.readingExportSubtitleBtn);

    await vi.waitFor(() => expect(btn(ids.readingExportSubtitleBtn).classList.contains("is-copy-failed")).toBe(true));
    expect(btn(ids.readingExportSubtitleBtn).getAttribute("aria-label")).toBe("导出失败");
    expect(clickedAnchor).toBe(null);
  });
});
