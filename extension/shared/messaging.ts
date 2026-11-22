// BILISCRIPT_DUAL_INSTANCE_STATEFUL
import type {
  BackgroundMessage,
  ContentScriptMessage,
  OffloadTaskMessage,
  OffloadTaskResponse,
  ResponseOf,
  SendResponse
} from "./messaging-protocol.js";

export function sendRuntimeMessage<M extends BackgroundMessage | ContentScriptMessage>(
  message: M
): Promise<ResponseOf<M>> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(resp as ResponseOf<M>);
      });
    } catch (error) {
      reject(error);
    }
  });
}

export async function sendRuntimeMessagePromise<M extends BackgroundMessage | ContentScriptMessage>(
  message: M
): Promise<ResponseOf<M>> {
  return (await chrome.runtime.sendMessage(message)) as ResponseOf<M>;
}

export function sendOffloadMessage(
  message: OffloadTaskMessage
): Promise<OffloadTaskResponse> {
  return sendRuntimeMessage(message);
}

type ContentMessageDispatcher = (rawMessage: unknown, sendResponse: SendResponse) => boolean;

const DISPATCHER_SLOT_KEY = "__BILISCRIPT_CONTENT_SCRIPT_DISPATCHER__";

function dispatcherHost(): Record<string, ContentMessageDispatcher | null | undefined> {
  return globalThis as unknown as Record<string, ContentMessageDispatcher | null | undefined>;
}

export function registerContentScriptDispatcher(dispatcher: ContentMessageDispatcher): void {
  dispatcherHost()[DISPATCHER_SLOT_KEY] = dispatcher;
}

export function dispatchContentScriptMessage<M extends ContentScriptMessage>(
  message: M,
  sendResponse: (response?: ResponseOf<M>) => void
): boolean {
  const dispatcher = dispatcherHost()[DISPATCHER_SLOT_KEY];
  return dispatcher ? dispatcher(message, sendResponse as SendResponse) : false;
}

export function safePostMessage(port: Pick<chrome.runtime.Port, "postMessage">, message: unknown): void {
  try {
    port.postMessage(message);
  } catch {
  }
}

export function consumeRuntimeLastError(): string | undefined {
  return globalThis.chrome?.runtime?.lastError?.message;
}
