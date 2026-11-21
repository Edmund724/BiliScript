import { getSettings } from "../core/runtime.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { ids } from "../shared/dom-ids.js";
import { confirmDialogWithResult, getConfirmDialogViewGeneration } from "../ui/confirm-dialog.js";

export const SEARCH_OPT_IN_TITLE = "允许联网搜索？";

export const SEARCH_OPT_IN_NOTICE_MESSAGE =
  "联网搜索会把查询词发往内置的免 Key 服务（Tavily / Firecrawl / AnySearch / Parallel）以及你配置过 Key 的搜索平台；关闭搜索开关可随时撤回，删除对应平台记录可停止向其发送查询。";

export const SEARCH_OPT_IN_PAID_NOTICE =
  "当前搜索链可能命中付费搜索平台，使用付费平台会产生费用；具体计费方式以该平台为准。";

export const SEARCH_OPT_IN_CONFIRM_TEXT = "允许并继续";
export const SEARCH_OPT_IN_DECLINE_TEXT = "关闭联网搜索";
export const SEARCH_OPT_IN_DECLINED_NOTICE = "已关闭联网搜索，可在输入区重新开启";

export type WebSearchOptInResult = "granted" | "skipped" | "declined" | "view-destroyed";

async function chainMayHitPaidPlatform(): Promise<boolean> {
  try {
    const response = await sendRuntimeMessage({ type: "resolve-search-provider" });
    if (!response?.ok || !Array.isArray(response.chain)) {
      return false;
    }
    return response.chain.some((candidate) => candidate?.provider?.access === "paid");
  } catch {
    return false;
  }
}

export interface ResolveWebSearchOptInOptions {
  mountHost?: HTMLElement | null;
}

export async function resolveWebSearchOptIn(
  enabled?: boolean,
  options: ResolveWebSearchOptInOptions = {}
): Promise<WebSearchOptInResult> {
  if (enabled === false) {
    return "skipped";
  }
  const viewGeneration = getConfirmDialogViewGeneration();
  const settings = await getSettings();
  if (getConfirmDialogViewGeneration() !== viewGeneration) {
    return "view-destroyed";
  }
  const preferenceEnabled = settings.webSearchEnabled === true;
  if (enabled === true && !preferenceEnabled) {
    return "skipped";
  }
  const turnEnabled = enabled ?? preferenceEnabled;
  if (!turnEnabled) {
    return "skipped";
  }
  if (settings.searchOptInNoticeAcknowledged) {
    return "granted";
  }
  if (typeof document === "undefined") {
    return "skipped";
  }
  const view = options.mountHost ?? document.getElementById(ids.readingView);
  if (!view) {
    return "skipped";
  }
  const paid = await chainMayHitPaidPlatform();
  if (!view.isConnected || getConfirmDialogViewGeneration() !== viewGeneration) {
    return "view-destroyed";
  }
  const result = await confirmDialogWithResult({
    title: SEARCH_OPT_IN_TITLE,
    message: paid
      ? `${SEARCH_OPT_IN_NOTICE_MESSAGE} ${SEARCH_OPT_IN_PAID_NOTICE}`
      : SEARCH_OPT_IN_NOTICE_MESSAGE,
    confirmText: SEARCH_OPT_IN_CONFIRM_TEXT,
    cancelText: SEARCH_OPT_IN_DECLINE_TEXT,
    mountHost: view
  });
  if (result === "view-destroyed") {
    return result;
  }
  if (result === "confirmed") {
    await sendRuntimeMessage({
      type: "save-settings",
      settings: { searchOptInNoticeAcknowledged: true }
    }).catch(() => null);
    return getConfirmDialogViewGeneration() === viewGeneration ? "granted" : "view-destroyed";
  }
  await sendRuntimeMessage({
    type: "save-settings",
    settings: { webSearchEnabled: false }
  }).catch(() => null);
  return getConfirmDialogViewGeneration() === viewGeneration ? "declined" : "view-destroyed";
}

export async function ensureWebSearchOptIn(
  enabled?: boolean,
  options: ResolveWebSearchOptInOptions = {}
): Promise<boolean> {
  return await resolveWebSearchOptIn(enabled, options) === "granted";
}
