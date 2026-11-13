// extension/search/opt-in-notice.ts
// 联网搜索首次授权闸（spec §6.7 / 票 11）：对话发送与选区解释共用同一套
// 标题 / 说明 / 双动作文案。需要区分视图销毁的消费端使用 resolveWebSearchOptIn。
//
// 事务步骤：
//   ① 本轮未开启搜索（开关关）→ 直接放行「本轮不搜索」，不弹层；
//   ② 全局偏好（settings.webSearchEnabled）已关闭时，调用方残留的开启态只按「本轮
//      不搜索」处理、不再询问——用户拒绝过授权或主动关掉开关后，下一条消息不重复
//      弹层；只有重新开启（偏好回到 true）才会再次询问；
//   ③ 已置位 searchOptInNoticeAcknowledged → 直接放行搜索；
//   ④ 未置位：先查当前搜索链是否含付费平台（resolve-search-provider 的候选 access，
//      只读本地配置、不发查询词），再经 ui/confirm-dialog.ts 弹「允许联网搜索？」：
//      明确标题 + 查询词外发说明（链可能命中付费平台时追加费用提示，只提示会产生
//      费用、计费以平台为准，不写价格）+「允许并继续 / 关闭联网搜索」双动作；
//   ⑤ 同意 → 持久化 searchOptInNoticeAcknowledged: true（写失败静默吞掉：本轮照常
//      带搜索继续，不报成功、不置任何本地缓存位，下次仍会询问）；拒绝 → 持久化
//      webSearchEnabled: false 关闭联网偏好（既有对话开关随存储变更同步），本轮降级
//      为不搜索；
//   ⑥ 阅读视图未挂载按「本轮不搜索」降级；视图销毁只取消，不写授权位或联网偏好。
// 说明内容与 PRIVACY.md 同一套词——那两处各自持有文案，不 import 本常量
//（跨越渲染层与文档面）。
import { getSettings } from "../core/runtime.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { ids } from "../shared/dom-ids.js";
import { confirmDialogWithResult, getConfirmDialogViewGeneration } from "../ui/confirm-dialog.js";

export const SEARCH_OPT_IN_TITLE = "允许联网搜索？";

export const SEARCH_OPT_IN_NOTICE_MESSAGE =
  "联网搜索会把查询词发往内置的免 Key 服务（Tavily / Firecrawl / AnySearch / Parallel）以及你配置过 Key 的搜索平台；关闭搜索开关可随时撤回，删除对应平台记录可停止向其发送查询。";

// 付费提示（票 11）：当前链可能命中付费平台时提示会产生费用，具体计费以平台为准
// ——不写价格、不写成价格承诺。
export const SEARCH_OPT_IN_PAID_NOTICE =
  "当前搜索链可能命中付费搜索平台，使用付费平台会产生费用；具体计费方式以该平台为准。";

export const SEARCH_OPT_IN_CONFIRM_TEXT = "允许并继续";
export const SEARCH_OPT_IN_DECLINE_TEXT = "关闭联网搜索";
export const SEARCH_OPT_IN_DECLINED_NOTICE = "已关闭联网搜索，可在输入区重新开启";

export type WebSearchOptInResult = "granted" | "skipped" | "declined" | "view-destroyed";

// 当前搜索链是否可能命中付费平台：链解析单源在 SW（resolve-search-provider，
// 付费平台判定见 core/presets.ts 的 access），这里只读候选的 access——不发查询词、
// 不执行搜索；解析失败 / 未配置一律按「不含付费平台」处理，不阻断授权。
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

export async function resolveWebSearchOptIn(enabled?: boolean): Promise<WebSearchOptInResult> {
  if (enabled === false) {
    return "skipped";
  }
  const viewGeneration = getConfirmDialogViewGeneration();
  const settings = await getSettings();
  if (getConfirmDialogViewGeneration() !== viewGeneration) {
    return "view-destroyed";
  }
  const preferenceEnabled = settings.webSearchEnabled === true;
  // 全局偏好已关：不弹授权（拒绝过的下一条消息不再重复询问），本轮也不带搜索。
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
  const view = document.getElementById(ids.readingView);
  // 没有可弹的界面：按本轮不搜索降级，不关闭偏好。
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
  // 明确拒绝：关闭联网偏好（既有开关经存储变更同步），下一轮不再询问。
  await sendRuntimeMessage({
    type: "save-settings",
    settings: { webSearchEnabled: false }
  }).catch(() => null);
  return getConfirmDialogViewGeneration() === viewGeneration ? "declined" : "view-destroyed";
}

export async function ensureWebSearchOptIn(enabled?: boolean): Promise<boolean> {
  return await resolveWebSearchOptIn(enabled) === "granted";
}
