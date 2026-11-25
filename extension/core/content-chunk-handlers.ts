import { withOkResponse } from "./provider-handlers.js";
import { resolveSenderFrameTarget } from "./content-style-handlers.js";
import type {
  BackgroundMessage,
  BackgroundMessageHandler,
  BackgroundResponseOf,
  MessageReplyDecision,
  MessageSender
} from "../shared/messaging-protocol.js";

export const ALLOWED_CONTENT_CHUNK_FILES = {
  "g-shared": ["entry/chunks/g-shared.iife.js"],
  "g-buttons": ["entry/chunks/g-buttons.iife.js"],
  "g-app": ["entry/chunks/g-app.iife.js"],
  "g-mermaid": ["entry/chunks/g-mermaid.iife.js"],
  "g-math": ["entry/chunks/g-math.iife.js"],
  "g-live-room": ["entry/chunks/g-live-room.iife.js"]
} as const satisfies Record<string, readonly string[]>;

export type AllowedContentChunkId = keyof typeof ALLOWED_CONTENT_CHUNK_FILES;

export interface ContentChunkScriptingAdapter {
  executeScript?: (injection: {
    target: { tabId: number; frameIds: number[] };
    files: string[];
  }) => Promise<unknown>;
}

export interface ContentChunkHostAdapter {
  scripting?: ContentChunkScriptingAdapter;
}

export interface ContentChunkHandlers {
  load: BackgroundMessageHandler<"content-chunk-load">;
}

type ChunkLoadMsg = Extract<BackgroundMessage, { type: "content-chunk-load" }>;
type ChunkLoadReply = (response: BackgroundResponseOf<"content-chunk-load">) => void;

export function isAllowedContentChunkId(value: unknown): value is AllowedContentChunkId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(ALLOWED_CONTENT_CHUNK_FILES, value)
  );
}

export function createContentChunkHandlers(
  adapter: ContentChunkHostAdapter
): ContentChunkHandlers {
  function load(
    message: ChunkLoadMsg,
    sender: MessageSender,
    sendResponse: ChunkLoadReply
  ): MessageReplyDecision {
    const target = resolveSenderFrameTarget(sender);
    if (!target) {
      sendResponse({ ok: false, error: "仅支持标签页内请求注入脚本分组" });
      return "answered";
    }
    if (!isAllowedContentChunkId(message.chunkId)) {
      sendResponse({ ok: false, error: "脚本分组不在静态白名单内" });
      return "answered";
    }
    const executeScript = adapter.scripting?.executeScript;
    if (typeof executeScript !== "function") {
      sendResponse({ ok: false, error: "scripting.executeScript 不可用" });
      return "answered";
    }
    const files = [...ALLOWED_CONTENT_CHUNK_FILES[message.chunkId]];
    withOkResponse(
      (async () => {
        await executeScript({ target, files });
        return { ok: true };
      })(),
      sendResponse
    );
    return "hold";
  }

  return { load };
}
