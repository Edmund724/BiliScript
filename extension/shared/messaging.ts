// BILISCRIPT_DUAL_INSTANCE_STATEFUL
import type {
  BackgroundMessage,
  ContentScriptMessage,
  OffloadTaskMessage,
  OffloadTaskResponse,
  ResponseOf,
  SendResponse
} from "./messaging-protocol.js";

interface Runtime {
  sendMessage(message: unknown, responseCallback?: (response: unknown) => void): void;
  lastError?: { message?: string };
}

export function sendRuntimeMessage<M extends BackgroundMessage | ContentScriptMessage>(
  message: M
): Promise<ResponseOf<M>> {
  return new Promise((resolve, reject) => {
    try {
      (chrome.runtime as Runtime).sendMessage(message, (resp) => {
        if ((chrome.runtime as Runtime).lastError) {
          reject(new Error((chrome.runtime as Runtime).lastError?.message));
          return;
        }
        resolve(resp as ResponseOf<M>);
      });
    } catch (error) {
      reject(error);
    }
  });
}

export function sendOffloadMessage(
  message: OffloadTaskMessage
): Promise<OffloadTaskResponse> {
  return sendRuntimeMessage(message);
}

interface PostMessageLikePort {
  postMessage(message: unknown): void;
}

type ContentMessageDispatcher = (rawMessage: unknown, sendResponse: SendResponse) => boolean;

const DISPATCHER_SLOT_KEY = "__BILISCRIPT_CONTENT_SCRIPT_DISPATCHER__";

function dispatcherHost(): Record<string, ContentMessageDispatcher | null | undefined> {
  return globalThis as unknown as Record<string, ContentMessageDispatcher | null | undefined>;
}

export function registerContentScriptDispatcher(dispatcher: ContentMessageDispatcher): void {
  dispatcherHost()[DISPATCHER_SLOT_KEY] = dispatcher;
}

export function dispatchContentScriptMessage(
  rawMessage: unknown,
  sendResponse: SendResponse
): boolean {
  const dispatcher = dispatcherHost()[DISPATCHER_SLOT_KEY];
  return dispatcher ? dispatcher(rawMessage, sendResponse) : false;
}

export function safePostMessage(port: PostMessageLikePort, message: unknown): void {
  try {
    port.postMessage(message);
  } catch {
  }
}

export function consumeRuntimeLastError(): string | undefined {
  return (globalThis.chrome?.runtime as Runtime | undefined)?.lastError?.message;
}
