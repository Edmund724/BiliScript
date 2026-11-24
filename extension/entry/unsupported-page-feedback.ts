import { logWarnAlways } from "../shared/logging.js";
import { isToastEligibleHostPage } from "../shared/site.js";

export { isToastEligibleHostPage };

export const UNSUPPORTED_PAGE_BADGE_TEXT = "!";
export const UNSUPPORTED_PAGE_ACTION_TITLE =
  "BiliScript｜当前页面不支持，请前往 B 站或 YouTube 视频页";
export const UNSUPPORTED_PAGE_TOAST_MESSAGE =
  "当前页面打不开文摘面板，请前往 B 站或 YouTube 视频页";
export const UNSUPPORTED_PAGE_TOAST_DURATION_MS = 6000;

const BADGE_BACKGROUND_COLOR = "#D92D20";

export async function applyUnsupportedPageFeedback(tabId: number): Promise<void> {
  const steps: Array<() => unknown> = [
    () => chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_BACKGROUND_COLOR }),
    () => chrome.action.setBadgeText({ tabId, text: UNSUPPORTED_PAGE_BADGE_TEXT }),
    () => chrome.action.setTitle({ tabId, title: UNSUPPORTED_PAGE_ACTION_TITLE })
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      logWarnAlways("[BILISCRIPT] unsupported-page badge/title feedback failed", error);
    }
  }
}

export async function clearUnsupportedPageFeedback(tabId: number): Promise<void> {
  const steps: Array<() => unknown> = [
    () => chrome.action.setBadgeText({ tabId, text: "" }),
    () => chrome.action.setTitle({ tabId, title: "" })
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      logWarnAlways("[BILISCRIPT] unsupported-page feedback clear failed", error);
    }
  }
}

export function isWwwBilibiliPage(url: unknown): boolean {
  try {
    return new URL(String(url || "")).hostname === "www.bilibili.com";
  } catch {
    return false;
  }
}

export async function showUnsupportedPageToast(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: renderUnsupportedPageToast,
    args: [UNSUPPORTED_PAGE_TOAST_MESSAGE, UNSUPPORTED_PAGE_TOAST_DURATION_MS]
  });
}

export function renderUnsupportedPageToast(message: string, durationMs: number): void {
  interface ToastSlot {
    el: HTMLElement;
    timer: ReturnType<typeof setTimeout>;
  }
  const TOAST_SLOT_KEY = "__BILISCRIPT_UNSUPPORTED_PAGE_TOAST__";
  const host = globalThis as unknown as Record<string, ToastSlot | undefined>;
  const previous = host[TOAST_SLOT_KEY];
  if (previous) {
    clearTimeout(previous.timer);
    if (previous.el.isConnected) {
      previous.el.textContent = message;
      previous.timer = setTimeout(() => previous.el.remove(), durationMs);
      return;
    }
  }
  const el = document.createElement("div");
  el.id = "biliscript-unsupported-toast";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.textContent = message;
  el.style.cssText = [
    "position:fixed",
    "top:16px",
    "left:50%",
    "transform:translateX(-50%)",
    "z-index:2147483000",
    "box-sizing:border-box",
    "max-width:80vw",
    "padding:10px 18px",
    "border-radius:8px",
    "corner-shape:superellipse(1.25)",
    "background:rgba(24,25,28,0.92)",
    "color:#ffffff",
    "font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "box-shadow:0 4px 16px rgba(0,0,0,0.25)",
    "pointer-events:none"
  ].join(";");
  (document.body || document.documentElement).appendChild(el);
  host[TOAST_SLOT_KEY] = {
    el,
    timer: setTimeout(() => el.remove(), durationMs)
  };
}
