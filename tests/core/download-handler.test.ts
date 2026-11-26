import { describe, expect, it, vi } from "vitest";
import {
  buildSafeNoteDownloadPath,
  createDownloadNoteArtifactHandler,
  encodeMarkdownAsDataUrl,
  sanitizeNoteArtifactFileName,
  type DownloadHandlerHostAdapter,
  type DownloadsApiLike
} from "../../extension/core/download-handler.js";
import type {
  DownloadNoteArtifactMessage,
  DownloadNoteArtifactResponse,
  MessageSender
} from "../../extension/shared/messaging-protocol.js";

const CONTENT_SENDER: MessageSender = { url: "https://www.bilibili.com/video/BV1test000000" };
type DownloadOptions = Parameters<NonNullable<DownloadsApiLike["download"]>>[0];

function decodeMarkdownDataUrl(url: string): string {
  const prefix = "data:text/markdown;charset=utf-8;base64,";
  expect(url.startsWith(prefix)).toBe(true);
  const base64 = url.slice(prefix.length);
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function invokeDownloadHandler(
  adapter: DownloadHandlerHostAdapter,
  message: DownloadNoteArtifactMessage
): { decision: unknown; responsePromise: Promise<DownloadNoteArtifactResponse> } {
  const handler = createDownloadNoteArtifactHandler(adapter);
  let resolveResponse!: (resp: DownloadNoteArtifactResponse) => void;
  const responsePromise = new Promise<DownloadNoteArtifactResponse>((resolve) => {
    resolveResponse = resolve;
  });
  const decision = handler(message, CONTENT_SENDER, resolveResponse);
  return { decision, responsePromise };
}

describe("download-handler 路径清洗与 UTF-8 Data URL 编码", () => {
  it.each([
    ["测试标题.md", "测试标题.md"],
    ["测试标题", "测试标题.md"],
    ["../secret.md", "secret.md"],
    ["../../etc/passwd", "etc_passwd.md"],
    ["a:b*c?.md", "a_b_c_.md"],
    ["这居然...太强了.md", "这居然.太强了.md"],
    ["CON.md", "video-note.md"],
    ["..", "video-note.md"],
    ["", "video-note.md"]
  ])("sanitizeNoteArtifactFileName：%j -> %j", (input, expected) => {
    expect(sanitizeNoteArtifactFileName(input)).toBe(expected);
  });

  it.each([
    ["测试标题.md", "BiliScript-Notes", "BiliScript-Notes/测试标题.md"],
    ["测试标题.md", "", "测试标题.md"],
    ["../secret.md", "../../etc", "etc/secret.md"],
    ["a:b*c?.md", "D:\\Notes\\Sub", "Notes/Sub/a_b_c_.md"],
    ["note.md", "a//b/..", "a/b/note.md"]
  ])("buildSafeNoteDownloadPath(%j, %j) -> %j", (fileName, subdir, expected) => {
    const built = buildSafeNoteDownloadPath(fileName, subdir);
    expect(built).toBe(expected);
    expect(built.startsWith("/")).toBe(false);
    expect(built.includes("..")).toBe(false);
    expect(built.includes(":")).toBe(false);
  });

  it("encodeMarkdownAsDataUrl 支持多字节中文与大体积文本分块编码无损还原", () => {
    const payload = `# 视频笔记\n\n${"中文内容 🚀 03:15\n".repeat(4000)}`;
    const dataUrl = encodeMarkdownAsDataUrl(payload);
    expect(decodeMarkdownDataUrl(dataUrl)).toBe(payload);
  });
});

describe("createDownloadNoteArtifactHandler 后台静默落盘处理器", () => {
  it("已授权 downloads 权限时携带子目录调用 chrome.downloads.download 并返回 downloadId", async () => {
    const contains = vi.fn(async () => true);
    const download = vi.fn(async (_opts: DownloadOptions) => 77);
    const markdown = "# 测试视频笔记\n\n正文内容";

    const { decision, responsePromise } = invokeDownloadHandler(
      { permissions: { contains }, downloads: { download } },
      { type: "download-note-artifact", markdown, fileName: "测试标题.md", subdir: "BiliScript-Notes" }
    );

    expect(decision).toBe("hold");
    const response = await responsePromise;
    expect(response).toEqual({ ok: true, downloadId: 77 });
    expect(contains).toHaveBeenCalledWith({ permissions: ["downloads"] });
    expect(download).toHaveBeenCalledTimes(1);

    const options = download.mock.calls[0]![0];
    expect(options.filename).toBe("BiliScript-Notes/测试标题.md");
    expect(options.saveAs).toBe(false);
    expect(options.conflictAction).toBe("uniquify");
    expect(decodeMarkdownDataUrl(options.url)).toBe(markdown);
  });

  it("未指定 subdir 时落盘到相对根文件名", async () => {
    const contains = vi.fn(async () => true);
    const download = vi.fn(async (_opts: DownloadOptions) => 88);

    const { responsePromise } = invokeDownloadHandler(
      { permissions: { contains }, downloads: { download } },
      { type: "download-note-artifact", markdown: "# 笔记", fileName: "flat-note.md" }
    );

    expect(await responsePromise).toEqual({ ok: true, downloadId: 88 });
    expect(download.mock.calls[0]![0].filename).toBe("flat-note.md");
  });

  it("对包含路径穿越与非法字符的 subdir 与 fileName 执行严格二次清洗", async () => {
    const contains = vi.fn(async () => true);
    const download = vi.fn(async (_opts: DownloadOptions) => 99);

    const { responsePromise } = invokeDownloadHandler(
      { permissions: { contains }, downloads: { download } },
      {
        type: "download-note-artifact",
        markdown: "# 笔记",
        fileName: "../secret:name*.md",
        subdir: "D:\\..\\..\\Notes\\<bad>"
      }
    );

    expect(await responsePromise).toEqual({ ok: true, downloadId: 99 });
    const filename = download.mock.calls[0]![0].filename ?? "";
    expect(filename).toBe("Notes/bad/secret_name_.md");
    expect(filename.startsWith("/")).toBe(false);
    expect(filename.includes("..")).toBe(false);
  });

  it("未授 downloads 权限时返回 fallbackRequired: true 且不调用 downloads.download", async () => {
    const contains = vi.fn(async () => false);
    const download = vi.fn(async () => 1);

    const { responsePromise } = invokeDownloadHandler(
      { permissions: { contains }, downloads: { download } },
      { type: "download-note-artifact", markdown: "# 笔记", fileName: "note.md", subdir: "Notes" }
    );

    expect(await responsePromise).toEqual({ ok: false, fallbackRequired: true });
    expect(download).not.toHaveBeenCalled();
  });

  it("permissions.contains 缺失或抛错，或 chrome.downloads 不可用时返回 fallbackRequired: true", async () => {
    const missingContains = invokeDownloadHandler(
      { downloads: { download: vi.fn(async () => 1) } },
      { type: "download-note-artifact", markdown: "# 笔记", fileName: "note.md" }
    );
    expect(await missingContains.responsePromise).toEqual({ ok: false, fallbackRequired: true });

    const throwingContains = invokeDownloadHandler(
      {
        permissions: { contains: vi.fn(async () => { throw new Error("contains failed"); }) },
        downloads: { download: vi.fn(async () => 1) }
      },
      { type: "download-note-artifact", markdown: "# 笔记", fileName: "note.md" }
    );
    expect(await throwingContains.responsePromise).toEqual({ ok: false, fallbackRequired: true });

    const missingDownloadsApi = invokeDownloadHandler(
      { permissions: { contains: vi.fn(async () => true) }, downloads: undefined },
      { type: "download-note-artifact", markdown: "# 笔记", fileName: "note.md" }
    );
    expect(await missingDownloadsApi.responsePromise).toEqual({ ok: false, fallbackRequired: true });
  });

  it("chrome.downloads.download 异常时干净捕获并返回 ok: false 与错误信息", async () => {
    const contains = vi.fn(async () => true);
    const download = vi.fn(async () => {
      throw new Error("disk full");
    });

    const { responsePromise } = invokeDownloadHandler(
      { permissions: { contains }, downloads: { download } },
      { type: "download-note-artifact", markdown: "# 笔记", fileName: "note.md" }
    );

    expect(await responsePromise).toEqual({ ok: false, error: "disk full" });
  });

  it("markdown 为空或非字符串时同步返回 answered 与错误且不调用权限或下载 API", async () => {
    const contains = vi.fn(async () => true);
    const download = vi.fn(async () => 1);

    const { decision, responsePromise } = invokeDownloadHandler(
      { permissions: { contains }, downloads: { download } },
      { type: "download-note-artifact", markdown: "", fileName: "note.md" }
    );

    expect(decision).toBe("answered");
    expect(await responsePromise).toEqual({ ok: false, error: "笔记内容为空" });
    expect(contains).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
});
