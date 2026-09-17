// ai/protocol-adapter.ts — 平台协议的开放注册表（multi-protocol-ai，spec 契约章）。
// ProtocolAdapter 层收敛在 completion.ts 唯一 fetch 点一侧：编排层（阶梯/归并/
// 工具循环）面对统一 ChatMessage[] 入参与 StreamChatEvent 出参，零改动。
// 每个 adapter 只负责六件随协议变化的事：endpoint / authHeaders / buildBody /
// extractErrorDetail / drainStream / parseResponse；重试循环、中止收束、溢出判定、
// 探针语义留在 core（completion.ts）不动。
// 注册表开放：加第四种协议（Gemini 等）= 实现一个 ProtocolAdapter + 登记一行，
// core 零改动。
import type { ChatMessage, ChatToolCall, StreamChatEvent } from "./types.js";

// 平台协议词表（CONTEXT.md「平台协议」）。
export type AiProtocol = "openai" | "anthropic" | "responses";

// tools 定义沿用 OpenAI 风格形状（编排层词表，adapter 内翻译为协议线格式）。
export interface ChatToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

// 能力声明：被有意不支持/压平的能力用稳定键显式列出（spec「被有意不支持的
// 能力」逐条落入 unsupported）。UI 与 tool-loop 只读结构化字段，不解析说明文案。
export interface ProtocolCapabilities {
  /** tool-loop（联网搜索）是否可用；false 时 tool-loop 摘除 tools 重发（现状兜底） */
  tools: boolean;
  /** 思考档位查表（thinking-profiles）是否可用 */
  thinkingProfiles: boolean;
  /** 被有意不支持的能力：稳定键 → 给人读的说明 */
  unsupported: Record<string, string>;
}

// core 组装好的、与协议无关的调用意图。baseUrl 已归一（去尾斜杠）。
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  probe: boolean;
  baseUrl: string;
  apiKey?: string;
  /** 思考档位查表的平台识别输入（presetId 主路径，custom/旧记录靠 baseUrl host 兜底） */
  presetId?: string;
  thinkingLevel?: string;
  maxTokens?: number | null;
  tools?: ChatToolDefinition[];
}

// drainStream/parseResponse 的聚合产物：与旧 DrainSseStreamResult 同型，
// 调用方（client 流式 / map-reduce 非流式 / tool-loop）消费形状不变。
export interface DrainResult {
  content: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
}

export interface DrainContext {
  signal?: AbortSignal | null;
  onEvent?: (event: StreamChatEvent) => void;
}

export interface ProtocolAdapter {
  readonly protocol: AiProtocol;
  readonly capabilities: ProtocolCapabilities;

  /** 端点路径（baseUrl 已去尾斜杠；代理平台路径以官方文档为准） */
  endpoint(baseUrl: string): string;

  /** 鉴权头全集；core 与 extraHeaders 合并时同键不覆盖调用方注入 */
  authHeaders(apiKey: string | undefined): Record<string, string>;

  /** 请求体组装：思考档位改写、token 上限参数名、协议特化结构
   * （system 剥出 / tool 翻译 / store 等）都在此。probe 特化（maxTokens=1）由 core 代劳。 */
  buildBody(request: ChatRequest): Record<string, unknown>;

  /** HTTP 错误体 → detail 文案（core 统一加 `[协议名] ` 前缀与 200 字符截断） */
  extractErrorDetail(bodyText: string): string;

  /** 流式：读 SSE，经 onEvent 吐归一 StreamChatEvent，返回聚合结果。
   *  中止抛 makeAbortedError；流内协议错误吐 error 事件或抛错（可重试语义同 core）。 */
  drainStream(response: Response, ctx: DrainContext): Promise<DrainResult>;

  /** 非流式：响应 JSON → 聚合结果（map-reduce 消费） */
  parseResponse(json: unknown): DrainResult;
}

// ---- 注册表 ----

import { openaiAdapter } from "./adapters/openai.js";
import { anthropicAdapter } from "./adapters/anthropic.js";
import { responsesAdapter } from "./adapters/responses.js";

export const PROTOCOL_ADAPTERS: Record<AiProtocol, ProtocolAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  responses: responsesAdapter
};

// 协议解析单点：存量记录缺 protocol 字段 / 未知值 → openai（行为零变化兜底）。
// 设置 UI 写入协议字段；读路径只经此处，禁止散落的 if-else。
export function resolveAdapter(protocol: unknown): ProtocolAdapter {
  if (typeof protocol === "string" && protocol in PROTOCOL_ADAPTERS) {
    return PROTOCOL_ADAPTERS[protocol as AiProtocol];
  }
  return PROTOCOL_ADAPTERS.openai;
}

// ===== 设置 UI 消费词表 =====

// 编辑 Modal 协议下拉的选项词表（展示名给人读；值即 AiProtocol）。
// 新增协议 = 注册表登记一行 + 此处加一个选项。
export const PROTOCOL_OPTIONS: ReadonlyArray<{ value: AiProtocol; label: string }> = [
  { value: "openai", label: "OpenAI 兼容" },
  { value: "anthropic", label: "Anthropic" },
  { value: "responses", label: "Responses API" }
];
