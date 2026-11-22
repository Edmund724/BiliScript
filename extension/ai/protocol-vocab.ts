export const AI_PROTOCOLS = ["openai", "anthropic", "gemini"] as const;

export type AiProtocol = (typeof AI_PROTOCOLS)[number];

const AI_PROTOCOL_SET: ReadonlySet<string> = new Set<string>(AI_PROTOCOLS);

export function isAiProtocol(value: unknown): value is AiProtocol {
  return typeof value === "string" && AI_PROTOCOL_SET.has(value);
}
