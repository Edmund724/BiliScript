// 换轨进场动画：列表容器挂一次进场类，CSS 侧复用 tab 体同款关键帧。
//
// 口径（2026-10 用户决议）：只有「用户主动发起的轨道变更」——字幕工具条主列选轨与
// 双语弹层副列改选——在其装载落定后播一次进场动画；初始加载、抓取对账、播放同步等
// 其它 renderReadingView 路径一律不播。
//
// 起播由发起方（subtitle-tab-ui 的两个 change 处理器）在装载落定后直接调用，列表属主
// （lifecycle 的列表投影）只负责重建，不参与动画判断。时序依据：两个接受事务
// （subtitle/commit.ts 的 acceptSubtitle / acceptSecondarySubtitle）emit 通知之后到
// 调用方 continuation 之间没有 await，重建与挂类落在同一个事件循环内——**这条不变量
// 必须保持**，否则新列表会先绘制再起播，肉眼可见地跳一下。失败、视图未开、未发起装载
// 的早退都不调用本函数，因此不存在「残标留到下一次无关重建误播」的形态。
const TRACK_SWITCH_CLASS = "is-track-switching";

// 在列表容器上播一次进场：先摘再强制 reflow 重挂，连续两次换轨（或动画未结束时又来
// 一次）能重新起播。类在 animationend 摘除；reduced-motion 下 CSS 侧 animation:none
// （reader.css 的关停段），事件不触发、类残留无碍——下次触发路径本就先摘后挂。
export function playTrackSwitchAnimation(listEl: HTMLElement | null | undefined): void {
  if (!listEl) {
    return;
  }
  listEl.classList.remove(TRACK_SWITCH_CLASS);
  void listEl.offsetWidth;
  listEl.classList.add(TRACK_SWITCH_CLASS);
  listEl.addEventListener("animationend", () => listEl.classList.remove(TRACK_SWITCH_CLASS), { once: true });
}
