// ai/compat-vocab.ts — 平台怪癖词表（CONTEXT.md「平台协议」域，compat-vocab 票）。
// 命名与语义设计参照 @earendil-works/pi-ai 的 `compat` 开关词表
// （thinkingFormat / maxTokensField / requiresReasoningContentOnAssistantMessages 等，
// 见 ADR-0009「借」清单）——只借命名与语义，**不借数据**：本模块零 import（只
// type-import 词表叶 AiProtocol），pi-ai 的任何值都不进本文件，也不在
// provider-http.ts → completion.ts → adapters/* 那条链上被读。
//
// 职责：回答「这个平台有哪些怪癖、各自的开关叫什么、谁消费」。
// - COMPAT_QUIRKS 是怪癖的**唯一主人**：稳定键 + 语义 + 适用协议 + 线格式取值。
//   adapter 注释里的怪癖散点只指键名，语义不回抄（无第二份描述）。
// - PLATFORM_QUIRKS 是「该平台开哪些怪癖」的唯一声明处。新增平台时在这里登记一行。
// - ProtocolAdapter.consumes 是「该协议 adapter 接纳哪些怪癖」的自陈；校验器
//   validateCompatVocab 对账两侧（测试期跑，不进运行时）：声明了却没人接纳、
//   接纳了却没声明，都报错。
//
// 词表里只放**协议线格式层面的怪癖**（请求体字段名、思考词汇、消息历史要求、
// 会话头、流式哨兵…）。模型血统事实（哪档发什么字段）不在这里——那是
// thinking-profiles.ts 的单一事实源，词表只登记它与协议栈之间的那些缝隙。

import type { AiProtocol } from "./protocol-vocab.js";

export interface CompatQuirkSpec {
  /** 语义：这条怪癖是什么、为什么存在（给人和给未来维护者看）。 */
  summary: string;
  /** 适用协议：哪些协议的 adapter 消费这条怪癖。 */
  protocols: readonly AiProtocol[];
  /**
   * 线格式取值：怪癖在线上表现为哪个字段名 / 头名。缺省表示该怪癖没有固定
   * 字面量（如"思考字段格式随平台变"这类由 thinking-profiles 决定的怪癖）。
   */
  wire?: string;
}

