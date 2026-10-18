// ai/adapters/openai.ts — OpenAI compatible 协议适配器（multi-protocol-ai）。
// 现有 completion.ts 的 OpenAI 行为迁入本文件，列举项逐字节不变：
// OPENAI_CHAT_PATH / buildChatRequestBody（调思考装配边取思考字段 + tokenParam 分流 +
// tools 透传）/ drainSseStream（data:-only 行解析、[DONE] 跳过、tool-call-fragment 按
// index 聚合）/ 非流式 choices 提取。唯一新增 extractErrorDetail（错误 envelope
// 提取）——spec 错误归一化要求，core 统一加 `[协议名] ` 前缀与 200 字符截断。
// core（completion.ts）只留重试/中止/溢出/探针骨架。
// 本文件里的平台怪癖一律只指 compat-vocab 词表的键，语义不回抄（无第二份描述）。
import { parseOpenAiUsage, parseSsePayload } from "../sse-parser.js";
import { makeAbortedError } from "../../shared/error-helpers.js";
import { planThinkingWire } from "../plan-thinking.js";
// 未归一的档位外部值的声明面（词表叶；本文件只透传给装配边）。纯类型引入：无运行时依赖边。
import type { ThinkingLevelInput } from "../thinking-levels.js";
import type { ChatMessage, ChatToolCall, ChatUsage } from "../types.js";
import type { ChatRequest, ChatToolDefinition, DrainContext, DrainResult, ListModelsInput, ListModelsResult, ProtocolAdapter } from "../protocol-adapter.js";

// OpenAI 兼容协议 chat 路径。
// 覆盖 OpenAI / DeepSeek / Qwen / Zhipu / Kimi / MiniMax / Mimo / Opencode Go / OpenRouter / Stepfun / Ollama（OpenAI 兼容模式）等。
export const OPENAI_CHAT_PATH = "/chat/completions";

interface BuildChatRequestBodyInput {
  model: string;
  messages: ChatRequest["messages"];
  stream?: boolean;
  // 探针请求事实（本链按探针语义传 maxTokens=1）：它是随整条链走向思考装配边的请求事实，
  // 但 openai 行不读它——本链「探针不发思考字段」靠请求侧归一（探针不传档位 → default
  // 不干预 → 空 patch）；读它的是 Messages 行的探针早退（怪癖 probeOmitsThinking）。
  probe?: boolean;
  // 未归一的档位外部值（本函数只把它交给思考装配边：归一的施加点是解析层
  // resolveThinkingProfile，见 ai/thinking-levels.ts 的 ThinkingLevelInput）。
  thinkingLevel?: ThinkingLevelInput;
  maxTokens?: number | null;
  // 思考参数查表的 provider 识别输入：presetId（preset 词表键）是主路径，
  // baseUrl host 推断兜底（custom/旧记录）。
  baseUrl?: string;
  presetId?: string;
  // 联网搜索管线：传入即随请求体带 tools + tool_choice: "auto"。
  tools?: ChatToolDefinition[];
}

// 带图消息的线格式（image-input 路线 B）：content 从字符串翻成 text / image_url
// 块数组；无图消息保持字符串，线形状与改动前逐字节一致。
type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface WireMessage extends Omit<ChatMessage, "content" | "images"> {
  content: string | ChatContentPart[];
}

// type 而非 interface：对象字面量类型可隐式赋给 Record<string, unknown>
//（adapter.buildBody 的返回签名），interface 无此隐式索引签名。
// 思考字段名与 token 上限参数名不在此逐字列出：它们是思考装配边（ai/plan-thinking.ts）
// 出参的键，取值来自线格式映射表的 openai 行，adapter 不回抄线格式取值
//（对账见 tests/ai/thinking-wire-map.test.ts）。
type ChatRequestBody = {
  model: string;
  messages: WireMessage[];
  stream: boolean;
  tools?: ChatToolDefinition[];
  tool_choice?: "auto";
} & Record<string, unknown>;

