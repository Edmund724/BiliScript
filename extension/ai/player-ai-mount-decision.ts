// 播放器快捷操作挂载判定（纯函数）。
//
// sync 主流程的判定骨架：
// 开关门控 → 校准信号 → 就位短路 → 宿主判定 → 挂载/拆除/重试。
//
// 次序不变量：
// 1. 设置门控先于一切：关闭直接返回 "none"，由宿主壳摘除按钮并清就位记录。
// 2. 校准先于短路：未校准且字幕控件就绪时旁路就位短路，强制走复校全量路径。
// 3. 短路仅在稳定态：未触发复校且已挂载就位时返回 "refresh-visuals"，宿主壳重置重试计数与预算。
// 4. 宿主缺失走退避：未就位或复校时若宿主缺席，返回 "unmount-retry"，宿主壳拆除残余并排退避重试。
// 5. 挂载在位：宿主存在时，复校走 "recalibrate"，首次/重新挂载走 "mount"。

export type PlayerAiMountIntent =
  | "none"
  | "recalibrate"
  | "refresh-visuals"
  | "mount"
  | "unmount-retry";

export interface PlayerAiMountDecisionInput {
  enabled: boolean;
  calibrated: boolean;
  hasSubtitleControl: boolean;
  mountedStable: boolean;
  hasHost: boolean;
}

export function decidePlayerAiQuickAction(
  input: PlayerAiMountDecisionInput
): PlayerAiMountIntent {
  // 1. 设置门控：关闭态仍要摘按钮（含清就位记录）
  if (!input.enabled) {
    return "none";
  }

  // 2. 字幕控件校准信号：未校准且控件已就绪，触发一次性复校。
  // 次序不变量：校准先于短路（mountedStable 短路被校准信号旁路，落入全量路径）。
  const shouldCalibrate = !input.calibrated && input.hasSubtitleControl;

  // 3. 已就位短路：非校准且已稳定就位时，只刷新视觉并补满预算。
  if (!shouldCalibrate && input.mountedStable) {
    return "refresh-visuals";
  }

  // 4. 宿主判定：宿主缺失走拆除重试与退避。
  if (!input.hasHost) {
    return "unmount-retry";
  }

  // 5. 挂载路径：若为校准触发则输出 recalibrate，否则为常规 mount。
  if (shouldCalibrate) {
    return "recalibrate";
  }

  return "mount";
}
