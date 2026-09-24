// offscreen-lifecycle.ts — offscreen 文档自身生命周期的纯判定（可测）。
//
// 同一 offscreen 文档承载三条通道：聊天（"offscreen-chat"）、asr-decode 解码、
// 概览代发（"provider-http-offscreen"，overview-offscreen-transport）。asr-decode
// 任务到达终态（done / error / 断连取消）后，若另两条通道都已无存活端口，文档再无
// 承载，自关以释放渲染进程；还有聊天端口或在飞代发请求时保留（代发是分钟级请求，
// 被自关吞掉的话回执永远不到）。
//
// 纯函数放独立模块：entry/offscreen.ts 顶层挂满 chrome 事件监听，不可在
// Node 测试环境导入。

// currentChatCount 为 0 且无在飞代发请求 → 关；NaN/undefined（计数异常）
// → 不关，保守保留文档。
export function shouldCloseAfterAsrTask(
  currentChatCount: unknown,
  activeProviderRequests: unknown
): boolean {
  return Number(currentChatCount) <= 0 && Number(activeProviderRequests) <= 0;
}