// 键集合稳定：改语义改 summary，改键名须同步迁移所有消费点与测试快照。
export const COMPAT_QUIRKS = {
  // ===== 请求体字段名类 =====
  /** token 上限参数名随平台变：openai-reasoning 系只认 max_completion_tokens（传 max_tokens 严格 400），其余 max_tokens。 */
  maxTokensField: {
    summary: "token 上限参数名随平台/模型血统变（max_tokens ↔ max_completion_tokens），随表事实来自 thinking-profiles 的 tokenParam。",
    protocols: ["openai"],
    wire: "max_completion_tokens"
  },
  /** 思考开关/档位的请求体词汇随平台变（reasoning_effort / thinking:{type} / enable_thinking），三套词汇无统一字段名。 */
  thinkingFormat: {
    summary: "思考控制字段的词汇随平台变：reasoning_effort（档位）、thinking:{type}（开关）、enable_thinking（开关）三套并存。",
    protocols: ["openai", "anthropic"]
  },
  /** 关思考字段仅流式可用（百炼 qwen3-235b/32b/30b），非流式遇此按「无事实」处理走级联。 */
  streamingOnlyThinkingOff: {
    summary: "关思考声明仅流式可用；非流式请求遇此规则按无事实处理（走 off 级联或缺档不发）。",
    protocols: ["openai"]
  },
  /** 严格拒收 thinking 开关的网关（AMD / SenseNova / OpenRouter）整域只认 effort 词汇。 */
  overrideEffortVocabulary: {
    summary: "网关对未知字段严格 400，整域只认 effort 词汇（reasoning_effort 含 none），任何模型不走血统表的开关词汇。",
    protocols: ["openai"]
  },
  /** Anthropic Messages 通道的 effort 词汇平台（stepfun / amd）只收 output_config.effort，不收 thinking。 */
  effortVocabMessages: {
    summary: "Anthropic Messages 通道只认新式 output_config.effort：发 thinking 字段直接 400（stepfun 官方字段表未列 thinking；amd 带 budget_tokens 的 thinking 报「not supported」）。",
    protocols: ["anthropic"]
  },
  /** 默认开思考的网关（ModelScope Messages 端点）必须显式发关思考字段，不能依赖服务端默认。 */
  thinkingDisabledMustBeExplicit: {
    summary: "平台默认开思考且忽略 enable_thinking:false，只有显式的 thinking:{type:\"disabled\"} 能真正关掉；依赖服务端默认会把正文挤成空串。",
    protocols: ["anthropic"]
  },
  /** 探针（maxTokens=1）不发任何思考字段：budget_tokens ≥1024 且必须 < max_tokens，发了必 400。 */
  probeOmitsThinking: {
    summary: "探针请求不发思考字段——思考预算有硬性下限且必须小于 max_tokens，探针的 maxTokens=1 会把请求打成 400。",
    protocols: ["anthropic"]
  },
  /** Anthropic max_tokens 必填且无平台默认值，调用方未传时 adapter 兜底。 */
  maxTokensRequired: {
    summary: "max_tokens 是必填参数且平台不给默认值，调用方未传时由 adapter 兜底（OpenAI 系此时干脆不发字段、由平台自行决定）。",
    protocols: ["anthropic"],
    wire: "max_tokens"
  },
  /** Anthropic 思考预算的字段形状与硬性下限。 */
  thinkingBudgetTokens: {
    summary: "思考预算走 thinking:{type:\"enabled\",budget_tokens}，budget 硬性 ≥1024 且必须 < max_tokens（思考计入 max_tokens，放不下就不发）。",
    protocols: ["anthropic"],
    wire: "thinking.budget_tokens"
  },
  /** 平台要求每个对话带一个稳定会话 id 头（Opencode Go），缺失不被接受。 */
  sessionHeader: {
    summary: "平台要求每个对话带一个稳定的会话 id 请求头（供平台路由与 prompt 缓存），不带则请求不被接受。",
    protocols: ["openai"],
    wire: "x-opencode-session"
  },

  // ===== 消息历史要求类 =====
  /** Anthropic messages 数组不接受 system 角色，多条 system 须剥出为顶层参数。 */
  systemOutOfBand: {
    summary: "messages 数组不接受 system 角色：system 消息须剥出为顶层参数，多条按出现顺序以空行拼接。",
    protocols: ["anthropic"]
  },
  /** Anthropic 无 tool 角色：tool 结果合并进 user 消息的 tool_result 块。 */
  toolResultInUserMessage: {
    summary: "没有 tool 角色：工具结果须合并进 user 消息的 tool_result 块（连续多条合并进同一条），且须紧跟对应的 assistant(tool_use)。",
    protocols: ["anthropic"]
  },
  /** Anthropic 的 stop_reason 词表与 OpenAI 的 finish_reason 不同，须映射回编排层认的词。 */
  stopReasonVocabulary: {
    summary: "结束原因词表与 OpenAI 不同（end_turn/tool_use/max_tokens…），须映射回编排层精确匹配的 OpenAI 词表。",
    protocols: ["anthropic"]
  },

  // ===== 流式线格式类 =====
  /** Anthropic 不发 [DONE] 哨兵，流读完即收束。 */
  noDoneSentinel: {
    summary: "流尾没有 [DONE] 哨兵，读完即收束；收束信号由调用方单发，不在流内吐。",
    protocols: ["anthropic"]
  },
  /** thinking 块的 signature 不回传历史，多轮回传 thinking 会 400。 */
  thinkingSignatureNotReplayed: {
    summary: "思考块带 signature 且必须原样回传历史，而本场景不把它存进 ChatMessage——多轮回传思考会 400，故有意的缺口。",
    protocols: ["anthropic"]
  },
  /** OpenAI 兼容端的并行 tool_use 被压平（tool_choice.disable_parallel_tool_use）。 */
  parallelToolUseFlattened: {
    summary: "并行 tool_use 被按协议压平（tool_choice 带 disable_parallel_tool_use），未来要并行时聚合层按 index 已天然支持。",
    protocols: ["anthropic"]
  },
  /** Anthropic 原生服务端工具（带日期后缀的名字）不走客户端 tool 循环，不翻译。 */
  serverToolsNotTranslated: {
    summary: "Anthropic 原生服务端工具（名字带日期版本后缀，如 web_search_20250305）不走 tool 循环，adapter 只翻译客户端 function 工具。",
    protocols: ["anthropic"]
  },

  // ===== 消息体形状类 =====
  /** 带图消息的 content 翻成块数组；无图消息保持字符串。 */
  contentPartsAsArray: {
    summary: "带图消息的 content 须翻成块数组（text + 每图一个块），无图消息保持字符串；空 text 块部分兼容端点会 400。",
    protocols: ["openai", "anthropic"]
  },
  /** OpenAI 兼容端流内 tool_calls 逐 chunk 分片，按 index 聚合。 */
  toolCallFragmentsByIndex: {
    summary: "流内工具调用逐 chunk 分片（id/name/arguments 跨 chunk 拼接），须按 index 聚合成完整调用。",
    protocols: ["openai"]
  },

  // ===== 鉴权头类 =====
  /** Anthropic 用 x-api-key + anthropic-version，非 Bearer。 */
  authHeaderScheme: {
    summary: "鉴权头不是 Bearer：x-api-key + 必带的 anthropic-version 版本头。",
    protocols: ["anthropic"],
    wire: "x-api-key"
  },
  /** requiresKey=false 的平台允许空 key，此时不注入 Authorization。 */
  bearerOptionalWithoutKey: {
    summary: "apiKey 缺失时不注入 Authorization 头（平台允许空 key 的本地/免鉴权部署）。",
    protocols: ["openai"],
    wire: "Authorization"
  }
} as const satisfies Record<string, CompatQuirkSpec>;

