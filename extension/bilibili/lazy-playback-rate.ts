// extension/bilibili/lazy-playback-rate.ts
// bilibili/playback-rate.ts 的按需加载器。
//
// 为什么惰性：playback-rate 只在设置 enableExtraPlaybackRates 开启时生效。
// 默认关闭，关闭态用户模块零装载、chunk 不下载。

import { createLazyLoader } from "../shared/lazy-import.js";

interface PlaybackRateDomain {
  startPlaybackRateButtons(): void;
  stopPlaybackRateButtons(): void;
}

const loader = createLazyLoader<PlaybackRateDomain>(() => import("./playback-rate.js"));

export function loadPlaybackRate(): Promise<PlaybackRateDomain> {
  return loader.load();
}

export function isPlaybackRateLoaded(): boolean {
  return loader.isLoaded();
}
