// extension/entry/unsupported-page-feedback.ts
// 非支持页工具栏可见反馈（工单 04）：用户在打不开文摘面板的页面点击扩展图标时，
// 立刻拿到原因——标签页级「!」徽标 + 图标标题引导（前往普通视频页或稍后再看页）；
// www.bilibili.com 已有 host 权限覆盖的页面（首页/番剧等）额外注入一条顶部居中、
// 约 6 秒消失的页内提示。搜索/空间等未获 host 权限的页面只用徽标与标题，不注入。
// 全部触点在本模块；entry/background.ts 只接线点击与导航清理。
// 可选链守卫同 chrome.action 先例：既有测试环境的 chrome stub 可能缺这些 API。

import { logWarnAlways } from "../shared/logging.js";

export const UNSUPPORTED_PAGE_BADGE_TEXT = "!";
// 图标标题（tooltip）引导：与 manifest.action.default_title 同以 BiliScript 开头。
export const UNSUPPORTED_PAGE_ACTION_TITLE =
  "BiliScript｜当前页面不支持，请前往普通视频页或稍后再看页";
export const UNSUPPORTED_PAGE_TOAST_MESSAGE =
  "当前页面打不开文摘面板，请前往普通视频页或稍后再看页";
export const UNSUPPORTED_PAGE_TOAST_DURATION_MS = 6000;

const BADGE_BACKGROUND_COLOR = "#D92D20";

// 非支持页点击：tab 级徽标 + 标题引导。徽标先于注入设置——注入失败时徽标/标题
// 仍生效（反馈不随注入失败丢失，工单 04 验收 5）；三项各自 best-effort，
// 单项失败不阻断其余。
export async function applyUnsupportedPageFeedback(tabId: number): Promise<void> {
  const steps: Array<() => unknown> = [
    () => chrome.action?.setBadgeBackgroundColor?.({ tabId, color: BADGE_BACKGROUND_COLOR }),
    () => chrome.action?.setBadgeText?.({ tabId, text: UNSUPPORTED_PAGE_BADGE_TEXT }),
    () => chrome.action?.setTitle?.({ tabId, title: UNSUPPORTED_PAGE_ACTION_TITLE })
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      logWarnAlways("[BILISCRIPT] unsupported-page badge/title feedback failed", error);
    }
  }
}

// 清徽标并恢复默认标题：空 badge text 与空 title 都是回落默认（Chrome 语义），
// 无需记住 manifest.default_title 字面量。
export async function clearUnsupportedPageFeedback(tabId: number): Promise<void> {
  const steps: Array<() => unknown> = [
    () => chrome.action?.setBadgeText?.({ tabId, text: "" }),
    () => chrome.action?.setTitle?.({ tabId, title: "" })
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      logWarnAlways("[BILISCRIPT] unsupported-page feedback clear failed", error);
    }
  }
}

// www.bilibili.com 的 host 权限由 manifest 静态持有（首页/番剧等整站覆盖），
// 命中才可安全注入；search./space. 等子域与其他站点不在权限内，只走徽标+标题。
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

// 页内提示渲染：顶部居中一次性 UI，不拉 reader 壳、不导航。本函数经
// executeScript 序列化进目标页执行，必须自包含——不得闭包引用模块作用域。
// 重复点击复用同一节点并复位计时器（重新计满 6 秒），同时只保留一个提示。
// 计时器句柄挂 globalThis（isolated world 内稳定），键名绕开
// build-content.js 的 *_SLOT_KEY 扫描约定——本模块只在 SW 图，不进 content 双实例守卫。
export function renderUnsupportedPageToast(message: string, durationMs: number): void {
  interface ToastSlot {
    el: HTMLElement;
    timer: ReturnType<typeof setTimeout>;
  }
  const host = globalThis as unknown as {
    __BILISCRIPT_UNSUPPORTED_PAGE_TOAST__?: ToastSlot;
  };
  const previous = host.__BILISCRIPT_UNSUPPORTED_PAGE_TOAST__;
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
    "background:rgba(24,25,28,0.92)",
    "color:#ffffff",
    "font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "box-shadow:0 4px 16px rgba(0,0,0,0.25)",
    "pointer-events:none"
  ].join(";");
  (document.body || document.documentElement).appendChild(el);
  host.__BILISCRIPT_UNSUPPORTED_PAGE_TOAST__ = {
    el,
    timer: setTimeout(() => el.remove(), durationMs)
  };
}