// 消息翻译（怪癖 contentPartsAsArray，语义见 compat-vocab）：带 images 的消息把
// content 翻成 content parts（text 块 + 每张图一个 image_url 块，url 为
// data:<mime>;base64,<b64>）；text 块仅在正文非空时发出——空 text 块部分兼容端点会
// 400。无图消息的线形状与改动前逐字节一致（images 字段不上线，是个纯本地字段）。
function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  return messages.map(({ images, ...message }) => {
    if (!images?.length) return message;
    const parts: ChatContentPart[] = [];
    if (message.content) parts.push({ type: "text", text: message.content });
    for (const image of images) {
      parts.push({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.data}` } });
    }
    return { ...message, content: parts };
  });
}

/**
 * 构造 chat/completions 请求体（纯函数，便于单测；请求构造单点）。
 * stream 显式传递（流式 true / 非流式 false）；maxTokens 供探针传 1。
 * 思考字段与输出上限参数名由思考装配边（ai/plan-thinking.ts 的 planThinkingWire）给出：
 * 那条边取档位事实（档位规则查表：平台（presetId / baseUrl host）× 模型（有上游平台时
 * 先查上游编译产物的指派表，未命中才回落例外表 >> 模式表）→ 档位 patch）并按本协议算行
 * 入参、取线格式映射表（ai/thinking-wire-map.ts 的 openai 行）——本协议即原样并入，
 * 查不到事实（unknown / noFields 哨兵）或缺档一律不发字段——软失败优于硬 400。
 * 装配边出参的 tokenParam（04 token 参数映射，见怪癖 maxTokensField）是输出上限参数名的
 * 唯一来源：openai-reasoning 系写 max_completion_tokens，其余类与 unknown 维持 max_tokens
 * 现状。装配边出参里 resolver 的 offUnavailable / thinkingClass（03 对话提示）本函数不消费；
 * 探针不发思考字段由请求侧归一承担（探针不传档位 → 不干预 → 空 patch），本函数与装配边都
 * 不做协议外的特判。
 * messages 经 toWireMessages 翻译：带图消息的 content → text/image_url 块数组，
 * 无图消息原字段原值透传。
 */
export function buildChatRequestBody({ model, messages, stream = false, thinkingLevel, maxTokens, baseUrl, presetId, tools, probe }: BuildChatRequestBodyInput): ChatRequestBody {
  const body: ChatRequestBody = { model, messages: toWireMessages(messages), stream };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  // 档位偏好与 probe 事实都原样交给装配边（归一入口在解析层：缺省 / 脏值 = default
  // （不干预）→ 空 patch，探针因此不发关思考字段（2026-10-05 裁定，见 docs/adr/0015 的
  // 修订块）；显式 `off` 仍走该平台的关思考写点）。装配边收下 probe，但本协议行不读它：
  // 本链探针不发思考字段靠的仍是那条请求侧归一，probeOmitsThinking 是 Messages 侧事实
  // （在装配边的 anthropic 装配行早退）。
  const wire = planThinkingWire({
    protocol: "openai",
    model,
    presetId,
    baseUrl,
    level: thinkingLevel,
    stream,
    probe: probe === true
  });
  Object.assign(body, wire.fields);
  if (maxTokens != null) {
    // 怪癖 maxTokensField（语义见 compat-vocab）：token 上限参数名随装配边出参——openai-reasoning
    // 系不认 max_tokens（严格 400），写 max_completion_tokens；其余类与 unknown 维持 max_tokens
    // 现状。探针（maxTokens 默认 1）与概览/分析的估算预算（含空正文加倍重试）同走此接缝，
    // 自动生效、无需调用方特判。
    body[wire.tokenParam] = maxTokens;
  }
  return body;
}

// 从 arguments JSON 宽容解析 query（spec §2.2 的 args 形状）：对象带 query 字符串
// 直取；其余（含非 JSON / 非对象）以原文包 { query } 兜底，工具调用方总有词可搜。
// tool-loop 回填 tool 消息时复用同一解析（收口单源）。
export function parseToolArgs(rawArguments: string): { query: string } {
  try {
    const parsed = JSON.parse(rawArguments) as { query?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.query === "string") {
      return { query: parsed.query };
    }
  } catch {}
  return { query: rawArguments };
}

/**
 * 读取并解析单个 SSE 响应，逐事件经 onEvent 吐出（不依赖 port/DOM）。
 * 手动 buffer 按行切、data: 前缀、[DONE] 跳过；解析出的事件（reasoning/content）
 * 归一为 { type: "token" | "reasoning", data }（port 协议词表，适配层可直透）。
 * 联网搜索扩展（怪癖 toolCallFragmentsByIndex，语义见 compat-vocab）：
 * delta.tool_calls 分片按 index 聚合（id/name/arguments 跨 chunk
 * 拼接），流结束时逐条吐 onEvent({ type: "tool-call", name, args: { query } })
 * （spec §2.2 聚合后发出），并随返回值带回聚合结果。
 * 中止时抛 makeAbortedError，由调用方统一收束。
 * 产物形状即契约 DrainResult：content 为 content 增量拼接（tool 轮 assistant
 * 消息回填用）；toolCalls 为按 index 聚合的 tool_calls；finishReason 取最后一个
 * finish 事件（"stop" | "tool_calls" | ...，缺失为 null）；usage 取最后一个非空的
 * usage 块（形状归一在 sse-parser.parseOpenAiUsage），平台未给即缺省。
 */
async function drainSseStream({ response, signal, onEvent }: { response: Response } & DrainContext): Promise<DrainResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  // 响应 usage（ai-usage-telemetry T1）：同一流可能出现多次（DeepSeek 等在
  // [DONE] 前最后一个块给出），取最后一个非空；空/形状不符的块不覆盖已有值。
  let usage: ChatUsage | undefined;
  const fragments = new Map<number, { id: string; name: string; args: string }>();

  while (true) {
    if (signal?.aborted) {
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
      if (!data || data === "[DONE]") continue;

      const events = parseSsePayload(data);
      for (const event of events) {
        if (event.type === "reasoning" || event.type === "content") {
          if (event.type === "content") {
            content += event.data;
          }
          onEvent?.({
            type: event.type === "reasoning" ? "reasoning" : "token",
            data: event.data
          });
        } else if (event.type === "tool-call-fragment") {
          const existing = fragments.get(event.index) || { id: "", name: "", args: "" };
          if (event.id) existing.id = event.id;
          if (event.name) existing.name = event.name;
          existing.args += event.argsFragment;
          fragments.set(event.index, existing);
        } else if (event.type === "finish") {
          finishReason = event.reason;
        } else if (event.type === "usage") {
          usage = event.usage;
        }
      }
    }
  }

  // 聚合的 tool_calls 按流内顺序（index 升序）吐 tool-call 事件并随结果带回。
  const toolCalls: ChatToolCall[] = [...fragments.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, fragment]) => ({
      id: fragment.id || `tool_call_${index}`,
      type: "function" as const,
      function: { name: fragment.name, arguments: fragment.args }
    }));
  for (const call of toolCalls) {
    onEvent?.({ type: "tool-call", name: call.function.name, args: parseToolArgs(call.function.arguments) });
  }
  return { content, toolCalls, finishReason, ...(usage ? { usage } : {}) };
}

// ===== 模型列表拉取（OpenAI 兼容形状） =====

// GET `${baseUrl}/v1/models` + Bearer（缺 key 裸 GET，怪癖 bearerOptionalWithoutKey
// 同款语义）：OpenAI compatible 协议的 models.list 形状。anthropic adapter 的
// listModels 复用本实现——Messages 通道无 models.list 端点，设置弹窗对 anthropic
// 协议已把探测地址跟随到预设的 OpenAI 端点（provider-editor-fetch-dialog.ts），
// 行为与归位前「非 gemini 一律 openai 形状」逐字节一致。baseUrl 归一（trim +
// 去尾斜杠 + 削 /v1 尾）在此单源。HTTP 错误在此格式化；网络 / 解析抛错上抛给壳。
export async function listOpenAiCompatibleModels({ baseUrl, apiKey, fetchImpl }: ListModelsInput): Promise<ListModelsResult> {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const doFetch = fetchImpl ?? fetch;
  const resp = await doFetch(`${normalizedBaseUrl}/v1/models`, { headers, method: "GET" });
  if (!resp.ok) {
    const text = await resp.text();
    return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
  }
  const data = (await resp.json()) as { data?: Array<{ id?: string }> };
  const models: string[] = [];
  if (Array.isArray(data?.data)) {
    for (const item of data.data) {
      if (item?.id) models.push(String(item.id));
    }
  }
  return { ok: true, models };
}

export const openaiAdapter: ProtocolAdapter = {
  protocol: "openai",
  capabilities: {
    tools: true,
    thinkingProfiles: true,
    unsupported: {}
  },

  // 平台怪癖自陈（语义与适用协议见 compat-vocab 词表单源）：
  // maxTokensField（token 上限参数名）/ thinkingFormat（思考词汇三套）/
  // streamingOnlyThinkingOff（关思考仅流式）/
  // contentPartsAsArray（带图消息 content 翻块数组）/ toolCallFragmentsByIndex（分片按 index 聚合）/
  // sessionHeader（会话头由 preset-headers 按词表派生）/
  // bearerOptionalWithoutKey（空 key 不注入 Authorization）。
  consumes: [
    "maxTokensField",
    "thinkingFormat",
    "streamingOnlyThinkingOff",
    "contentPartsAsArray",
    "toolCallFragmentsByIndex",
    "sessionHeader",
    "bearerOptionalWithoutKey"
  ],

  endpoint(baseUrl: string): string {
    return `${baseUrl}${OPENAI_CHAT_PATH}`;
  },

  authHeaders(apiKey: string | undefined): Record<string, string> {
    // 怪癖 bearerOptionalWithoutKey（语义见 compat-vocab）：Bearer 仅在 apiKey
    // 存在时注入（requiresKey=false 的平台允许空 key）。
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  },

  buildBody(request: ChatRequest): Record<string, unknown> {
    // 迁入现有 buildChatRequestBody：思考装配边（presetId 主路径 + baseUrl host 兜底 →
    // 线格式映射表 openai 行）出 tokenParam 分流（openai-reasoning 系写
    // max_completion_tokens）+ tools 透传。行为与迁移前逐字节一致。
    return buildChatRequestBody({
      model: request.model,
      messages: request.messages,
      stream: request.stream,
      thinkingLevel: request.thinkingLevel,
      maxTokens: request.maxTokens,
      baseUrl: request.baseUrl,
      presetId: request.presetId,
      tools: request.tools,
      probe: request.probe
    });
  },

  extractErrorDetail(bodyText: string): string {
    // OpenAI error envelope：{ error: { message, type, ... } }；缺失回落整段 body。
    try {
      const parsed = JSON.parse(bodyText) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") return parsed.error.message;
    } catch {}
    return bodyText;
  },

  async drainStream(response: Response, ctx: DrainContext): Promise<DrainResult> {
    return drainSseStream({ response, signal: ctx.signal, onEvent: ctx.onEvent });
  },

  parseResponse(json: unknown): DrainResult {
    // 迁入现有非流式提取：choices[0].message.content / tool_calls 宽容归一。
    // 顶层 usage 走 sse-parser 的同一映射（字段名单源，与流式路径一致）。
    const data = json as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>; usage?: unknown };
    const choice = data?.choices?.[0];
    const content = choice?.message?.content;
    const rawToolCalls = Array.isArray(choice?.message?.tool_calls) ? choice!.message!.tool_calls : [];
    const toolCalls = (rawToolCalls as Array<Record<string, unknown>>).map((call, index) => {
      const fn = (call.function || {}) as { name?: unknown; arguments?: unknown };
      return {
        id: typeof call.id === "string" && call.id ? call.id : `tool_call_${index}`,
        type: "function" as const,
        function: {
          name: typeof fn.name === "string" ? fn.name : "",
          arguments: typeof fn.arguments === "string" ? fn.arguments : "{}"
        }
      };
    });
    const usage = parseOpenAiUsage(data?.usage);
    return {
      content: typeof content === "string" ? content : "",
      toolCalls,
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
      ...(usage ? { usage } : {})
    };
  },

  listModels: listOpenAiCompatibleModels
};
