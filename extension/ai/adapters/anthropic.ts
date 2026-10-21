// ai/adapters/anthropic.ts — Anthropic Messages API 协议适配器（multi-protocol-ai
// 第二部分）。线格式对照 research/anthropic-wire-mapping.md（issues/02），底稿为
// 评审过的 prototype adapters/anthropic.ts，实现期修正四处：
// - probe 不发 thinking（怪癖 probeOmitsThinking）；
// - off 判定覆盖全部关思考词汇（enable_thinking:false / thinking:{type:"disabled"}
//   / reasoning_effort:"none"），prototype 只认 effort 词表会把 off 误发成开；
// - 流内不吐 done（对齐 openai adapter：done 由 client/map-reduce 收口单发，
//   prototype 的 message_stop 发 done 会与调用方收口双发；怪癖 noDoneSentinel）；
// - stop_reason 必须映射回 OpenAI 词表（tool_use→"tool_calls" 等，怪癖
//   stopReasonVocabulary）：tool-loop 对 finishReason 精确匹配 "tool_calls"
//   （tool-loop.ts），原词会让联网轮提前返回；research「保留原词」的建议与真实
//   消费方矛盾，spec「编排层零改动」优先。
// 另修正 prototype 的线形状错误：message_delta 的 stop_reason 在 delta 内。
// 聚合形状与 openai adapter 同型（DrainResult），编排层零改动。
// 思考字段的写法（off 三词汇归一 / probe 早退 / effort 词汇平台改写）不落在本文件：
// 那是线格式映射表 ai/thinking-wire-map.ts 的一格，装配（取档位事实 → 算行入参 → 取表）
// 的落点是思考装配边 ai/plan-thinking.ts（唯一调用点 = 唯一 fetch 点 completion.ts，
// 产出经 ChatRequest 注入）——本文件只把装配边产出并入请求体，输出上限参数名（本通道
// 必填的 max_tokens）也取自那条边的出参，不写字面量。
// 本文件里的平台怪癖一律只指 compat-vocab 词表的键，语义不回抄（无第二份描述）。
import { makeAbortedError } from "../../shared/error-helpers.js";
import { DEFAULT_MAX_TOKENS } from "../output-budget.js";
import { listOpenAiCompatibleModels, parseToolArgs } from "./openai.js";
import type { ChatRequest, DrainContext, DrainResult, ListModelsInput, ListModelsResult, ProtocolAdapter } from "../protocol-adapter.js";
import type { ChatMessage, ChatToolCall, ChatUsage } from "../types.js";

// 怪癖 maxTokensRequired（语义见 compat-vocab 词表单源）：max_tokens 必填且无
// 默认，调用方未传时 adapter 兜底。兜底值的语义 =「调用方不关心时给一个合理上限」
// （OpenAI 系平台此时干脆不发字段、由平台自身默认决定），故按「思考之外还留得下
// 正文」取值；具体数字单源在 ai/output-budget.ts（core 也读它做「被平台
// 拒收后退回保守值」的判定，本 adapter 的 defaultMaxTokens 声明同一个值）。
// 思考是否计入 max_tokens 看平台：官方文档计入；ModelScope 实测分模型——
// Qwen3.8-Flash-Next 不计入（max_tokens=8192 时 output_tokens 可达 15805，
// stop_reason 仍 end_turn），step-3.7-flash 计入、会把正文挤成空串（即
// analysis-orchestrate 的 finish_reason=length 空正文记录）。中文长答本身也吃额度：
// 实测 4096 下六千字散文在 5637 字处截断（stop_reason=max_tokens），同一请求 8192
// 完整收尾——旧兜底 8192 = 已废弃的默认思考预算 2048 + 正文余量，只够旧模型，现
// 降级为退回下限（CONSERVATIVE_MAX_TOKENS，见 output-budget.ts）。
// 思考档位在 Messages 通道的写法（怪癖 thinkingFormat / thinkingDisabledMustBeExplicit /
// probeOmitsThinking / effortVocabMessages）逐格落在 ai/thinking-wire-map.ts 的 anthropic
// 行；「本行读得到哪些平台事实、各按什么口径识别」（思考平台识别 resolveThinkingProviderId、
// 怪癖词表识别 resolvePlatformQuirkId）落在思考装配边 ai/plan-thinking.ts——本文件不算平台识别。
// Anthropic 家族的思考控制有两套词汇：老式 thinking:{type} 开关（原生各家）
// 与新式 output_config.effort。走 Messages 通道而只认后者的平台（stepfun / amd）由
// 怪癖 effortVocabMessages 登记，词表 PLATFORM_QUIRKS 是唯一主人。
// 本通道**任何一格都不发 thinking.budget_tokens**（官方没有 effort→预算的换算表，
// 自造预算会挤占 max_tokens；线格式映射表的文件头是同一条硬规则）。

