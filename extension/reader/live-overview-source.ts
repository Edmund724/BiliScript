// 概览快照的伴看来源槽：lifecycle 在装配协调器后登记，
// chat-tab 组合根在创建实时伴看时读取并订阅。
//
// 为什么不让 chat-tab 直接 import lifecycle：chat-tab 是二级惰性 chunk，lifecycle
// 是 reader 域组装根（模块求值时注册 reader 端口、订阅 presenter）。把它拉进
// 对话组合根的静态依赖会把「对话页」与「reader 装配」绑死在同一次模块求值上，
// 测试里多纪元重载还会撞上 reader-bus 的重复注册守卫。这里只留一个窄槽：
// 提供快照 + 订阅，两个方向的依赖都落在 reader 域内部。

import type { LiveOverviewSource } from "../live/live-overview-context.js";

export interface ReaderOverviewSource {
  getSnapshot(): LiveOverviewSource | null;
  subscribe(listener: () => void): () => void;
}

let currentSource: ReaderOverviewSource | null = null;

/** lifecycle 装配协调器后单点登记；重复登记以后者为准（测试多纪元重载）。 */
export function registerReaderOverviewSource(source: ReaderOverviewSource): void {
  currentSource = source;
}

/** 当前概览快照；未登记（对话早于 reader 装配）时返回 null。 */
export function getReaderOverviewSource(): LiveOverviewSource | null {
  return currentSource ? currentSource.getSnapshot() : null;
}

/** 概览相位/产物变化订阅；未登记时返回 no-op 退订。 */
export function subscribeReaderOverviewSource(listener: () => void): () => void {
  if (!currentSource || typeof listener !== "function") {
    return () => {};
  }
  return currentSource.subscribe(listener);
}
