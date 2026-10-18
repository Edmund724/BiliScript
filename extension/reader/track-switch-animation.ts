// 换轨进场动画的触发标记（reader 域零依赖叶子：subtitle-tab-ui 是壳可静态
// 携带的轻叶子，本模块随之同样不 import 任何域模块，chunk 边不变形）。
//
// 口径（2026-10 用户决议）：只有「用户主动发起的轨道变更」——字幕工具条
// 主列选轨与双语弹层副列改选——在列表整表重建时播一次进场动画；初始加载、
// 抓取对账、播放同步等其它 renderReadingView 路径一律不播。时序：
//   发起方（subtitle-tab-ui 的两个 change 处理器）装载前置位标记
//     → 接受事务的通知（subtitle-ready / secondary-subtitle-ready / rerender）
//       驱动 lifecycle 的列表投影整表重建
//     → 投影消费标记并播动画。
// 视图未开时通知的渲染分支不出场、装载失败时通知不到达——这两种「标记了却
// 没重建」的残局由发起方在收尾清偿（主列 finally / 副列 settled），残标
// 不留到下一次无关重建误播。

const TRACK_SWITCH_CLASS = "is-track-switching";

let pending = false;

// 发起方在装载前置位。在飞禁用保证一次只有一笔换轨在飞，单值布尔够用。
export function markTrackSwitchAnimation(): void {
  pending = true;
}

// 发起方收尾清偿：成功且视图开着时标记已被重建消费（此处是幂等 no-op）。
export function clearTrackSwitchAnimation(): void {
  pending = false;
}

// 列表属主（lifecycle 的列表投影）在整表重建后调用：标记在场则消费并播一次。
// 先摘再强制 reflow 重挂：连续两次换轨（或动画未结束时又来一次）能重新起播。
// 类在 animationend 摘除；reduced-motion 下 CSS 侧 animation:none（reader.css
// 的关停段），事件不触发、类残留无碍——下次触发路径本就先摘后挂。
export function playTrackSwitchAnimationIfMarked(listEl: HTMLElement): void {
  if (!pending) {
    return;
  }
  pending = false;
  listEl.classList.remove(TRACK_SWITCH_CLASS);
  void listEl.offsetWidth;
  listEl.classList.add(TRACK_SWITCH_CLASS);
  listEl.addEventListener("animationend", () => listEl.classList.remove(TRACK_SWITCH_CLASS), { once: true });
}