// system 剥出（怪癖 systemOutOfBand，语义见 compat-vocab）：Anthropic messages
// 数组不允许 system 角色；多条按出现顺序 \n\n 拼接（契约点）。
function extractSystem(messages: ChatMessage[]): { system: string | undefined; rest: ChatMessage[] } {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    rest: messages.filter((m) => m.role !== "system")
  };
}

// 消息翻译（怪癖 toolResultInUserMessage / contentPartsAsArray，语义见 compat-vocab）：
// - assistant 带 tool_calls → content 块数组：text 块 + 每 call 一个 tool_use 块
//   （arguments JSON.parse 失败兜底 { query: 原文 }，对齐 parseToolArgs 宽容风格）。
// - 带 images 的消息（image-input 路线 B）→ content 块数组：text 块 + image 块
//   （base64 源）；无图消息维持原字符串 content（线形状逐字节不变）。图片只可能
//   来自用户粘贴，故 assistant(tool_calls) 轮不合并图片（仍是 text + tool_use 块）。
// - role:"tool" 消息 → 合并进 user 消息的 tool_result 块（连续多条合并进同一条）；
//   前置条件：须紧跟对应 assistant(tool_use) 消息，孤立 tool 消息由平台 400 兜底
//   （调用方消息序列由编排层保证）。
function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.length) {
      const blocks: unknown[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.tool_calls) {
        // arguments → input：合法对象透传，其余（非 JSON / 非对象 / 缺 query）统一
        // 走 parseToolArgs 的 { query } 兜底（与出参方向、tool-loop 回填单源）。
        blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseToolArgs(call.function.arguments) });
      }
      out.push({ role: "assistant", content: blocks });
    } else if (message.role === "tool") {
      const resultBlock = { type: "tool_result", tool_use_id: message.tool_call_id ?? "", content: message.content };
      const last = out[out.length - 1] as { role?: string; content?: unknown[] } | undefined;
      if (
        last?.role === "user" &&
        Array.isArray(last.content) &&
        last.content.some((b) => (b as { type?: string }).type === "tool_result")
      ) {
        last.content.push(resultBlock);
      } else {
        out.push({ role: "user", content: [resultBlock] });
      }
    } else if (message.images?.length) {
      // 图片输入（image-input 路线 B）：text 块 + 每张图一个 image 块（base64 源，
      // media_type 取消息自带 mime）。text 块仅在正文非空时发出——空 text 块会 400。
      const blocks: unknown[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const image of message.images) {
        blocks.push({ type: "image", source: { type: "base64", media_type: image.mime, data: image.data } });
      }
      out.push({ role: message.role, content: blocks });
    } else {
      out.push({ role: message.role, content: message.content });
    }
  }
  return out;
}

// input_schema 直接改名透传（压平并行的 disable_parallel_tool_use 在 buildBody
// 的 tool_choice 上，见怪癖 parallelToolUseFlattened）。原生服务端工具（名字带日期
// 版本后缀，如 web_search_20250305）不走 tool-loop，显式不翻译（怪癖
// serverToolsNotTranslated，语义见 compat-vocab；只翻译编排层发来的客户端 function 工具）。
const NATIVE_TOOL_NAME = /_\d{8}$/;

