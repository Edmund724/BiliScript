// extension/chat/view-intent.ts — 视图意图词表（零依赖纯叶，跨消费方共享）。
//
// 「对话视图重建」动作的决策面（arch-review-2026-10 评审候选 11 第一刀）：
// 历史上 send-gate / context-load / chat-runtime / replay 各自持有清场回调
// （resetView / resetConversationView 三个名字一个动作）直写消息区，决策散在
// 4 个 module、走「store change 标志 / policy plan 标志 / 直调注入」三条异构
// 通道，且 replay 的空历史分支回调组合根再作废自己（回环靠排序巧合无害）。
// 本词表把「要清场/要状态屏」收成一种意图：消费方只发意图，执行体唯一住在
// 组合根 reader/chat-tab.ts 的 requestViewReset——「清场即作废在飞回放」
// （世代号 +1）由那一个入口承重，消费方不再感知 replay。
//
// 词表刻意封闭、按需扩员：replay 空历史死分支删除后暂无 empty 生产者，
// 后续动作（如第二刀的「跟随式重启」）落地时在此加变体。
export interface ViewResetStateIntent {
  kind: "state";
  // 状态屏文案（HTML，可含「前往设置」锚点，由组合根 innerHTML 落进消息区）。
  html: string;
}

export type ViewResetIntent = ViewResetStateIntent;
