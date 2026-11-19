// tab-utils.ts — tab 级通信与加载等待原语（纯传输叶，零域依赖）。
//
// Exported functions:
//   - waitForTabComplete(tabId, options)       polls chrome.tabs.get until "complete"
//   - sendMessageToTab(tabId, message)         typed one-shot tabs.sendMessage as a promise
import { sleep } from "./utils.js";
import type { ContentScriptMessage, ResponseOf } from "./messaging-protocol.js";

interface WaitForTabCompleteOptions {
  timeoutMs?: number;
  polls?: number;
  pollMs?: number;
}

// 轮询等待 tab 加载完成（chrome.tabs.get 直到 status === "complete"）。两种终止
// 条件按调用方显式二选一：
//   - options.polls > 0：最多轮询 polls 次（间隔 options.pollMs），耗尽返回
//     false，失败处理交给调用方（background 注入流程用）；
//   - 否则限时 options.timeoutMs（默认 15000），超时抛错（sidepanel / seek
//     流程用，catch 后统一提示）。
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

// 单发 tabs.sendMessage（callback 包成 promise，返回类型按 ContentScriptMessage 经
// ResponseOf<M> 静态推断；同步抛错与 chrome.runtime.lastError 统一 reject）。
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
