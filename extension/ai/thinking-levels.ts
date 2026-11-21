export const AI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof AI_THINKING_LEVELS)[number];

export const THINKING_DEFAULT_LEVEL = "default";
export const AI_THINKING_LEVEL_VALUES = [THINKING_DEFAULT_LEVEL, ...AI_THINKING_LEVELS] as const;

export type ThinkingLevelValue = (typeof AI_THINKING_LEVEL_VALUES)[number];

const LEVEL_SET: ReadonlySet<string> = new Set<string>(AI_THINKING_LEVELS);
const VALUE_SET: ReadonlySet<string> = new Set<string>(AI_THINKING_LEVEL_VALUES);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && LEVEL_SET.has(value);
}

export function isThinkingLevelValue(value: unknown): value is ThinkingLevelValue {
  return typeof value === "string" && VALUE_SET.has(value);
}

export type ThinkingLevelInput = unknown;

export function normalizeThinkingLevel(value: unknown): ThinkingLevelValue {
  return isThinkingLevelValue(value) ? value : THINKING_DEFAULT_LEVEL;
}
