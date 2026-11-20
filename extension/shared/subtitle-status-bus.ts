// extension/shared/subtitle-status-bus.ts
// 字幕状态相位的进程内镜像叶子（经 shared/content-event-bus 跨常驻/懒加载两区共享）。
//
// 相位清单（发布点）：
//   asr-transcribing / asr-done / asr-failed  转写编排（asr/active-fallback），
//     驱动 reader 转写横幅与转写判定；
//   subtitle-ready                            字幕接受事务（subtitle/commit
//     acceptSubtitle，主轨落账后与 reader-bus 通知同点发布），驱动 chat 发送闸。

import {
  contentEventBus,
  getLastSubtitleStatusPhase,
  setLastSubtitleStatusPhase
} from "./content-event-bus.js";
import type { EventSubscribeOptions } from "./typed-event-bus.js";

type SubtitleStatusListener = (phase: string) => void;

// 发布新相位：先更新粘性相位（订阅方回调内读 get 拿到的必须是新值），再经强类型总线通知。
export function publishSubtitleStatusPhase(phase: string): void {
  const next = String(phase || "");
  if (!next) {
    return;
  }
  setLastSubtitleStatusPhase(next);
  contentEventBus.emit("subtitle:status-phase", next);
}

// 当前（最后发布的）相位；从未发布过返回空串。
export function getSubtitleStatusPhase(): string {
  return getLastSubtitleStatusPhase();
}

// 订阅相位变化，返回退订函数，并支持 `{ signal?: AbortSignal }` 自动退订。
export function subscribeSubtitleStatusPhase(
  listener: SubtitleStatusListener,
  options?: EventSubscribeOptions
): () => void {
  return contentEventBus.on("subtitle:status-phase", listener, options);
}
