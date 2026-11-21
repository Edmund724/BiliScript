import type { ChatUsage, SseEvent } from "./types.js";

export function parseOpenAiUsage(raw: unknown): ChatUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
  };
  const inputTokens = toTokenCount(usage.prompt_tokens);
  const outputTokens = toTokenCount(usage.completion_tokens);
  const reasoningTokens = toTokenCount(usage.completion_tokens_details?.reasoning_tokens);
  if (inputTokens == null && outputTokens == null && reasoningTokens == null) return undefined;
  return {
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(reasoningTokens != null ? { reasoningTokens } : {})
  };
}

function toTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseSsePayload(text: unknown): (SseEvent | { type: "tool-call-fragment"; index: number; id?: string; name?: string; argsFragment: string } | { type: "finish"; reason: string } | { type: "usage"; usage: ChatUsage })[] {
  const trimmed = String(text || "").trim();
  if (!trimmed || trimmed === "[DONE]") {
    return [];
  }

  try {
    const json = JSON.parse(trimmed) as {
      choices?: Array<{
        delta?: { reasoning_content?: unknown; content?: unknown; tool_calls?: unknown };
        finish_reason?: unknown;
      }>;
      usage?: unknown;
    };
    const choice = json?.choices?.[0];
    const delta = choice?.delta || {};
    const events: ReturnType<typeof parseSsePayload> = [];

    if (delta.reasoning_content) {
      events.push({ type: "reasoning", data: String(delta.reasoning_content) });
    }
    if (delta.content) {
      events.push({ type: "content", data: String(delta.content) });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const fragment of delta.tool_calls as Array<{
        index?: unknown;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }>) {
        if (!fragment || typeof fragment !== "object") continue;
        events.push({
          type: "tool-call-fragment",
          index: Number(fragment.index ?? 0),
          ...(typeof fragment.id === "string" && fragment.id ? { id: fragment.id } : {}),
          ...(typeof fragment.function?.name === "string" && fragment.function.name
            ? { name: fragment.function.name }
            : {}),
          argsFragment: typeof fragment.function?.arguments === "string" ? fragment.function.arguments : ""
        });
      }
    }
    if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
      events.push({ type: "finish", reason: choice.finish_reason });
    }
    const usage = parseOpenAiUsage(json.usage);
    if (usage) {
      events.push({ type: "usage", usage });
    }
    return events;
  } catch {
    return [];
  }
}
