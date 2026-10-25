// extension/search/opt-in-notice.ts
// 联网搜索首次授权闸（spec §6.7）：两个内容侧消费端（chat/chat-runtime.ts 的发送前、
// reader/explain-card.ts 的发起前）共用同一条 ensureWebSearchOptIn 入口与同一句
// 平铺说明 + 确认键文案。
// 事务四步：本轮未开启搜索时直接放行 false；已置位 searchOptInNoticeAcknowledged
// 时直接放行 true；未置位时经 ui/confirm-dialog.ts 的 confirmDialog 请求授权；
// 同意则持久化 searchOptInNoticeAcknowledged: true（写失败静默吞掉，本轮照常继续），
// 拒绝或阅读视图未挂载（confirmDialog fail-closed 返回 false）则本轮降级为 false。
// 说明内容与设置页常驻行（ui/settings-panel-html.ts）、PRIVACY.md 同一套词——
// 那两处各自持有文案，不 import 本常量（跨越渲染层与文档面）。
import { getSettings } from "../core/runtime.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { confirmDialog } from "../ui/confirm-dialog.js";

export const SEARCH_OPT_IN_NOTICE_MESSAGE =
  "联网搜索会把查询词发往内置的免 Key 服务（Tavily / Firecrawl / AnySearch / Parallel）以及你配置过 Key 的搜索平台；关闭搜索开关可随时撤回，删除对应平台记录可停止向其发送查询。";

export const SEARCH_OPT_IN_CONFIRM_TEXT = "同意并继续";

export async function ensureWebSearchOptIn(enabled?: boolean): Promise<boolean> {
  if (enabled === false) {
    return false;
  }
  const settings = await getSettings();
  const turnEnabled = enabled ?? settings.webSearchEnabled;
  if (!turnEnabled) {
    return false;
  }
  if (settings.searchOptInNoticeAcknowledged) {
    return true;
  }
  const agreed = await confirmDialog({
    message: SEARCH_OPT_IN_NOTICE_MESSAGE,
    confirmText: SEARCH_OPT_IN_CONFIRM_TEXT
  });
  if (!agreed) {
    return false;
  }
  await sendRuntimeMessage({
    type: "save-settings",
    settings: { searchOptInNoticeAcknowledged: true }
  }).catch(() => null);
  return true;
}
