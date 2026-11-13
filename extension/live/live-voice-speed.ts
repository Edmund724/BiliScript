export const DEFAULT_LIVE_VOICE_SPEED = 1.0;
export const LIVE_VOICE_SPEED_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5] as const;
export type LiveVoiceSpeed = (typeof LIVE_VOICE_SPEED_STEPS)[number];

export function normalizeLiveVoiceSpeed(value: unknown): LiveVoiceSpeed {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LIVE_VOICE_SPEED;
  return LIVE_VOICE_SPEED_STEPS.reduce((nearest, step) =>
    Math.abs(step - value) < Math.abs(nearest - value) ? step : nearest
  );
}
