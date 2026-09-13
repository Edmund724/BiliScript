// extension/chat/search-sources.ts — 联网搜索来源的纯函数（spec §2.5/§4）：
// tool 消息内容（{ title, url, snippet }[] 的 JSON 序列化，持久化截断 2,000
// 字符）容错解析为来源数组；历史回合聚合（assistant(tool_calls) 的查询词 +
// tool 结果 → 重开会话后时间线卡与内联引用的重建输入）。零 DOM / chrome 依赖，
// chat-tab-core 回放与测试共用。纯数据，不知 port / 存储。
import type { ChatMessage } from "../ai/types.js";
import type { ChatSessionMessage } from "./chat-state.js";

// 来源条目：与 search/adapters 的 NormalizedSearchResult 同形（tool 消息内容
// 就是该数组的 JSON 序列化，spec §5）。类型本地声明避免渲染层依赖搜索适配器。
export interface ChatSearchSource {
  title: string;
  url: string;
  snippet: string;
}

// 来源预览卡摘录上限（spec §5：snippet 前 200 字符）。
export const SEARCH_PREVIEW_MAX_CHARS = 200;

// 数组字符串里的顶层对象边界扫描：从 content 中析取完整的 { ... } 对象序列，
// 残缺尾巴（持久化截断腰斩的对象）丢弃。只认深度 1 的顶层对象，嵌套结构里
// 的花括号由深度计数越过。
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

/**
 * parseToolSourceArray(content) — tool 消息内容 → 来源数组（容错）。
 *
 * tool 内容正常是 { title, url, snippet }[] 的 JSON（spec §5），但持久化副本
 * 截断 2,000 字符可能腰斩 JSON：先试 JSON.parse，失败再按顶层对象边界析取
 * 完整条目（残缺尾巴丢弃）。任何解析失败返回空数组——来源展示是锦上添花，
 * 不抛错。
 */
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
    // 继续走析取路径（截断的 JSON.parse 必失败）
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

// tool call arguments 里的查询词（parseToolArgs 同款语义的小型本地版：解析
// 失败记空串，不抛）。
function parseQueryFromArguments(argumentsText: unknown): string {
  try {
    const parsed = JSON.parse(String(argumentsText || "{}"));
    const query = (parsed as { query?: unknown }).query;
    return typeof query === "string" ? query : "";
  } catch {
    return "";
  }
}

// 单条回放回合：一条 assistant 回答对应的前置搜索（查询词 + 结果）。
export interface HistorySearchTurn {
  // 回合的纯 assistant 回答在 history 中的下标（回放循环按它对位插卡）——
  // 是 tool_calls 之后的最终回答消息，不是带 tool_calls 的中间消息。
  assistantIndex: number;
  // 每次搜索的查询词（tool_call 顺序；arguments 解析失败记空串）。
  queries: string[];
  // 每次搜索的结果条数（tool 消息解析；失败内容记 0）。
  resultCounts: number[];
  // 跨搜索累计的来源列表（chip 行与内联引用的编号顺序，spec §4）。
  sources: ChatSearchSource[];
}

/**
 * collectHistorySearchTurns(history) — 聚合历史中的搜索回合（回放重建）。
 *
 * 回合 = user 消息起的问答组：assistant(tool_calls) 开启搜索、紧随的
 * role:"tool" 消息是结果、之后的纯 assistant 消息是回答——回合挂在回答消息
 * 的下标上（回放对位插卡；截断在工具轮的半回合无回答，丢弃）。无 tool 轮的
 * 回答不产出条目。顺序即 chip 行 / 内联引用的编号顺序（与 live 侧
 * tool-status 到达顺序一致）。
 */
export function collectHistorySearchTurns(history: readonly ChatSessionMessage[] | readonly ChatMessage[]): HistorySearchTurn[] {
  const turns: HistorySearchTurn[] = [];
  // 开启中（尚未遇到回答消息）的搜索轮：assistantIndex 落点待定。
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
    // assistant 消息：带 tool_calls 则开启新搜索轮（查询词按 tool_call 顺序）；
    // 纯 assistant 则收口一轮（有搜索内容才产出，回答下标即本条）。
    const toolCalls = (message as ChatSessionMessage).tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length) {
      pending = { queries: [], resultCounts: [], sources: [] };
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