export type CompatQuirk = keyof typeof COMPAT_QUIRKS;

// ===== 平台声明表（新增平台时"该平台开哪些怪癖"的一处声明）=====
// 键 = core/presets.ts 的 AI preset id。未列出的平台不开任何怪癖。
// 事实主人在 thinking-profiles.ts 的 PROVIDERS/CLASSES（思考参数逐格事实）；
// 这里只登记"平台 × 协议线格式"层面的缝隙，不复制思考档位事实。
export const PLATFORM_QUIRKS: Readonly<Record<string, readonly CompatQuirk[]>> = {
  // Opencode Go：官方文档要求每对话一个稳定会话 id 头（x-opencode-session）。
  opencodego: ["sessionHeader"],
  // stepfun / amd：Messages 通道只认 output_config.effort，不收 thinking 字段。
  stepfun: ["effortVocabMessages", "overrideEffortVocabulary"],
  amd: ["effortVocabMessages", "overrideEffortVocabulary"],
  // OpenRouter / SenseNova：严格拒收 thinking 开关的 effort 词汇网关。
  openrouter: ["overrideEffortVocabulary"],
  sensenova: ["overrideEffortVocabulary"],
  // ModelScope Messages 端点：默认开思考、enable_thinking:false 被忽略。
  modelscope: ["thinkingDisabledMustBeExplicit"]
};

/** 该平台是否开某条怪癖（未登记的平台一律不开）。 */
export function hasPlatformQuirk(platformId: string | undefined, quirk: CompatQuirk): boolean {
  return (PLATFORM_QUIRKS[String(platformId || "").trim()] ?? []).includes(quirk);
}

/** 该平台某条怪癖的线格式取值（如会话头名）；平台未开该怪癖返回 undefined。 */
export function quirkWireValue(platformId: string | undefined, quirk: CompatQuirk): string | undefined {
  if (!hasPlatformQuirk(platformId, quirk)) return undefined;
  // 声明类型收口一次：as const 让各成员的 wire 可选性不统一，赋值到规格接口
  // 后按统一的可选 wire 读。
  const spec: CompatQuirkSpec = COMPAT_QUIRKS[quirk];
  return spec.wire;
}

// ===== 二次校验层（测试期"编译器"，票第 4 条）=====
// 语义：词表声明的「适用协议」与 adapter 自陈的「接纳的怪癖」必须两侧对齐——
// 声明了没人接纳 = 死声明，接纳了没声明 = 漏登记。两者都报错，测试即红。
// 校验真实表（传 consumes）或注入违规后的表副本；返回中文错误列表（空 = 通过）。
// 纯函数、无副作用：consumes 由调用方从 PROTOCOL_ADAPTERS 取（词表叶不 import 分发表）。

export interface CompatVocabTables {
  quirks?: Record<string, CompatQuirkSpec>;
  platforms?: Readonly<Record<string, readonly CompatQuirk[]>>;
  /** 每个协议 adapter 接纳的怪癖键集（按 AiProtocol 索引）。 */
  consumes: Readonly<Record<AiProtocol, readonly CompatQuirk[]>>;
}

export function validateCompatVocab({ quirks = COMPAT_QUIRKS, platforms = PLATFORM_QUIRKS, consumes }: CompatVocabTables): string[] {
  const errors: string[] = [];

  for (const [quirk, spec] of Object.entries(quirks)) {
    // 声明的适用协议必须都被对应 adapter 接纳。
    for (const protocol of spec.protocols) {
      if (!consumes[protocol]?.includes(quirk as CompatQuirk)) {
        errors.push(`${quirk}: 词表声明适用协议 ${protocol}，但 ${protocol} adapter 未接纳`);
      }
    }
    // 被某 adapter 接纳的必须在词表里声明了该协议（漏登记方向）。
    for (const protocol of Object.keys(consumes) as AiProtocol[]) {
      if (consumes[protocol].includes(quirk as CompatQuirk) && !spec.protocols.includes(protocol)) {
        errors.push(`${quirk}: ${protocol} adapter 接纳，但词表未声明适用该协议`);
      }
    }
  }

  // 平台声明的怪癖键必须在词表里（防手滑打错键），且必须被至少一个 adapter
  // 接纳（不声明没人消费的死键）。
  const protocols = Object.keys(consumes) as AiProtocol[];
  for (const [platform, declared] of Object.entries(platforms)) {
    for (const quirk of declared) {
      if (!quirks[quirk]) {
        errors.push(`PLATFORM_QUIRKS.${platform}: 怪癖键 "${quirk}" 不在词表 COMPAT_QUIRKS 中`);
        continue;
      }
      if (!protocols.some((protocol) => consumes[protocol].includes(quirk))) {
        errors.push(`PLATFORM_QUIRKS.${platform}: 怪癖键 "${quirk}" 没有任何协议 adapter 接纳（死声明）`);
      }
    }
  }

  return errors;
}
