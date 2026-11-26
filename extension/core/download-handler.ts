import { normalizeNoteDownloadSubdir } from "./validators.js";
import { withOkResponse } from "./provider-handlers.js";
import type { PermissionApiLike } from "./host-permission-handlers.js";
import type {
  BackgroundMessage,
  BackgroundMessageHandler,
  BackgroundResponseOf,
  MessageReplyDecision,
  MessageSender
} from "../shared/messaging-protocol.js";

const DEFAULT_NOTE_ARTIFACT_FILENAME = "video-note.md";
const MAX_NOTE_ARTIFACT_FILENAME_LENGTH = 120;
const BASE64_CHUNK_SIZE = 0x4000;
const WINDOWS_RESERVED_FILENAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export interface DownloadsApiLike {
  download?: (options: {
    url: string;
    filename?: string;
    saveAs?: boolean;
    conflictAction?: "uniquify" | "overwrite" | "prompt";
  }) => Promise<number> | number;
}

export interface DownloadHandlerHostAdapter {
  permissions?: Pick<PermissionApiLike, "contains">;
  downloads?: DownloadsApiLike;
}

export function sanitizeNoteArtifactFileName(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/]+/g, "_")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[._\s]+/, "")
    .replace(/[. ]+$/g, "");
  const withoutExt = cleaned
    .replace(/\.md$/i, "")
    .replace(/[. ]+$/g, "")
    .slice(0, MAX_NOTE_ARTIFACT_FILENAME_LENGTH - 3)
    .replace(/[. ]+$/g, "");
  if (!withoutExt || withoutExt === "." || WINDOWS_RESERVED_FILENAME_RE.test(withoutExt)) {
    return DEFAULT_NOTE_ARTIFACT_FILENAME;
  }
  return `${withoutExt}.md`;
}

export function buildSafeNoteDownloadPath(fileName: unknown, subdir?: unknown): string {
  const safeSubdir = normalizeNoteDownloadSubdir(subdir);
  const safeFileName = sanitizeNoteArtifactFileName(fileName);
  return safeSubdir ? `${safeSubdir}/${safeFileName}` : safeFileName;
}

export function encodeMarkdownAsDataUrl(markdown: string): string {
  const bytes = new TextEncoder().encode(markdown);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return `data:text/markdown;charset=utf-8;base64,${btoa(binary)}`;
}

type DownloadMessage = Extract<BackgroundMessage, { type: "download-note-artifact" }>;
type DownloadReply = (response: BackgroundResponseOf<"download-note-artifact">) => void;

export function createDownloadNoteArtifactHandler(
  host: DownloadHandlerHostAdapter
): BackgroundMessageHandler<"download-note-artifact"> {
  return function handleDownloadNoteArtifact(
    message: DownloadMessage,
    _sender: MessageSender,
    sendResponse: DownloadReply
  ): MessageReplyDecision {
    if (typeof message.markdown !== "string" || !message.markdown) {
      sendResponse({ ok: false, error: "笔记内容为空" });
      return "answered";
    }
    withOkResponse(
      (async () => {
        const permissionsApi = host.permissions;
        if (typeof permissionsApi?.contains !== "function") {
          return { ok: false, fallbackRequired: true };
        }
        let granted = false;
        try {
          granted = Boolean(await permissionsApi.contains({ permissions: ["downloads"] }));
        } catch {
          return { ok: false, fallbackRequired: true };
        }
        const downloadsApi = host.downloads;
        if (!granted || typeof downloadsApi?.download !== "function") {
          return { ok: false, fallbackRequired: true };
        }
        const filename = buildSafeNoteDownloadPath(message.fileName, message.subdir);
        const url = encodeMarkdownAsDataUrl(message.markdown);
        const downloadId = await downloadsApi.download({
          url,
          filename,
          saveAs: false,
          conflictAction: "uniquify"
        });
        return { ok: true, downloadId };
      })(),
      sendResponse
    );
    return "hold";
  };
}
