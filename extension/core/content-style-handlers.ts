import { withOkResponse } from "./provider-handlers.js";
import type {
  BackgroundMessage,
  BackgroundMessageHandler,
  BackgroundResponseOf,
  MessageReplyDecision,
  MessageSender
} from "../shared/messaging-protocol.js";

export const ALLOWED_CONTENT_STYLE_PATHS = [
  "entry/styles/tokens-primitive.css",
  "entry/styles/reader.css",
  "entry/styles/reader-gate.css",
  "entry/styles/player-ai.css",
  "entry/styles/interpret-subtitles.css",
  "entry/styles/reader-settings-shell.css",
  "entry/styles/reader-settings-rows.css",
  "entry/styles/reader-settings-providers.css",
  "entry/styles/custom-select.css",
  "entry/styles/toggle-switch.css",
  "entry/styles/bilingual-subtitles.css",
  "entry/styles/github-markdown.css",
  "entry/styles/github-markdown-theme.css",
  "entry/styles/reader-chat.css"
] as const;

export type AllowedContentStylePath = (typeof ALLOWED_CONTENT_STYLE_PATHS)[number];

const ALLOWED_CONTENT_STYLE_SET = new Set<string>(ALLOWED_CONTENT_STYLE_PATHS);
const MAX_STYLE_BATCH_SIZE = ALLOWED_CONTENT_STYLE_PATHS.length * 2;
const HOST_PERMISSION_ERROR_RE =
  /cannot access contents of url|missing host permission|must request permission/i;

export interface ContentStyleScriptingAdapter {
  insertCSS?: (injection: {
    target: { tabId: number; frameIds: number[] };
    files: string[];
  }) => Promise<void>;
  removeCSS?: (injection: {
    target: { tabId: number; frameIds: number[] };
    files: string[];
  }) => Promise<void>;
}

export interface ContentStyleHostAdapter {
  scripting?: ContentStyleScriptingAdapter;
  getRuntimeUrl: (path: string) => string;
  fetchImpl?: typeof fetch;
}

export interface ContentStyleHandlers {
  insert: BackgroundMessageHandler<"content-style-insert">;
  remove: BackgroundMessageHandler<"content-style-remove">;
  read: BackgroundMessageHandler<"content-style-read">;
}

type StyleMsg<T extends "content-style-insert" | "content-style-remove" | "content-style-read"> =
  Extract<BackgroundMessage, { type: T }>;
type StyleReply<T extends "content-style-insert" | "content-style-remove" | "content-style-read"> =
  (response: BackgroundResponseOf<T>) => void;

export function isAllowedContentStylePath(value: unknown): value is AllowedContentStylePath {
  return typeof value === "string" && ALLOWED_CONTENT_STYLE_SET.has(value);
}

export function validateContentStyleFiles(rawFiles: unknown): AllowedContentStylePath[] | null {
  if (!Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.length > MAX_STYLE_BATCH_SIZE) {
    return null;
  }
  const normalized: AllowedContentStylePath[] = [];
  const seen = new Set<string>();
  for (const raw of rawFiles) {
    if (!isAllowedContentStylePath(raw)) {
      return null;
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      normalized.push(raw);
    }
  }
  return normalized.length > 0 ? normalized : null;
}

export function resolveSenderFrameTarget(
  sender: MessageSender | undefined
): { tabId: number; frameIds: number[] } | null {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId <= 0) {
    return null;
  }
  const rawFrameId = sender?.frameId;
  if (rawFrameId !== undefined) {
    if (typeof rawFrameId !== "number" || !Number.isInteger(rawFrameId) || rawFrameId < 0) {
      return null;
    }
  }
  return {
    tabId,
    frameIds: [rawFrameId ?? 0]
  };
}

export function createContentStyleHandlers(adapter: ContentStyleHostAdapter): ContentStyleHandlers {
  const cssTextCache = new Map<AllowedContentStylePath, string>();
  const fetchFn = adapter.fetchImpl ?? ((input: RequestInfo | URL) => fetch(input));

  async function readStyleText(path: AllowedContentStylePath): Promise<string> {
    const cached = cssTextCache.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const url = adapter.getRuntimeUrl(path);
    const response = await fetchFn(url);
    if (!response.ok) {
      throw new Error(`读取样式资源失败: ${path} (${response.status})`);
    }
    const text = await response.text();
    cssTextCache.set(path, text);
    return text;
  }

  async function readStyleMap(files: readonly AllowedContentStylePath[]): Promise<Record<string, string>> {
    const entries = await Promise.all(
      files.map(async (file) => [file, await readStyleText(file)] as const)
    );
    const styles: Record<string, string> = {};
    for (const [file, cssText] of entries) {
      styles[file] = cssText;
    }
    return styles;
  }

  function insert(
    message: StyleMsg<"content-style-insert">,
    sender: MessageSender,
    sendResponse: StyleReply<"content-style-insert">
  ): MessageReplyDecision {
    const target = resolveSenderFrameTarget(sender);
    if (!target) {
      sendResponse({ ok: false, error: "仅支持标签页内请求注入样式" });
      return "answered";
    }
    const files = validateContentStyleFiles(message.files);
    if (!files) {
      sendResponse({ ok: false, error: "样式路径不在白名单内" });
      return "answered";
    }
    const insertCSS = adapter.scripting?.insertCSS;
    if (typeof insertCSS !== "function") {
      sendResponse({ ok: false, error: "scripting.insertCSS 不可用" });
      return "answered";
    }
    withOkResponse(
      (async () => {
        try {
          await insertCSS({ target, files });
          return { ok: true };
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          if (!HOST_PERMISSION_ERROR_RE.test(messageText)) {
            throw error;
          }
          const styles = await readStyleMap(files);
          return { ok: true, styles };
        }
      })(),
      sendResponse
    );
    return "hold";
  }

  function remove(
    message: StyleMsg<"content-style-remove">,
    sender: MessageSender,
    sendResponse: StyleReply<"content-style-remove">
  ): MessageReplyDecision {
    const target = resolveSenderFrameTarget(sender);
    if (!target) {
      sendResponse({ ok: false, error: "仅支持标签页内请求移除样式" });
      return "answered";
    }
    const files = validateContentStyleFiles(message.files);
    if (!files) {
      sendResponse({ ok: false, error: "样式路径不在白名单内" });
      return "answered";
    }
    const removeCSS = adapter.scripting?.removeCSS;
    if (typeof removeCSS !== "function") {
      sendResponse({ ok: false, error: "scripting.removeCSS 不可用" });
      return "answered";
    }
    withOkResponse(
      (async () => {
        await removeCSS({ target, files });
        return { ok: true };
      })(),
      sendResponse
    );
    return "hold";
  }

  function read(
    message: StyleMsg<"content-style-read">,
    sender: MessageSender,
    sendResponse: StyleReply<"content-style-read">
  ): MessageReplyDecision {
    const target = resolveSenderFrameTarget(sender);
    if (!target) {
      sendResponse({ ok: false, error: "仅支持标签页内请求读取样式" });
      return "answered";
    }
    const files = validateContentStyleFiles(message.files);
    if (!files) {
      sendResponse({ ok: false, error: "样式路径不在白名单内" });
      return "answered";
    }
    withOkResponse(
      (async () => ({ ok: true, styles: await readStyleMap(files) }))(),
      sendResponse
    );
    return "hold";
  }

  return { insert, remove, read };
}