function toAnthropicTools(tools: ChatRequest["tools"]): unknown[] | undefined {
  if (!tools?.length) return undefined;
  const translated = tools
    .filter((t) => !NATIVE_TOOL_NAME.test(t.function.name))
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters
    }));
  return translated.length ? translated : undefined;
}

// stop_reason 词表映射回 OpenAI 词表（怪癖 stopReasonVocabulary，语义见
// compat-vocab）：tool-loop 对 finishReason 精确匹配 "tool_calls"，原词会让联网轮
// 提前返回——spec「编排层零改动」要求此处翻译而非改消费方；未列出的新词原样透传。
function mapStopReason(reason: string): string {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "refusal":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return reason;
  }
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  message?: { usage?: unknown };
  usage?: unknown;
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  error?: { type?: string; message?: string };
  content_block?: { type?: string; id?: string; name?: string };
}

// 响应 usage 单字段取数（ai-usage-telemetry T1）：流式 input_tokens 在
// message_start.message.usage、output_tokens 在 message_delta.usage；非流式两者同在
// 响应体 json.usage（形状由本 adapter 自陈，core 不认）。容器形状不符 / 字段缺失 /
// null / 非有限数一律缺省——不抛错、不降级。两字段全缺省时由调用方决定是否产生
// usage 对象。
function usageTokenCount(container: unknown, field: "input_tokens" | "output_tokens"): number | undefined {
  const value = (container as Record<string, unknown> | null | undefined)?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// 单容器双字段归一（非流式响应体 json.usage）：两字段全缺省 → undefined，调用方据此
// 不产生 usage（与 openai 侧 parseOpenAiUsage 的同名纪律一致，值域不过滤）。
function usageFromContainer(container: unknown): ChatUsage | undefined {
  const inputTokens = usageTokenCount(container, "input_tokens");
  const outputTokens = usageTokenCount(container, "output_tokens");
  if (inputTokens == null && outputTokens == null) return undefined;
  return {
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {})
  };
}

