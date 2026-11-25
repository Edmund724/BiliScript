import { sendMessageToTab, waitForTabComplete } from "../shared/tab-utils.js";
import { createBackgroundContentOrchestrator } from "../core/background-content-orchestration.js";

export const EXPECTED_CONTENT_SCRIPT_VERSION = chrome.runtime.getManifest().version || "";

async function probeContentScriptVersionOnce(tabId: number) {
  const probe = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => (globalThis as Record<string, unknown>).__BILISCRIPT_CONTENT_SCRIPT_LOADED__ || ""
  });
  return String(probe?.[0]?.result || "");
}

async function injectReaderAssets(tabId: number) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["entry/content-resident.iife.js"]
  });
}

async function isTabReaderModeOff(tabId: number) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) {
    return false;
  }
  try {
    return new URL(tab.url).searchParams.get("biliscript_reader") !== "1";
  } catch {
    return false;
  }
}

export const {
  ensureReaderContentReady,
  probeContentScriptVersion,
  injectReaderContent,
  triggerReaderModeInTab,
  triggerReaderModeCloseInTab,
  triggerReaderModeToggleInTab
} = createBackgroundContentOrchestrator({
  probeOnce: probeContentScriptVersionOnce,
  injectAssets: injectReaderAssets,
  reloadTab: (tabId: number) => chrome.tabs.reload(tabId),
  waitForTabComplete,
  sendMessageToTab,
  isTabReaderModeOff,
  canInject: (tabId: number) => Boolean(chrome.scripting) && Boolean(tabId),
  expectedVersion: EXPECTED_CONTENT_SCRIPT_VERSION
});
