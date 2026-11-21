import {
  resolveThinkingAdjustment,
  type ResolveThinkingInput,
  type ThinkingLevelAdjustment
} from "../ai/thinking-profiles.js";
import { THINKING_DEFAULT_LEVEL, type ThinkingLevel, type ThinkingLevelValue } from "../ai/thinking-levels.js";

export const THINKING_LEVEL_LABELS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Xhigh",
  max: "Max"
};

export const THINKING_ON_LABEL = "On";

export const THINKING_DEFAULT_LABEL = "Default";

const SWITCH_ON_LEVEL: ThinkingLevel = "high";

export type ThinkingPickerInput = Pick<
  ThinkingLevelAdjustment,
  "availableLevels" | "switchOnly" | "requestedLevel" | "effectiveLevel"
>;

export interface ThinkingPickerEntry {
  level: ThinkingLevelValue;
  label: string;
  effective: boolean;
  writesPreference: boolean;
}

export interface ThinkingView {
  label: string;
  entries: readonly ThinkingPickerEntry[];
  hint: string | null;
}

export function thinkingViewOf(input: ResolveThinkingInput): ThinkingView {
  const adjustment = resolveThinkingAdjustment(input);
  return {
    label: thinkingPickerLabel(adjustment),
    entries: thinkingPickerEntries(adjustment),
    hint: thinkingHint(adjustment)
  };
}

function isSwitchCollapsed(input: ThinkingPickerInput): boolean {
  return input.switchOnly || input.availableLevels.filter((level) => level !== "off").length === 1;
}

function shownLevel(input: ThinkingPickerInput): ThinkingLevelValue {
  return input.effectiveLevel ?? input.requestedLevel;
}

export function thinkingLevelValueLabel(value: ThinkingLevelValue): string {
  return value === "default" ? THINKING_DEFAULT_LABEL : THINKING_LEVEL_LABELS[value] ?? value;
}

export function thinkingPickerEntries(input: ThinkingPickerInput): ThinkingPickerEntry[] {
  const { availableLevels, switchOnly, requestedLevel } = input;
  const effective = input.effectiveLevel;
  const entries: ThinkingPickerEntry[] = [
    {
      level: THINKING_DEFAULT_LEVEL,
      label: THINKING_DEFAULT_LABEL,
      effective: effective === THINKING_DEFAULT_LEVEL,
      writesPreference: requestedLevel !== THINKING_DEFAULT_LEVEL
    }
  ];
  if (availableLevels.length === 0) {
    return entries;
  }
  const tiers = availableLevels.filter((level) => level !== "off");
  if (availableLevels.includes("off")) {
    entries.push({
      level: "off",
      label: THINKING_LEVEL_LABELS.off,
      effective: effective === "off",
      writesPreference: requestedLevel !== "off"
    });
  }
  if (switchOnly) {
    entries.push({
      level: SWITCH_ON_LEVEL,
      label: THINKING_ON_LABEL,
      effective: effective !== null && effective !== "off" && effective !== THINKING_DEFAULT_LEVEL,
      writesPreference: requestedLevel === "off" || requestedLevel === THINKING_DEFAULT_LEVEL
    });
    return entries;
  }
  if (tiers.length === 1) {
    entries.push({
      level: tiers[0],
      label: THINKING_ON_LABEL,
      effective: effective === tiers[0],
      writesPreference: requestedLevel !== tiers[0]
    });
    return entries;
  }
  for (const level of tiers) {
    entries.push({
      level,
      label: THINKING_LEVEL_LABELS[level] ?? level,
      effective: effective === level,
      writesPreference: level !== requestedLevel
    });
  }
  return entries;
}

export function thinkingPickerLabel(input: ThinkingPickerInput): string {
  const shown = shownLevel(input);
  if (shown === THINKING_DEFAULT_LEVEL || shown === "off") {
    return thinkingLevelValueLabel(shown);
  }
  return isSwitchCollapsed(input) ? THINKING_ON_LABEL : THINKING_LEVEL_LABELS[shown] ?? shown;
}

const THINKING_OFF_FALLBACK_LOW_HINT = "当前模型不支持关闭思考，已使用最低档位";
const THINKING_OFF_UNAVAILABLE_HINT = "当前模型不支持关闭思考";

export function thinkingHint(adjustment: ThinkingLevelAdjustment): string | null {
  const { requestedLevel, effectiveLevel, resolution, reason } = adjustment;
  if (requestedLevel === "off") {
    if (!resolution.offUnavailable) {
      return null;
    }
    return resolution.offFallback === "low" ? THINKING_OFF_FALLBACK_LOW_HINT : THINKING_OFF_UNAVAILABLE_HINT;
  }
  if (reason && effectiveLevel !== null) {
    return `当前模型不支持思考强度 ${requestedLevel}，已使用 ${effectiveLevel}`;
  }
  return null;
}
