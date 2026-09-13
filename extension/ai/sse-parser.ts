// 纯函数 SSE payload 解析器。
// 输入：SSE data: 行去掉前缀后的文本（可能为空或 "[DONE]"）。
// 输出：{ type: "reasoning" | "content", data: string }[]，联网搜索管线扩展
// { type: "tool-call-fragment" }（delta.tool_calls 分片，聚合由 drainSseStream
// 按 index 拼接）与 { type: "finish" }（choices[0].finish_reason）。
// 不依赖任何 Chrome API、port、signal 或 fetch，可同时在 ES module 与 classic script 中使用。

import type { SseEvent } from "./types.js";

export function parseSsePayload(text: unknown): (SseEvent | { type: "tool-call-fragment"; index: number; id?: string; name?: string; argsFragment: string } | { type: "finish"; reason: string })[] {
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
    return events;
  } catch {
    return [];
  }
}
