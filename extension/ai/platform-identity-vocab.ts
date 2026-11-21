export const PLATFORM_IDENTITY_KEYS = [
  "deepseek",
  "qwen",
  "zhipu",
  "moonshot",
  "minimax",
  "mimo",
  "openrouter",
  "stepfun",
  "modelscope",
  "ollama",
  "siliconflow",
  "amd",
  "sensenova",
  "opencodego",
  "gemini"
] as const;

export type PlatformKey = (typeof PLATFORM_IDENTITY_KEYS)[number];

const PLATFORM_KEY_SET: ReadonlySet<string> = new Set<string>(PLATFORM_IDENTITY_KEYS);

export function isPlatformKey(value: unknown): value is PlatformKey {
  return typeof value === "string" && PLATFORM_KEY_SET.has(value);
}
