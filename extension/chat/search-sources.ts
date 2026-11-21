import type { ChatMessage } from "../ai/types.js";
import type { ChatSessionMessage } from "./chat-state.js";

export interface ChatSearchSource {
  title: string;
  url: string;
  snippet: string;
  paid?: boolean;
}

export const SEARCH_PREVIEW_MAX_CHARS = 200;

function salvageTopLevelObjects(content: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(content.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) {
        depth = 0;
      }
    }
  }
  return objects;
}

function normalizeSourceEntry(entry: unknown): ChatSearchSource | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const record = entry as { title?: unknown; url?: unknown; snippet?: unknown };
  return {
    title: String(record.title ?? ""),
    url: String(record.url ?? ""),
    snippet: String(record.snippet ?? "")
  };
}

export function parseToolSourceArray(content: unknown): ChatSearchSource[] {
  const text = String(content || "").trim();
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map(normalizeSourceEntry).filter((item): item is ChatSearchSource => item !== null);
  } catch {
  }
  return salvageTopLevelObjects(text)
    .map((objectText) => {
      try {
        return normalizeSourceEntry(JSON.parse(objectText));
      } catch {
        return null;
      }
    })
    .filter((item): item is ChatSearchSource => item !== null);
}

function parseQueryFromArguments(argumentsText: unknown): string {
  try {
    const parsed = JSON.parse(String(argumentsText || "{}"));
    const query = (parsed as { query?: unknown }).query;
    return typeof query === "string" ? query : "";
  } catch {
    return "";
  }
}

export interface HistorySearchTurn {
  assistantIndex: number;
  queries: string[];
  resultCounts: number[];
  sources: ChatSearchSource[];
}

export function collectHistorySearchTurns(history: readonly ChatSessionMessage[] | readonly ChatMessage[]): HistorySearchTurn[] {
  const turns: HistorySearchTurn[] = [];
  let pending: { queries: string[]; resultCounts: number[]; sources: ChatSearchSource[] } | null = null;

  history.forEach((message, index) => {
    if (message.role === "user") {
      pending = null;
      return;
    }
    if (message.role === "tool") {
      if (!pending) {
        return;
      }
      const sources = parseToolSourceArray((message as ChatSessionMessage).content);
      pending.resultCounts.push(sources.length);
      pending.sources.push(...sources);
      return;
    }
    const toolCalls = (message as ChatSessionMessage).tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length) {
      if (!pending) {
        pending = { queries: [], resultCounts: [], sources: [] };
      }
      for (const call of toolCalls) {
        const fn = (call as { function?: { name?: unknown; arguments?: unknown } }).function;
        if (fn && fn.name === "web_search") {
          pending.queries.push(parseQueryFromArguments(fn.arguments));
        }
      }
      return;
    }
    if (pending && (pending.queries.length || pending.sources.length)) {
      turns.push({ assistantIndex: index, ...pending });
      pending = null;
    }
  });
  return turns;
}
