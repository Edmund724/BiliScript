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
  if (!input.enabled) {
    return "none";
  }

  const shouldCalibrate = !input.calibrated && input.hasSubtitleControl;

  if (!shouldCalibrate && input.mountedStable) {
    return "refresh-visuals";
  }

  if (!input.hasHost) {
    return "unmount-retry";
  }

  if (shouldCalibrate) {
    return "recalibrate";
  }

  return "mount";
}