export const anthropicAdapter: ProtocolAdapter = {
  protocol: "anthropic",
  defaultMaxTokens: DEFAULT_MAX_TOKENS,
  capabilities: {
    tools: true,
    thinkingProfiles: true,
    // 三条「有意不支持的能力」（spec 逐条落点）只在此注释留档，不再出到设置 UI
    //（2026-10-06 用户裁定删文案）；语义单源是 compat-vocab 的 parallelToolUseFlattened /
    // thinkingSignatureNotReplayed / serverToolsNotTranslated：
    // - 并行 tool_use：本通道一律压平（buildBody 的 tool_choice.disable_parallel_tool_use；
    //   并行是 Anthropic 默认能力，压平是本扩展的选择，聚合层按 index 已天然支持）；
    // - thinking 回传：signature 不进 ChatMessage，本通道不回传思考块。上游在 tool use 时
    //   要求原样回传并校验未改动（preserved thinking），本扩展依赖网关不校验——严格端点
    //   上联网轮会 400，走 tool-loop 的 4xx 兜底降级；
    // - 原生服务端工具（type 带日期版本，如 web_search_20250305）：不走 tool-loop，
    //   adapter 只翻译客户端 function 工具（判据是 NATIVE_TOOL_NAME 的名字启发式）。
    unsupported: {}
  },

  // 平台怪癖自陈（语义与适用协议见 compat-vocab 词表单源）。
  consumes: [
    "maxTokensRequired",
    "thinkingFormat",
    "thinkingDisabledMustBeExplicit",
    "effortVocabMessages",
    "probeOmitsThinking",
    "systemOutOfBand",
    "toolResultInUserMessage",
    "stopReasonVocabulary",
    "noDoneSentinel",
    "thinkingSignatureNotReplayed",
    "parallelToolUseFlattened",
    "serverToolsNotTranslated",
    "contentPartsAsArray",
    "authHeaderScheme"
  ],

  endpoint(baseUrl: string): string {
    return `${baseUrl}/v1/messages`;
  },

  authHeaders(apiKey: string | undefined): Record<string, string> {
    // 怪癖 authHeaderScheme（语义见 compat-vocab）：非 Bearer，x-api-key +
    // anthropic-version。
    const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
    if (apiKey) headers["x-api-key"] = apiKey;
    return headers;
  },

  buildBody(request: ChatRequest): Record<string, unknown> {
    const { system, rest } = extractSystem(request.messages);
    // 怪癖 maxTokensRequired：本通道上限字段必填，调用方未传兜底 DEFAULT_MAX_TOKENS；
    // 探针由 core 代劳传 1。
    const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
    // 思考线格式产出由 core（唯一 fetch 点）经装配边注入：档位偏好、平台识别与
    // probe 早退都已在产出里兑现（缺省 / 脏值 = default 不干预 → 空 fields；显式
    // `off` 走 MESSAGES_OFF_EXIT 的逐格出口），本函数只并入。
    const wire = request.thinkingWire;
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toAnthropicMessages(rest),
      stream: request.stream,
      // 上限字段名取自装配边出参（怪癖 maxTokensRequired 的字段名由映射表的 anthropic 行
      // 声明）：本文件不写该字段的字面量。
      [wire.tokenParam]: maxTokens
    };
    if (system) body.system = system;
    const tools = toAnthropicTools(request.tools);
    if (tools) {
      body.tools = tools;
      body.tool_choice = { type: "auto", disable_parallel_tool_use: true };
    }
    Object.assign(body, wire.fields);
    return body;
  },

  extractErrorDetail(bodyText: string): string {
    // Anthropic 错误体：{ type: "error", error: { type, message } }；core 统一加
    // `[Anthropic] ` 前缀与 200 字符截断。
    try {
      const parsed = JSON.parse(bodyText) as { error?: { type?: unknown; message?: unknown } };
      const type = typeof parsed.error?.type === "string" ? parsed.error.type : "";
      const message = typeof parsed.error?.message === "string" ? parsed.error.message : "";
      if (type && message) return `${type}: ${message}`;
      if (message) return message;
      if (type) return type;
    } catch {}
    return bodyText;
  },

  async drainStream(response: Response, ctx: DrainContext): Promise<DrainResult> {
    // 事件映射。data: 行自带 type 字段，无需解析 event: 行；无 [DONE] 哨兵
    // （怪癖 noDoneSentinel，语义见 compat-vocab）——流读完即收束，done 由调用方
    // （client/map-reduce）收口单发。中止抛 makeAbortedError（与 openai adapter
    // 同型），由 core 统一收束。
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason: string | null = null;
    // 响应 usage（ai-usage-telemetry T1）：input 来自 message_start、output 来自
    // message_delta，跨事件累积；各自缺失则不填，全程未采到即缺省。
    let usage: ChatUsage | undefined;
    const fragments = new Map<number, { id: string; name: string; args: string }>();

    while (true) {
      if (ctx.signal?.aborted) {
        throw makeAbortedError();
      }

      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.length ? lines.pop()! : "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        // Anthropic 不发 [DONE]；跳过逻辑保留无害。
        if (!data || data === "[DONE]") continue;

        let event: AnthropicStreamEvent;
        try {
          event = JSON.parse(data) as AnthropicStreamEvent;
        } catch {
          // 坏行宽容忽略（契约级约定：不抛错）。
          continue;
        }
        switch (event.type) {
          case "content_block_start":
            // tool_use 块起始：记录 { index, id, name }；text/thinking 块忽略
            // （首字在 delta 里）。
            if (event.content_block?.type === "tool_use") {
              fragments.set(event.index ?? 0, {
                id: event.content_block.id ?? "",
                name: event.content_block.name ?? "",
                args: ""
              });
            }
            break;
          case "content_block_delta":
            if (event.delta?.type === "text_delta") {
              content += event.delta.text ?? "";
              ctx.onEvent?.({ type: "token", data: event.delta.text ?? "" });
            } else if (event.delta?.type === "thinking_delta") {
              ctx.onEvent?.({ type: "reasoning", data: event.delta.thinking ?? "" });
            } else if (event.delta?.type === "input_json_delta") {
              const existing = fragments.get(event.index ?? 0) || { id: "", name: "", args: "" };
              existing.args += event.delta.partial_json ?? "";
              fragments.set(event.index ?? 0, existing);
            }
            // signature_delta 忽略（怪癖 thinkingSignatureNotReplayed：thinking
            // 不回传，语义见 compat-vocab）。
            break;
          case "message_delta": {
            // stop_reason 在 delta 内（message_delta 形状）；词表经 mapStopReason
            // 映射回 OpenAI 词表（怪癖 stopReasonVocabulary，tool-loop 精确匹配
            // "tool_calls"，见文件头）。usage.output_tokens 同帧（响应 usage 采集）。
            if (typeof event.delta?.stop_reason === "string" && event.delta.stop_reason) {
              finishReason = mapStopReason(event.delta.stop_reason);
            }
            const outputTokens = usageTokenCount(event.usage, "output_tokens");
            if (outputTokens != null) usage = { ...usage, outputTokens };
            break;
          }
          case "message_start": {
            // input_tokens 在 message_start.message.usage（响应 usage 采集）；
            // 其余字段（id/model 等）本 adapter 不消费。
            const inputTokens = usageTokenCount(event.message?.usage, "input_tokens");
            if (inputTokens != null) usage = { ...usage, inputTokens };
            break;
          }
          case "error":
            // 流内错误（如 overloaded_error）：抛出走 core 的读流中断重试（流式
            // 2 次，retryable 语义与 http ≥500 对齐）；前缀对齐 core HTTP 路径的
            // `[协议名] ` 形状。继续读完只会把截断内容当成功返回。
            throw new Error(`[anthropic] ${event.error?.type ?? "error"}: ${event.error?.message ?? ""}`);
          // content_block_stop / ping / 未知事件：一律忽略
          // （官方要求 graceful 处理未知类型）。
        }
      }
    }

    // 聚合的 tool_use 按 index 升序吐 tool-call 事件（与 openai adapter 同型，
    // client 侧吞掉不出 port）并随结果带回。
    const toolCalls: ChatToolCall[] = [...fragments.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, fragment]) => ({
        id: fragment.id || `tool_call_${index}`,
        type: "function" as const,
        function: { name: fragment.name, arguments: fragment.args }
      }));
    for (const call of toolCalls) {
      ctx.onEvent?.({ type: "tool-call", name: call.function.name, args: parseToolArgs(call.function.arguments) });
    }
    return { content, toolCalls, finishReason, ...(usage ? { usage } : {}) };
  },

  parseResponse(json: unknown): DrainResult {
    // 非流式：content 块数组——text 块顺序拼接无分隔符（怪癖
    // contentPartsAsArray），tool_use 块回转为 ChatToolCall。
    const data = json as {
      content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason?: unknown;
      usage?: unknown;
    };
    let content = "";
    const toolCalls: ChatToolCall[] = [];
    for (const block of data.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") content += block.text;
      if (block.type === "tool_use") {
        toolCalls.push({
          id: typeof block.id === "string" && block.id ? block.id : `tool_call_${toolCalls.length}`,
          type: "function" as const,
          function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) }
        });
      }
    }
    // 响应 usage（ai-usage-telemetry T1）：Messages API 非流式响应体带顶层
    // json.usage（map-reduce 段/概览全走非流式，不补则本协议零采样）；形状不符 /
    // 缺字段一律缺省，不改既有 content/toolCalls/finishReason 控制流。
    const usage = usageFromContainer(data.usage);
    return {
      content,
      toolCalls,
      finishReason: typeof data.stop_reason === "string" && data.stop_reason ? mapStopReason(data.stop_reason) : null,
      ...(usage ? { usage } : {})
    };
  },

  // 模型列表拉取复用 OpenAI 兼容形状（listOpenAiCompatibleModels）：Messages 通道
  // 无 models.list 端点（实测 anthropic baseUrl + /v1/models 404），设置弹窗对
  // anthropic 协议已把探测地址跟随到预设的 OpenAI 端点——与归位前「非 gemini 一律
  // openai 形状」行为逐字节一致。
  listModels(input: ListModelsInput): Promise<ListModelsResult> {
    return listOpenAiCompatibleModels(input);
  }
};
