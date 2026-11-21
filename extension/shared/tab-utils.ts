import { sleep } from "./utils.js";
import type { ContentScriptMessage, ResponseOf } from "./messaging-protocol.js";

interface WaitForTabCompleteOptions {
  timeoutMs?: number;
  polls?: number;
  pollMs?: number;
}

export async function waitForTabComplete(
  tabId: number,
  { timeoutMs = 15000, polls = 0, pollMs = 250 }: WaitForTabCompleteOptions = {}
): Promise<boolean> {
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === "complete") {
      return true;
    }
    if (polls > 0) {
      if (attempt + 1 >= polls) {
        return false;
      }
    } else if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("视频页面加载超时");
    }
    await sleep(pollMs);
  }
}

export function sendMessageToTab<M extends ContentScriptMessage>(
  tabId: number,
  message: M
): Promise<ResponseOf<M>> {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (resp: unknown) => {
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
