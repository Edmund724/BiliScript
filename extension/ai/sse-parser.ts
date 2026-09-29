// 纯函数 SSE payload 解析器。
// 输入：SSE data: 行去掉前缀后的文本（可能为空或 "[DONE]"）。
// 输出：{ type: "reasoning" | "content", data: string }[]，联网搜索管线扩展
// { type: "tool-call-fragment" }（delta.tool_calls 分片，聚合由 drainSseStream
// 按 index 拼接）与 { type: "finish" }（choices[0].finish_reason）；
// usage 采集（ai-usage-telemetry T1）扩展 { type: "usage" }（顶层 usage 字段，
// 归一形状见 parseOpenAiUsage，多块出现由 adapter 取最后一个非空）。
// 不依赖任何 Chrome API、port、signal 或 fetch，可同时在 ES module 与 classic script 中使用。

import type { ChatUsage, SseEvent } from "./types.js";

// 响应 usage 归一（openai 线格式：prompt_tokens / completion_tokens /
// completion_tokens_details.reasoning_tokens）；非流式路径（adapter.parseResponse）
// 复用同一映射，字段名不出现第二份。缺失 / 形状不符 / null / 非有限数 → 对应字段
// 缺省；三字段全缺省时返回 undefined（调用方据此不产生 usage）。不抛错、不降级。
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

// 单字段取数：只认有限数值（字符串 / NaN / Infinity / null 视为形状不符）。
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
