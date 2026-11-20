// extension/shared/self-heal.ts
// 自愈调度共享常量（按钮自查节拍单源）。
//
// SELF_HEAL_INTERVAL_MS：content 侧按钮「定时自查自愈」的节拍——
// ui/script-button.ts 的按钮补回自查周期；面板重锚节拍留在 reader/script-host.ts。
// 阅读壳退出通知已收口至 shared/content-event-bus.ts 的 "reader:closed" 强类型事件。
export const SELF_HEAL_INTERVAL_MS = 200;
