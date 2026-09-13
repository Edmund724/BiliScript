// extension/ai/explain.ts
// 选区「解释」的单次模型调用：拼提示词 + 发非流式请求，返回解释文本。
//
// 与概览生成（ai/analysis.js）的区别只在形态：解释是一问一答的短回复，不进
// Map-Reduce、不进会话存储、不落缓存，因此不走 port 流式链路，直接
// ai/completion.js 的非流式 chatCompletion（content 侧可直发，概览同理）。
//
// 上下文口径：以选中所在句为锚，取前后各 CONTEXT_WINDOW_SENTENCES 句字幕组成
// 窗口（带时间戳），并把选中句本身单独列出——模型据此判断选中的是个词、术语
// 还是一句观点，而不必回读整片字幕。整片字幕既贵又没必要（解释只需要局部语境）。

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
  /** 用户实际选中的文本（词 / 短语 / 句子片段） */
  selection: string;
  /** 选中所在的整条字幕句 */
  line: string;
  /** 所在句起始秒 */
  from: number;
  /** 全片字幕体（只用于截取局部上下文窗口） */
  body?: ExplainSubtitleItem[];
  /** 所在句在 body 中的下标；缺省或越界时退化为「无上下文窗口」 */
  index?: number;
  signal?: AbortSignal | null;
  /** 联网搜索运行时（spec §2.1：选区解释链同样携带）：传入即走 tool-loop，
   * 提示词换联网变体（允许调用 web_search 核实字幕未覆盖的术语/事实）。 */
  webSearch?: ExplainWebSearch;
  /** 搜索状态回调（tool-status 透传）：解释卡据此把「正在解释…」换成搜索中态。 */
  onSearchStatus?: (payload: ToolStatusPayload) => void;
  /** 联网 notice（额度用尽 / 搜索失败原因）：调用方自行决定提示位置。 */
  onNotice?: (text: string) => void;
}

// 联网搜索运行时（与对话链 ai/client.ts 的 WebSearchRuntime 同形状；解释卡经
// search/search-runtime.ts 的解析器组装）。
export interface ExplainWebSearch {
  maxToolCalls: number;
  executeSearch: (query: string) => Promise<ToolLoopSearchOutcome>;
}

// 上下文窗口半径（前后各取几句）。太小判不出指代，太大就只是在重复字幕。
const CONTEXT_WINDOW_SENTENCES = 2;
// 解释输出的 token 上限：口径是「最多三句话」，320 已够中文三句 + 少量英文术语，
// 压低上限同时也是给模型的长度信号（越长出得越慢）。
const EXPLAIN_MAX_TOKENS = 320;

// 系统提示词：联网开启时换规则变体——「只依据字幕上下文」改为允许（且仅允许）
// 调 web_search 核实，避免工具与「不要臆造」口径打架。基础规则数组单一来源，
// 两变体只在「依据口径」一条上分叉。
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

/**
 * 以选中句为锚截取上下文窗口（前后各 N 句，带时间戳；跳过空句）。
 * index 缺失 / 越界 / body 为空时返回空串（调用方按「无上下文」渲染提示词）。
 */
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
  // 窗口级小时位判定走条目级谓词（两端任一 ≥3600）。字幕体经「字幕接受」事务
  // 保证 from 升序，与逐条 some(...) 扫描等价，省掉窗口中间项的重复判定。
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

/** 组装解释请求的消息（纯函数，便于单测）。webSearch 时系统提示词换联网变体。 */
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

/**
 * 发一次解释请求，返回模型给出的解释文本（已 trim）。
 * 思考档位显式钉死 "off"：解释要的是即时性，不跟随用户在对话 tab 选的档位；
 * off 在协议层（ai/completion.js → thinking-profiles 查表）会发该平台已知混合
 * 模型的显式关闭字段（thinking:{type:"disabled"} / enable_thinking:false /
 * reasoning_effort:"none"），关不掉的模型落最低思考档，查不到事实的平台×模型
 * 不发任何字段。「不要思考过程」的措辞留在系统提示词里做第二道闸。
 * 中止（signal）与网络/HTTP 失败按 ai/completion.js 的错误模型上抛，由调用方
 * 落 error 态展示；空回复按错误处理（模型没给东西不算成功）。
 *
 * 传输层经 SW 代发（core/provider-http.js）：本函数在 content script 里跑，
 * 而 content script 的跨域 fetch 服从**网页** CORS——平台网关不支持浏览器预检
 * 时（OPTIONS 无 Access-Control-Allow-*）带 Authorization 的请求一律
 *「Failed to fetch」，与配置无关。请求构造与错误文案仍单源在 completion 链，
 * 只有「谁来发这一跳」不同。
 */
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
    // 联网链（spec §2.1 选区解释链同样可用）：非流式走 tool-loop，最终文本取
    // 返回值（非流式轮为 chatCompletion 字符串）。tool 定义不带 [n] 引用要求
    //（解释卡无来源渲染），失败降级与额度上限语义同对话链。
    const webText = (
      await runToolLoop({
        provider,
        messages,
        stream: false,
        signal,
        thinkingLevel: "off",
        maxToolCalls: webSearch.maxToolCalls,
        executeSearch: webSearch.executeSearch,
        toolDefinition: webSearchTool({ requireCitations: false }),
        maxTokens: EXPLAIN_MAX_TOKENS,
        onToolStatus: onSearchStatus,
        onNotice,
        fetchImpl: providerFetchViaBackground
      })
    ).trim();
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
