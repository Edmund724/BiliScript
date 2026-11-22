import { chatCompletion } from "./completion.js";
import { runToolLoop, webSearchTool, type ToolLoopSearchOutcome, type ToolStatusPayload } from "./tool-loop.js";
import { providerFetchViaBackground } from "../core/provider-http.js";
import { formatClock, shouldUseHours, shouldUseHoursForRange } from "../shared/clock-text.js";
import type { AiProvider, ChatMessage } from "./types.js";

interface ExplainSubtitleItem {
  from?: unknown;
  content?: unknown;
}

export interface ExplainSelectionInput {
  provider: AiProvider;
  videoTitle?: string;
  selection: string;
  line: string;
  from: number;
  body?: ExplainSubtitleItem[];
  index?: number;
  signal?: AbortSignal | null;
  webSearch?: ExplainWebSearch;
  onSearchStatus?: (payload: ToolStatusPayload) => void;
  onNotice?: (text: string) => void;
}

export interface ExplainWebSearch {
  maxToolCalls: number;
  executeSearch: (query: string) => Promise<ToolLoopSearchOutcome>;
}

const CONTEXT_WINDOW_SENTENCES = 2;
const EXPLAIN_MAX_TOKENS = 320;

export function buildExplainSystemPrompt({ webSearch = false }: { webSearch?: boolean } = {}): string {
  const rules = [
    "- 不要思考过程、不要前言后语，直接给出解释本身",
    "- 最多 3 句话，尽量短",
    "- 选中的是词或术语：给简明定义，并说明它在本视频里具体指什么",
    "- 选中的是短语或整句：解释它在当前上下文中的含义与说话人想表达什么",
    "- 人名 / 机构 / 产品名：说明它是谁 / 什么，以及与本片主题的关系",
    "- 字幕是语音识别（ASR）生成的，可能有同音错别字：先按上下文推断选中文字的本字再解释；无法确定本字时如实说明",
    webSearch
      ? "- 可调用 web_search 工具联网核实：仅当字幕上下文不足以解释选中的术语 / 实体 / 时效性事实时才调用，不需要就不搜"
      : "- 只依据给出的字幕上下文判断，上下文不足以确定时如实说明，不要臆造",
    webSearch
      ? "- 只依据字幕上下文与搜索结果回答，都不足以确定时如实说明，不要臆造"
      : "- 用与字幕一致的语言回答（中文字幕用中文）"
  ];
  if (webSearch) {
    rules.push("- 用与字幕一致的语言回答（中文字幕用中文）");
  }
  return ["你在解释 B 站视频字幕里被观众选中的内容。", "规则：", ...rules].join("\n");
}

const EXPLAIN_SYSTEM_PROMPT = buildExplainSystemPrompt();

export function buildExplainContext(
  body: ExplainSubtitleItem[] | undefined,
  index: number | undefined
): string {
  const list = Array.isArray(body) ? body : [];
  const anchor = Number(index);
  if (!list.length || !Number.isFinite(anchor) || anchor < 0 || anchor >= list.length) {
    return "";
  }
  const from = Math.max(0, Math.floor(anchor) - CONTEXT_WINDOW_SENTENCES);
  const to = Math.min(list.length - 1, Math.floor(anchor) + CONTEXT_WINDOW_SENTENCES);
  const withHours = shouldUseHoursForRange(list[from]?.from, list[to]?.from);
  const lines: string[] = [];
  for (let i = from; i <= to; i += 1) {
    const item = list[i];
    const content = String(item?.content || "").trim();
    if (!content) {
      continue;
    }
    const mark = i === Math.floor(anchor) ? "→ " : "  ";
    lines.push(`${mark}[${formatClock(Number(item?.from) || 0, { hours: withHours })}] ${content}`);
  }
  return lines.join("\n");
}

export function buildExplainMessages({
  videoTitle,
  selection,
  line,
  from,
  body,
  index,
  webSearch
}: Omit<ExplainSelectionInput, "provider" | "signal" | "onSearchStatus" | "onNotice">): ChatMessage[] {
  const stamp = formatClock(Number(from) || 0, { hours: shouldUseHours(from) });
  const context = buildExplainContext(body, index);
  const sections = [
    `视频标题：${String(videoTitle || "未知").trim() || "未知"}`,
    `选中内容：「${selection}」`,
    `所在字幕句（${stamp}）：「${line}」`,
    context ? `字幕上下文（→ 标记为所在句）：\n${context}` : "（无可用上下文）"
  ];
  return [
    { role: "system", content: webSearch ? buildExplainSystemPrompt({ webSearch: true }) : EXPLAIN_SYSTEM_PROMPT },
    { role: "user", content: `${sections.join("\n\n")}\n\n请解释选中内容。` }
  ];
}

export async function explainSelection({
  provider,
  videoTitle,
  selection,
  line,
  from,
  body,
  index,
  signal,
  webSearch,
  onSearchStatus,
  onNotice
}: ExplainSelectionInput): Promise<string> {
  const messages = buildExplainMessages({ videoTitle, selection, line, from, body, index, webSearch });
  if (webSearch) {
    const webResult = await runToolLoop({
      requestProfile: {
        provider,
        stream: false,
        signal,
        thinkingLevel: "off",
        toolDefinition: webSearchTool({ requireCitations: false }),
        maxTokens: EXPLAIN_MAX_TOKENS,
        retries: 1,
        fetchImpl: providerFetchViaBackground
      },
      messages,
      maxToolCalls: webSearch.maxToolCalls,
      executeSearch: webSearch.executeSearch,
      onToolStatus: onSearchStatus,
      onNotice
    });
    const webText = typeof webResult === "string" ? webResult.trim() : "";
    if (!webText) {
      throw new Error("模型没有给出解释，请重试。");
    }
    return webText;
  }
  const result = await chatCompletion({
    provider,
    messages,
    stream: false,
    thinkingLevel: "off",
    signal,
    maxTokens: EXPLAIN_MAX_TOKENS,
    retries: 1,
    fetchImpl: providerFetchViaBackground
  });
  const text = typeof result === "string" ? result.trim() : "";
  if (!text) {
    throw new Error("模型没有给出解释，请重试。");
  }
  return text;
}
