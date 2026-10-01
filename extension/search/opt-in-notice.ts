// extension/search/opt-in-notice.ts
// 联网搜索 opt-in 一次性说明的文案单源（spec §6.7）：两个内容侧闸
// （chat/chat-runtime.ts 的发送前、reader/explain-card.ts 的发起前）共用同一句
// 平铺说明与同一个确认键文案，经 ui/confirm-dialog.ts 的 confirmDialog 呈现
//（消息区是单个 <p>，只放一句平铺的话）。
// 说明内容与设置页常驻行（ui/settings-panel-html.ts）、PRIVACY.md 同一套词——
// 那两处各自持有文案，不 import 本常量（跨越渲染层与文档面）。
export const SEARCH_OPT_IN_NOTICE_MESSAGE =
  "联网搜索会把查询词发往内置的免 Key 服务（Tavily / Firecrawl / AnySearch / Parallel）以及你配置过 Key 的搜索平台；关闭搜索开关可随时撤回，删除对应平台记录可停止该家接收查询。";

export const SEARCH_OPT_IN_CONFIRM_TEXT = "同意并继续";
