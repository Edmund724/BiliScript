export const AI_PROTOCOLS = ["openai", "anthropic", "gemini"] as const;

export type AiProtocol = (typeof AI_PROTOCOLS)[number];
