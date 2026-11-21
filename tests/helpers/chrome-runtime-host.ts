import { vi, type Mock } from "vitest";
import { createMemoryStorageArea, type ChromeHostStorageArea } from "./memory-storage-area.js";

export type RuntimeReplies = Record<string, unknown | ((message: unknown) => unknown)>;

const UNREGISTERED = Symbol("unregistered-runtime-message");

export interface RuntimeReplyOptions {
  fallback?: unknown;
  onSend?: (message: unknown) => void;
}

function replyFor(replies: RuntimeReplies, fallback: unknown, message: unknown): unknown {
  const type = String((message as { type?: unknown } | null)?.type ?? "");
  if (!Object.prototype.hasOwnProperty.call(replies, type)) {
    if (fallback === UNREGISTERED) {
      throw new Error(`未登记的 runtime 消息类型：${type === "" ? "(缺少 type)" : type}`);
    }
    return fallback;
  }
  const reply = replies[type];
  return typeof reply === "function" ? (reply as (message: unknown) => unknown)(message) : reply;
}

export function callbackStyleSendMessage(replies: RuntimeReplies = {}, options: RuntimeReplyOptions = {}): Mock {
  const fallback = "fallback" in options ? options.fallback : UNREGISTERED;
  return vi.fn((message: unknown, callback?: (response: unknown) => void) => {
    options.onSend?.(message);
    callback?.(replyFor(replies, fallback, message));
    return undefined;
  });
}

export interface SendMessageHost<M = unknown> {
  sendMessage: Mock;
  sent: M[];
}

export function installSendMessageHost<M = unknown>(
  replies: RuntimeReplies = {},
  options: RuntimeReplyOptions = {}
): SendMessageHost<M> {
  const sent: unknown[] = [];
  const sendMessage = callbackStyleSendMessage(replies, {
    ...options,
    onSend: (message) => {
      options.onSend?.(message);
      sent.push(message);
    }
  });
  (chrome as unknown as { runtime: { sendMessage: unknown } }).runtime.sendMessage = sendMessage;
  return { sendMessage, sent: sent as M[] };
}

export interface MinimalChromeHostOptions extends RuntimeReplyOptions {
  replies?: RuntimeReplies;
  replyStyle?: "promise" | "both";
  onConnect?: boolean;
  offscreen?: boolean;
  storage?: boolean;
  preserveExisting?: boolean;
}

export interface MinimalChromeHost {
  sendMessage: Mock;
  onConnectListeners: Array<(port: chrome.runtime.Port) => void>;
  storage: ChromeHostStorageArea | null;
}

export function installMinimalChromeHost(options: MinimalChromeHostOptions = {}): MinimalChromeHost {
  const fallback = "fallback" in options ? options.fallback : UNREGISTERED;
  const sendMessage =
    options.replyStyle === "both"
      ? vi.fn((message: unknown, callback?: (response: unknown) => void) => {
          const reply = replyFor(options.replies ?? {}, fallback, message);
          callback?.(reply);
          return Promise.resolve(reply);
        })
      : vi.fn(async (message: unknown) => replyFor(options.replies ?? {}, fallback, message));

  const onConnectListeners: Array<(port: chrome.runtime.Port) => void> = [];
  const storage = options.storage ? createMemoryStorageArea() : null;

  const previous = options.preserveExisting
    ? (globalThis.chrome as unknown as Record<string, unknown> | undefined)
    : undefined;
  const previousRuntime = (previous?.runtime ?? {}) as Record<string, unknown>;

  const runtime: Record<string, unknown> = { ...previousRuntime, sendMessage };
  if (options.onConnect) {
    runtime.onConnect = {
      addListener: (fn: (port: chrome.runtime.Port) => void) => onConnectListeners.push(fn)
    };
  }

  const chromeStub: Record<string, unknown> = { ...previous, runtime };
  if (storage) {
    chromeStub.storage = { ...(previous?.storage as Record<string, unknown> | undefined), local: storage };
  }
  if (options.offscreen) {
    chromeStub.offscreen = { closeDocument: vi.fn(async () => {}) };
  }
  vi.stubGlobal("chrome", chromeStub);

  return { sendMessage, onConnectListeners, storage };
}
